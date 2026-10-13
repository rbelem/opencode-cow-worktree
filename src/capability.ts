import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { reflinkFile } from "./clone";

/**
 * The outcome of a CoW capability probe.
 *
 * - `supported`: a clone attempt succeeded.
 * - `unsupported`: the clone attempt failed in a way that definitively means
 *   the filesystem cannot satisfy a CoW clone.
 * - `error`: any other failure — permissions, a missing path, I/O. Never
 *   collapsed into `unsupported`.
 */
export type CowCapability =
  | { readonly status: "supported" }
  | { readonly status: "unsupported" }
  | { readonly status: "error"; readonly error: Error };

/**
 * Performs one clone of `source` onto `destination`, throwing on failure.
 * Injectable so tests can drive the unsupported and error branches without a
 * filesystem that lacks CoW support.
 */
export type CowCloneAttempt = (
  source: string,
  destination: string,
) => Promise<void>;

/**
 * Default clone operation: `reflinkFile`, which is the platform's forced CoW
 * clone — `COPYFILE_FICLONE_FORCE` on Linux, `copyfile(3)` with
 * `COPYFILE_CLONE_FORCE` on macOS. Both fail instead of silently degrading to a
 * byte copy, which is the semantics this predicate needs; a best-try flag would
 * report `supported` on a filesystem without CoW support.
 */
const cloneWithReflink: CowCloneAttempt = reflinkFile;

const PROBE_PREFIX = ".opencode-cow-capability-";

/** Failures that definitively mean the clone operation is not supported. */
const NOT_SUPPORTED_CODES = new Set([
  "EOPNOTSUPP",
  "ENOTSUP",
  "ENOTTY",
  "EINVAL",
  "EXDEV",
  "ENOSYS",
]);

const cache = new Map<string, Promise<CowCapability>>();

/**
 * Answers whether `directory`'s filesystem can satisfy a CoW clone, by
 * attempting one of a small temporary file inside that directory. Never throws:
 * a failure is reported as `unsupported` or `error`. Terminal verdicts
 * (`supported`, `unsupported`) are cached per directory; an `error` verdict is
 * deliberately not — it is the one class defined as transient (permissions, a
 * missing path, an I/O hiccup), so caching it would disable this directory
 * until the server restarted over one bad moment. Concurrent first callers
 * share the one in-flight probe, and only its terminal verdict is kept.
 */
export function probeCowCapability(
  directory: string,
  attempt: CowCloneAttempt = cloneWithReflink,
): Promise<CowCapability> {
  const cached = cache.get(directory);
  if (cached !== undefined) return cached;
  const pending = probe(directory, attempt);
  // Stored before the first await so concurrent callers share this probe
  // instead of each starting their own. When it settles on `error`, the entry
  // is dropped: this call and every caller sharing the probe still receive
  // the verdict, but the next call probes again instead of replaying a
  // transient failure forever. The identity check means the eviction can only
  // remove this probe's own entry, never a verdict a newer probe already
  // replaced it with.
  cache.set(directory, pending);
  void pending.then((verdict) => {
    if (verdict.status === "error" && cache.get(directory) === pending) {
      cache.delete(directory);
    }
  });
  return pending;
}

async function probe(
  directory: string,
  attempt: CowCloneAttempt,
): Promise<CowCapability> {
  try {
    return await attemptClone(directory, attempt);
  } catch (error) {
    return { status: "error", error: toError(error) };
  }
}

async function attemptClone(
  directory: string,
  attempt: CowCloneAttempt,
): Promise<CowCapability> {
  const scratch = await mkdtemp(join(directory, PROBE_PREFIX));
  try {
    const source = join(scratch, "source");
    await writeFile(source, "opencode-cow-worktree");
    await attempt(source, join(scratch, "clone"));
    return { status: "supported" };
  } catch (error) {
    return classifyCloneFailure(error);
  } finally {
    // The cleanup is best-effort and runs in its own guard: the scratch is
    // dot-prefixed, tiny, and inside the probed directory, so a failed `rm`
    // (say, EACCES on a suddenly read-only parent) is not a capability fact
    // and must never mask the verdict above — least of all by turning a
    // `supported` answer into an `error`.
    try {
      await rm(scratch, { recursive: true, force: true });
    } catch {
      // A leftover scratch is harmless; the verdict stands as reported.
    }
  }
}

function classifyCloneFailure(error: unknown): CowCapability {
  const code = errorCode(error);
  if (code !== undefined && NOT_SUPPORTED_CODES.has(code)) {
    return { status: "unsupported" };
  }
  return { status: "error", error: toError(error) };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error as { code?: unknown };
    if (typeof code === "string") return code;
  }
  return undefined;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
