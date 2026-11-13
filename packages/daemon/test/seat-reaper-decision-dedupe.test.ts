import { expect, it } from "vitest";
import { fixture } from "./seat-reaper-fixture.js";

// Review finding (slice 2): a decision event per seat per tick flooded the events
// ledger (~72k rows/day on a 50-seat fleet). A seat's decision is recorded when it
// changes, and at most hourly while it stays the same; receipts are unaffected.

it("records an unchanged refusal once, not once per tick", async () => {
  // Given a seat that is refused for a stable reason (a pending queue item).
  const f = fixture();
  f.db.prepare("INSERT INTO queue_items(qitem_id, ts_created, ts_updated, source_session, destination_session, state, body) VALUES ('q','0','0','x','worker@test','pending','b')").run();
  // When the reaper ticks many times without the reason changing.
  for (let i = 0; i < 30; i++) await f.tick();
  // Then the ledger holds one decision, not thirty.
  const decisions = f.events().filter(event => event.phase === "decision");
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({ decision: "pending-work", nodeId: "a" });
});

it("records the new decision when the refusal reason changes", async () => {
  // Given a seat first refused for pending work, then for being busy.
  const f = fixture();
  f.db.prepare("INSERT INTO queue_items(qitem_id, ts_created, ts_updated, source_session, destination_session, state, body) VALUES ('q','0','0','x','worker@test','pending','b')").run();
  await f.tick();
  f.db.prepare("DELETE FROM queue_items").run();
  f.state.activity = "working";
  // When the reason changes.
  await f.tick();
  // Then both decisions are on record, in order.
  const decisions = f.events().filter(event => event.phase === "decision");
  expect(decisions.map(event => event.decision)).toEqual(["pending-work", "ineligible"]);
});

it("still records would-reap-observe for an eligible seat, once per unchanged state", async () => {
  const f = fixture();
  f.settings.observe = true;
  for (let i = 0; i < 70; i++) await f.tick();
  const decisions = f.events().filter(event => event.phase === "decision");
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({ decision: "would-reap-observe", idleMinutes: 60 });
  expect(f.stops).toHaveLength(0);
});

it("defers instead of holding the delivery lease when the workspace re-check overruns", async () => {
  // Given a reaper whose in-lease workspace probe never settles.
  const f = fixture();
  // The per-rig pass probe answers clean; only the in-lease re-check never settles.
  let probes = 0;
  // Ticks 1..61 answer clean (61 = the pass probe of the tick that reaches the threshold) (the clock is still maturing); from the first tick past the
  // threshold the probe never settles, so the in-lease re-check must hit its deadline.
  f.deps.workspaceProbe = () => (++probes <= 61 ? Promise.resolve("clean" as const) : new Promise<never>(() => {}));
  f.deps.workspaceRecheckDeadlineMs = 20;
  // When an eligible seat crosses its threshold and the re-check is attempted.
  for (let i = 0; i < 61; i++) await f.tick();
  // Then no stop is attempted and the pass is treated as an uncertain probe.
  expect(f.stops).toHaveLength(0);
  expect(f.events().some(event => event.phase === "decision" && event.decision === "defer-probe-failed")).toBe(true);
}, 30_000);
