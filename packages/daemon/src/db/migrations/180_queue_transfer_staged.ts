import type { Migration } from "../migrate.js";

/**
 * Queue transfer milestone 1 — durable, inactive staging of one validated archive.
 *
 * One table holds the contract's "immutable envelope plus a durable manifest" (D1): the archive JSON
 * verbatim, and the manifest columns an operator lists/discards without parsing it. No scheduler,
 * sweep, list or pickup query reads this table; activation code does not exist in milestone 1 (D-M1.2).
 *
 * Numbering is coordination only: upstream renumbers this migration at merge time if 180/181 is
 * already taken — the file name and the table name are the stable contract.
 */
export const queueTransferStagedSchema: Migration = {
  name: "180_queue_transfer_staged.sql",
  sql: `
    CREATE TABLE queue_transfer_staged (
      import_id TEXT PRIMARY KEY,
      staged_at TEXT NOT NULL,
      format TEXT NOT NULL,
      digest TEXT NOT NULL,
      origin_host_id TEXT NOT NULL,
      origin_minted_at TEXT NOT NULL,
      origin_generation INTEGER,
      origin_openrig_version TEXT,
      scope_json TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('staged', 'discarded', 'rejected')),
      envelope_json TEXT NOT NULL,
      report_json TEXT NOT NULL,
      UNIQUE (origin_host_id, origin_minted_at, digest)
    );
  `,
};
