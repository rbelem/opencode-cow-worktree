/**
 * The occupancy guard for `spawn_workspace` (issue #15): a cow worktree carries
 * a marker naming the session that holds it, and an attach refuses while that
 * session is still alive.
 *
 * The decision half is pure and table-driven, in the style of `dirty.ts`, so
 * the refusal table is testable without a filesystem or opencode2. The probe
 * half classifies one session lookup; the file half owns the marker file and
 * the git exclude entry that keeps it out of `git status`.
 *
 * opencode2 sessions persist after completion and carry no status field — the
 * record's `time.updated` (epoch milliseconds) is the only liveness signal a
 * probe gets (verified against 0.0.0-next-20260912.3). Dormancy is therefore a
 * time judgement, not a state read, and the guard fails closed wherever that
 * judgement cannot be made: a probe that errors, and a record whose
 * `time.updated` is missing or unusable, both refuse.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The worktree-root file naming the session that holds the worktree. */
export const MARKER_NAME = ".cow-session.json";

/**
 * How long a session may stay silent before it no longer counts as holding a
 * worktree. `time.updated` advances at message writes only (probe 2026-09-14:
 * exactly 2 distinct values across a completed sim turn), so a turn silent
 * longer than this window false-clears; false clearance is the worse
 * direction, so the window is set to the generous end.
 */
export const OCCUPIED_AFTER_MS = 60 * 60 * 1000;

/**
 * The marker payload. `startedAt` is informational, written for a human
 * reading the file: decisions never compare it against the server's
 * `time.updated` — the two come from different clocks.
 */
export interface OccupancyMarker {
  readonly sessionID: string;
  readonly startedAt?: string;
}

/** A marker file read's three answers: a marker, no marker, or an unusable one. */
export type ParsedMarker = OccupancyMarker | undefined | "malformed";

/** What one probe of the marker's session reported. */
export type ProbeResult =
  | { readonly kind: "absent" }
  | { readonly kind: "live"; readonly updated: number }
  | { readonly kind: "error" };

/** Whether the attach may proceed, and why not when it may not. */
export type OccupancyDecision =
  | { readonly action: "refuse"; readonly reason: string }
  | { readonly action: "proceed"; readonly rewrite: boolean };

/**
 * The three ways out of an occupancy refusal, spelled out in full because the
 * refusal is the only place the guard explains itself. Exactly three, in the
 * order a blocked caller reaches for them.
 */
export const RECOVERIES =
  "Pick another worktree name; delete the occupying session out of band " +
  "(DELETE /api/session/<sessionID> against this server); or remove the " +
  `occupancy marker (${MARKER_NAME}) from the worktree root if you know it is stale.`;

/**
 * Parses a marker file's raw content. An absent file is `undefined`; anything
 * that does not parse as JSON, or that names no session, is `"malformed"` —
 * the guard cannot tell who holds the worktree, so it will not guess.
 */
export function parseMarker(raw: string | undefined): ParsedMarker {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "malformed";
  }
  if (typeof parsed !== "object" || parsed === null) return "malformed";
  const sessionID = (parsed as { sessionID?: unknown }).sessionID;
  if (typeof sessionID !== "string" || sessionID.length === 0) return "malformed";
  const startedAt = (parsed as { startedAt?: unknown }).startedAt;
  return typeof startedAt === "string" ? { sessionID, startedAt } : { sessionID };
}

/**
 * Classifies one `sessionGet` probe of the session a marker names.
 *
 * The verified server contract: an absent id makes the lookup throw with
 * `_tag: "SessionNotFoundError"` (HTTP 404), which is a *positive* absence —
 * the one answer that proves the worktree free. A resolved `null` or
 * `undefined` counts as absent too. Anything else is an unanswerable probe: a
 * throw with any other tag, a non-object body, or a body without a string id
 * all refuse rather than guess, and so does a body whose `time.updated` is not
 * a usable epoch-milliseconds number — a malformed 200 must never become
 * dormancy, because naive `now - updated` arithmetic over a missing or
 * non-numeric value would read as endlessly idle.
 */
export async function probeOccupyingSession(
  sessionGet: (id: string) => Promise<unknown>,
  sessionID: string,
): Promise<ProbeResult> {
  let answer: unknown;
  try {
    answer = await sessionGet(sessionID);
  } catch (cause) {
    return isSessionNotFound(cause) ? { kind: "absent" } : { kind: "error" };
  }
  if (answer === null || answer === undefined) return { kind: "absent" };
  if (typeof answer !== "object") return { kind: "error" };
  const record = answer as { id?: unknown; time?: { updated?: unknown } };
  if (typeof record.id !== "string") return { kind: "error" };
  const updated = record.time?.updated;
  return typeof updated === "number" && Number.isFinite(updated) && updated >= 0
    ? { kind: "live", updated }
    : { kind: "error" };
}

function isSessionNotFound(cause: unknown): boolean {
  // The only positive-absence signals from a throw, both verified: the HTTP
  // payload tags the 404 `SessionNotFoundError`, while the error the
  // plugin-side lookup throws is `Session.NotFoundError` with an empty
  // message. No message matching: a substring is not a tag, and an unrelated
  // gateway error that happens to phrase itself like a 404 must refuse, not
  // clear the worktree.
  return (
    typeof cause === "object" &&
    cause !== null &&
    ((cause as { _tag?: unknown })._tag === "SessionNotFoundError" ||
      (cause as { _tag?: unknown })._tag === "Session.NotFoundError")
  );
}

/**
 * The occupancy decision table.
 *
 * Refusals, in the order checked: a malformed marker (the holder is unknown),
 * a probe error (a failed lookup is not a positive absence), a live record
 * whose `time.updated` is unusable (fail closed — the naive arithmetic would
 * call it dormant), and a live record still inside the occupancy window.
 * Otherwise the attach proceeds; `rewrite` says whether an old marker is being
 * replaced — a stale one the probe proved dead, or a dormant one past the
 * window — as opposed to a first marker for a worktree that never had one.
 */
export function occupancyDecision(input: {
  readonly marker: ParsedMarker;
  readonly probe: ProbeResult;
  readonly now: number;
}): OccupancyDecision {
  if (input.marker === "malformed") {
    return {
      action: "refuse",
      reason: `the occupancy marker is unparsable or names no session, so the holder is unknown. ${RECOVERIES}`,
    };
  }
  if (input.probe.kind === "error") {
    return {
      action: "refuse",
      reason: `the session holding this worktree could not be checked, and a failed lookup is not proof it is gone. ${RECOVERIES}`,
    };
  }
  if (input.probe.kind === "live") {
    const updated = input.probe.updated;
    // Deliberate defense-in-depth, not dead code: the classifier already maps
    // an unusable `updated` to a probe error, so this row only fires if that
    // classification ever drifts.
    if (!Number.isFinite(updated) || updated < 0) {
      return {
        action: "refuse",
        reason: `the session holding this worktree reports no usable last-activity time. ${RECOVERIES}`,
      };
    }
    const idle = input.now - updated;
    if (!Number.isFinite(idle) || idle <= OCCUPIED_AFTER_MS) {
      const holder = input.marker === undefined ? "A session" : `Session ${input.marker.sessionID}`;
      return { action: "refuse", reason: occupiedMessage(holder, idle) };
    }
  }
  return { action: "proceed", rewrite: input.marker !== undefined };
}

function occupiedMessage(holder: string, idleMs: number): string {
  return `${holder} appears to still be using it — its last activity was ${humanAge(idleMs)} ago. ${RECOVERIES}`;
}

/** A last-active age in human form; an unanswerable age never reads as fresh. */
function humanAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "an unknown amount of time";
  if (ms < 60_000) return "less than a minute";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} minute(s)`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour(s)`;
  return `${Math.floor(hours / 24)} day(s)`;
}

// The file half: the marker file and its git exclude entry. Read failures
// other than "not there" propagate — an unreadable marker is not evidence of a
// free worktree — and write failures propagate to the caller's warning path.

const EXCLUDE_APPEND = `\n# opencode-cow-worktree occupancy marker\n${MARKER_NAME}\n`;

/**
 * The raw marker file's content, or `undefined` when there is none. Any other
 * read failure (permissions, an obstacle in the path) propagates.
 */
export async function readMarkerFile(directory: string): Promise<string | undefined> {
  try {
    return await readFile(join(directory, MARKER_NAME), "utf8");
  } catch (cause) {
    if (isNotFound(cause)) return undefined;
    throw cause;
  }
}

/**
 * Writes the marker naming `sessionID`, first ensuring the worktree's
 * `.git/info/exclude` ignores the marker file — the exclude line goes in
 * before the marker exists, so `git status` never sees it, not even in the
 * moment between the two writes. Both steps are idempotent, and both
 * propagate their failures: the caller demotes them to a warning, never a
 * failed spawn.
 */
export async function writeMarkerFile(directory: string, sessionID: string): Promise<void> {
  await ensureGitExclude(directory);
  const marker: OccupancyMarker = { sessionID, startedAt: new Date().toISOString() };
  await writeFile(join(directory, MARKER_NAME), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

async function ensureGitExclude(directory: string): Promise<void> {
  const excludePath = join(directory, ".git", "info", "exclude");
  const current = await readFile(excludePath, "utf8").catch((cause) => {
    if (isNotFound(cause)) return undefined;
    throw cause;
  });
  if (current !== undefined && hasExcludeEntry(current)) return;
  await mkdir(dirname(excludePath), { recursive: true });
  await writeFile(excludePath, (current ?? "") + EXCLUDE_APPEND, "utf8");
}

/** Whether the exclude already carries the marker entry as its own line. */
function hasExcludeEntry(content: string): boolean {
  return content.split("\n").some((line) => line.trim() === MARKER_NAME);
}

function isNotFound(cause: unknown): boolean {
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT"
  );
}
