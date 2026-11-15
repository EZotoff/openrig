// Repro for the 2026-11-15 fleet incident (ez-rig-config, docs/fleet/incident-20261115-slack-answer-loop.md):
// a seat re-served a person IDENTICAL standing state on every watchdog wake — a new person-facing
// "update" row whose summary said "unchanged since the last wake" and whose body re-carried the full
// directive blob. Slack showed the same standing state re-posted into the thread again and again,
// reading as corruption and as the agent ignoring the person's answers.
//
// This cell asks one question of the daemon: when a person-facing notice carries EXACTLY the content
// the person already received (same summary, same body, different row), does the delivery path post
// it again?
//
//   desired: an identical re-serve does not post; only genuinely new content does.
//   if this fails on main, the no-change re-post is daemon-side and upstream-fileable;
//   if it passes, main already guards and the fleet incident was purely seat-side row hygiene.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";

const human = "person@external";
const registry = { ok: true as const, entities: [{ entityId: "person", class: "human" as const,
  displayName: "Person", address: human, connectorBindings: [{ kind: "slack" as const,
    connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary", handle: "UPERSON" }],
  prefs: { deliveryClass: "A" as const } }] };

const STANDING_SUMMARY = "Still your decision, unchanged since the last wake";
const STANDING_BODY = [
  "Design decision D0 is still yours: layout A, B or C.",
  "",
  "OPERATOR DIRECTIVE (verbatim, 2026-11-08): the way we have visualised session activity is not",
  "applicable to OpenRig+omo5 stack... [long standing-state directive blob carried in every post]",
].join("\n");

describe("a person-facing notice re-served with identical content", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  let wire: ReturnType<typeof buildSlackGatewayWire>;
  let postCount: number;
  const postedTexts: string[] = [];

  function start() {
    wire = buildSlackGatewayWire({ home, queueRepo: repo,
      registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      fetchImpl: async (url, init) => {
        if (String(url).endsWith("chat.postMessage")) {
          postCount++;
          const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
          postedTexts.push(String(body.text ?? ""));
          return new Response(JSON.stringify({ ok: true, ts: `${postCount}.000001` }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
      },
    });
    wire.startServices?.();
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "slack-standing-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
    const secrets = join(home, "fake.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-ASKS", secretsEnvFile: secrets }, home);
    postCount = 0; postedTexts.length = 0;
    start();
  });
  afterEach(() => { wire.stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  const serve = (summary: string, body: string) =>
    repo.create({ sourceSession: "orch-lead@rig", destinationSession: human,
      humanIntent: "update", summary, body, nudge: false });

  const delivered = new Set<string>();
  async function sweep() {
    const alerts = await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({ minimumLevel: "NOTICE" });
    for (const alert of alerts) {
      if (delivered.has(alert.qitemId)) continue;
      const res = wire.dispatcher.dispatch("post_message", human, alert) as { ok: boolean };
      if (res.ok) delivered.add(alert.qitemId);
    }
  }

  it("does not re-post standing state the person already received verbatim", async () => {
    // Wake 1: the first serve of the standing state posts (baseline).
    const u1 = await serve(STANDING_SUMMARY, STANDING_BODY);
    await sweep();
    await vi.waitFor(() => expect(postCount).toBe(1));
    expect(postedTexts[0]).toContain(STANDING_SUMMARY);
    // The next wake comes much later; the first serve's receipt is durable by then.
    await vi.waitFor(() => expect(repo.listTransitions(u1.qitemId).some((t) => t.transitionNote?.startsWith("slack-owner-notification-posted"))).toBe(true));

    // Wake 2: a new row carries EXACTLY the same summary and body ("nothing changed").
    await serve(STANDING_SUMMARY, STANDING_BODY);
    await sweep();
    await new Promise((r) => setTimeout(r, 50));
    // Desired: the identical re-serve is not posted again.
    expect(postCount, "an identical re-serve must not re-post the same standing state").toBe(1);

    // Control: genuinely new content still posts exactly once.
    await serve("Layout C recorded; parity gate is the open item", "The decision landed; the rest is execution.");
    await sweep();
    await vi.waitFor(() => expect(postCount).toBe(2));
  });
});
