import { afterEach, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { cowStrategy, createCowStrategy } from "../src/strategy";
import { OccupiedTargetError } from "../src/clone";
import * as cloneModule from "../src/clone";
import * as hooksModule from "../src/hooks";
import * as uncommittedModule from "../src/uncommitted";
import plugin from "../src/plugin";
import { findCowRoot, findNonCowRoot, hasGit } from "./fs-roots";

// Discover the roots instead of hardcoding this machine's mounts. The CoW
// tests skip cleanly where no CoW filesystem exists; the negative test needs a
// filesystem that definitively refuses a clone. Tests that build a scratch git
// repository also skip when git is absent.
const cowRoot = await findCowRoot();
const nonCowRoot = await findNonCowRoot();
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

interface Scratch {
  dir: string;
  repo: string;
}

/**
 * A real scratch git repository with tracked files, an ignored dependency
 * directory, an ignored file, a symbolic link, and an incompressible blob.
 */
async function makeScratchRepo(root: string): Promise<Scratch> {
  const dir = await mkdtemp(join(root, "cow-strategy-"));
  scratchDirs.push(dir);
  const repo = join(dir, "source");
  await mkdir(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  await writeFile(join(repo, ".gitignore"), "node_modules/\n*.log\n");
  await writeFile(join(repo, "tracked.txt"), "tracked contents\n");
  await mkdir(join(repo, "node_modules", "dep"), { recursive: true });
  await writeFile(join(repo, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  await writeFile(join(repo, "debug.log"), "ignored log line\n");
  await writeFile(join(repo, "blob.bin"), randomBytes(8 * 1024 * 1024));
  await symlink("tracked.txt", join(repo, "link-to-tracked"));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "scratch");
  return { dir, repo };
}

interface Added {
  readonly id: string;
  readonly definition: typeof cowStrategy;
}

/** A fake Context that records what the plugin registers through the seam. */
function fakeContext(added: Added[], options?: Record<string, unknown>) {
  const editor = {
    add: (definition: typeof cowStrategy) => {
      added.push({ id: definition.id, definition });
    },
  };
  const ctx = {
    options,
    worktree: {
      transform: async (callback: (editor: unknown) => void) => {
        callback(editor);
        return { dispose: async () => {} };
      },
    },
  };
  return ctx as unknown as Parameters<typeof plugin.setup>[0];
}

test("plugin setup registers exactly one strategy, with id cow", async () => {
  const added: Added[] = [];
  await plugin.setup(fakeContext(added));

  expect(plugin.id).toBe("opencode-cow-worktree");
  expect(added).toHaveLength(1);
  expect(added[0]?.id).toBe("cow");
  // The factory instance the setup builds, not the module-level hookless
  // default: the registered strategy closes over the validated options.
  expect(added[0]?.definition).toMatchObject({ id: "cow" });
  expect(typeof added[0]?.definition.create).toBe("function");
});

test.skipIf(cowRoot === undefined || !gitOnPath)("a worktree created through the registered strategy is a Deep clone", async () => {
  const added: Added[] = [];
  await plugin.setup(fakeContext(added));
  const { repo } = await makeScratchRepo(cowRoot!);
  const target = join(repo, "..", "clone");
  const signal = new AbortController().signal;

  // Drive the strategy the plugin actually registered, not the module import.
  const definition = added[0]!.definition;
  const created = await definition.create(
    { sourceDirectory: repo, directory: target },
    { signal },
  );

  expect(created).toEqual({ directory: target });
  // Ignored state is why this Strategy exists.
  expect(await readFile(join(target, "node_modules", "dep", "index.js"), "utf8")).toBe(
    "module.exports = 1;\n",
  );
  expect(await readFile(join(target, "debug.log"), "utf8")).toBe("ignored log line\n");
  // A link is a link, not a copy of its target.
  expect((await lstat(join(target, "link-to-tracked"))).isSymbolicLink()).toBe(true);
  // A real, standalone metadata directory with no dependency on the source.
  expect((await lstat(join(target, ".git"))).isDirectory()).toBe(true);
  await expect(
    readFile(join(target, ".git", "objects", "info", "alternates"), "utf8"),
  ).rejects.toThrow();
  expect(git(target, "status", "--porcelain")).toBe(git(repo, "status", "--porcelain"));

  // Editing in the clone leaves the source byte-for-byte unchanged.
  const beforeTracked = await readFile(join(repo, "tracked.txt"));
  const beforeIgnored = await readFile(join(repo, "node_modules", "dep", "index.js"));
  await writeFile(join(target, "tracked.txt"), "changed in clone\n");
  await writeFile(join(target, "node_modules", "dep", "index.js"), "changed dependency\n");
  expect(await readFile(join(repo, "tracked.txt"))).toEqual(beforeTracked);
  expect(await readFile(join(repo, "node_modules", "dep", "index.js"))).toEqual(beforeIgnored);

  // The clone is genuinely independent: it still reads git with the source gone.
  await rename(repo, `${repo}.moved`);
  expect(git(target, "status", "--porcelain")).toBe(" M tracked.txt\n");
});

// The strategy-layer half of ticket 12: an occupied target is refused before
// the first write, so the create rollback must never `rm` foreign content.
// Runs off the CoW root — the refusal precedes any reflink.
test("a create whose target is already occupied is refused without rolling back", async () => {
  const source = await mkdtemp(join(tmpdir(), "cow-occupied-src-"));
  const target = join(tmpdir(), `cow-occupied-tgt-${randomBytes(8).toString("hex")}`);
  await mkdir(target, { recursive: true });
  const foreign = join(target, "foreign.txt");
  await writeFile(foreign, "not the plugin's");
  const signal = new AbortController().signal;

  await expect(
    cowStrategy.create({ sourceDirectory: source, directory: target }, { signal }),
  ).rejects.toBeInstanceOf(OccupiedTargetError);

  expect(await readFile(foreign, "utf8")).toEqual("not the plugin's");
  await rm(source, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
});

test.skipIf(cowRoot === undefined || !gitOnPath)("removing a worktree through the strategy removes its directory", async () => {
  const { repo } = await makeScratchRepo(cowRoot!);
  const target = join(repo, "..", "clone");
  const signal = new AbortController().signal;
  await cowStrategy.create({ sourceDirectory: repo, directory: target }, { signal });

  await cowStrategy.remove({ directory: target, force: true }, { signal });

  await expect(lstat(target)).rejects.toThrow();
});

// Not gated on a CoW filesystem: `remove` never reflinks, so this runs in CI
// where no CoW root exists. It is the strategy-level half of issue #12 — the
// `DELETE /api/worktree` half lives in `scripts/e2e/scenarios.ts`, because the
// server refuses before it reaches this code.
test("remove is idempotent: a missing directory is not an error at force", async () => {
  const signal = new AbortController().signal;
  const gone = join(tmpdir(), `cow-remove-gone-${randomBytes(8).toString("hex")}`);

  await expect(cowStrategy.remove({ directory: gone, force: true }, { signal })).resolves.toBeUndefined();
});

test("remove still fails loudly on a real error, not just a missing path", async () => {
  const signal = new AbortController().signal;
  // A file where a path component is expected is corruption, not absence, and
  // must not be swallowed along with ENOENT.
  const parent = await mkdtemp(join(tmpdir(), "cow-remove-enotdir-"));
  scratchDirs.push(parent);
  await writeFile(join(parent, "a-file"), "not a directory\n");

  await expect(
    cowStrategy.remove({ directory: join(parent, "a-file", "child"), force: true }, { signal }),
  ).rejects.toThrow();
});

// --- the uncommitted-work guard (issue #13) ---
//
// `remove` at `force: false` must refuse a worktree whose git status is not
// positively clean, and must do so before touching the filesystem. The
// injected `probeUncommitted` seam keeps each branch deterministic: a real
// git repository for the two end-to-end survival cases, and a stub for the
// branches a real repository cannot produce (unknown, probe failure).

/** A directory holding one real file; returns the file path for survival checks. */
async function makePlainDir(prefix: string): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  const file = join(dir, "precious.txt");
  await writeFile(file, "uncommitted work\n");
  return { dir, file };
}

test("remove at force: false deletes a clean worktree", async () => {
  // The probe must positively report "clean" to allow a delete, so this uses a
  // real repository with no changes, not a directory without git metadata
  // (which is unknown and deliberately refuses). The probe itself is pinned in
  // test/uncommitted.test.ts.
  test.skipIf(!gitOnPath);
  const signal = new AbortController().signal;
  const dir = await mkdtemp(join(tmpdir(), "cow-remove-clean-"));
  scratchDirs.push(dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  await writeFile(join(dir, "tracked.txt"), "committed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "scratch");

  await expect(
    cowStrategy.remove({ directory: dir, force: false }, { signal }),
  ).resolves.toBeUndefined();
  await expect(lstat(dir)).rejects.toThrow();
});

test("remove at force: true deletes without probing", async () => {
  const signal = new AbortController().signal;
  const { dir } = await makePlainDir("cow-remove-forced-");
  let probed = 0;
  const spy = spyOn(uncommittedModule, "probeUncommitted").mockImplementation(async () => {
    probed += 1;
    return ["precious.txt"];
  });
  try {
    // The force is authorization, not a request to ask again: even a probe
    // that would answer "dirty" must not run, and the delete must succeed.
    await expect(
      cowStrategy.remove({ directory: dir, force: true }, { signal }),
    ).resolves.toBeUndefined();
    expect(probed).toBe(0);
    await expect(lstat(dir)).rejects.toThrow();
  } finally {
    spy.mockRestore();
  }
});

test("remove at force: false refuses a dirty worktree and every file survives", async () => {
  const signal = new AbortController().signal;
  const { dir, file } = await makePlainDir("cow-remove-dirty-");
  const spy = spyOn(uncommittedModule, "probeUncommitted").mockImplementation(async () => [
    "precious.txt",
    "src/app.ts",
  ]);
  try {
    const error = await cowStrategy
      .remove({ directory: dir, force: false }, { signal })
      .then(() => undefined, (failure: unknown) => failure as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe(
      `cow refuses to remove ${dir} without force: ` +
        "2 uncommitted change(s) (e.g. precious.txt, src/app.ts). " +
        "Re-run with force to delete them.",
    );
    // The whole point: nothing was touched. The directory and its file are
    // still there, byte for byte.
    expect(await readFile(file, "utf8")).toBe("uncommitted work\n");
    expect((await lstat(dir)).isDirectory()).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

test("remove at force: false refuses when the probe cannot answer", async () => {
  const signal = new AbortController().signal;
  const { dir, file } = await makePlainDir("cow-remove-unknown-");
  const spy = spyOn(uncommittedModule, "probeUncommitted").mockImplementation(
    async () => undefined,
  );
  try {
    const error = await cowStrategy
      .remove({ directory: dir, force: false }, { signal })
      .then(() => undefined, (failure: unknown) => failure as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(`cow refuses to remove ${dir} without force:`);
    expect(error?.message).toContain("could not be determined");
    expect(await readFile(file, "utf8")).toBe("uncommitted work\n");
  } finally {
    spy.mockRestore();
  }
});

test("remove at force: false refuses a directory with no git metadata", async () => {
  // Not a stub: the real probe must report unknown for a plain directory, and
  // that unknown must refuse rather than delete.
  const signal = new AbortController().signal;
  const { dir, file } = await makePlainDir("cow-remove-nogit-");

  const error = await cowStrategy
    .remove({ directory: dir, force: false }, { signal })
    .then(() => undefined, (failure: unknown) => failure as Error);

  expect(error).toBeInstanceOf(Error);
  expect(await readFile(file, "utf8")).toBe("uncommitted work\n");
});

test("remove at force: false refuses when git itself fails", async () => {
  // `.git` exists but is not a git directory, so `git -C … status` exits
  // non-zero. That is a failed probe — unknown — and must refuse, not delete.
  test.skipIf(!gitOnPath);
  const signal = new AbortController().signal;
  const { dir, file } = await makePlainDir("cow-remove-badgit-");
  await writeFile(join(dir, ".git"), "not a git directory\n");

  const error = await cowStrategy
    .remove({ directory: dir, force: false }, { signal })
    .then(() => undefined, (failure: unknown) => failure as Error);

  expect(error).toBeInstanceOf(Error);
  expect(error?.message).toContain("could not be determined");
  expect(await readFile(file, "utf8")).toBe("uncommitted work\n");
});

test("remove at force: true deletes a real dirty worktree", async () => {
  // End to end through the real probe: a real git worktree with a modified
  // tracked file is refused at force: false and deleted at force: true.
  test.skipIf(!gitOnPath);
  const signal = new AbortController().signal;
  const dir = await mkdtemp(join(tmpdir(), "cow-remove-real-dirty-"));
  scratchDirs.push(dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  await writeFile(join(dir, "tracked.txt"), "committed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "scratch");
  await writeFile(join(dir, "tracked.txt"), "uncommitted\n");

  await expect(
    cowStrategy.remove({ directory: dir, force: false }, { signal }),
  ).rejects.toThrow(/cow refuses to remove/);
  expect(await readFile(join(dir, "tracked.txt"), "utf8")).toBe("uncommitted\n");

  await cowStrategy.remove({ directory: dir, force: true }, { signal });
  await expect(lstat(dir)).rejects.toThrow();
});


test("list returns no entries, leaving inventory to opencode2", async () => {
  const signal = new AbortController().signal;
  expect(await cowStrategy.list("/anywhere", { signal })).toEqual([]);
});

test.skipIf(nonCowRoot === undefined || !gitOnPath)("create fails loudly on a filesystem without CoW support and leaves no directory", async () => {
  const { repo } = await makeScratchRepo(nonCowRoot!);
  const target = join(repo, "..", "clone");
  const signal = new AbortController().signal;

  const error = await cowStrategy
    .create({ sourceDirectory: repo, directory: target }, { signal })
    .then(() => undefined, (failure: unknown) => failure as Error);

  expect(error).toBeDefined();
  expect(error?.message).toContain(target);
  // cloneDirectory creates the target before it can fail; the strategy must
  // clean that partial tree up rather than leave a directory behind.
  await expect(lstat(target)).rejects.toThrow();
});

test.skipIf(cowRoot === undefined || !gitOnPath)("create rejects when the signal is already aborted", async () => {
  const { repo } = await makeScratchRepo(cowRoot!);
  const target = join(repo, "..", "clone");
  const controller = new AbortController();
  controller.abort();

  await expect(
    cowStrategy.create({ sourceDirectory: repo, directory: target }, { signal: controller.signal }),
  ).rejects.toThrow();
  await expect(lstat(target)).rejects.toThrow();
});

// The strategy pre-flights the same cross-device rule the tool applies, so a
// target on another filesystem fails with a message naming the cause and the
// remedy instead of a bare EXDEV mid-walk. The target parent is a real
// directory (so the nearest-existing walk lands on it) whose device the seam
// reports as a different number, so no second mount is required.
test("create rejects a cross-device target before cloning anything", async () => {
  const { repo } = await makeScratchRepo("/tmp");
  const otherDevice = await mkdtemp("/tmp/cow-other-device-");
  scratchDirs.push(otherDevice);
  const target = join(otherDevice, "clone");
  const signal = new AbortController().signal;
  const realDeviceOf = await import("../src/device").then((m) => m.deviceOf);
  const sourceDevice = await realDeviceOf(repo);
  const otherDeviceNumber = (sourceDevice ?? 0) + 1;
  // Report the target parent on a different device than the real source; all
  // other paths keep their real device.
  const probeDevice = async (path: string) =>
    path === otherDevice ? otherDeviceNumber : realDeviceOf(path);

  const spy = spyOn(await import("../src/device"), "deviceOf").mockImplementation(probeDevice);
  try {
    const error = await cowStrategy
      .create({ sourceDirectory: repo, directory: target }, { signal })
      .then(() => undefined, (failure: unknown) => failure as Error);

    expect(error).toBeDefined();
    expect(error?.message).toContain(`cow cannot clone ${repo} into ${otherDevice}`);
    expect(error?.message).toContain("different filesystem");
    expect(error?.message).toContain("worktree.directory");
    expect(error?.message).toContain("targetRoot");
    // Exit before the walk: cloneDirectory would have created the target.
    await expect(lstat(target)).rejects.toThrow();
  } finally {
    spy.mockRestore();
  }
});

test("create proceeds when source and target share a device", async () => {
  // A real scratch tree under a CoW root (when one exists) so the clone itself
  // runs; the device seam reports both sides the same. Without a CoW root the
  // clone fails for an unrelated reason, but the pre-flight must not be it.
  const { repo } = await makeScratchRepo(cowRoot ?? "/tmp");
  const target = join(repo, "..", "clone");
  const signal = new AbortController().signal;
  const realDeviceOf = await import("../src/device").then((m) => m.deviceOf);
  const sourceDevice = await realDeviceOf(repo);
  const probeDevice = async (path: string) => {
    const device = await realDeviceOf(path);
    // Report the target parent as the source's device: same-device, no reject.
    return path === join(repo, "..") ? sourceDevice : device;
  };

  const spy = spyOn(await import("../src/device"), "deviceOf").mockImplementation(probeDevice);
  try {
    // Same devices: the pre-flight never rejects, so on a CoW root the clone
    // runs to completion. Off a CoW root the clone's own wrapper is the only
    // acceptable failure — never the cross-device message.
    const error = await cowStrategy
      .create({ sourceDirectory: repo, directory: target }, { signal })
      .then(() => undefined, (failure: unknown) => failure as Error);

    expect(error?.message ?? "").not.toContain("different filesystem");
    if (error !== undefined) {
      expect(error.message).toContain("cow strategy failed to clone into");
    }
  } finally {
    spy.mockRestore();
  }
});

test("create proceeds when a device is unreadable, leaving the failure to the clone", async () => {
  // `deviceOf` returns undefined for a path it cannot read; that is "unknown",
  // not a mismatch, so the pre-flight must not fabricate a cross-device error
  // and the real clone attempt decides the outcome.
  const signal = new AbortController().signal;

  const error = await cowStrategy
    .create(
      { sourceDirectory: "/nowhere/source", directory: "/nowhere/clone" },
      { signal },
    )
    .then(() => undefined, (failure: unknown) => failure as Error);

  expect(error).toBeDefined();
  expect(error?.message).not.toContain("different filesystem");
  // It fails as the strategy's clone wrapper, not as a device rejection.
  expect(error?.message).toContain("cow strategy failed to clone into");
});

// --- post-create hooks (ticket 05) ---
//
// The hook tail runs after a successful clone, so these tests replace
// `cloneDirectory` with a stand-in that creates the target, exactly as the
// real one does before it can fail. That keeps every hook branch runnable —
// and the coverage gate satisfiable — on any filesystem, including CI where
// no CoW root exists. The commands themselves are real `sh -c` executions.

/** A plain scratch directory; no git and no CoW filesystem required. */
async function makeHookScratch(prefix: string): Promise<{ dir: string; source: string; target: string }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  const source = join(dir, "source");
  await mkdir(source);
  return { dir, source, target: join(dir, "clone") };
}

/** A cloneDirectory stand-in that creates the target, like the real one. */
function cloneCreatingTarget(): typeof cloneModule.cloneDirectory {
  return async (_source, target) => {
    await mkdir(target, { recursive: true });
  };
}

/** Runs a strategy's create with the real clone replaced. */
async function createWithFakeClone(
  strategy: typeof cowStrategy,
  source: string,
  target: string,
): Promise<{ directory: string } | undefined> {
  const spy = spyOn(cloneModule, "cloneDirectory").mockImplementation(cloneCreatingTarget());
  try {
    const signal = new AbortController().signal;
    return await strategy.create({ sourceDirectory: source, directory: target }, { signal });
  } finally {
    spy.mockRestore();
  }
}

test("with no hooks configured, create behaves exactly as before", async () => {
  const { source, target } = await makeHookScratch("cow-hooks-none-");

  const spy = spyOn(cloneModule, "cloneDirectory").mockImplementation(cloneCreatingTarget());
  try {
    const signal = new AbortController().signal;
    const result = await cowStrategy.create(
      { sourceDirectory: source, directory: target },
      { signal },
    );

    // The unhooked result, and nothing but the clone itself.
    expect(result).toEqual({ directory: target });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(source, target);
  } finally {
    spy.mockRestore();
  }
});

test("hooks run sequentially in the worktree, with both paths in the environment", async () => {
  const { source, target } = await makeHookScratch("cow-hooks-run-");
  const strategy = createCowStrategy({
    postCreate: [
      "printf one >> hook-order.txt",
      "printf two >> hook-order.txt",
      // Relative writes land in the worktree only if it is the command's cwd.
      'printf "%s" "$COW_WORKTREE_PATH" > hook-worktree.txt',
      'printf "%s" "$COW_SOURCE_DIRECTORY" > hook-source.txt',
    ],
  });

  await createWithFakeClone(strategy, source, target);

  expect(await readFile(join(target, "hook-order.txt"), "utf8")).toBe("onetwo");
  expect(await readFile(join(target, "hook-worktree.txt"), "utf8")).toBe(resolve(target));
  expect(await readFile(join(target, "hook-source.txt"), "utf8")).toBe(resolve(source));
});

test("the first hook failure names the command and step, removes the worktree, and stops", async () => {
  const { source, target } = await makeHookScratch("cow-hooks-fail-");
  const strategy = createCowStrategy({
    postCreate: ["true", "echo boom; exit 3", "printf nope > hook-after.txt"],
  });

  const error = await createWithFakeClone(strategy, source, target).then(
    () => undefined,
    (failure: unknown) => failure as Error,
  );

  expect(error).toBeInstanceOf(Error);
  expect(error?.message).toBe(
    "post-create hook failed (step 2 of 3): echo boom; exit 3 (exit code 3)\n" +
      "--- output ---\n" +
      "boom",
  );
  // No orphan clone: the just-created directory is gone, third hook never ran.
  await expect(lstat(target)).rejects.toThrow();
});

test("a hook's stderr is captured alongside its stdout", async () => {
  const { source, target } = await makeHookScratch("cow-hooks-err-");
  const strategy = createCowStrategy({ postCreate: ["printf out; printf err >&2; false"] });

  const error = await createWithFakeClone(strategy, source, target).then(
    () => undefined,
    (failure: unknown) => failure as Error,
  );

  expect(error?.message).toContain("post-create hook failed (step 1 of 1): printf out; printf err >&2; false (exit code 1)");
  expect(error?.message).toContain("--- output ---\nout\nerr");
});

// The hook runner's own mechanics — env absoluteness, stdin, the timeout
// kill shape — are pinned where the code lives, in test/hooks.test.ts.

test("a timed-out hook aborts creation, names the timeout, and removes the worktree", async () => {
  const { source, target } = await makeHookScratch("cow-hooks-timeout-");
  const strategy = createCowStrategy({ postCreate: ["sleep 30", "printf nope > hook-after.txt"] });
  // `runHookCommand` is the seam the timeout flows through; the killed shape
  // is what execFile's own timeout produces (pinned by the test above).
  const spy = spyOn(hooksModule, "runHookCommand").mockImplementation(
    async () => {
      throw Object.assign(new Error("sleep 30 killed by SIGTERM"), {
        killed: true,
        signal: "SIGTERM",
        code: null,
      });
    },
  );
  try {
    const error = await createWithFakeClone(strategy, source, target).then(
      () => undefined,
      (failure: unknown) => failure as Error,
    );

    // The spy must actually have been driven: a silent mock failure would
    // otherwise run the real 300s sleep.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(error?.message).toBe(
      "post-create hook failed (step 1 of 2): sleep 30 (timed out after 300s)",
    );
    await expect(lstat(target)).rejects.toThrow();
  } finally {
    spy.mockRestore();
  }
});

test("a hook killed by a signal names the signal", async () => {
  const { source, target } = await makeHookScratch("cow-hooks-signal-");
  const strategy = createCowStrategy({ postCreate: ["kill -TERM $$"] });
  // The shape execFile actually rejects with on a signal death (probed on
  // Bun 1.4.2): signal set, code null, killed false.
  const spy = spyOn(hooksModule, "runHookCommand").mockImplementation(async () => {
    throw Object.assign(new Error("terminated"), {
      signal: "SIGTERM",
      code: null,
      killed: false,
    });
  });
  try {
    const error = await createWithFakeClone(strategy, source, target).then(
      () => undefined,
      (failure: unknown) => failure as Error,
    );

    expect(error?.message).toBe(
      "post-create hook failed (step 1 of 1): kill -TERM $$ (terminated by SIGTERM)",
    );
  } finally {
    spy.mockRestore();
  }
});

test("a hook over the output limit is reported as an output limit", async () => {
  // Real mechanism: execFile's maxBuffer rejects with Bun's
  // ERR_CHILD_PROCESS_STDIO_MAXBUFFER (Node names it ENOBUFS) instead of the
  // kill shape, so the message says the output limit, not a signal or a
  // timeout.
  const { source, target } = await makeHookScratch("cow-hooks-maxbuf-");
  const strategy = createCowStrategy({ postCreate: ["head -c 2000000 /dev/zero"] });

  const error = await createWithFakeClone(strategy, source, target).then(
    () => undefined,
    (failure: unknown) => failure as Error,
  );

  expect(error?.message).toContain(
    "post-create hook failed (step 1 of 1): " +
      "head -c 2000000 /dev/zero (output limit exceeded (1 MiB))",
  );
  // Same leave-nothing-behind cleanup as any other hook failure.
  await expect(lstat(target)).rejects.toThrow();
});

test("a hook's oversized output is capped in the error message", async () => {
  // Half a megabyte of stdout, with the command still failing on its own exit
  // status: the message keeps the diagnosis, not the megabyte.
  const { source, target } = await makeHookScratch("cow-hooks-cap-");
  const strategy = createCowStrategy({
    postCreate: ["head -c 512000 /dev/zero | tr '\\0' y; false"],
  });

  const error = await createWithFakeClone(strategy, source, target).then(
    () => undefined,
    (failure: unknown) => failure as Error,
  );

  expect(
    error?.message.startsWith(
      "post-create hook failed (step 1 of 1): " +
        "head -c 512000 /dev/zero | tr '\\0' y; false (exit code 1)",
    ),
  ).toBe(true);
  expect(error?.message).toContain("…output truncated…");
  expect(error?.message.length).toBeLessThan(3000);
});

test("an unrecognized failure shape still names its code", async () => {
  // The defensive tail: a rejection carrying only a non-numeric code — no
  // real Bun 1.4.2 shape looks like this today — still says something usable
  // instead of "terminated by null".
  const { source, target } = await makeHookScratch("cow-hooks-odd-");
  const strategy = createCowStrategy({ postCreate: ["never runs"] });
  const spy = spyOn(hooksModule, "runHookCommand").mockImplementation(async () => {
    throw Object.assign(new Error("odd"), { code: "SIGUSR1" });
  });
  try {
    const error = await createWithFakeClone(strategy, source, target).then(
      () => undefined,
      (failure: unknown) => failure as Error,
    );

    expect(error?.message).toBe(
      "post-create hook failed (step 1 of 1): never runs (terminated by SIGUSR1)",
    );
  } finally {
    spy.mockRestore();
  }
});

test("a hook failure whose cleanup also fails still reports the hook error", async () => {
  const { source, target } = await makeHookScratch("cow-hooks-rmfail-");
  const strategy = createCowStrategy({ postCreate: ["echo boom; exit 3"] });
  // The stand-in clone leaves the target read-only after creating it, so the
  // failure path's `rm` cannot unlink the file inside and the cleanup itself
  // fails (as with an immutable or permission-blocked file).
  const spy = spyOn(cloneModule, "cloneDirectory").mockImplementation(
    async (_source, targetPath) => {
      await mkdir(targetPath, { recursive: true });
      await writeFile(join(targetPath, "stuck.txt"), "unremovable\n");
      await chmod(targetPath, 0o555);
    },
  );
  try {
    const signal = new AbortController().signal;
    const error = await strategy
      .create({ sourceDirectory: source, directory: target }, { signal })
      .then(() => undefined, (failure: unknown) => failure as Error);

    // The hook failure keeps first billing: command, step, exit code, output.
    expect(
      error?.message.startsWith(
        "post-create hook failed (step 1 of 1): echo boom; exit 3 (exit code 3)",
      ),
    ).toBe(true);
    expect(error?.message).toContain("Removing the worktree also failed");
    expect(error?.message).toContain(`the remains are left at ${target}`);
    // The primary hook cause stays chained.
    expect((error?.cause as { code?: number }).code).toBe(3);
    // The cleanup failed, so the remains genuinely are at the path.
    expect((await lstat(target)).isDirectory()).toBe(true);
  } finally {
    await chmod(target, 0o755);
    spy.mockRestore();
  }
});

test("plugin setup installs the post-create hooks from the options", async () => {
  const added: Added[] = [];
  await plugin.setup(
    fakeContext(added, { hooks: { postCreate: ["printf hooked > hook-marker.txt"] } }),
  );
  const { source, target } = await makeHookScratch("cow-hooks-wired-");

  // Drive the strategy the plugin actually registered, not the module import.
  const spy = spyOn(cloneModule, "cloneDirectory").mockImplementation(cloneCreatingTarget());
  try {
    const signal = new AbortController().signal;
    await added[0]!.definition.create(
      { sourceDirectory: source, directory: target },
      { signal },
    );
  } finally {
    spy.mockRestore();
  }
  expect(await readFile(join(target, "hook-marker.txt"), "utf8")).toBe("hooked");
});

test("plugin setup fails loudly on an invalid hooks option, registering nothing", async () => {
  const added: Added[] = [];

  await expect(plugin.setup(fakeContext(added, { hooks: "bogus" }))).rejects.toThrow(
    /invalid plugin option "hooks"/,
  );
  expect(added).toEqual([]);
});
