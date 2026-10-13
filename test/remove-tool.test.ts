import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeWorktree, runGit } from "../src/remove-tool";
import type { GitRun, RemoveWorktreeDeps } from "../src/remove-tool";
import type { UncommittedChanges } from "../src/dirty";
import { hasGit } from "./fs-roots";
import plugin from "../src/plugin";

// remove_worktree's decision-table pins, driven through fake seams —
// no opencode2, no filesystem, no git. The git seam is a responder keyed by
// the commands the landed-ness guard runs (`symbolic-ref`,
// `rev-parse --verify --quiet`, `merge-base --is-ancestor`,
// `rev-list --count`, and the refusal path's `fetch`), so every test states
// its scenario as data. The final block pins the live git binding itself
// (`runGit`) against a real scratch repository: the fake seam's `GitRun`
// answers are only meaningful because the real binding keeps the same
// contract.

const WT = "/wt/worker";

/** A one-row cow inventory naming the worktree every happy path removes. */
function cowInventory(): Array<{ directory: string; strategy?: string }> {
  return [{ directory: WT, strategy: "cow" }];
}

/** What the fake git seam answers, per command; unlisted commands answer "no". */
interface GitScript {
  /** `symbolic-ref`'s answer; absent means exit 1 (no origin/HEAD). */
  readonly symbolicRef?: { code: number; stdout: string };
  /** Refs `rev-parse --verify --quiet` confirms; all others exit 1. */
  readonly verifiedRefs?: readonly string[];
  /** `merge-base --is-ancestor`'s exit code; absent means "not landed". */
  readonly mergeBase?: number;
  /** `rev-list --count`'s answer; absent means exit 1 with no output. */
  readonly revList?: { code: number; stdout: string };
  /** `fetch`'s exit code; absent means 0 (the refresh succeeds). */
  readonly fetch?: number;
  /** The script the seam answers with after a successful fetch; absent means unchanged. */
  readonly afterFetch?: GitScript;
}

/** Builds the git seam from a script; records every call for the assertions. */
function gitResponder(script: GitScript): {
  run: (args: string[], cwd: string) => GitRun;
  calls: Array<{ args: string[]; cwd: string }>;
} {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  let active = script;
  const run = (args: string[], cwd: string): GitRun => {
    calls.push({ args, cwd });
    const [command] = args;
    if (command === "fetch") {
      const answer = { code: active.fetch ?? 0, stdout: "" };
      if (answer.code === 0 && active.afterFetch) active = active.afterFetch;
      return answer;
    }
    if (command === "symbolic-ref") {
      return active.symbolicRef ?? { code: 1, stdout: "" };
    }
    if (command === "rev-parse") {
      const ref = args[args.length - 1]!;
      return (active.verifiedRefs ?? []).includes(ref)
        ? { code: 0, stdout: `${ref}\n` }
        : { code: 1, stdout: "" };
    }
    if (command === "merge-base") {
      return { code: active.mergeBase ?? 1, stdout: "" };
    }
    if (command === "rev-list") {
      return active.revList ?? { code: 1, stdout: "" };
    }
    throw new Error(`fake git seam received an unexpected command: ${String(command)}`);
  };
  return { run, calls };
}

/** The fake deps: every seam is a recording fake; nothing touches the world. */
function fakeDeps(
  options: {
    readonly inventory?: ReadonlyArray<{ directory: string; strategy?: string }>;
    /** Paths `directoryExists` answers true for; everything else is gone. */
    readonly present?: readonly string[];
    /** The git script; absent means every git answer is "no". */
    readonly git?: (args: string[], cwd: string) => GitRun;
    /** The dirty probe's answer; absent means "cannot tell" (`undefined`). */
    readonly uncommitted?: UncommittedChanges;
  } = {},
): {
  deps: RemoveWorktreeDeps;
  removed: Array<{ directory: string; force: boolean }>;
  gitCalls: Array<{ args: string[]; cwd: string }>;
} {
  const removed: Array<{ directory: string; force: boolean }> = [];
  const gitCalls: Array<{ args: string[]; cwd: string }> = [];
  const deps: RemoveWorktreeDeps = {
    listWorktrees: async () => options.inventory ?? [],
    removeWorktree: async (directory, force) => {
      removed.push({ directory, force });
    },
    directoryExists: async (directory) => options.present?.includes(directory) ?? false,
    runGit: async (args, cwd) => {
      gitCalls.push({ args, cwd });
      return options.git?.(args, cwd) ?? { code: 1, stdout: "" };
    },
    probeUncommitted: async () => options.uncommitted,
  };
  return { deps, removed, gitCalls };
}

test("a landed worktree removes without force, dirty or not", async () => {
  const git = gitResponder({
    symbolicRef: { code: 0, stdout: "refs/remotes/origin/main\n" },
    verifiedRefs: ["origin/main"],
    mergeBase: 0,
  });
  const { deps, removed } = fakeDeps({
    inventory: cowInventory(),
    present: [WT],
    git: git.run,
    // Landed decides: uncommitted files do not block a landed HEAD.
    uncommitted: [".env"],
  });

  const result = await removeWorktree({ directory: WT }, deps);

  expect(result).toEqual({ directory: WT, forced: false });
  expect(removed).toEqual([{ directory: WT, force: false }]);
});

test("the origin/HEAD landing ref is trimmed to origin/<branch> before use", async () => {
  const git = gitResponder({
    symbolicRef: { code: 0, stdout: "refs/remotes/origin/main\n" },
    verifiedRefs: ["origin/main"],
    mergeBase: 0,
  });
  const { deps, removed, gitCalls } = fakeDeps({
    inventory: cowInventory(),
    present: [WT],
    git: git.run,
  });

  await removeWorktree({ directory: WT }, deps);

  const verified = gitCalls
    .filter((call) => call.args[0] === "rev-parse")
    .map((call) => call.args.at(-1));
  // The symbolic-ref answer was trimmed before verification, and only the
  // trimmed ref was asked about.
  expect(verified).toEqual(["origin/main"]);
  expect(gitCalls.every((call) => call.cwd === WT)).toBe(true);
  expect(removed).toEqual([{ directory: WT, force: false }]);
});

test("an origin/HEAD ref that does not verify falls through to main, then master", async () => {
  const git = gitResponder({
    symbolicRef: { code: 0, stdout: "refs/remotes/origin/gone\n" },
    verifiedRefs: ["master"],
    mergeBase: 0,
  });
  const { deps, removed, gitCalls } = fakeDeps({
    inventory: cowInventory(),
    present: [WT],
    git: git.run,
  });

  await removeWorktree({ directory: WT }, deps);

  const verified = gitCalls
    .filter((call) => call.args[0] === "rev-parse")
    .map((call) => call.args.at(-1));
  expect(verified).toEqual(["origin/gone", "main", "master"]);
  expect(removed).toHaveLength(1);
});

test("a clean worktree with no unique commits removes at force:false even when unlanded", async () => {
  const git = gitResponder({
    verifiedRefs: ["main"],
    mergeBase: 1,
    revList: { code: 0, stdout: "0\n" },
  });
  const { deps, removed } = fakeDeps({
    inventory: cowInventory(),
    present: [WT],
    git: git.run,
    uncommitted: [],
  });

  const result = await removeWorktree({ directory: WT }, deps);

  // Clean and free of unique commits is the one unlanded state that passes;
  // force stays false, so the strategy's own dirty probe still runs.
  expect(removed).toEqual([{ directory: WT, force: false }]);
  expect(result.forced).toBe(false);
});

test("an unlanded, dirty worktree refuses without force and names the counts", async () => {
  const git = gitResponder({
    symbolicRef: { code: 0, stdout: "refs/remotes/origin/main\n" },
    verifiedRefs: ["origin/main"],
    mergeBase: 1,
    revList: { code: 0, stdout: "3\n" },
  });
  const { deps, removed } = fakeDeps({
    inventory: cowInventory(),
    present: [WT],
    git: git.run,
    uncommitted: ["src/a.ts", "src/b.ts"],
  });

  await expect(removeWorktree({ directory: WT }, deps)).rejects.toThrow(
    /3 unique commit\(s\).*2 uncommitted file\(s\).*Re-run with force to remove anyway/s,
  );
  expect(removed).toEqual([]);
});

test("an undeterminable dirty state refuses even with no unique commits (fail closed)", async () => {
  const git = gitResponder({
    verifiedRefs: ["main"],
    mergeBase: 1,
    revList: { code: 0, stdout: "0\n" },
  });
  const { deps, removed } = fakeDeps({
    inventory: cowInventory(),
    present: [WT],
    git: git.run,
    // probeUncommitted's "cannot tell" answer: never read as clean.
    uncommitted: undefined,
  });

  await expect(removeWorktree({ directory: WT }, deps)).rejects.toThrow(
    /unknown number of uncommitted file\(s\).*Re-run with force/s,
  );
  expect(removed).toEqual([]);
});

test("a failed unique-commit count refuses (fail closed)", async () => {
  const git = gitResponder({
    verifiedRefs: ["main"],
    mergeBase: 1,
    revList: { code: 1, stdout: "" },
  });
  const { deps, removed } = fakeDeps({
    inventory: cowInventory(),
    present: [WT],
    git: git.run,
    uncommitted: [],
  });

  await expect(removeWorktree({ directory: WT }, deps)).rejects.toThrow(
    /unknown number of unique commit\(s\).*Re-run with force/s,
  );
  expect(removed).toEqual([]);
});

test("an undetectable landing ref refuses without force", async () => {
  // No origin/HEAD, and neither main nor master verifies: landed-ness cannot
  // be judged, so the removal refuses even though the tree is clean.
  const { deps, removed } = fakeDeps({
    inventory: cowInventory(),
    present: [WT],
    uncommitted: [],
  });

  await expect(removeWorktree({ directory: WT }, deps)).rejects.toThrow(
    /landing ref could not be determined.*Re-run with force to remove anyway/s,
  );
  expect(removed).toEqual([]);
});

// The refusal path's refresh (issue #16): a cow lane's origin/<branch> refs
// freeze at clone time, so before refusing the guard fetches once and
// re-judges on the fresh refs. A fetch failure keeps the refusal and says
// the verdict is stale-limited.

test("a refusal refreshes origin once and re-judges on the fresh refs", async () => {
  const git = gitResponder({
    verifiedRefs: ["main"],
    mergeBase: 1,
    revList: { code: 0, stdout: "1\n" },
    afterFetch: { verifiedRefs: ["main"], mergeBase: 0 },
  });
  const { deps, removed, gitCalls } = fakeDeps({
    inventory: cowInventory(),
    present: [WT],
    git: git.run,
    uncommitted: [],
  });

  const result = await removeWorktree({ directory: WT }, deps);

  expect(result).toEqual({ directory: WT, forced: false });
  expect(removed).toEqual([{ directory: WT, force: false }]);
  const commands = gitCalls.map((call) => call.args[0]);
  // One fetch, sandwiched between the stale and the fresh ancestry probe.
  expect(commands).toEqual([
    "symbolic-ref",
    "rev-parse",
    "merge-base",
    "rev-list",
    "fetch",
    "merge-base",
    "rev-list",
  ]);
});

test("a failed fetch refresh keeps the refusal and names the stale verdict", async () => {
  const git = gitResponder({
    verifiedRefs: ["main"],
    mergeBase: 1,
    revList: { code: 0, stdout: "4\n" },
    fetch: 1,
  });
  const { deps, removed, gitCalls } = fakeDeps({
    inventory: cowInventory(),
    present: [WT],
    git: git.run,
    uncommitted: ["dirty.txt"],
  });

  await expect(removeWorktree({ directory: WT }, deps)).rejects.toThrow(
    /4 unique commit\(s\).*`git fetch origin` refresh failed.*Re-run with force/s,
  );
  expect(removed).toEqual([]);
  expect(gitCalls.filter((call) => call.args[0] === "fetch")).toHaveLength(1);
});

test("a successful refresh that still finds unlanded work refuses without the stale note", async () => {
  const git = gitResponder({
    verifiedRefs: ["main"],
    mergeBase: 1,
    revList: { code: 0, stdout: "4\n" },
  });
  const { deps, removed } = fakeDeps({
    inventory: cowInventory(),
    present: [WT],
    git: git.run,
    uncommitted: ["dirty.txt"],
  });

  await expect(removeWorktree({ directory: WT }, deps)).rejects.toThrow(
    /4 unique commit\(s\) and 1 uncommitted file\(s\)\. Re-run with force/s,
  );
  expect(removed).toEqual([]);
});

test("force bypasses the guard entirely and is passed through verbatim", async () => {
  const git = gitResponder({
    verifiedRefs: ["main"],
    mergeBase: 1,
    revList: { code: 0, stdout: "4\n" },
  });
  const { deps, removed, gitCalls } = fakeDeps({
    inventory: cowInventory(),
    present: [WT],
    git: git.run,
    uncommitted: ["dirty.txt"],
  });

  const result = await removeWorktree({ directory: WT, force: true }, deps);

  expect(result).toEqual({ directory: WT, forced: true });
  expect(removed).toEqual([{ directory: WT, force: true }]);
  // The guard never ran: no git command, no dirty probe answer consulted.
  expect(gitCalls).toEqual([]);
});

test("a dangling inventory row is refused before the guard, even at force:true", async () => {
  const { deps, removed, gitCalls } = fakeDeps({
    inventory: cowInventory(),
    present: [], // the directory is gone; the row is dangling
  });

  await expect(removeWorktree({ directory: WT, force: true }, deps)).rejects.toThrow(
    /dangling.*candidate 8.*Worktree directory unavailable.*force:true/s,
  );
  expect(removed).toEqual([]);
  // The guard never ran git in a directory that is not there.
  expect(gitCalls).toEqual([]);
});

test("a directory the inventory does not know is refused as a Foreign worktree", async () => {
  const { deps, removed } = fakeDeps({ inventory: cowInventory(), present: ["/wt/stranger"] });

  await expect(removeWorktree({ directory: "/wt/stranger" }, deps)).rejects.toThrow(
    /refusing to remove \/wt\/stranger.*Foreign worktree/,
  );
  expect(removed).toEqual([]);
});

test("an inventory row of another strategy is refused, mirroring the attach refusal", async () => {
  const { deps, removed } = fakeDeps({
    inventory: [{ directory: WT, strategy: "git" }],
    present: [WT],
  });

  await expect(removeWorktree({ directory: WT }, deps)).rejects.toThrow(
    /refusing to remove \/wt\/worker.*records it with "git", not "cow"/,
  );

  const strategyless = fakeDeps({ inventory: [{ directory: WT }], present: [WT] });
  await expect(removeWorktree({ directory: WT }, strategyless.deps)).rejects.toThrow(
    /records it with no strategy, not "cow"/,
  );
  expect(removed).toEqual([]);
});

test("an unknown name refuses and lists the known cow rows", async () => {
  const { deps, removed } = fakeDeps({
    inventory: [
      { directory: "/wt/alpha", strategy: "cow" },
      { directory: "/wt/beta", strategy: "cow" },
    ],
  });

  await expect(removeWorktree({ name: "zzz" }, deps)).rejects.toThrow(
    /no cow worktree named "zzz".*alpha.*beta.*list_worktrees/s,
  );
  expect(removed).toEqual([]);
});

test("an unknown name in an inventory with no cow rows says there are none", async () => {
  const { deps } = fakeDeps({ inventory: [{ directory: "/wt/root" }] });

  await expect(removeWorktree({ name: "zzz" }, deps)).rejects.toThrow(
    /no cow worktree named "zzz".*no cow worktrees/s,
  );
});

test("a name several cow rows share is ambiguous, naming the candidates", async () => {
  const { deps, removed } = fakeDeps({
    inventory: [
      { directory: "/wt/a/worker", strategy: "cow" },
      { directory: "/wt/b/worker", strategy: "cow" },
    ],
  });

  await expect(removeWorktree({ name: "worker" }, deps)).rejects.toThrow(
    /ambiguous.*\/wt\/a\/worker.*\/wt\/b\/worker.*full directory/s,
  );
  expect(removed).toEqual([]);
});

test("a non-cow row is invisible to a name lookup, not a foreign-strategy refusal", async () => {
  // The name selector filters cow rows first, so a git-strategy row under the
  // same basename is simply not a match — it refuses as unknown, listing no
  // cow rows, and never removes the foreign worktree.
  const { deps, removed } = fakeDeps({
    inventory: [{ directory: WT, strategy: "git" }],
    present: [WT],
  });

  await expect(removeWorktree({ name: "worker" }, deps)).rejects.toThrow(
    /no cow worktree named "worker".*no cow worktrees/s,
  );
  expect(removed).toEqual([]);
});

test("resolving by name removes the inventory-recorded directory at force:false", async () => {
  const git = gitResponder({ verifiedRefs: ["main"], mergeBase: 0 });
  const { deps, removed } = fakeDeps({
    inventory: [{ directory: "/wt/recorded/worker", strategy: "cow" }],
    present: ["/wt/recorded/worker"],
    git: git.run,
  });

  const result = await removeWorktree({ name: "worker" }, deps);

  expect(result).toEqual({ directory: "/wt/recorded/worker", forced: false });
  expect(removed).toEqual([{ directory: "/wt/recorded/worker", force: false }]);
});

test("exactly one of name and directory is required", async () => {
  const { deps } = fakeDeps({ inventory: cowInventory() });

  await expect(removeWorktree({}, deps)).rejects.toThrow(
    /exactly one of "name" or "directory".*neither was given/s,
  );
  await expect(removeWorktree({ name: "worker", directory: WT }, deps)).rejects.toThrow(
    /exactly one of "name" or "directory".*both were given/s,
  );
  // An empty string is not a selector — the same rule attach applies to name —
  // so `{ name: "" }` refuses as "neither given" rather than matching nothing.
  await expect(removeWorktree({ name: "" }, deps)).rejects.toThrow(/neither was given/);
});

// ---------------------------------------------------------------------------
// Registration pins: remove_worktree joins the native tool list with the same
// contract as the other two tools, and its declared output schema matches what
// execute returns (a returned `output` without a schema is a hard defect).
// ---------------------------------------------------------------------------

/** The location slice `liveDeps` and the registration read. */
const fakeLocation = {
  directory: "/src",
  project: { id: "prj_test", directory: "/src", canonical: "/src" },
};

test("plugin setup registers remove_worktree on the native tool list with its output schema", async () => {
  const registered: Array<{
    name: string;
    options?: { codemode?: boolean; permission?: string };
    input?: unknown;
    output?: unknown;
  }> = [];
  const ctx = {
    location: fakeLocation,
    worktree: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: () => {} });
        return { dispose: async () => {} };
      },
    },
    tool: {
      transform: async (callback: (editor: { add: (tool: any) => void }) => void) => {
        callback({
          add: (tool: any) => {
            registered.push(tool);
          },
        });
        return { dispose: async () => {} };
      },
    },
  } as unknown as Parameters<typeof plugin.setup>[0];

  await plugin.setup(ctx);

  const tool = registered.find((entry) => entry.name === "remove_worktree");
  expect(tool).toBeDefined();
  // Callable by name, like spawn_workspace and list_worktrees.
  expect(tool!.options?.codemode).toBe(false);
  // Removal is an edit-approved mutation on the host since v2.0.27
  // (PR anomalyco/opencode#53981); this pins the registration shape, not the
  // host's enforcement.
  expect(tool!.options?.permission).toBe("edit");
  const output = tool!.output as {
    properties: Record<string, unknown>;
    required: readonly string[];
    additionalProperties: boolean;
  };
  expect([...output.required]).toEqual(["directory"]);
  expect(Object.keys(output.properties)).toEqual(["directory"]);
  expect(output.additionalProperties).toBe(false);
  const input = tool!.input as { properties: Record<string, unknown>; required?: string[] };
  expect(Object.keys(input.properties).sort()).toEqual(["directory", "force", "name"]);
  // Exactly-one-of is validated in execute, so the schema requires neither.
  expect(input.required).toBeUndefined();
});

// The live git binding, pinned where the code lives (src/remove-tool.ts
// `runGit`): a successful command resolves stdout with exit code 0, a
// non-zero git exit is a failed answer with no stdout, and an unreadable
// failure (no such directory) resolves to exit code 1.

const gitOnPath = hasGit();

const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** A real scratch repository with one committed file; returns its directory. */
async function makeScratchRepo(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  await writeFile(join(dir, "tracked.txt"), "committed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "scratch");
  return dir;
}

test("runGit resolves a successful command's stdout with exit code 0", async () => {
  test.skipIf(!gitOnPath);
  const dir = await makeScratchRepo("cow-remove-git-ok-");

  const run = await runGit(["log", "--oneline"], dir);

  expect(run.code).toBe(0);
  expect(run.stdout).toContain("scratch");
});

test("runGit reads a non-zero git exit as a failed answer with no stdout", async () => {
  test.skipIf(!gitOnPath);
  const dir = await makeScratchRepo("cow-remove-git-refuse-");

  const run = await runGit(["rev-parse", "--verify", "--quiet", "no-such-ref"], dir);

  expect(run.code).toBe(1);
  expect(run.stdout).toBe("");
});

test("runGit resolves an unreadable failure to exit code 1 with no stdout", async () => {
  test.skipIf(!gitOnPath);

  const run = await runGit(
    ["status", "--porcelain"],
    join(tmpdir(), "cow-remove-git-missing-cwd"),
  );

  expect(run.code).toBe(1);
  expect(run.stdout).toBe("");
});

// The plugin's own wiring, driven through a live ctx: real stat
// (`directoryPresent`) and real git (`runGit`) on a scratch repository, with
// the inventory and removal faked at the `ctx.worktree` boundary. This pins
// what the seams-only tests above cannot: the projectID on every remove, the
// force pass-through, the result text, and the prune seam's forced DELETE.

interface RecordedRemove {
  projectID: string;
  directory: string;
  force: boolean;
}

/** The remove tool through its live ctx bindings; records ctx.worktree.remove calls. */
async function registeredRemoveTool(
  listed: ReadonlyArray<{ directory: string; strategy?: string }>,
): Promise<{
  removeCalls: Array<RecordedRemove>;
  execute: (input: unknown) => Promise<{ output: unknown; content: string }>;
}> {
  const registered: Array<{
    name: string;
    execute: (input: unknown) => Promise<{ output: unknown; content: string }>;
  }> = [];
  const removeCalls: Array<RecordedRemove> = [];
  const ctx = {
    location: fakeLocation,
    worktree: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: () => {} });
        return { dispose: async () => {} };
      },
      list: async () => listed,
      remove: async (input: RecordedRemove) => {
        removeCalls.push(input);
      },
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          add: (tool: {
            name: string;
            execute: (input: unknown) => Promise<{ output: unknown; content: string }>;
          }) => registered.push(tool),
        });
        return { dispose: async () => {} };
      },
    },
  } as unknown as Parameters<typeof plugin.setup>[0];

  await plugin.setup(ctx);
  const tool = registered.find((entry) => entry.name === "remove_worktree");
  if (tool === undefined) throw new Error("remove_worktree was not registered");
  return { removeCalls, execute: (input) => tool.execute(input) };
}

test("the registered remove_worktree tool removes a landed worktree through the live ctx", async () => {
  test.skipIf(!gitOnPath);
  const dir = await makeScratchRepo("cow-remove-live-ok-");
  const { removeCalls, execute } = await registeredRemoveTool([
    { directory: dir, strategy: "cow" },
  ]);

  const result = await execute({ directory: dir });

  expect(result.output).toEqual({ directory: dir });
  expect(result.content).toBe(`Removed cow worktree ${dir}.`);
  expect(removeCalls).toEqual([{ projectID: "prj_test", directory: dir, force: false }]);
});

test("the registered remove_worktree tool carries force through and names the bypass", async () => {
  test.skipIf(!gitOnPath);
  const dir = await makeScratchRepo("cow-remove-live-force-");
  const { removeCalls, execute } = await registeredRemoveTool([
    { directory: dir, strategy: "cow" },
  ]);

  const result = await execute({ directory: dir, force: true });

  expect(result.content).toBe(
    `Removed cow worktree ${dir}. Force was used: the landed-ness guard was bypassed.`,
  );
  expect(removeCalls).toEqual([{ projectID: "prj_test", directory: dir, force: true }]);
});

test("the registered remove_worktree tool refuses a dangling inventory row", async () => {
  const gone = join(tmpdir(), "cow-remove-live-gone");
  const { execute } = await registeredRemoveTool([{ directory: gone, strategy: "cow" }]);

  await expect(execute({ directory: gone })).rejects.toThrow(/dangling/);
});

test("the registered remove_worktree tool propagates a non-ENOENT stat failure", async () => {
  // A self-referential symlink makes stat answer ELOOP — a real anomaly the
  // dangling-row pre-check must surface, not absorb. Works on any filesystem,
  // as any user.
  const base = await mkdtemp(join(tmpdir(), "cow-remove-live-loop-"));
  scratchDirs.push(base);
  const loop = join(base, "loop");
  await symlink(loop, loop);
  const { execute } = await registeredRemoveTool([{ directory: loop, strategy: "cow" }]);

  await expect(execute({ directory: loop })).rejects.toThrow(/loop|ELOOP|too many/i);
});

test("the registered list_worktrees tool prunes a dangling row through the live ctx", async () => {
  const gone = join(tmpdir(), "cow-list-live-prune-gone");
  const registered: Array<{
    name: string;
    execute: (input: unknown) => Promise<{ output: unknown; content: string }>;
  }> = [];
  const removeCalls: Array<RecordedRemove> = [];
  const ctx = {
    location: fakeLocation,
    worktree: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: () => {} });
        return { dispose: async () => {} };
      },
      list: async () => [{ directory: gone, strategy: "cow" }],
      remove: async (input: RecordedRemove) => {
        removeCalls.push(input);
      },
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          add: (tool: {
            name: string;
            execute: (input: unknown) => Promise<{ output: unknown; content: string }>;
          }) => registered.push(tool),
        });
        return { dispose: async () => {} };
      },
    },
  } as unknown as Parameters<typeof plugin.setup>[0];
  await plugin.setup(ctx);
  const tool = registered.find((entry) => entry.name === "list_worktrees");
  if (tool === undefined) throw new Error("list_worktrees was not registered");

  const result = await tool.execute({ missing: "prune" });

  expect(removeCalls).toEqual([{ projectID: "prj_test", directory: gone, force: true }]);
  expect(result.output).toEqual({ worktrees: [] });
});

// Issue #16: a cow lane is a separate clone, so its origin/<branch> refs
// freeze at clone time. Work the lane committed can land on the remote
// through another clone (a merged PR), and the guard's stale refs must not
// turn that landed work into a refusal.

/**
 * A bare origin plus a lane clone whose origin/* refs are stale: the lane
 * commits work, that exact commit lands on the remote through an author
 * clone, and the lane never fetches. Returns the lane directory.
 */
async function makeStaleLane(prefix: string): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(base);
  const origin = join(base, "origin.git");
  const seed = join(base, "seed");
  const lane = join(base, "lane");
  const author = join(base, "author");

  git(base, "init", "-q", "-b", "main", "seed");
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "user.name", "Test");
  await writeFile(join(seed, "tracked.txt"), "committed\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "scratch");
  git(base, "clone", "--bare", "--quiet", "seed", "origin.git");
  git(base, "clone", "--quiet", "origin.git", "lane");
  git(lane, "config", "user.email", "test@example.com");
  git(lane, "config", "user.name", "Test");

  await writeFile(join(lane, "lane.txt"), "lane work\n");
  git(lane, "add", "-A");
  git(lane, "commit", "-qm", "lane work");
  const laneHead = git(lane, "rev-parse", "HEAD").trim();

  // Land the lane's exact commit on the remote through another clone; the
  // lane's origin/main stays at the seed commit.
  git(base, "clone", "--quiet", "origin.git", "author");
  git(author, "fetch", lane, "main");
  git(author, "merge", "--ff-only", "FETCH_HEAD");
  git(author, "push", "--quiet", "origin", "main");

  const remoteMain = git(author, "rev-parse", "origin/main").trim();
  const staleLaneOrigin = git(lane, "rev-parse", "origin/main").trim();
  if (remoteMain !== laneHead || staleLaneOrigin === laneHead) {
    throw new Error("fixture failed to produce a stale lane");
  }
  return lane;
}

test("a lane commit landed on the remote after clone time still removes (issue #16)", async () => {
  test.skipIf(!gitOnPath);
  const lane = await makeStaleLane("cow-remove-live-stale-");
  const { removeCalls, execute } = await registeredRemoveTool([
    { directory: lane, strategy: "cow" },
  ]);

  const result = await execute({ directory: lane });

  expect(result.content).toBe(`Removed cow worktree ${lane}.`);
  expect(removeCalls).toEqual([{ projectID: "prj_test", directory: lane, force: false }]);
});
