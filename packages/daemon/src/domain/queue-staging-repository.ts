import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import {
  computeArchiveDigest,
  parseEnvelope,
  type TransferArchiveEnvelope,
} from "./queue-transfer-archive.js";

/**
 * Durable staging store for `openrig.queue-transfer/v2` archives.
 *
 * Rows live only here: never in `queue_items`, never read by a scheduler, sweep, list or pickup query.
 * The envelope is immutable after insert; the only mutable manifest facts are status (staged →
 * discarded) and, on an explicit restage after discard, a fresh import id. Idempotency key is
 * `(origin_host_id, origin_minted_at, digest)` (contract §10).
 */

export type StagedTransferStatus = "staged" | "discarded" | "rejected";

export interface StagedTransferRecord {
  importId: string;
  stagedAt: string;
  format: string;
  digest: string;
  originHostId: string;
  originMintedAt: string;
  originGeneration: number | null;
  originOpenrigVersion: string | null;
  scopeJson: string;
  rowCount: number;
  status: StagedTransferStatus;
  envelopeJson: string;
  reportJson: string;
}

interface StagedTransferSqlRow {
  import_id: string;
  staged_at: string;
  format: string;
  digest: string;
  origin_host_id: string;
  origin_minted_at: string;
  origin_generation: number | null;
  origin_openrig_version: string | null;
  scope_json: string;
  row_count: number;
  status: StagedTransferStatus;
  envelope_json: string;
  report_json: string;
}

function toRecord(row: StagedTransferSqlRow): StagedTransferRecord {
  return {
    importId: row.import_id,
    stagedAt: row.staged_at,
    format: row.format,
    digest: row.digest,
    originHostId: row.origin_host_id,
    originMintedAt: row.origin_minted_at,
    originGeneration: row.origin_generation,
    originOpenrigVersion: row.origin_openrig_version,
    scopeJson: row.scope_json,
    rowCount: row.row_count,
    status: row.status,
    envelopeJson: row.envelope_json,
    reportJson: row.report_json,
  };
}

export function newImportId(): string {
  return `xfer-import-${randomBytes(8).toString("hex")}`;
}

export interface StageResult {
  record: StagedTransferRecord;
  /** True when this exact `(origin host, origin minted at, digest)` was already staged. */
  alreadyStaged: boolean;
}

export class QueueStagingRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Stage one archive. Re-staging the same key returns the existing record; a discarded record is
   * restaged under a fresh import id, keeping its immutable envelope.
   */
  stage(envelope: TransferArchiveEnvelope, report: unknown): StageResult {
    const existing = this.findByKey(envelope.origin.hostId, envelope.origin.mintedAt, envelope.digest.value);
    const stagedAt = new Date().toISOString();
    const reportJson = JSON.stringify(report ?? {});
    const scopeJson = JSON.stringify(envelope.scope);
    if (existing) {
      if (existing.status !== "discarded") return { record: existing, alreadyStaged: true };
      const importId = newImportId();
      this.db
        .prepare(
          `UPDATE queue_transfer_staged
             SET import_id = ?, staged_at = ?, scope_json = ?, row_count = ?, status = 'staged',
                 report_json = ?, origin_generation = ?, origin_openrig_version = ?
           WHERE import_id = ?`,
        )
        .run(
          importId,
          stagedAt,
          scopeJson,
          envelope.rows.length,
          reportJson,
          envelope.origin.generation,
          envelope.origin.openrigVersion,
          existing.importId,
        );
      return { record: this.get(importId)!, alreadyStaged: false };
    }

    const importId = newImportId();
    this.db
      .prepare(
        `INSERT INTO queue_transfer_staged
           (import_id, staged_at, format, digest, origin_host_id, origin_minted_at, origin_generation,
            origin_openrig_version, scope_json, row_count, status, envelope_json, report_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, ?)`,
      )
      .run(
        importId,
        stagedAt,
        envelope.format,
        envelope.digest.value,
        envelope.origin.hostId,
        envelope.origin.mintedAt,
        envelope.origin.generation,
        envelope.origin.openrigVersion,
        scopeJson,
        envelope.rows.length,
        JSON.stringify(envelope),
        reportJson,
      );
    return { record: this.get(importId)!, alreadyStaged: false };
  }

  findByKey(originHostId: string, originMintedAt: string, digest: string): StagedTransferRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM queue_transfer_staged
          WHERE origin_host_id = ? AND origin_minted_at = ? AND digest = ?`,
      )
      .get(originHostId, originMintedAt, digest) as StagedTransferSqlRow | undefined;
    return row ? toRecord(row) : null;
  }

  get(importId: string): StagedTransferRecord | null {
    const row = this.db
      .prepare("SELECT * FROM queue_transfer_staged WHERE import_id = ?")
      .get(importId) as StagedTransferSqlRow | undefined;
    return row ? toRecord(row) : null;
  }

  list(): StagedTransferRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM queue_transfer_staged ORDER BY staged_at DESC, import_id")
      .all() as StagedTransferSqlRow[];
    return rows.map(toRecord);
  }

  /** Explicit discard: status only; the envelope is retained (contract §15 custody). */
  discard(importId: string): boolean {
    const result = this.db
      .prepare("UPDATE queue_transfer_staged SET status = 'discarded' WHERE import_id = ? AND status = 'staged'")
      .run(importId);
    return result.changes > 0;
  }

  /** Recompute the digest from the stored envelope and compare it with the manifest. */
  recomputeDigestAndVerify(importId: string): boolean {
    const record = this.get(importId);
    if (!record) return false;
    try {
      return computeArchiveDigest(parseEnvelope(record.envelopeJson)) === record.digest;
    } catch {
      return false;
    }
  }
}
