import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueDeps } from "../src/commands/queue.js";
import { createProgram } from "../src/index.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

interface Recorded {
  posts: Array<{ path: string; body: unknown }>;
  gets: string[];
}

function makeDeps(responder: (path: string, body?: unknown) => { status: number; data: unknown }): { deps: QueueDeps; recorded: Recorded } {
  const recorded: Recorded = { posts: [], gets: [] };
  const deps = {
    lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
    clientFactory: () => ({
      post: vi.fn(async (urlPath: string, body: unknown) => {
        recorded.posts.push({ path: urlPath, body });
        return responder(urlPath, body);
      }),
      get: vi.fn(async (urlPath: string) => {
        recorded.gets.push(urlPath);
        return responder(urlPath);
      }),
    }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
  } as QueueDeps;
  return { deps, recorded };
}

const ARCHIVE = '{"format":"openrig.queue-transfer/v2","transferId":"xfer-test"}';
const SELECTION = { kind: "host", includeClosed: true, counts: { total: 2, open: 1, terminal: 1, erased: 0 } };

describe("rig queue transfer CLI", () => {
  let out: string[];
  let errors: string[];
  let dir: string;

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("OPENRIG_SESSION_NAME", "desk@rig");
    out = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...args) => out.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
    process.exitCode = undefined;
    dir = mkdtempSync(join(tmpdir(), "openrig-cli-transfer-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (deps: QueueDeps, ...args: string[]) =>
    createProgram({ queueDeps: deps }).parseAsync(["node", "rig", "queue", ...args]);

  it("exports to a 0600 file and prints the explicit selection", async () => {
    const { deps, recorded } = makeDeps(() => ({ status: 200, data: { archive: ARCHIVE, selection: SELECTION } }));
    const file = join(dir, "archive.json");
    await run(deps, "export", "--whole-host", "--out", file);

    expect(readFileSync(file, "utf8")).toBe(ARCHIVE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(recorded.posts).toEqual([
      { path: "/api/queue/transfer/export", body: { wholeHost: true, rigs: [], missions: [], slices: [], qitemIds: [], maxBytes: undefined } },
    ]);
    expect(out.join("\n")).toContain("Selection (host)");
    expect(out.join("\n")).toContain("rows total=2");
    expect(process.exitCode).toBeUndefined();
  });

  it("refuses an export with no scope flags before contacting the daemon", async () => {
    const { deps, recorded } = makeDeps(() => ({ status: 200, data: {} }));
    await run(deps, "export", "--out", join(dir, "archive.json"));
    expect(recorded.posts).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect([...errors, ...out].join("\n")).toContain("--whole-host");
  });

  it("import --dry-run sends dryRun and stages nothing", async () => {
    const file = join(dir, "archive.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, ARCHIVE);
    const report = {
      status: "not_ready_for_activation",
      dryRun: true,
      importId: null,
      alreadyStaged: false,
      counts: { total: 1, wouldBecomeRunnable: 1, inProgress: 0, blocked: 0, terminal: 0, erased: 0 },
      warnings: [{ code: "not_ready_for_activation", message: "no authorization exists yet" }],
    };
    const { deps, recorded } = makeDeps(() => ({ status: 200, data: report }));
    await run(deps, "import", file, "--dry-run", "--json");

    expect(recorded.posts).toEqual([{ path: "/api/queue/transfer/import", body: { archive: ARCHIVE, dryRun: true } }]);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ importId: null, status: "not_ready_for_activation" });
    expect(process.exitCode).toBeUndefined();
  });

  it("import stages and prints the import id", async () => {
    const file = join(dir, "archive.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, ARCHIVE);
    const { deps } = makeDeps(() => ({
      status: 200,
      data: {
        status: "not_ready_for_activation",
        dryRun: false,
        importId: "xfer-import-abc",
        alreadyStaged: false,
        counts: { total: 1, wouldBecomeRunnable: 1, inProgress: 0, blocked: 0, terminal: 0, erased: 0 },
        warnings: [],
      },
    }));
    await run(deps, "import", file);
    expect(out.join("\n")).toContain("importId xfer-import-abc");
  });

  it("prints a refusal and exits non-zero", async () => {
    const file = join(dir, "archive.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, ARCHIVE);
    const { deps } = makeDeps(() => ({ status: 400, data: { error: "digest_mismatch", message: "archive digest does not match its content" } }));
    await run(deps, "import", file);
    expect(process.exitCode).toBe(1);
    expect([...errors, ...out].join("\n")).toContain("digest_mismatch");
  });

  it("round-trips staged list and staged discard", async () => {
    const record = { importId: "xfer-import-abc", digest: "abcdef0123456789", originHostId: "origin", rowCount: 2, status: "staged", stagedAt: "2026-11-21T00:00:00.000Z" };
    const listed = makeDeps(() => ({ status: 200, data: { records: [record] } }));
    await run(listed.deps, "staged", "list");
    expect(listed.recorded.gets).toEqual(["/api/queue/transfer/staged"]);
    expect(out.join("\n")).toContain("xfer-import-abc");

    const discarded = makeDeps(() => ({ status: 200, data: { discarded: true, record: { ...record, status: "discarded" } } }));
    await run(discarded.deps, "staged", "discard", "xfer-import-abc");
    expect(discarded.recorded.posts).toEqual([
      { path: "/api/queue/transfer/staged/discard", body: { importId: "xfer-import-abc" } },
    ]);
    expect(out.join("\n")).toContain("Discarded xfer-import-abc");
  });
});
