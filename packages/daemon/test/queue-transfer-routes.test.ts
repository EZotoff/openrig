import { Hono } from "hono";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { queueRoutes } from "../src/routes/queue.js";

let db: Database.Database;
let app: Hono;

function buildApp(database: Database.Database): Hono {
  const instance = new Hono();
  instance.use("*", async (c, next) => {
    c.set("db" as never, database as never);
    await next();
  });
  instance.route("/api/queue", queueRoutes());
  return instance;
}

function insertRow(qitemId: string, state = "pending"): void {
  db.prepare(
    `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
     VALUES (?, '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z', 'src@rig-a', 'dst@rig-a', ?, 'routine', ?)`,
  ).run(qitemId, state, `body of ${qitemId}`);
}

async function post(path: string, body: unknown) {
  return app.request(`/api/queue${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  db = createDb();
  migrate(db, ALL_MIGRATIONS);
  db.prepare(
    "INSERT INTO self_host_identity (singleton, host_id, minted_at, reconciled_at) VALUES (1, 'origin-host', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
  ).run();
  app = buildApp(db);
});

describe("queue transfer routes", () => {
  it("exports a parseable archive and prints the selection", async () => {
    insertRow("qitem-a");
    insertRow("qitem-done", "done");
    const res = await post("/transfer/export", { wholeHost: true });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { archive: string; selection: { kind: string; includeClosed: boolean; counts: { total: number } } };
    expect(payload.selection.kind).toBe("host");
    expect(payload.selection.includeClosed).toBe(true);
    expect(payload.selection.counts.total).toBe(2);
    expect(JSON.parse(payload.archive).format).toBe("openrig.queue-transfer/v2");
  });

  it("returns selection_required when no scope is named", async () => {
    const res = await post("/transfer/export", {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("selection_required");
  });

  it("dry-runs, stages, lists and discards an import without live rows", async () => {
    insertRow("qitem-a");
    const exported = (await (await post("/transfer/export", { wholeHost: true })).json()) as { archive: string };
    db.prepare("DELETE FROM queue_items").run();

    const dry = await post("/transfer/import", { archive: exported.archive, dryRun: true });
    expect(dry.status).toBe(200);
    const dryReport = (await dry.json()) as { status: string; importId: string | null };
    expect(dryReport.status).toBe("not_ready_for_activation");
    expect(dryReport.importId).toBeNull();

    const staged = await post("/transfer/import", { archive: exported.archive });
    expect(staged.status).toBe(200);
    const report = (await staged.json()) as { status: string; importId: string };
    expect(report.status).toBe("not_ready_for_activation");
    expect(report.importId).toMatch(/^xfer-import-/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n).toBe(0);

    const listed = await app.request("/api/queue/transfer/staged");
    expect(listed.status).toBe(200);
    const records = ((await listed.json()) as { records: Array<{ importId: string }> }).records;
    expect(records.map((record) => record.importId)).toEqual([report.importId]);

    const discarded = await post("/transfer/staged/discard", { importId: report.importId });
    expect(discarded.status).toBe(200);
    expect(((await discarded.json()) as { discarded: boolean }).discarded).toBe(true);
    const again = await post("/transfer/staged/discard", { importId: report.importId });
    expect(again.status).toBe(404);
  });

  it("surfaces each refusal as a structured error", async () => {
    insertRow("qitem-a");
    const exported = (await (await post("/transfer/export", { wholeHost: true })).json()) as { archive: string };

    const badFormat = JSON.parse(exported.archive) as Record<string, unknown>;
    badFormat.format = "openrig.queue-transfer/v3";
    const formatRes = await post("/transfer/import", { archive: JSON.stringify(badFormat) });
    expect(formatRes.status).toBe(400);
    expect(((await formatRes.json()) as { error: string }).error).toBe("format_unsupported");

    const tampered = JSON.parse(exported.archive) as { rows: Array<{ body: string }> };
    tampered.rows[0]!.body = "tampered";
    const digestRes = await post("/transfer/import", { archive: JSON.stringify(tampered) });
    expect(digestRes.status).toBe(400);
    expect(((await digestRes.json()) as { error: string }).error).toBe("digest_mismatch");

    const collisionRes = await post("/transfer/import", { archive: exported.archive });
    expect(collisionRes.status).toBe(409);
    expect(((await collisionRes.json()) as { error: string }).error).toBe("qitem_id_collision");
  });
});
