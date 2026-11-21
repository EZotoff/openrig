import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import {
  QUEUE_TRANSFER_FORMAT,
  computeArchiveDigest,
  type TransferArchiveEnvelope,
} from "../src/domain/queue-transfer-archive.js";
import { QueueStagingRepository } from "../src/domain/queue-staging-repository.js";

function fullDb(): Database.Database {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  return db;
}

function envelope(transferId = "xfer-one", qitemId = "qitem-a"): TransferArchiveEnvelope {
  const base = {
    format: QUEUE_TRANSFER_FORMAT,
    transferId,
    createdAt: "2026-11-21T00:00:00.000Z",
    origin: {
      hostId: "origin-host",
      mintedAt: "2026-01-01T00:00:00.000Z",
      generation: null,
      openrigVersion: "0.7.1",
      schemaMigration: "180_queue_transfer_staged.sql",
    },
    scope: {
      kind: "qitems" as const,
      rigs: [],
      missions: [],
      slices: [],
      qitemIds: [qitemId],
      includeClosed: true,
      selectionShownAt: "2026-11-21T00:00:00.000Z",
    },
    rows: [],
    erasure: { ids: [], rigs: [] },
    digest: { algorithm: "sha256" as const, value: "", coverage: QUEUE_TRANSFER_FORMAT },
  };
  return { ...base, digest: { ...base.digest, value: computeArchiveDigest(base) } };
}

const report = { status: "not_ready_for_activation", warnings: [] };

describe("queue staging repository", () => {
  it("migration 180 creates queue_transfer_staged on a fresh full schema", () => {
    const db = fullDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name)).toContain("queue_transfer_staged");
  });

  it("stages one immutable envelope with a durable manifest", () => {
    const db = fullDb();
    const repo = new QueueStagingRepository(db);
    const archive = envelope();
    const { record, alreadyStaged } = repo.stage(archive, report);

    expect(alreadyStaged).toBe(false);
    expect(record.importId).toMatch(/^xfer-import-/);
    expect(record.status).toBe("staged");
    expect(record.format).toBe(QUEUE_TRANSFER_FORMAT);
    expect(record.digest).toBe(archive.digest.value);
    expect(record.originHostId).toBe("origin-host");
    expect(record.originMintedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(record.rowCount).toBe(0);
    expect(JSON.parse(record.envelopeJson)).toEqual(archive);
    expect(JSON.parse(record.reportJson)).toMatchObject({ status: "not_ready_for_activation" });

    expect(repo.findByKey("origin-host", "2026-01-01T00:00:00.000Z", archive.digest.value)?.importId).toBe(
      record.importId,
    );
    expect(repo.get(record.importId)?.digest).toBe(archive.digest.value);
    expect(repo.list().map((entry) => entry.importId)).toEqual([record.importId]);
  });

  it("is idempotent by (origin host, origin minted at, digest)", () => {
    const db = fullDb();
    const repo = new QueueStagingRepository(db);
    const archive = envelope();
    const first = repo.stage(archive, report);
    const second = repo.stage(archive, report);
    expect(second.alreadyStaged).toBe(true);
    expect(second.record.importId).toBe(first.record.importId);
    expect(repo.list()).toHaveLength(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n).toBe(0);
  });

  it("discard marks the record without touching the envelope, and a re-import restages fresh", () => {
    const db = fullDb();
    const repo = new QueueStagingRepository(db);
    const archive = envelope();
    const staged = repo.stage(archive, report);

    expect(repo.discard(staged.record.importId)).toBe(true);
    const discarded = repo.get(staged.record.importId)!;
    expect(discarded.status).toBe("discarded");
    expect(discarded.envelopeJson).toBe(staged.record.envelopeJson);
    expect(repo.discard("xfer-import-missing")).toBe(false);

    const restaged = repo.stage(archive, report);
    expect(restaged.alreadyStaged).toBe(false);
    expect(restaged.record.importId).not.toBe(staged.record.importId);
    expect(restaged.record.status).toBe("staged");
    expect(repo.list()).toHaveLength(1);
    expect(restaged.record.envelopeJson).toBe(staged.record.envelopeJson);
  });

  it("recomputes the digest from the stored envelope and verifies it", () => {
    const db = fullDb();
    const repo = new QueueStagingRepository(db);
    const archive = envelope();
    const staged = repo.stage(archive, report);
    expect(repo.recomputeDigestAndVerify(staged.record.importId)).toBe(true);
    expect(repo.recomputeDigestAndVerify("xfer-import-missing")).toBe(false);

    db.prepare("UPDATE queue_transfer_staged SET envelope_json = ? WHERE import_id = ?").run(
      JSON.stringify({ ...archive, transferId: "xfer-tampered" }),
      staged.record.importId,
    );
    expect(repo.recomputeDigestAndVerify(staged.record.importId)).toBe(false);
  });
});
