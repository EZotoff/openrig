import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { fixture } from "./seat-reaper-fixture.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatReaperService } from "../src/domain/seat-reaper-service.js";

const exec = promisify(execFile);

it.each([false, true])("exercises real isolated tmux without an agent provider (observe=%s)", async observe => {
  // Given a private tmux server, real checked-stop services, and deterministic idle/capture inputs.
  const socket = `reaper-test-${randomUUID()}`;
  const run = async (...args: string[]) => (await exec("tmux", ["-L", socket, ...args], { timeout: 10_000 })).stdout;
  const pane = (await run("-f", "/dev/null", "new-session", "-d", "-s", "worker@test", "-P", "-F", "#{pane_id}", "sleep 300")).trim();
  // A sibling session keeps the server alive after the seat session is killed, so absence is a
  // positive tmux answer (transport_unavailable would mean the server, not just the seat, was gone).
  await run("new-session", "-d", "-s", "keeper", "sleep 300");
  try {
    const f = fixture(); f.settings.observe = observe;
    f.db.prepare("UPDATE bindings SET tmux_pane=?").run(pane);
    const tmux = new TmuxAdapter(async () => { throw Error("argv execution required"); }, undefined,
      async argv => {
        const [file, ...args] = argv;
        if (!file) throw Error("missing executable");
        return (await exec(file, args, { timeout: 10_000 })).stdout;
      }, ["-L", socket]);
    const guard = new SeatDeliveryGuard(f.db, name => resolveGuardTarget(f.db, name)); tmux.deliveryGuard = guard;
    const lifecycle = new SeatLifecycleService({ db: f.db, rigRepo: new RigRepository(f.db), sessionRegistry: new SessionRegistry(f.db), eventBus: f.bus, tmuxAdapter: tmux });
    let at = 0;
    const service = new SeatReaperService({ ...f.deps, guard, lifecycle, now: () => at });
    // When the reaper crosses the configured threshold.
    for (let i = 0; i <= 60; i++) { at += 60_000; await service.tick(); }
    // Then real process liveness matches observe/enforce, and durable seat history survives.
    expect((await tmux.probeSession("worker@test")).state).toBe(observe ? "present" : "absent");
    expect(f.db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 1 });
    expect(f.events().at(-1)).toMatchObject(observe ? { decision: "would-reap-observe" } : { phase: "effect", result: { ok: true } });
  } finally {
    try { await run("kill-server"); }
    catch (error) { if (!(error instanceof Error) || !error.message.includes("no server running")) throw error; }
  }
});
