import { createHash } from "node:crypto";

/**
 * Queue transfer archive (`openrig.queue-transfer/v2`) — milestone 1 shape.
 *
 * This module owns the immutable document's encoding only: canonical JSON (keys sorted
 * recursively, no insignificant whitespace), the content digest (sha256 over the canonical
 * serialization with the top-level `digest` member removed), and a parser that ignores unknown
 * optional properties anywhere in the envelope (the v1/v2 "only grows" rule,
 * docs/reference/bundle-formats.md). Numbers and strings are plain JSON.stringify primitives;
 * nothing here re-invents JSON encoding beyond sorting keys and dropping whitespace.
 */

export const QUEUE_TRANSFER_FORMAT = "openrig.queue-transfer/v2" as const;

export type QueueTransferRefusalCode =
  | "format_unsupported"
  | "digest_mismatch"
  | "origin_identity_missing"
  | "selection_not_shown"
  | "archive_too_large"
  | "qitem_id_collision";

/** A refusal stops a stage and a dry run alike; warnings never do. */
export class QueueTransferRefusal extends Error {
  constructor(
    public readonly code: QueueTransferRefusalCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "QueueTransferRefusal";
  }
}

export type TransferScopeKind = "host" | "rig" | "mission" | "slice" | "qitems";

export interface TransferScope {
  kind: TransferScopeKind;
  rigs: string[];
  missions: string[];
  slices: string[];
  qitemIds: string[];
  includeClosed: boolean;
  /** Omitted only when the document itself omits it (so a re-parse keeps the original digest). */
  selectionShownAt?: string;
}

export interface TransferOrigin {
  hostId: string;
  mintedAt: string;
  generation: number | null;
  openrigVersion: string;
  schemaMigration: string | null;
}

export interface TransferTransition {
  transitionId: number;
  qitemId: string;
  ts: string;
  state: string;
  transitionNote: string | null;
  actorSession: string | null;
  identityProvenance: string | null;
  identityPrincipal: string | null;
  ownerNotificationKind: string | null;
  ownerNotificationLevel: string | null;
  closureReason: string | null;
  closureTarget: string | null;
}

export interface TransferArchivedTransition extends TransferTransition {
  archivedAt: string | null;
}

export interface TransferWake {
  transitionId: number;
  qitemId: string;
  phase: string;
  wakeKind: string;
  wakeRef: string | null;
  deliveryStatus: string;
}

export interface TransferMissionControlAction {
  actionId: string;
  actionVerb: string;
  qitemId: string | null;
  actorSession: string | null;
  identityProvenance: string | null;
  actedAt: string;
  beforeStateJson: string | null;
  afterStateJson: string | null;
  reason: string | null;
  annotation: string | null;
  notifyAttempted: number | null;
  notifyResult: string | null;
  auditNotesJson: string | null;
}

export interface TransferRowErasure {
  erasedAt: string;
  reason: string | null;
}

/**
 * Every `queue_items` column in contract §3 (38), camelCased, plus the row's source history:
 * live + archived transitions, wake evidence, mission-control actions and its erasure marker.
 */
export interface TransferRow {
  qitemId: string;
  tsCreated: string;
  tsUpdated: string;
  sourceSession: string;
  destinationSession: string;
  state: string;
  priority: string;
  tier: string | null;
  tags: string | null;
  blockedOn: string | null;
  handedOffTo: string | null;
  handedOffFrom: string | null;
  expiresAt: string | null;
  chainOfRecord: string | null;
  body: string;
  closureReason: string | null;
  closureTarget: string | null;
  closureRequiredAt: string | null;
  claimedAt: string | null;
  lastNudgeAttempt: string | null;
  lastNudgeResult: string | null;
  lastHeartbeat: string | null;
  resolution: string | null;
  targetRepo: string | null;
  summary: string | null;
  evidenceRef: string | null;
  mintingGenerationUuid: string | null;
  claimedByGenerationUuid: string | null;
  humanIntent: string | null;
  humanDetail: string | null;
  replyTo: string | null;
  humanQuestions: string | null;
  humanAnswers: string | null;
  lastNudgeInputBox: string | null;
  delegatedDecision: string | null;
  contentErasedAt: string | null;
  returnRoute: string | null;
  returnRouteBasis: string | null;
  transitions: TransferTransition[];
  archivedTransitions: TransferArchivedTransition[];
  wakes: TransferWake[];
  missionControlActions: TransferMissionControlAction[];
  erasure: TransferRowErasure | null;
}

export interface TransferArchiveEnvelope {
  format: typeof QUEUE_TRANSFER_FORMAT;
  transferId: string;
  createdAt: string;
  origin: TransferOrigin;
  scope: TransferScope;
  rows: TransferRow[];
  erasure: {
    ids: Array<{ qitemId: string; erasedAt: string; reason: string | null }>;
    rigs: Array<{ rigId: string; rigName: string; membersDigest: string | null; verifiedAt: string | null; completedAt: string | null }>;
  };
  digest: { algorithm: "sha256"; value: string; coverage: typeof QUEUE_TRANSFER_FORMAT };
}

/** The `queue_items` fields in archive order; also the parser's known-key whitelist. */
export const QUEUE_ITEM_ARCHIVE_FIELDS = [
  "qitemId",
  "tsCreated",
  "tsUpdated",
  "sourceSession",
  "destinationSession",
  "state",
  "priority",
  "tier",
  "tags",
  "blockedOn",
  "handedOffTo",
  "handedOffFrom",
  "expiresAt",
  "chainOfRecord",
  "body",
  "closureReason",
  "closureTarget",
  "closureRequiredAt",
  "claimedAt",
  "lastNudgeAttempt",
  "lastNudgeResult",
  "lastHeartbeat",
  "resolution",
  "targetRepo",
  "summary",
  "evidenceRef",
  "mintingGenerationUuid",
  "claimedByGenerationUuid",
  "humanIntent",
  "humanDetail",
  "replyTo",
  "humanQuestions",
  "humanAnswers",
  "lastNudgeInputBox",
  "delegatedDecision",
  "contentErasedAt",
  "returnRoute",
  "returnRouteBasis",
] as const;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const member = source[key];
      if (member !== undefined) out[key] = canonicalize(member);
    }
    return out;
  }
  return value;
}

/** Canonical JSON: UTF-8, recursively sorted keys, no insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** sha256 hex over the canonical envelope with its top-level `digest` member removed. */
export function computeArchiveDigest(envelope: unknown): string {
  const { digest: _digest, ...content } = envelope as Record<string, unknown>;
  return createHash("sha256").update(canonicalJson(content), "utf8").digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Copy only known keys, dropping every unknown optional property (the parser's tolerance). */
function pickKnown(source: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = asRecord(source);
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  return out;
}

const TRANSITION_FIELDS = [
  "transitionId",
  "qitemId",
  "ts",
  "state",
  "transitionNote",
  "actorSession",
  "identityProvenance",
  "identityPrincipal",
  "ownerNotificationKind",
  "ownerNotificationLevel",
  "closureReason",
  "closureTarget",
] as const;

const WAKE_FIELDS = ["transitionId", "qitemId", "phase", "wakeKind", "wakeRef", "deliveryStatus"] as const;

const MISSION_CONTROL_FIELDS = [
  "actionId",
  "actionVerb",
  "qitemId",
  "actorSession",
  "identityProvenance",
  "actedAt",
  "beforeStateJson",
  "afterStateJson",
  "reason",
  "annotation",
  "notifyAttempted",
  "notifyResult",
  "auditNotesJson",
] as const;

function parseRow(value: unknown): TransferRow {
  const source = asRecord(value);
  const row = pickKnown(source, QUEUE_ITEM_ARCHIVE_FIELDS) as unknown as TransferRow;
  row.transitions = Array.isArray(source.transitions)
    ? source.transitions.map((entry) => pickKnown(entry, TRANSITION_FIELDS) as unknown as TransferTransition)
    : [];
  row.archivedTransitions = Array.isArray(source.archivedTransitions)
    ? source.archivedTransitions.map(
        (entry) => pickKnown(entry, [...TRANSITION_FIELDS, "archivedAt"]) as unknown as TransferArchivedTransition,
      )
    : [];
  row.wakes = Array.isArray(source.wakes)
    ? source.wakes.map((entry) => pickKnown(entry, WAKE_FIELDS) as unknown as TransferWake)
    : [];
  row.missionControlActions = Array.isArray(source.missionControlActions)
    ? source.missionControlActions.map(
        (entry) => pickKnown(entry, MISSION_CONTROL_FIELDS) as unknown as TransferMissionControlAction,
      )
    : [];
  const erasure = source.erasure;
  row.erasure =
    erasure === null || erasure === undefined
      ? null
      : {
          erasedAt: str(asRecord(erasure).erasedAt),
          reason: nullableStr(asRecord(erasure).reason),
        };
  return row;
}

function parseOrigin(value: unknown): TransferOrigin {
  const source = asRecord(value);
  return {
    hostId: str(source.hostId),
    mintedAt: str(source.mintedAt),
    generation: numOrNull(source.generation),
    openrigVersion: str(source.openrigVersion),
    schemaMigration: nullableStr(source.schemaMigration),
  };
}

function parseScope(value: unknown): TransferScope {
  const source = asRecord(value);
  const kinds: TransferScopeKind[] = ["host", "rig", "mission", "slice", "qitems"];
  const kind = kinds.find((candidate) => candidate === source.kind) ?? "qitems";
  return {
    kind,
    rigs: stringArray(source.rigs),
    missions: stringArray(source.missions),
    slices: stringArray(source.slices),
    qitemIds: stringArray(source.qitemIds),
    includeClosed: source.includeClosed === true,
    ...(typeof source.selectionShownAt === "string" ? { selectionShownAt: source.selectionShownAt } : {}),
  };
}

/**
 * Parse an archive text as `openrig.queue-transfer/v2`, ignoring unknown optional properties.
 * A missing or different `format` is `format_unsupported`, refused before any other check.
 */
export function parseEnvelope(text: string): TransferArchiveEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new QueueTransferRefusal("format_unsupported", "archive is not valid JSON");
  }
  const source = asRecord(raw);
  if (source.format !== QUEUE_TRANSFER_FORMAT) {
    throw new QueueTransferRefusal(
      "format_unsupported",
      `archive format ${JSON.stringify(source.format)} is not ${QUEUE_TRANSFER_FORMAT}`,
      { format: source.format },
    );
  }
  const erasure = asRecord(source.erasure);
  const digest = asRecord(source.digest);
  return {
    format: QUEUE_TRANSFER_FORMAT,
    transferId: str(source.transferId),
    createdAt: str(source.createdAt),
    origin: parseOrigin(source.origin),
    scope: parseScope(source.scope),
    rows: Array.isArray(source.rows) ? source.rows.map(parseRow) : [],
    erasure: {
      ids: Array.isArray(erasure.ids)
        ? erasure.ids.map((entry) => {
            const record = asRecord(entry);
            return { qitemId: str(record.qitemId), erasedAt: str(record.erasedAt), reason: nullableStr(record.reason) };
          })
        : [],
      rigs: Array.isArray(erasure.rigs)
        ? erasure.rigs.map((entry) => {
            const record = asRecord(entry);
            return {
              rigId: str(record.rigId),
              rigName: str(record.rigName),
              membersDigest: nullableStr(record.membersDigest),
              verifiedAt: nullableStr(record.verifiedAt),
              completedAt: nullableStr(record.completedAt),
            };
          })
        : [],
    },
    digest: {
      algorithm: "sha256",
      value: str(digest.value),
      coverage: QUEUE_TRANSFER_FORMAT,
    },
  };
}
