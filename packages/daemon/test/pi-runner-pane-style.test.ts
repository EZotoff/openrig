// Hermetic tests for the pane's status line and text emphasis: what the seat shows
// about itself, and how the runner's own lines are coloured. No live pi.

import { describe, it, expect } from "vitest";
import {
  mapPiEvent, paneStyles, RunnerCore, type RunnerIo,
} from "../src/adapters/pi-runner.js";

describe("pane styles", () => {
  it("is the identity when disabled", () => {
    const style = paneStyles(false);
    expect(style.dim("x")).toBe("x");
    expect(style.commit("you ▸")).toBe("you ▸");
    expect(style.failed("FAILED")).toBe("FAILED");
  });

  it("uses SGR emphasis when enabled", () => {
    const style = paneStyles(true);
    expect(style.dim("x")).toBe("\u001b[2mx\u001b[0m");
    expect(style.commit("you ▸")).toBe("\u001b[1;36myou ▸\u001b[0m");
    expect(style.failed("FAILED")).toBe("\u001b[1;31mFAILED\u001b[0m");
  });
});

describe("styled tool lines", () => {
  it("dims a running tool and marks a failed one", () => {
    const style = paneStyles(true);
    const running = mapPiEvent({ type: "tool_execution_start", toolName: "Bash" }, "pi", style);
    expect(running.mirrorLines[0]).toBe("  \u001b[2m⚙ Bash …\u001b[0m");
    const failed = mapPiEvent({ type: "tool_execution_end", toolName: "Bash", isError: true }, "pi", style);
    expect(failed.mirrorLines[0]).toBe("  \u001b[2m⚙ Bash\u001b[0m \u001b[1;31mFAILED\u001b[0m");
    const done = mapPiEvent({ type: "tool_execution_end", toolName: "Bash" }, "pi", style);
    expect(done.mirrorLines[0]).toBe("  \u001b[2m⚙ Bash\u001b[0m done");
  });

  it("leaves tool lines plain when styling is off", () => {
    const running = mapPiEvent({ type: "tool_execution_start", toolName: "Bash" }, "pi", paneStyles(false));
    expect(running.mirrorLines[0]).toBe("  ⚙ Bash …");
  });
});

describe("pane status line", () => {
  function seat(options: { model?: string; thinking?: string } = {}) {
    const statuses: string[] = [];
    const io: RunnerIo = {
      sendRpc: () => {},
      mirrorLine: () => {},
      mirrorAppend: () => {},
      postActivity: () => {},
      writeSidecar: () => {},
      now: () => "2026-11-09T00:00:00Z",
      setStatus: (text) => statuses.push(text),
      clearStatus: () => statuses.push(""),
    };
    const core = new RunnerCore(io, { sessionName: "seat-a@some-rig", nodeId: "node-1", launchId: "launch-1" }, options);
    core.start();
    return { core, statuses };
  }

  it("shows the seat's model, effort and state, and follows the working state", () => {
    const { core, statuses } = seat({ model: "seat-lead", thinking: "high" });
    core.handlePiLine(JSON.stringify({
      type: "response", id: "pi-runner-get-state",
      data: { sessionFile: "/state/pi/seat-a/sessions/2026_0197.jsonl", sessionId: "0197a2f0" },
    }));
    expect(statuses.at(-1)).toBe("seat-lead · thinking:high · idle");
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    expect(statuses.at(-1)).toBe("seat-lead · thinking:high · working");
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(statuses.at(-1)).toBe("seat-lead · thinking:high · idle");
  });

  it("omits the effort segment when no effort was passed", () => {
    const { core, statuses } = seat({ model: "seat-lead" });
    core.handlePiLine(JSON.stringify({
      type: "response", id: "pi-runner-get-state",
      data: { sessionFile: "/state/pi/seat-a/sessions/2026_0197.jsonl", sessionId: "0197a2f0" },
    }));
    expect(statuses.at(-1)).toBe("seat-lead · idle");
  });
});
