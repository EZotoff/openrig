import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import {
  QueueTransferRefusal,
  computeArchiveDigest,
  parseEnvelope,
} from "../src/domain/queue-transfer-archive.js";
import { exportQueueArchive } from "../src/domain/queue-transfer-export.js";
import { importQueueArchive, type QueueImportReport } from "../src/domain/queue-transfer-import.js";
import { QueueStagingRepository } from "../src/domain/queue-staging-repository.js";

const NOW = "2026-11-21T12:00:00.000Z";

function fullDb(): Database.Database {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  return db;
}

function seedIdentity(db: Database.Database, hostId = "origin-host"): void {
  db.prepare(
    "INSERT INTO self_host_identity (singleton, host_id, minted_at, reconciled_at) VALUES (1, ?, ?, ?)",
  ).run(hostId, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
}

function insertRow(db: Database.Database, row: { qitemId: string; [column: string]: unknown }): void {
  const values: Record<string, unknown> = {
    qitem_id: row.qitemId,
    ts_created: "2026-11-20T00:00:00.000Z",
    ts_updated: "2026-11-20T00:00:00.000Z",
    source_session: row.source ?? "src@rig-a",
    destination_session: row.destination ?? "dst@rig-a",
    state: "pending",
    priority: "routine",
    body: `body of ${row.qitemId}`,
    ...row,
  };
  delete values.qitemId;
  delete values.source;
  delete values.destination;
  const columns = Object.keys(values);
  db.prepare(`INSERT INTO queue_items (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
    ...columns.map((column) => values[column]),
  );
}

function sourceArchive(seed: (db: Database.Database) => void, scope: Parameters<typeof exportQueueArchive>[1] = { wholeHost: true }): string {
  const db = fullDb();
  seedIdentity(db);
  seed(db);
  return exportQueueArchive(db, scope, { now: () => new Date(NOW) }).text;
}

function withDigest(text: string, mutate: (envelope: ReturnType<typeof parseEnvelope>) => unknown): string {
  const envelope = parseEnvelope(text);
  const next = mutate(envelope);
  const content = next as Record<string, unknown>;
  const { digest: _old, ...rest } = content;
  (rest as { digest?: unknown }).digest = {
    algorithm: "sha256",
    value: computeArchiveDigest(rest),
    coverage: "openrig.queue-transfer/v2",
  };
  return JSON.stringify(rest);
}

function dumpTables(db: Database.Database): string {
  const tables = [
    "queue_items",
    "queue_transitions",
    "queue_transition_wakes",
    "mission_control_actions",
    "queue_erased_ids",
    "queue_erased_rigs",
    "queue_transfer_staged",
  ];
  return JSON.stringify(Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()])));
}

describe("queue transfer import — validation and dry run", () => {
  it("refuses a digest mismatch and stages nothing", () => {
    const text = sourceArchive((db) => insertRow(db, { qitemId: "qitem-a" }));
    const envelope = parseEnvelope(text);
    envelope.rows[0]!.body = "tampered";
    const tampered = JSON.stringify(envelope);
    const db = fullDb();
    expect(() => importQueueArchive(db, tampered)).toThrowError(QueueTransferRefusal);
    try {
      importQueueArchive(db, tampered);
    } catch (error) {
      expect((error as QueueTransferRefusal).code).toBe("digest_mismatch");
    }
    expect(new QueueStagingRepository(db).list()).toHaveLength(0);
  });

  it("refuses an unknown format major before staging", () => {
    const text = sourceArchive((db) => insertRow(db, { qitemId: "qitem-a" }));
    const envelope = JSON.parse(text) as Record<string, unknown>;
    envelope.format = "openrig.queue-transfer/v3";
    const db = fullDb();
    try {
      importQueueArchive(db, JSON.stringify(envelope));
      throw new Error("expected format_unsupported");
    } catch (error) {
      expect((error as QueueTransferRefusal).code).toBe("format_unsupported");
    }
    expect(new QueueStagingRepository(db).list()).toHaveLength(0);
  });

  it("ignores unknown optional properties and stages cleanly", () => {
    const text = sourceArchive((db) => insertRow(db, { qitemId: "qitem-a" }));
    const envelope = JSON.parse(text) as Record<string, unknown>;
    envelope.futureTopLevel = { anything: true };
    const db = fullDb();
    const report = importQueueArchive(db, JSON.stringify(envelope));
    expect(report.status).toBe("not_ready_for_activation");
    expect(report.importId).toBeTruthy();
    expect(new QueueStagingRepository(db).get(report.importId!)).not.toBeNull();
  });

  it("treats missing evidence and an outside reference as warnings, never refusals", () => {
    const text = sourceArchive((db) => {
      insertRow(db, {
        qitemId: "qitem-a",
        evidence_ref: "/outside/every/root/evidence.md",
        blocked_on: "qitem-outside-selection",
      });
    });
    const db = fullDb();
    const report = importQueueArchive(db, text, { allowlist: [{ name: "root", canonicalPath: "/tmp/allowed-root" }] });
    const codes = report.warnings.map((warning) => warning.code);
    expect(codes).toContain("missing_evidence");
    expect(codes).toContain("dangling_reference");
    expect(report.importId).toBeTruthy();
    expect(new QueueStagingRepository(db).get(report.importId!)).not.toBeNull();
  });

  it("warns on unresolved rig and seat addresses while preserving them verbatim", () => {
    const text = sourceArchive(
      (db) => insertRow(db, { qitemId: "qitem-ghost", source: "src@ghost-rig", destination: "dst@ghost-rig" }),
      { rigs: ["ghost-rig"], includeClosed: true },
    );
    const db = fullDb();
    const report = importQueueArchive(db, text);
    expect(report.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["unresolved_rig", "unresolved_seat"]),
    );
    const record = new QueueStagingRepository(db).get(report.importId!)!;
    const envelope = parseEnvelope(record.envelopeJson);
    expect(envelope.rows[0]!.sourceSession).toBe("src@ghost-rig");
    expect(envelope.rows[0]!.destinationSession).toBe("dst@ghost-rig");
  });

  it("resolves a rig that exists locally", () => {
    const text = sourceArchive((db) => insertRow(db, { qitemId: "qitem-a" }), { rigs: ["rig-a"], includeClosed: true });
    const db = fullDb();
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'rig-a')").run();
    const report = importQueueArchive(db, text);
    expect(report.warnings.map((warning) => warning.code)).not.toContain("unresolved_rig");
    expect(report.warnings.map((warning) => warning.code)).not.toContain("unresolved_seat");
  });

  it("refuses an envelope without a shown selection and one without origin identity", () => {
    const text = sourceArchive((db) => insertRow(db, { qitemId: "qitem-a" }));
    const noSelection = withDigest(text, (envelope) => {
      delete (envelope.scope as { selectionShownAt?: string }).selectionShownAt;
      return envelope;
    });
    const noOrigin = withDigest(text, (envelope) => {
      envelope.origin.hostId = "";
      return envelope;
    });
    const db = fullDb();
    try {
      importQueueArchive(db, noSelection);
      throw new Error("expected selection_not_shown");
    } catch (error) {
      expect((error as QueueTransferRefusal).code).toBe("selection_not_shown");
    }
    try {
      importQueueArchive(db, noOrigin);
      throw new Error("expected origin_identity_missing");
    } catch (error) {
      expect((error as QueueTransferRefusal).code).toBe("origin_identity_missing");
    }
  });

  it("refuses an incoming qitem id that already exists as a live local row", () => {
    const text = sourceArchive((db) => insertRow(db, { qitemId: "qitem-clash" }));
    const db = fullDb();
    insertRow(db, { qitemId: "qitem-clash" });
    try {
      importQueueArchive(db, text);
      throw new Error("expected qitem_id_collision");
    } catch (error) {
      expect((error as QueueTransferRefusal).code).toBe("qitem_id_collision");
    }
  });

  it("reports not_ready_for_activation on every unbound import and dry run", () => {
    const text = sourceArchive((db) => insertRow(db, { qitemId: "qitem-a" }));
    const db = fullDb();
    const dry = importQueueArchive(db, text, { dryRun: true });
    const staged = importQueueArchive(db, text);
    expect(dry.status).toBe("not_ready_for_activation");
    expect(staged.status).toBe("not_ready_for_activation");
    expect(dry.warnings.map((warning) => warning.code)).toContain("not_ready_for_activation");
    expect(staged.warnings.map((warning) => warning.code)).toContain("not_ready_for_activation");
  });

  it("a dry run writes nothing and reports runnable, terminal and erased counts", () => {
    const text = sourceArchive((db) => {
      insertRow(db, { qitemId: "qitem-open" });
      insertRow(db, { qitemId: "qitem-done", state: "done" });
      insertRow(db, { qitemId: "qitem-erased", body: "", content_erased_at: "2026-11-20T10:00:00.000Z" });
    });
    const db = fullDb();
    const before = dumpTables(db);
    const report: QueueImportReport = importQueueArchive(db, text, { dryRun: true });
    expect(report.counts).toEqual({ total: 3, wouldBecomeRunnable: 2, inProgress: 0, blocked: 0, terminal: 1, erased: 1 });
    expect(report.importId).toBeNull();
    expect(dumpTables(db)).toBe(before);
  });

  it("refuses an envelope above the archive bound", () => {
    const text = sourceArchive((db) => insertRow(db, { qitemId: "qitem-big", body: "x".repeat(4096) }));
    const db = fullDb();
    try {
      importQueueArchive(db, text, { maxBytes: 256 });
      throw new Error("expected archive_too_large");
    } catch (error) {
      expect((error as QueueTransferRefusal).code).toBe("archive_too_large");
      expect((error as Error).message).toContain("256");
    }
  });
});
