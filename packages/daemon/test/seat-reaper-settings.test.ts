import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore, SETTINGS_VALID_KEYS } from "../src/domain/user-settings/settings-store.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("registers the same six seat-scale keys in both settings twins", () => {
  // Given the daemon and CLI's machine-consumed key lists.
  const cli = readFileSync(new URL("../../cli/src/config-store.ts", import.meta.url), "utf8");
  const expected = ["enabled", "observe", "idle_threshold_minutes", "max_reaps_per_24h", "protected_rigs", "opt_in_rigs"]
    .map(key => `policies.seat_scale.${key}`);
  // When selecting the new namespace.
  const keys = SETTINGS_VALID_KEYS.filter(key => key.startsWith("policies.seat_scale."));
  // Then both twins expose exactly the agreed surface.
  expect(keys).toEqual(expected);
  for (const key of keys) expect(cli).toContain(`"${key}"`);
});

it("defaults to disabled observation and validates policy limits", () => {
  // Given a fresh, isolated config path.
  const root = mkdtempSync(join(tmpdir(), "seat-reaper-settings-")); roots.push(root);
  const store = new SettingsStore(join(root, "config.json"));
  // When resolving the new policy.
  const values = SETTINGS_VALID_KEYS.filter(key => key.startsWith("policies.seat_scale."))
    .map(key => store.resolveOne(key).value);
  // Then default posture and bounds are conservative.
  expect(values).toEqual([false, true, 240, 12, '["coordination"]', "[]"]);
});
