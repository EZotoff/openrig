import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { getDaemonVersion } from "./daemon-version.js";
import { SelfHostIdentityStore } from "./seat-identity-store.js";
import {
  QUEUE_TRANSFER_FORMAT,
  QueueTransferRefusal,
  canonicalJson,
  computeArchiveDigest,
  type TransferArchivedTransition,
  type TransferArchiveEnvelope,
  type TransferMissionControlAction,
  type TransferRow,
  type TransferScopeKind,
  type TransferTransition,
  type TransferWake,
} from "./queue-transfer-archive.js";

/** The contract's default archive bound (§12): refuse, never truncate. */
export const DEFAULT_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

const TERMINAL_STATES = new Set(["done", "failed", "denied", "canceled", "handed-off"]);

/** An export needs a scope; unlike other refusals this is a usage error naming the flags (D7). */
export class QueueTransferScopeError extends Error {
  readonly code = "selection_required" as const;
  constructor() {
    super(
      "an export needs an explicit selection: at least one of --whole-host, --rig, --mission, --slice, --qitem",
    );
    this.name = "QueueTransferScopeError";
  }
}

export interface QueueExportScopeInput {
  wholeHost?: boolean;
  rigs?: string[];
  missions?: string[];
  slices?: string[];
  qitemIds?: string[];
  includeClosed?: boolean;
  /** Hard bound on the serialized archive; refusing is contract-legal (§12, D11). */
  maxBytes?: number;
}

export interface QueueExportSelection {
  kind: TransferScopeKind;
  rigs: string[];
  missions: string[];
  slices: string[];
  qitemIds: string[];
  includeClosed: boolean;
  selectionShownAt: string;
  counts: { total: number; open: number; terminal: number; erased: number };
}

export interface QueueExportResult {
  envelope: TransferArchiveEnvelope;
  /** The canonical archive text the caller writes to `--out`; never written by this module. */
  text: string;
  selection: QueueExportSelection;
}

export interface QueueExportOptions {
  now?: () => Date;
}

interface QueueItemSqlRow {
  qitem_id: string;
  [column: string]: unknown;
}

/** DB column → archive field for the 38 `queue_items` columns (§3). */
const QUEUE_ITEM_FIELD: Record<string, keyof TransferRow> = {
  qitem_id: "qitemId",
  ts_created: "tsCreated",
  ts_updated: "tsUpdated",
  source_session: "sourceSession",
  destination_session: "destinationSession",
  state: "state",
  priority: "priority",
  tier: "tier",
  tags: "tags",
  blocked_on: "blockedOn",
  handed_off_to: "handedOffTo",
  handed_off_from: "handedOffFrom",
  expires_at: "expiresAt",
  chain_of_record: "chainOfRecord",
  body: "body",
  closure_reason: "closureReason",
  closure_target: "closureTarget",
  closure_required_at: "closureRequiredAt",
  claimed_at: "claimedAt",
  last_nudge_attempt: "lastNudgeAttempt",
  last_nudge_result: "lastNudgeResult",
  last_heartbeat: "lastHeartbeat",
  resolution: "resolution",
  target_repo: "targetRepo",
  summary: "summary",
  evidence_ref: "evidenceRef",
  minting_generation_uuid: "mintingGenerationUuid",
  claimed_by_generation_uuid: "claimedByGenerationUuid",
  human_intent: "humanIntent",
  human_detail: "humanDetail",
  reply_to: "replyTo",
  human_questions: "humanQuestions",
  human_answers: "humanAnswers",
  last_nudge_input_box: "lastNudgeInputBox",
  delegated_decision: "delegatedDecision",
  content_erased_at: "contentErasedAt",
  return_route: "returnRoute",
  return_route_basis: "returnRouteBasis",
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function splitTags(tags: unknown): string[] {
  if (typeof tags !== "string" || !tags.trim()) return [];
  return tags.split(",").map((tag) => tag.trim()).filter(Boolean);
}

function sessionRig(address: unknown): string | null {
  if (typeof address !== "string") return null;
  const at = address.lastIndexOf("@");
  return at > 0 && at < address.length - 1 ? address.slice(at + 1) : null;
}

function resolveKind(input: QueueExportScopeInput): TransferScopeKind {
  if (input.wholeHost) return "host";
  if ((input.qitemIds ?? []).length > 0) return "qitems";
  if ((input.missions ?? []).length > 0) return "mission";
  if ((input.slices ?? []).length > 0) return "slice";
  return "rig";
}

function hasSelection(input: QueueExportScopeInput): boolean {
  return Boolean(
    input.wholeHost ||
      (input.rigs ?? []).length > 0 ||
      (input.missions ?? []).length > 0 ||
      (input.slices ?? []).length > 0 ||
      (input.qitemIds ?? []).length > 0,
  );
}

function matchesSelection(row: QueueItemSqlRow, input: QueueExportScopeInput): boolean {
  if (input.wholeHost) return true;
  const rigs = input.rigs ?? [];
  if (rigs.length > 0) {
    const sourceRig = sessionRig(row.source_session);
    const destinationRig = sessionRig(row.destination_session);
    if (rigs.some((rig) => rig === sourceRig || rig === destinationRig)) return true;
  }
  const tags = splitTags(row.tags);
  if ((input.missions ?? []).some((mission) => tags.includes(`mission:${mission}`))) return true;
  if ((input.slices ?? []).some((slice) => tags.includes(`slice:${slice}`))) return true;
  if ((input.qitemIds ?? []).includes(row.qitem_id)) return true;
  return false;
}

interface TransitionSqlRow {
  transition_id: number;
  qitem_id: string;
  ts: string;
  state: string;
  transition_note: string | null;
  actor_session: string | null;
  identity_provenance: string | null;
  identity_principal: string | null;
  owner_notification_kind: string | null;
  owner_notification_level: string | null;
  closure_reason: string | null;
  closure_target: string | null;
  archived_at?: string | null;
}

function toTransition(row: TransitionSqlRow): TransferTransition {
  return {
    transitionId: row.transition_id,
    qitemId: row.qitem_id,
    ts: row.ts,
    state: row.state,
    transitionNote: row.transition_note,
    actorSession: row.actor_session,
    identityProvenance: row.identity_provenance,
    identityPrincipal: row.identity_principal,
    ownerNotificationKind: row.owner_notification_kind,
    ownerNotificationLevel: row.owner_notification_level,
    closureReason: row.closure_reason,
    closureTarget: row.closure_target,
  };
}

function orderTransitions<T extends TransferTransition>(transitions: T[]): T[] {
  return [...transitions].sort(
    (left, right) => left.ts.localeCompare(right.ts) || left.transitionId - right.transitionId,
  );
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function rowsFor<T>(db: Database.Database, sql: string, ids: readonly string[]): T[] {
  if (ids.length === 0) return [];
  return db.prepare(sql).all(...ids) as T[];
}

function migrationHead(db: Database.Database): string | null {
  const row = db
    .prepare("SELECT name FROM schema_migrations ORDER BY applied_at DESC, name DESC LIMIT 1")
    .get() as { name: string } | undefined;
  return row?.name ?? null;
}

/**
 * Build one `openrig.queue-transfer/v2` archive from live queue history. SELECTs only: it acquires
 * no claim, mutates no row, writes no ownership and enqueues no wake (§11, D-M1.9).
 */
export function exportQueueArchive(
  db: Database.Database,
  input: QueueExportScopeInput,
  options: QueueExportOptions = {},
): QueueExportResult {
  if (!hasSelection(input)) throw new QueueTransferScopeError();

  const now = options.now ?? (() => new Date());
  const selectionShownAt = now().toISOString();
  const selfHost = new SelfHostIdentityStore(db).get();
  if (!selfHost || !selfHost.hostId) {
    throw new QueueTransferRefusal(
      "origin_identity_missing",
      "cannot export: this daemon's self-host identity has no host id",
    );
  }

  const kind = resolveKind(input);
  const includeClosed = input.includeClosed ?? (kind === "host" || kind === "rig");
  const rigs = input.rigs ?? [];
  const missions = input.missions ?? [];
  const slices = input.slices ?? [];
  const qitemIds = input.qitemIds ?? [];

  const allRows = db.prepare("SELECT * FROM queue_items").all() as QueueItemSqlRow[];
  const selected = allRows
    .filter((row) => matchesSelection(row, input))
    .filter((row) => includeClosed || !TERMINAL_STATES.has(asString(row.state)))
    .sort((left, right) => left.qitem_id.localeCompare(right.qitem_id));
  const ids = selected.map((row) => row.qitem_id);

  const transitions = orderTransitions(
    rowsFor<TransitionSqlRow>(
      db,
      `SELECT * FROM queue_transitions WHERE qitem_id IN (${placeholders(ids)})`,
      ids,
    ).map(toTransition),
  );
  const archivedTransitions = orderTransitions(
    rowsFor<TransitionSqlRow>(
      db,
      `SELECT * FROM queue_transitions_archive WHERE qitem_id IN (${placeholders(ids)})`,
      ids,
    ).map((row) => ({ ...toTransition(row), archivedAt: row.archived_at ?? null }) as TransferArchivedTransition),
  );
  const wakes = rowsFor<{
    transition_id: number;
    qitem_id: string;
    phase: string;
    wake_kind: string;
    wake_ref: string | null;
    delivery_status: string | null;
  }>(db, `SELECT * FROM queue_transition_wakes WHERE qitem_id IN (${placeholders(ids)})`, ids)
    .map<TransferWake>((row) => ({
      transitionId: row.transition_id,
      qitemId: row.qitem_id,
      phase: row.phase,
      wakeKind: row.wake_kind,
      wakeRef: row.wake_ref,
      deliveryStatus: row.delivery_status ?? "",
    }))
    .sort((left, right) => left.transitionId - right.transitionId);
  const actions = rowsFor<{
    action_id: string;
    action_verb: string;
    qitem_id: string | null;
    actor_session: string | null;
    identity_provenance: string | null;
    acted_at: string;
    before_state_json: string | null;
    after_state_json: string | null;
    reason: string | null;
    annotation: string | null;
    notify_attempted: number | null;
    notify_result: string | null;
    audit_notes_json: string | null;
  }>(db, `SELECT * FROM mission_control_actions WHERE qitem_id IN (${placeholders(ids)})`, ids)
    .map<TransferMissionControlAction>((row) => ({
      actionId: row.action_id,
      actionVerb: row.action_verb,
      qitemId: row.qitem_id,
      actorSession: row.actor_session,
      identityProvenance: row.identity_provenance,
      actedAt: row.acted_at,
      beforeStateJson: row.before_state_json,
      afterStateJson: row.after_state_json,
      reason: row.reason,
      annotation: row.annotation,
      notifyAttempted: typeof row.notify_attempted === "number" ? row.notify_attempted : null,
      notifyResult: row.notify_result,
      auditNotesJson: row.audit_notes_json,
    }))
    .sort((left, right) => left.actionId.localeCompare(right.actionId));

  const erasureIds = rowsFor<{ qitem_id: string; erased_at: string; reason: string | null }>(
    db,
    `SELECT * FROM queue_erased_ids WHERE qitem_id IN (${placeholders(ids)})`,
    ids,
  );
  const erasureByItem = new Map(erasureIds.map((row) => [row.qitem_id, row]));
  const selectedRigs = new Set(rigs);
  const erasedRigs = (db.prepare("SELECT * FROM queue_erased_rigs").all() as Array<{
    rig_id: string;
    rig_name: string;
    members_digest: string | null;
    verified_at: string | null;
    completed_at: string | null;
  }>)
    .filter((row) => kind === "host" || selectedRigs.has(row.rig_name) || selectedRigs.has(row.rig_id))
    .map((row) => ({
      rigId: row.rig_id,
      rigName: row.rig_name,
      membersDigest: row.members_digest,
      verifiedAt: row.verified_at,
      completedAt: row.completed_at,
    }));

  const rows = selected.map<TransferRow>((source) => {
    const row = {} as TransferRow;
    for (const [column, field] of Object.entries(QUEUE_ITEM_FIELD)) {
      (row as unknown as Record<string, unknown>)[field] = source[column];
    }
    row.transitions = transitions.filter((transition) => transition.qitemId === row.qitemId);
    row.archivedTransitions = archivedTransitions.filter((transition) => transition.qitemId === row.qitemId);
    row.wakes = wakes.filter((wake) => wake.qitemId === row.qitemId);
    row.missionControlActions = actions.filter((action) => action.qitemId === row.qitemId);
    const erasure = erasureByItem.get(row.qitemId);
    row.erasure = erasure ? { erasedAt: erasure.erased_at, reason: erasure.reason } : null;
    return row;
  });

  const counts = {
    total: rows.length,
    open: rows.filter((row) => !TERMINAL_STATES.has(asString(row.state))).length,
    terminal: rows.filter((row) => TERMINAL_STATES.has(asString(row.state))).length,
    erased: rows.filter((row) => row.contentErasedAt !== null).length,
  };

  const envelopeBase = {
    format: QUEUE_TRANSFER_FORMAT,
    transferId: `xfer-${randomBytes(8).toString("hex")}`,
    createdAt: selectionShownAt,
    origin: {
      hostId: selfHost.hostId,
      mintedAt: selfHost.mintedAt,
      generation: null,
      openrigVersion: getDaemonVersion(),
      schemaMigration: migrationHead(db),
    },
    scope: {
      kind,
      rigs,
      missions,
      slices,
      qitemIds,
      includeClosed,
      selectionShownAt,
    },
    rows,
    erasure: { ids: erasureIds.map((row) => ({ qitemId: row.qitem_id, erasedAt: row.erased_at, reason: row.reason })), rigs: erasedRigs },
  };
  const envelope: TransferArchiveEnvelope = {
    ...envelopeBase,
    digest: {
      algorithm: "sha256",
      value: computeArchiveDigest(envelopeBase),
      coverage: QUEUE_TRANSFER_FORMAT,
    },
  };
  const text = canonicalJson(envelope);
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes >= maxBytes) {
    throw new QueueTransferRefusal(
      "archive_too_large",
      `archive is ${bytes} bytes, at or above the ${maxBytes}-byte bound (archive_too_large)`,
      { bytes, maxBytes },
    );
  }

  return {
    envelope,
    text,
    selection: {
      kind,
      rigs,
      missions,
      slices,
      qitemIds,
      includeClosed,
      selectionShownAt,
      counts,
    },
  };
}
