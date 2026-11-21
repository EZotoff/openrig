import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { eraseQueue } from "../src/domain/queue-erasure.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { exportQueueArchive } from "../src/domain/queue-transfer-export.js";
import { importQueueArchive } from "../src/domain/queue-transfer-import.js";
import { QueueStagingRepository } from "../src/domain/queue-staging-repository.js";

const NOW = "2026-11-21T12:00:00.000Z";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fullDb(file?: string): Database.Database {
  const db = createDb(file);
  migrate(db, ALL_MIGRATIONS);
  return db;
}

function seedIdentity(db: Database.Database): void {
  db.prepare(
    "INSERT INTO self_host_identity (singleton, host_id, minted_at, reconciled_at) VALUES (1, 'origin-host', ?, ?)",
  ).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
}

function insertRow(
  db: Database.Database,
  row: { qitemId: string; state?: string; destination?: string; [column: string]: unknown },
): void {
  const values: Record<string, unknown> = {
    qitem_id: row.qitemId,
    ts_created: "2026-11-20T00:00:00.000Z",
    ts_updated: "2026-11-20T00:00:00.000Z",
    source_session: "src@rig-a",
    destination_session: row.destination ?? "dst@rig-a",
    state: row.state ?? "pending",
    priority: "routine",
    body: `body of ${row.qitemId}`,
    ...row,
  };
  delete values.qitemId;
  delete values.destination;
  const columns = Object.keys(values);
  db.prepare(`INSERT INTO queue_items (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
    ...columns.map((column) => values[column]),
  );
}

function archiveFrom(seed: (db: Database.Database) => void): string {
  const db = fullDb();
  seedIdentity(db);
  seed(db);
  return exportQueueArchive(db, { wholeHost: true }, { now: () => new Date(NOW) }).text;
}

function dumpExceptStaging(db: Database.Database): string {
  const tables = [
    "queue_items",
    "queue_transitions",
    "queue_transition_wakes",
    "mission_control_actions",
    "queue_erased_ids",
    "queue_erased_rigs",
  ];
  return JSON.stringify(Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()])));
}

describe("queue transfer staging semantics", () => {
  it("stages once for the same file: one record, no live rows, already_staged reported", () => {
    const text = archiveFrom((db) => insertRow(db, { qitemId: "qitem-a" }));
    const db = fullDb();
    const first = importQueueArchive(db, text);
    const second = importQueueArchive(db, text);
    expect(first.alreadyStaged).toBe(false);
    expect(second.alreadyStaged).toBe(true);
    expect(second.importId).toBe(first.importId);
    expect(new QueueStagingRepository(db).list()).toHaveLength(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n).toBe(0);
  });

  it("survives restart and stays invisible to the scheduler and claims", () => {
    const dir = mkdtempSync(join(tmpdir(), "openrig-staging-"));
    tempDirs.push(dir);
    const path = join(dir, "daemon.db");
    const text = archiveFrom((db) => insertRow(db, { qitemId: "qitem-staged" }));

    const first = fullDb(path);
    const staged = importQueueArchive(first, text);
    first.close();

    const reopened = fullDb(path);
    try {
      const record = new QueueStagingRepository(reopened).get(staged.importId!)!;
      expect(record.status).toBe("staged");
      const repo = new QueueRepository(reopened, new EventBus(reopened));
      expect(repo.list()).toEqual([]);
      expect((reopened.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n).toBe(0);
      expect(() => repo.claim({ qitemId: "qitem-staged", destinationSession: "dst@rig-a" })).toThrowError(/not found/);
    } finally {
      reopened.close();
    }
  });

  it("discard marks the record, keeps the envelope and writes no ownership", () => {
    const text = archiveFrom((db) => insertRow(db, { qitemId: "qitem-a" }));
    const db = fullDb();
    const imported = importQueueArchive(db, text);
    const repo = new QueueStagingRepository(db);
    const before = dumpExceptStaging(db);
    expect(repo.discard(imported.importId!)).toBe(true);
    const record = repo.get(imported.importId!)!;
    expect(record.status).toBe("discarded");
    expect(JSON.parse(record.envelopeJson).digest.value).toBe(record.digest);
    expect(dumpExceptStaging(db)).toBe(before);
  });

  it("keeps unrelated live work running through export and staging, and erase still works", async () => {
    const source = fullDb();
    seedIdentity(source);
    insertRow(source, { qitemId: "qitem-transferred", destination: "dst@rig-a" });
    insertRow(source, { qitemId: "qitem-unrelated", destination: "other@rig-a" });
    const text = exportQueueArchive(source, { wholeHost: true }, { now: () => new Date(NOW) }).text;

    const destination = fullDb();
    importQueueArchive(destination, text);
    expect(new QueueStagingRepository(destination).list()).toHaveLength(1);

    const sourceRepo = new QueueRepository(source, new EventBus(source));
    expect(sourceRepo.claim({ qitemId: "qitem-unrelated", destinationSession: "other@rig-a" }).state).toBe("in-progress");

    // `rig queue erase` is unchanged and unaware of staging: an unrelated live row still erases.
    const erased = await eraseQueue(source, {
      scope: { kind: "ids", entries: [{ qitemId: "qitem-unrelated", action: "delete" }] },
      apply: true,
      nowIso: NOW,
    });
    expect(erased.ok).toBe(true);
    expect(source.prepare("SELECT qitem_id FROM queue_items WHERE qitem_id = 'qitem-unrelated'").get()).toBeUndefined();
    const stagedErase = await eraseQueue(source, {
      scope: { kind: "ids", entries: [{ qitemId: "qitem-staged", action: "delete" }] },
      apply: true,
      nowIso: NOW,
    });
    expect(stagedErase.qitems).toEqual([]);
    expect(new QueueStagingRepository(source).list()).toHaveLength(0);
  });
});
