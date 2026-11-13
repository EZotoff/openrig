import { expect, it } from "vitest";
import { fixture } from "./seat-reaper-fixture.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatReaperService } from "../src/domain/seat-reaper-service.js";

it.each([false, true])("uses the real checked stop and lifecycle lease (uncertain=%s)", async uncertain => {
  // Given real lifecycle/guard/adapter services, with only OS terminal effects replaced.
  const f = fixture(); let killed = false;
  const commands: string[] = [];
  const tmux = new TmuxAdapter(async command => {
    commands.push(command);
    if (command.includes("has-session")) return "";
    if (command.includes("list-panes")) return "%1|0|/fixture|120|40|1";
    if (command.includes("show-environment")) return "OPENRIG_NODE_ID=a";
    // The guarded if-shell wraps its fallback in display-message, so match the effect
    // commands first and only then the plain probes.
    if (command.includes("kill-session")) {
      expect(f.events().at(-1)).toMatchObject({ phase: "capture", sessionId: "s" });
      if (uncertain) throw Error("kill interrupted");
      killed = true; return "";
    }
    if (command.includes("detach-client")) return "";
    if (command.startsWith("tmux display-message")) return "$7|4242|1700000000";
    throw Error(`unexpected command ${command}`);
  });
  const guard = new SeatDeliveryGuard(f.db, name => resolveGuardTarget(f.db, name)); tmux.deliveryGuard = guard;
  const lifecycle = new SeatLifecycleService({ db: f.db, rigRepo: new RigRepository(f.db), sessionRegistry: new SessionRegistry(f.db), eventBus: f.bus, tmuxAdapter: tmux });
  let at = 0;
  const service = new SeatReaperService({ ...f.deps, guard, lifecycle, now: () => at });
  // When the eligible seat reaches its threshold under the real guard.
  for (let i = 0; i <= 60; i++) { at += 60_000; await service.tick(); }
  // Then only the reviewed tmux session is targeted, and effects match the receipt.
  // Upstream kills through a conditional if-shell that re-verifies the reviewed pane's
  // session id + pid + start time atomically, so the whole command is the receipt.
  const kills = commands.filter(command => command.includes("kill-session"));
  expect(kills).toHaveLength(1);
  expect(kills[0]).toContain("if-shell");
  expect(kills[0]).toContain("$7");
  expect(kills[0]).toContain("1700000000");
  expect(killed).toBe(!uncertain);
  expect(f.events()).toContainEqual(expect.objectContaining({ phase: "effect", budgetConsumed: true,
    result: expect.objectContaining(uncertain ? { ok: false, code: "stop_uncertain" } : { ok: true }) }));
  if (!uncertain) {
    expect(f.db.prepare("SELECT status,intentionally_stopped FROM sessions WHERE id='s'").get()).toEqual({ status: "exited", intentionally_stopped: 1 });
    expect(f.bus.replayAll(0)).toContainEqual(expect.objectContaining({ type: "session.stopped", reason: "idle_reap", operator: "daemon:seat-reaper" }));
  } else {
    expect(f.db.prepare("SELECT startup_status FROM sessions WHERE id='s'").get()).toEqual({ startup_status: "attention_required" });
  }
});
