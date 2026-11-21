import { isAbsolute, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import { readAllowlistFromEnv, type AllowlistRoot } from "./files/path-safety.js";
import { SelfHostIdentityStore } from "./seat-identity-store.js";
import { parseSessionName } from "./session-name.js";
import {
  QueueTransferRefusal,
  computeArchiveDigest,
  parseEnvelope,
  type TransferArchiveEnvelope,
  type TransferRow,
} from "./queue-transfer-archive.js";
import { DEFAULT_MAX_ARCHIVE_BYTES } from "./queue-transfer-export.js";
import { QueueStagingRepository, type StagedTransferRecord } from "./queue-staging-repository.js";

/**
 * Import validation, dry run and durable staging for `openrig.queue-transfer/v2` (milestone 1).
 *
 * Refusals stop both a dry run and a stage (§8). Warnings — missing evidence, an outside reference,
 * an unresolved address, and the unconditional `not_ready_for_activation` — are recorded and never
 * stop anything (D8). A dry run writes nothing; a stage writes only the staging record, never live
 * queue rows (D-M1.2).
 */

const TERMINAL_STATES = new Set(["done", "failed", "denied", "canceled", "handed-off"]);
const QITEM_SHAPE = /^(qitem-[A-Za-z0-9._-]+)/;

export type QueueImportWarningCode =
  | "not_ready_for_activation"
  | "unresolved_rig"
  | "unresolved_seat"
  | "missing_evidence"
  | "dangling_reference";

export interface QueueImportWarning {
  code: QueueImportWarningCode;
  message: string;
  qitemId?: string;
  ref?: string;
}

export interface QueueImportCounts {
  total: number;
  /** pending rows: runnable once M2 activation projects them. */
  wouldBecomeRunnable: number;
  /** in-progress rows: runnable after activation projection (M2); their old claim is history. */
  inProgress: number;
  blocked: number;
  terminal: number;
  erased: number;
}

export interface QueueImportReport {
  status: "not_ready_for_activation";
  dryRun: boolean;
  /** null on a dry run. */
  importId: string | null;
  alreadyStaged: boolean;
  digest: string;
  format: string;
  origin: { hostId: string; mintedAt: string };
  counts: QueueImportCounts;
  warnings: QueueImportWarning[];
  stagedAt: string | null;
}

export interface QueueImportOptions {
  dryRun?: boolean;
  maxBytes?: number;
  /** Shared evidence roots; defaults to OPENRIG_FILES_ALLOWLIST. */
  allowlist?: AllowlistRoot[];
}

function countRows(rows: readonly TransferRow[]): QueueImportCounts {
  return {
    total: rows.length,
    wouldBecomeRunnable: rows.filter((row) => row.state === "pending").length,
    inProgress: rows.filter((row) => row.state === "in-progress").length,
    blocked: rows.filter((row) => row.state === "blocked").length,
    terminal: rows.filter((row) => TERMINAL_STATES.has(row.state)).length,
    erased: rows.filter((row) => row.contentErasedAt !== null).length,
  };
}

function referenceQitemId(value: string | null): string | null {
  if (!value) return null;
  const match = QITEM_SHAPE.exec(value.trim());
  return match ? match[1]! : null;
}

function insideAnyRoot(candidate: string, roots: readonly AllowlistRoot[]): boolean {
  if (!isAbsolute(candidate)) return false;
  const resolved = resolve(candidate);
  return roots.some(
    (root) => resolved === root.canonicalPath || resolved.startsWith(`${root.canonicalPath}${sep}`),
  );
}

function localRigTokens(db: Database.Database): Set<string> {
  const rows = db.prepare("SELECT id, name FROM rigs").all() as Array<{ id: string; name: string }>;
  return new Set(rows.flatMap((row) => [row.id, row.name]));
}

function collectWarnings(
  db: Database.Database,
  envelope: TransferArchiveEnvelope,
  allowlist: readonly AllowlistRoot[],
): QueueImportWarning[] {
  const warnings: QueueImportWarning[] = [
    {
      code: "not_ready_for_activation",
      message: "no authorization exists yet: this import is staged and inactive (not ready for activation)",
    },
  ];
  const rigs = localRigTokens(db);
  const selfHostId = new SelfHostIdentityStore(db).get()?.hostId ?? null;
  const resolvesRig = (rig: string) => rigs.has(rig) || rig === selfHostId;

  for (const rig of envelope.scope.rigs) {
    if (!resolvesRig(rig)) {
      warnings.push({ code: "unresolved_rig", message: `rig ${rig} does not resolve on this daemon`, ref: rig });
    }
  }

  const selected = new Set(envelope.rows.map((row) => row.qitemId));
  for (const row of envelope.rows) {
    for (const address of [row.sourceSession, row.destinationSession]) {
      const parsed = parseSessionName(address);
      if (parsed.kind === "canonical" && !resolvesRig(parsed.rig)) {
        warnings.push({
          code: "unresolved_seat",
          message: `seat address ${address} does not resolve on this daemon (preserved verbatim)`,
          qitemId: row.qitemId,
          ref: address,
        });
      } else if (parsed.kind === "malformed") {
        warnings.push({
          code: "unresolved_seat",
          message: `seat address ${address} is malformed (preserved verbatim)`,
          qitemId: row.qitemId,
          ref: address,
        });
      }
    }

    if (row.evidenceRef && !insideAnyRoot(row.evidenceRef, allowlist)) {
      warnings.push({
        code: "missing_evidence",
        message: `evidence ref ${row.evidenceRef} is outside every shared root`,
        qitemId: row.qitemId,
        ref: row.evidenceRef,
      });
    }

    const references: Array<[string, string | null]> = [
      ["blocked_on", row.blockedOn],
      ["reply_to", row.replyTo],
      ["handed_off_from", row.handedOffFrom],
      ["closure_target", row.closureTarget],
    ];
    for (const [field, value] of references) {
      const referenced = referenceQitemId(value);
      if (referenced && !selected.has(referenced)) {
        warnings.push({
          code: "dangling_reference",
          message: `${field} names ${referenced}, which is outside this selection (preserved verbatim)`,
          qitemId: row.qitemId,
          ref: referenced,
        });
      }
    }
  }
  return warnings;
}

function preStageReport(
  envelope: TransferArchiveEnvelope,
  counts: QueueImportCounts,
  warnings: QueueImportWarning[],
): object {
  return {
    status: "not_ready_for_activation",
    dryRun: false,
    digest: envelope.digest.value,
    format: envelope.format,
    origin: { hostId: envelope.origin.hostId, mintedAt: envelope.origin.mintedAt },
    counts,
    warnings,
  };
}

function reportOf(
  record: StagedTransferRecord,
  counts: QueueImportCounts,
  warnings: QueueImportWarning[],
  alreadyStaged: boolean,
): QueueImportReport {
  return {
    status: "not_ready_for_activation",
    dryRun: false,
    importId: record.importId,
    alreadyStaged,
    digest: record.digest,
    format: record.format,
    origin: { hostId: record.originHostId, mintedAt: record.originMintedAt },
    counts,
    warnings,
    stagedAt: record.stagedAt,
  };
}

/**
 * Validate an archive and, unless `dryRun`, stage it durably. Refusals throw
 * `QueueTransferRefusal`; nothing is written before every refusal has passed.
 */
export function importQueueArchive(
  db: Database.Database,
  text: string,
  options: QueueImportOptions = {},
): QueueImportReport {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes >= maxBytes) {
    throw new QueueTransferRefusal(
      "archive_too_large",
      `archive is ${bytes} bytes, at or above the ${maxBytes}-byte bound (archive_too_large)`,
      { bytes, maxBytes },
    );
  }

  const envelope = parseEnvelope(text);
  if (!envelope.digest.value || envelope.digest.value !== computeArchiveDigest(envelope)) {
    throw new QueueTransferRefusal("digest_mismatch", "archive digest does not match its content");
  }
  if (!envelope.origin.hostId) {
    throw new QueueTransferRefusal("origin_identity_missing", "archive names no origin host id");
  }
  if (!envelope.scope.selectionShownAt) {
    throw new QueueTransferRefusal("selection_not_shown", "archive has no scope.selectionShownAt");
  }

  const ids = envelope.rows.map((row) => row.qitemId);
  if (ids.length > 0) {
    const clashes = db
      .prepare(`SELECT qitem_id FROM queue_items WHERE qitem_id IN (${ids.map(() => "?").join(", ")})`)
      .all(...ids) as Array<{ qitem_id: string }>;
    if (clashes.length > 0) {
      throw new QueueTransferRefusal(
        "qitem_id_collision",
        `incoming qitem ids already exist as live local rows: ${clashes.map((row) => row.qitem_id).join(", ")}`,
        { qitemIds: clashes.map((row) => row.qitem_id) },
      );
    }
  }

  const counts = countRows(envelope.rows);
  const warnings = collectWarnings(db, envelope, options.allowlist ?? readAllowlistFromEnv());

  if (options.dryRun) {
    return {
      status: "not_ready_for_activation",
      dryRun: true,
      importId: null,
      alreadyStaged: false,
      digest: envelope.digest.value,
      format: envelope.format,
      origin: { hostId: envelope.origin.hostId, mintedAt: envelope.origin.mintedAt },
      counts,
      warnings,
      stagedAt: null,
    };
  }

  const repository = new QueueStagingRepository(db);
  const staged = repository.stage(envelope, preStageReport(envelope, counts, warnings));
  return reportOf(staged.record, counts, warnings, staged.alreadyStaged);
}
