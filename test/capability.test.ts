import { expect, test } from "bun:test";
import { constants } from "node:fs";
import { chmod, copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { probeCowCapability, type CowCloneAttempt } from "../src/capability";

// The unsupported branch is produced by substituting the clone operation
// (CowCloneAttempt) — the only filesystem operation the predicate performs. A
// non-CoW filesystem cannot be mounted reliably without root, so stubbing the
// clone operation is the portable choice; the supported branch keeps a real
// filesystem test at the bottom.

function codedError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

const failedAttempt =
  (code: string): CowCloneAttempt =>
  async () => {
    throw codedError(code);
  };

const NOT_SUPPORTED = ["EOPNOTSUPP", "ENOTSUP", "EINVAL", "EXDEV", "ENOSYS"];
const UNEXPECTED = ["EACCES", "ENOENT", "EIO", "EPERM"];

function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cow-capability-"));
}

for (const code of NOT_SUPPORTED) {
  test(`reports unsupported when the clone fails with ${code}`, async () => {
    const dir = await scratchDir();
    try {
      const result = await probeCowCapability(dir, failedAttempt(code));
      expect(result).toEqual({ status: "unsupported" });
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

for (const code of UNEXPECTED) {
  test(`reports an error when the clone fails with ${code}`, async () => {
    const dir = await scratchDir();
    try {
      const result = await probeCowCapability(dir, failedAttempt(code));
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error).toHaveProperty("code", code);
      }
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("reports an error when the clone throws a plain Error without a code", async () => {
  // The coded-error branch above classifies by `code`; this covers the other
  // shape a filesystem failure can take — an Error with no `.code` at all,
  // which must land in `error`, not `unsupported`.
  const dir = await scratchDir();
  try {
    const plain = new Error("plain failure");
    const attempt: CowCloneAttempt = async () => {
      throw plain;
    };
    const result = await probeCowCapability(dir, attempt);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toBe(plain);
    }
    expect(await readdir(dir)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reports an error, without throwing, for a missing directory", async () => {
  const parent = await scratchDir();
  try {
    const result = await probeCowCapability(join(parent, "missing"));
    expect(result.status).toBe("error");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("caches per source directory without changing the answer", async () => {
  const dir = await scratchDir();
  try {
    let calls = 0;
    const attempt: CowCloneAttempt = async () => {
      calls += 1;
    };
    const first = await probeCowCapability(dir, attempt);
    const second = await probeCowCapability(dir, attempt);
    expect(first).toEqual({ status: "supported" });
    expect(second).toEqual({ status: "supported" });
    expect(calls).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- cache lifetime (ticket 09) ---
//
// `error` is the one verdict class defined as transient, so it must never be
// cached: one bad moment at first probe would otherwise disable the
// directory until the server restarted. Terminal verdicts stay cached.

test("an error verdict is not cached: the next call probes again", async () => {
  const dir = await scratchDir();
  try {
    let calls = 0;
    const attempt: CowCloneAttempt = async () => {
      calls += 1;
      if (calls === 1) throw codedError("EIO");
    };

    const first = await probeCowCapability(dir, attempt);
    expect(first.status).toBe("error");
    // The transient failure did not stick: the second call runs a fresh
    // probe (the attempt is invoked a second time) and reports the real
    // answer.
    const second = await probeCowCapability(dir, attempt);
    expect(second).toEqual({ status: "supported" });
    expect(calls).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unsupported verdict stays cached: the attempt is not invoked again", async () => {
  const dir = await scratchDir();
  try {
    let calls = 0;
    const attempt: CowCloneAttempt = async () => {
      calls += 1;
      throw codedError("ENOTSUP");
    };

    const first = await probeCowCapability(dir, attempt);
    const second = await probeCowCapability(dir, attempt);
    expect(first).toEqual({ status: "unsupported" });
    expect(second).toEqual({ status: "unsupported" });
    expect(calls).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent calls share one in-flight probe", async () => {
  const dir = await scratchDir();
  try {
    let calls = 0;
    let release: (() => void) | undefined;
    const gated = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Hold the first probe open so the second call arrives while it is still
    // in flight — the window where a verdict-based cache (store only after
    // classification) would find nothing cached and start a second probe.
    const attempt: CowCloneAttempt = async () => {
      calls += 1;
      await gated;
    };

    const first = probeCowCapability(dir, attempt);
    const second = probeCowCapability(dir, attempt);
    release!();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toEqual({ status: "supported" });
    expect(b).toEqual({ status: "supported" });
    expect(calls).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A scratch `rm` that fails (here: the probed directory is made read-only
// mid-probe, so unlinking the dot-prefixed scratch from it gets EACCES) is
// not a capability fact and must never mask the verdict. Root ignores the
// permission bit, so the interleaving cannot be produced there.
const asRoot = (process.getuid?.() ?? 0) === 0;

test.skipIf(asRoot)("a failing scratch cleanup still yields supported", async () => {
  const dir = await scratchDir();
  try {
    const attempt: CowCloneAttempt = async () => {
      // Runs after the probe has created its scratch and written its source
      // but before the probe's `finally` — exactly the window needed to make
      // the cleanup fail while the clone attempt itself succeeds.
      await chmod(dir, 0o500);
    };

    const result = await probeCowCapability(dir, attempt);

    expect(result).toEqual({ status: "supported" });
    // Proof the cleanup really failed rather than the pin testing nothing:
    // the dot-prefixed scratch survived the probe.
    const leftovers = await readdir(dir);
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0]).toMatch(/^\.opencode-cow-capability-/);
  } finally {
    await chmod(dir, 0o700);
    await rm(dir, { recursive: true, force: true });
  }
});

// --- supported branch, against a real copy-on-write filesystem ---

/** Independent ground truth: does a raw forced clone work in `dir`? */
async function cloneSucceeds(dir: string): Promise<boolean> {
  let scratch: string;
  try {
    scratch = await mkdtemp(join(dir, "cow-capability-ground-truth-"));
  } catch {
    return false;
  }
  try {
    const source = join(scratch, "source");
    await writeFile(source, "x");
    await copyFile(
      source,
      join(scratch, "clone"),
      constants.COPYFILE_FICLONE_FORCE,
    );
    return true;
  } catch {
    return false;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function findCowBase(): Promise<string | undefined> {
  for (const base of [homedir(), tmpdir(), process.cwd()]) {
    if (await cloneSucceeds(base)) return base;
  }
  return undefined;
}

const cowBase = await findCowBase();

test.skipIf(cowBase === undefined)(
  "reports supported on a copy-on-write filesystem",
  async () => {
    const dir = await mkdtemp(join(cowBase!, "supported-"));
    try {
      expect(await probeCowCapability(dir)).toEqual({ status: "supported" });
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
