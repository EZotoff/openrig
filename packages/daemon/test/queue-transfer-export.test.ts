import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import {
  QUEUE_ITEM_ARCHIVE_FIELDS,
  parseEnvelope,
  QueueTransferRefusal,
} from "../src/domain/queue-transfer-archive.js";
import {
  DEFAULT_MAX_ARCHIVE_BYTES,
  exportQueueArchive,
  QueueTransferScopeError,
} from "../src/domain/queue-transfer-export.js";

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

interface SeedRow {
  qitemId: string;
  source?: string;
  destination?: string;
  state?: string;
  body?: string;
  tags?: string | null;
  [column: string]: unknown;
}

function insertRow(db: Database.Database, input: SeedRow): void {
  const row: Record<string, unknown> = {
    qitem_id: input.qitemId,
    ts_created: "2026-11-20T00:00:00.000Z",
    ts_updated: "2026-11-20T00:00:00.000Z",
    source_session: input.source ?? "src@rig-a",
    destination_session: input.destination ?? "dst@rig-a",
    state: input.state ?? "pending",
    priority: "routine",
    body: input.body ?? `body of ${input.qitemId}`,
    tags: input.tags ?? null,
    ...input,
  };
  delete row.qitemId;
  delete row.source;
  delete row.destination;
  for (const [key, value] of Object.entries(input)) {
    if (["qitemId", "source", "destination", "state", "body"].includes(key)) continue;
    row[key] = value;
  }
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO queue_items (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...columns.map((column) => row[column]));
}

function insertTransition(
  db: Database.Database,
  input: { id: number; qitemId: string; ts: string; state?: string; note?: string | null },
): void {
  db.prepare(
    `INSERT INTO queue_transitions (transition_id, qitem_id, ts, state, transition_note, actor_session,
       identity_provenance, identity_principal, owner_notification_kind, owner_notification_level)
     VALUES (?, ?, ?, ?, ?, 'actor@rig-a', 'claimed:v1', 'principal:v1', 'wake', 'summary')`,
  ).run(input.id, input.qitemId, input.ts, input.state ?? "pending", input.note ?? null);
}

const DUMP_TABLES = [
  "queue_items",
  "queue_transitions",
  "queue_transitions_archive",
  "queue_transition_wakes",
  "mission_control_actions",
  "queue_erased_ids",
  "queue_erased_rigs",
  "self_host_identity",
] as const;

function dumpTables(db: Database.Database): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const table of DUMP_TABLES) out[table] = db.prepare(`SELECT * FROM ${table}`).all();
  return out;
}

function exportAll(db: Database.Database, input: Parameters<typeof exportQueueArchive>[1]) {
  return exportQueueArchive(db, input, { now: () => new Date(NOW) });
}

describe("queue transfer export — explicit scope and row assembly", () => {
  it("requires an explicit scope and names the flags", () => {
    const db = fullDb();
    seedIdentity(db);
    expect(() => exportAll(db, {})).toThrowError(QueueTransferScopeError);
    try {
      exportAll(db, {});
    } catch (error) {
      expect((error as Error).message).toMatch(/--whole-host/);
      expect((error as Error).message).toMatch(/--rig/);
      return;
    }
    throw new Error("expected selection_required");
  });

  it("selects exactly the requested rows for every scope kind", () => {
    const db = fullDb();
    seedIdentity(db);
    insertRow(db, { qitemId: "qitem-host", source: "s@rig-a", destination: "d@rig-a" });
    insertRow(db, { qitemId: "qitem-rig-b", source: "s@rig-b", destination: "d@rig-b" });
    insertRow(db, { qitemId: "qitem-mission", tags: "mission:m1,slice:s1" });
    insertRow(db, { qitemId: "qitem-slice", tags: "slice:s2" });
    insertRow(db, { qitemId: "qitem-terminal", state: "done" });

    const ids = (input: Parameters<typeof exportQueueArchive>[1]) =>
      exportAll(db, input).envelope.rows.map((row) => row.qitemId).sort();

    expect(ids({ wholeHost: true })).toEqual([
      "qitem-host",
      "qitem-mission",
      "qitem-rig-b",
      "qitem-slice",
      "qitem-terminal",
    ]);
    expect(ids({ rigs: ["rig-a"] })).toEqual(["qitem-host", "qitem-mission", "qitem-slice", "qitem-terminal"]);
    expect(ids({ missions: ["m1"] })).toEqual(["qitem-mission"]);
    expect(ids({ slices: ["s2"] })).toEqual(["qitem-slice"]);
    expect(ids({ qitemIds: ["qitem-rig-b", "qitem-host"] })).toEqual(["qitem-host", "qitem-rig-b"]);
  });

  it("shows the selection explicitly with open/terminal/erased counts and a shown-at stamp", () => {
    const db = fullDb();
    seedIdentity(db);
    insertRow(db, { qitemId: "qitem-open" });
    insertRow(db, { qitemId: "qitem-blocked", state: "blocked" });
    insertRow(db, { qitemId: "qitem-done", state: "done" });
    insertRow(db, { qitemId: "qitem-erased", body: "", content_erased_at: "2026-11-20T10:00:00.000Z" });

    const result = exportAll(db, { wholeHost: true });
    expect(result.envelope.scope.kind).toBe("host");
    expect(result.envelope.scope.selectionShownAt).toBe(NOW);
    expect(result.envelope.scope.includeClosed).toBe(true);
    expect(result.selection.counts).toEqual({ total: 4, open: 3, terminal: 1, erased: 1 });
    expect(result.selection.includeClosed).toBe(true);
  });

  it("defaults includeClosed to true for host/rig scopes and false for narrower scopes", () => {
    const db = fullDb();
    seedIdentity(db);
    insertRow(db, { qitemId: "qitem-open" });
    insertRow(db, { qitemId: "qitem-done", state: "done", tags: "mission:m1" });

    expect(exportAll(db, { wholeHost: true }).envelope.scope.includeClosed).toBe(true);
    expect(exportAll(db, { rigs: ["rig-a"] }).envelope.scope.includeClosed).toBe(true);
    expect(exportAll(db, { missions: ["m1"] }).envelope.scope.includeClosed).toBe(false);
    expect(exportAll(db, { missions: ["m1"] }).envelope.scope.includeClosed).toBe(false);
    expect(
      exportAll(db, { missions: ["m1"], includeClosed: true }).envelope.rows.map((row) => row.qitemId),
    ).toEqual(["qitem-done"]);
  });

  it("exports every §3 queue_items column, including the late ones", () => {
    const db = fullDb();
    seedIdentity(db);
    insertRow(db, {
      qitemId: "qitem-full",
      return_route: "human@external",
      return_route_basis: "issued",
      delegated_decision: "approved",
      content_erased_at: "2026-11-20T10:00:00.000Z",
      human_questions: "[]",
      human_answers: "[]",
      reply_to: "qitem-earlier",
      last_nudge_input_box: "input-box",
      minting_generation_uuid: "gen-mint",
      claimed_by_generation_uuid: "gen-claim",
    });
    const row = exportAll(db, { qitemIds: ["qitem-full"] }).envelope.rows[0]!;
    for (const field of QUEUE_ITEM_ARCHIVE_FIELDS) expect(row).toHaveProperty(field);
    expect(row.returnRoute).toBe("human@external");
    expect(row.returnRouteBasis).toBe("issued");
    expect(row.delegatedDecision).toBe("approved");
    expect(row.contentErasedAt).toBe("2026-11-20T10:00:00.000Z");
    expect(row.humanQuestions).toBe("[]");
    expect(row.humanAnswers).toBe("[]");
    expect(row.replyTo).toBe("qitem-earlier");
    expect(row.lastNudgeInputBox).toBe("input-box");
  });

  it("carries live and archived transitions, wake evidence and mission-control action ids as history", () => {
    const db = fullDb();
    seedIdentity(db);
    insertRow(db, { qitemId: "qitem-hist" });
    insertTransition(db, { id: 3, qitemId: "qitem-hist", ts: "2026-11-20T02:00:00.000Z", state: "in-progress" });
    insertTransition(db, { id: 1, qitemId: "qitem-hist", ts: "2026-11-20T00:00:00.000Z", state: "pending" });
    insertTransition(db, { id: 2, qitemId: "qitem-hist", ts: "2026-11-20T02:00:00.000Z", state: "blocked" });
    db.prepare(
      `INSERT INTO queue_transitions_archive (transition_id, qitem_id, ts, state, transition_note, actor_session,
         archived_at, identity_provenance, identity_principal, owner_notification_kind, owner_notification_level)
       VALUES (9, 'qitem-hist', '2026-11-19T00:00:00.000Z', 'pending', 'old', 'actor@rig-a', '2026-11-20T03:00:00.000Z',
         'claimed:v1', 'principal:v1', 'wake', 'summary')`,
    ).run();
    db.prepare(
      `INSERT INTO queue_transition_wakes (transition_id, qitem_id, phase, wake_kind, wake_ref, delivery_status)
       VALUES (2, 'qitem-hist', 'armed', 'timer', 'wake-ref', 'pending')`,
    ).run();
    db.prepare(
      `INSERT INTO mission_control_actions (action_id, action_verb, qitem_id, actor_session, acted_at,
         identity_provenance, before_state_json, after_state_json, notify_attempted, audit_notes_json)
       VALUES ('mc-1', 'resolve', 'qitem-hist', 'actor@rig-a', '2026-11-20T02:05:00.000Z', 'claimed:v1', '{}', '{}', 0, '{}')`,
    ).run();

    const row = exportAll(db, { qitemIds: ["qitem-hist"] }).envelope.rows[0]!;
    expect(row.transitions.map((transition) => transition.transitionId)).toEqual([1, 2, 3]);
    expect(row.transitions[0]!.identityProvenance).toBe("claimed:v1");
    expect(row.transitions[0]!.identityPrincipal).toBe("principal:v1");
    expect(row.transitions[0]!.ownerNotificationKind).toBe("wake");
    expect(row.transitions[0]!.ownerNotificationLevel).toBe("summary");
    expect(row.archivedTransitions.map((transition) => transition.transitionId)).toEqual([9]);
    expect(row.archivedTransitions[0]!.archivedAt).toBe("2026-11-20T03:00:00.000Z");
    expect(row.wakes.map((wake) => wake.transitionId)).toEqual([2]);
    expect(row.missionControlActions.map((action) => action.actionId)).toEqual(["mc-1"]);
    expect(row.missionControlActions[0]!.identityProvenance).toBe("claimed:v1");
  });

  it("does not export outbox entries or inbox check-ins", () => {
    const db = fullDb();
    seedIdentity(db);
    insertRow(db, { qitemId: "qitem-x" });
    db.prepare(
      `INSERT INTO outbox_entries (outbox_id, sender_session, destination_session, body, tags, urgency, ts_dispatched)
       VALUES ('out-1', 'a@rig-a', 'b@rig-a', 'body', NULL, 'routine', '2026-11-20T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO queue_inbox_checkins (session, checked_at) VALUES ('b@rig-a', '2026-11-20T00:00:00.000Z')`,
    ).run();
    const text = exportAll(db, { wholeHost: true }).text;
    expect(text).not.toContain("outbox");
    expect(text).not.toContain("checkin");
    const parsed = parseEnvelope(text);
    expect(parsed.rows.map((row) => row.qitemId)).toEqual(["qitem-x"]);
  });

  it("exports an erased row's marker with empty content", () => {
    const db = fullDb();
    seedIdentity(db);
    insertRow(db, { qitemId: "qitem-erased", body: "", content_erased_at: "2026-11-20T10:00:00.000Z" });
    db.prepare(
      `INSERT INTO queue_erased_ids (qitem_id, erased_at, reason) VALUES ('qitem-erased', '2026-11-20T10:00:00.000Z', 'operator')`,
    ).run();
    const result = exportAll(db, { wholeHost: true });
    const row = result.envelope.rows[0]!;
    expect(row.body).toBe("");
    expect(row.contentErasedAt).toBe("2026-11-20T10:00:00.000Z");
    expect(row.erasure).toEqual({ erasedAt: "2026-11-20T10:00:00.000Z", reason: "operator" });
    expect(result.envelope.erasure.ids).toHaveLength(1);
  });

  it("is passive: no queue table changes and unrelated live work still claims", () => {
    const db = fullDb();
    seedIdentity(db);
    insertRow(db, { qitemId: "qitem-exported" });
    insertRow(db, { qitemId: "qitem-free", destination: "free@rig-a" });
    insertTransition(db, { id: 1, qitemId: "qitem-exported", ts: "2026-11-20T00:00:00.000Z" });
    const before = JSON.stringify(dumpTables(db));

    exportAll(db, { wholeHost: true });

    expect(JSON.stringify(dumpTables(db))).toBe(before);
    const repo = new QueueRepository(db, new EventBus(db));
    const claimed = repo.claim({ qitemId: "qitem-free", destinationSession: "free@rig-a" });
    expect(claimed.state).toBe("in-progress");
    expect(claimed.claimedAt).not.toBeNull();
  });

  it("refuses an export when the origin self-host identity is missing", () => {
    const db = fullDb();
    insertRow(db, { qitemId: "qitem-x" });
    expect(() => exportAll(db, { wholeHost: true })).toThrowError(QueueTransferRefusal);
    try {
      exportAll(db, { wholeHost: true });
    } catch (error) {
      expect((error as QueueTransferRefusal).code).toBe("origin_identity_missing");
      return;
    }
    throw new Error("expected origin_identity_missing");
  });

  it("refuses an archive at or above the size cap and names the bound", () => {
    const db = fullDb();
    seedIdentity(db);
    insertRow(db, { qitemId: "qitem-big", body: "x".repeat(2048) });
    expect(DEFAULT_MAX_ARCHIVE_BYTES).toBe(256 * 1024 * 1024);
    expect(() => exportAll(db, { wholeHost: true, maxBytes: 512 })).toThrowError(QueueTransferRefusal);
    try {
      exportAll(db, { wholeHost: true, maxBytes: 512 });
    } catch (error) {
      expect((error as QueueTransferRefusal).code).toBe("archive_too_large");
      expect((error as Error).message).toContain("512");
      expect((error as QueueTransferRefusal).details).toMatchObject({ maxBytes: 512 });
    }
    expect(exportAll(db, { wholeHost: true, maxBytes: 64 * 1024 }).text.length).toBeGreaterThan(512);
  });
});
