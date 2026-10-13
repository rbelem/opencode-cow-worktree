import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MARKER_NAME,
  OCCUPIED_AFTER_MS,
  occupancyDecision,
  parseMarker,
  probeOccupyingSession,
  writeMarkerFile,
} from "../src/occupancy";
import type { OccupancyMarker, ProbeResult } from "../src/occupancy";
import { probeUncommitted } from "../src/uncommitted";
import { hasGit } from "./fs-roots";

// The pure half of the occupancy guard (issue #15): the refusal table, the
// probe classifier, and the marker parser, pinned where they live
// (src/occupancy.ts) in the style of test/dirty.test.ts. Sessions carry no
// status field — `time.updated` (epoch ms) is the only liveness signal — so
// every row below is about what that one signal, or its absence, allows.

const ABSENT: ProbeResult = { kind: "absent" };
const ERROR: ProbeResult = { kind: "error" };

function live(updated: number): ProbeResult {
  return { kind: "live", updated };
}

function marker(sessionID: string): OccupancyMarker {
  return { sessionID };
}

test("a malformed marker refuses, whatever the probe says", () => {
  for (const probe of [ABSENT, live(0), ERROR]) {
    const decision = occupancyDecision({ marker: "malformed", probe, now: 1_000_000 });
    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") {
      expect(decision.reason).toContain("unparsable or names no session");
      expect(decision.reason).toContain("Pick another worktree name");
      expect(decision.reason).toContain("DELETE /api/session/<sessionID>");
      expect(decision.reason).toContain("remove the occupancy marker");
    }
  }
});

test("a probe error refuses: a failed lookup is not a positive absence", () => {
  const decision = occupancyDecision({ marker: marker("ses_old"), probe: ERROR, now: 0 });
  expect(decision.action).toBe("refuse");
  if (decision.action === "refuse") {
    expect(decision.reason).toContain("could not be checked");
    expect(decision.reason).toContain("Pick another worktree name");
    expect(decision.reason).toContain("DELETE /api/session/<sessionID>");
    expect(decision.reason).toContain("remove the occupancy marker");
  }
});

test("a probe error refuses even without a marker", () => {
  const decision = occupancyDecision({ marker: undefined, probe: ERROR, now: 0 });
  expect(decision.action).toBe("refuse");
});

test("a live record with an unusable time.updated refuses (fail closed)", () => {
  // Naive `now - updated` arithmetic over either value reads as endlessly
  // idle; the decision must refuse instead of going dormant.
  for (const updated of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const decision = occupancyDecision({ marker: marker("ses_old"), probe: live(updated), now: 0 });
    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") {
      expect(decision.reason).toContain("no usable last-activity time");
    }
  }
});

test("a fresh live session refuses, naming the holder and its age", () => {
  const now = OCCUPIED_AFTER_MS + 5_000;
  const decision = occupancyDecision({
    marker: marker("ses_old"),
    probe: live(OCCUPIED_AFTER_MS),
    now,
  });
  expect(decision.action).toBe("refuse");
  if (decision.action === "refuse") {
    expect(decision.reason).toContain("Session ses_old");
    expect(decision.reason).toContain("less than a minute");
    expect(decision.reason).toContain("Pick another worktree name");
    expect(decision.reason).toContain("DELETE /api/session/<sessionID>");
    expect(decision.reason).toContain("remove the occupancy marker");
  }
});

test("a live session exactly at the window's edge is still fresh", () => {
  // `<= OCCUPIED_AFTER_MS` is occupied: only strictly older activity clears.
  const decision = occupancyDecision({
    marker: marker("ses_old"),
    probe: live(0),
    now: OCCUPIED_AFTER_MS,
  });
  expect(decision.action).toBe("refuse");
});

test("a dormant live session proceeds and rewrites the stale marker", () => {
  const decision = occupancyDecision({
    marker: marker("ses_old"),
    probe: live(0),
    now: OCCUPIED_AFTER_MS + 1,
  });
  expect(decision).toEqual({ action: "proceed", rewrite: true });
});

test("a stale marker (probe 404) proceeds and rewrites", () => {
  const decision = occupancyDecision({ marker: marker("ses_old"), probe: ABSENT, now: 0 });
  expect(decision).toEqual({ action: "proceed", rewrite: true });
});

test("no marker proceeds without a rewrite — the legacy worktree", () => {
  const decision = occupancyDecision({ marker: undefined, probe: ABSENT, now: 0 });
  expect(decision).toEqual({ action: "proceed", rewrite: false });
});

test("no marker with a dormant session proceeds without a rewrite", () => {
  const decision = occupancyDecision({
    marker: undefined,
    probe: live(0),
    now: OCCUPIED_AFTER_MS + 1,
  });
  expect(decision).toEqual({ action: "proceed", rewrite: false });
});

test("the fresh refusal's decision reason names holder, age, and the recoveries", () => {
  // Single refusal path: the decision reason is the message body the tool
  // wraps, so it must carry the whole escape hatch on its own.
  const decision = occupancyDecision({
    marker: marker("ses_old"),
    probe: live(Date.now() - 30_000),
    now: Date.now(),
  });
  expect(decision.action).toBe("refuse");
  if (decision.action === "refuse") {
    expect(decision.reason).toContain("Session ses_old");
    expect(decision.reason).toContain("less than a minute");
    expect(decision.reason).toContain("Pick another worktree name");
    expect(decision.reason).toContain("DELETE /api/session/<sessionID>");
    expect(decision.reason).toContain("remove the occupancy marker");
  }
});

test("an unanswerable clock never reads as fresh", () => {
  // A negative or non-finite idle (an injected `now` behind the record, or
  // garbage) must refuse, not fall through to the dormant proceed.
  for (const now of [Number.NaN, -1]) {
    const decision = occupancyDecision({ marker: marker("ses_old"), probe: live(0), now });
    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") {
      expect(decision.reason).toContain("an unknown amount of time");
    }
  }
});

// The probe classifier: one `sessionGet` call, four verdicts.

test("a not-found throw with the verified _tag counts as absent", async () => {
  const verdict = await probeOccupyingSession(async () => {
    throw Object.assign(new Error("Session not found"), { _tag: "SessionNotFoundError" });
  }, "ses_old");
  expect(verdict).toEqual({ kind: "absent" });
});

test("the plugin-side dotted tag with an empty message counts as absent too", async () => {
  // Verified against the running binary: the plugin-side lookup throws
  // `_tag: "Session.NotFoundError"` with no message, while the HTTP payload
  // spells the same 404 `SessionNotFoundError`.
  const verdict = await probeOccupyingSession(async () => {
    throw Object.assign(new Error(""), { _tag: "Session.NotFoundError" });
  }, "ses_old");
  expect(verdict).toEqual({ kind: "absent" });
});

test("a throw that merely says Session not found is not a positive absence", async () => {
  // No message matching: an unrelated gateway error that phrases itself like
  // a 404 must refuse, not clear the worktree.
  const verdict = await probeOccupyingSession(async () => {
    throw new Error("Session not found");
  }, "ses_old");
  expect(verdict).toEqual({ kind: "error" });
});

test("any other throw is a probe error", async () => {
  const verdict = await probeOccupyingSession(async () => {
    throw new Error("503 upstream");
  }, "ses_old");
  expect(verdict).toEqual({ kind: "error" });
});

test("a null or undefined answer counts as absent", async () => {
  expect(await probeOccupyingSession(async () => undefined, "ses_old")).toEqual({ kind: "absent" });
  expect(await probeOccupyingSession(async () => null, "ses_old")).toEqual({ kind: "absent" });
});

test("any other non-conforming answer refuses, never clears", async () => {
  // Only null/undefined are positive absences from a resolved answer. A
  // non-object primitive or a body without a string id proves nothing about
  // the session, so it must refuse — an id-less object clearing a live
  // worktree is exactly the fail-open the classifier exists to prevent.
  for (const answer of ["x", 42, {}, { id: 42 }]) {
    expect(await probeOccupyingSession(async () => answer, "ses_old")).toEqual({ kind: "error" });
  }
});

test("a live record needs a usable epoch-milliseconds time.updated", async () => {
  expect(await probeOccupyingSession(async () => ({ id: "s", time: { updated: 5_000 } }), "s")).toEqual({
    kind: "live",
    updated: 5_000,
  });
  // Missing, non-numeric, negative, and non-finite values are never live: a
  // malformed 200 must not become dormancy.
  for (const time of [undefined, { updated: "soon" }, { updated: -1 }, { updated: Number.NaN }]) {
    expect(await probeOccupyingSession(async () => ({ id: "s", time }), "s")).toEqual({
      kind: "error",
    });
  }
});

// The marker parser.

test("an absent file is no marker", () => {
  expect(parseMarker(undefined)).toBeUndefined();
});

test("a marker parses to its session id, keeping startedAt when present", () => {
  expect(parseMarker('{"sessionID":"ses_old"}')).toEqual({ sessionID: "ses_old" });
  expect(parseMarker('{"sessionID":"ses_old","startedAt":"2026-09-14T00:00:00.000Z"}')).toEqual({
    sessionID: "ses_old",
    startedAt: "2026-09-14T00:00:00.000Z",
  });
});

test("unparsable JSON, an empty sessionID, or a non-object is malformed", () => {
  for (const raw of ["{not json", "", "null", '"ses_old"', "[]", '{"sessionID":""}', '{}']) {
    expect(parseMarker(raw)).toBe("malformed");
  }
});

// The file half. Plain tmpdirs: the exclude write needs only a writable
// directory, and the git-exclude pin below needs the real git binary.

const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

test("writeMarker creates the marker, then rewrites it for the next session", async () => {
  const dir = await scratchDir("cow-occ-write-");
  await writeMarkerFile(dir, "ses_one");
  const first = JSON.parse(await readFile(join(dir, MARKER_NAME), "utf8")) as {
    sessionID: string;
    startedAt?: string;
  };
  expect(first.sessionID).toBe("ses_one");
  expect(typeof first.startedAt).toBe("string");

  await writeMarkerFile(dir, "ses_two");
  const second = JSON.parse(await readFile(join(dir, MARKER_NAME), "utf8")) as {
    sessionID: string;
  };
  expect(second.sessionID).toBe("ses_two");
});

test("the exclude entry is idempotent: two writes, one entry", async () => {
  const dir = await scratchDir("cow-occ-exclude-");
  await writeMarkerFile(dir, "ses_one");
  await writeMarkerFile(dir, "ses_two");

  const exclude = await readFile(join(dir, ".git", "info", "exclude"), "utf8");
  const entries = exclude.split("\n").filter((line) => line.trim() === MARKER_NAME);
  expect(entries).toEqual([MARKER_NAME]);
  expect(exclude).toContain("# opencode-cow-worktree occupancy marker");
});

test("the exclude entry is appended to an existing exclude file", async () => {
  const dir = await scratchDir("cow-occ-append-");
  await mkdir(join(dir, ".git", "info"), { recursive: true });
  await writeFile(join(dir, ".git", "info", "exclude"), "node_modules/\n", "utf8");

  await writeMarkerFile(dir, "ses_one");
  const exclude = await readFile(join(dir, ".git", "info", "exclude"), "utf8");
  expect(exclude.split("\n")[0]).toBe("node_modules/");
  expect(exclude).toContain(MARKER_NAME);
});

test.skipIf(!hasGit())(
  "the marker stays out of git status: probeUncommitted reads clean after a write",
  async () => {
    // The whole point of the exclude line: a marked worktree must not look
    // dirty. A positive `[]` — not the unknown of a failed probe — proves the
    // metadata was read and the marker is ignored.
    const dir = await scratchDir("cow-occ-git-");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    await writeFile(join(dir, "tracked.txt"), "committed\n");
    git("add", "-A");
    git("commit", "-qm", "scratch");

    await writeMarkerFile(dir, "ses_one");
    expect(await probeUncommitted(dir)).toEqual([]);
  },
);
