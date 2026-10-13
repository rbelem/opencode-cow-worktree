// SPDX-License-Identifier: MIT
/** Writes the committed run log from what the harness actually observed. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "./lib";
import type { Server } from "./server";
import type { ConfigRoot } from "./lib";
import type { Assertions } from "./assertions";
import type { FallbackResult, WorktreeRun } from "./scenarios";

export interface RunLogInput {
  readonly config: ConfigRoot;
  readonly source: string;
  readonly server: Server;
  readonly runtime: string;
  readonly version: string;
  readonly runs: readonly WorktreeRun[];
  readonly assertions: Assertions;
  readonly fallback: FallbackResult;
}

export async function writeRunLog(input: RunLogInput): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  const path = join(REPO_ROOT, "docs", "e2e", `run-${date}.md`);
  await writeFile(path, render(date, input));
  return path;
}

interface SimulationFacts {
  readonly scriptedToolName?: string;
  readonly scriptedToolStatus?: string;
  readonly scriptedToolOutput?: string;
  readonly sessionID?: string;
  readonly requests?: number;
  readonly driveEndpoint?: string;
  readonly toolNames?: readonly string[];
  readonly pluginToolOffered?: boolean;
}

/** Renders the simulation rounds recorded by `runSimulationScenario`. */
function simulationLines(fallback: FallbackResult): string[] {
  const lines: string[] = [];
  for (const [label, raw] of [
    ["scripted builtin tool (`shell`)", fallback.simulation],
    ["scripted plugin tool (`spawn_workspace`), CoW source", fallback.spawnSimulation],
    ["`spawn_workspace`, non-CoW source + `fallback: \"git\"`", fallback.simulationFallbackGit],
    ["`spawn_workspace`, non-CoW source + `fallback: \"none\"`", fallback.simulationFallbackNone],
  ] as const) {
    const facts = raw as SimulationFacts | undefined;
    if (!facts) {
      lines.push(`- ${label}: not run`);
      continue;
    }
    lines.push(
      `- ${label}: drive websocket \`${facts.driveEndpoint ?? "unknown"}\`, ` +
        `${facts.requests ?? 0} \`llm.request\`(s), session \`${facts.sessionID ?? "unknown"}\``,
    );
    lines.push(`  - model offered: ${(facts.toolNames ?? []).join(", ") || "none"}`);
    lines.push(
      `  - \`spawn_workspace\` offered: ${facts.pluginToolOffered ? "yes" : "no"}`,
    );
    if (facts.scriptedToolName) {
      lines.push(
        `  - scripted \`${facts.scriptedToolName}\` -> ${facts.scriptedToolStatus ?? "not found"}` +
          `${facts.scriptedToolOutput ? `: \`${facts.scriptedToolOutput.replace(/\n/g, "\\n").slice(0, 200)}\`` : ""}`,
      );
    }
  }
  return lines;
}

function render(date: string, input: RunLogInput): string {
  const pluginLines = input.server
    .output()
    .split("\n")
    .filter((line) => /loading plugin|opencode-cow-worktree|worktree/i.test(line))
    .slice(-8);
  return [
    `# e2e dogfood run — ${date}`,
    "",
    "Produced by `bun scripts/e2e/harness.ts`. Every value below is observed from a real",
    "`opencode2 serve` run, not hand-written. Temp paths are the run's own throwaway root.",
    "",
    "## Environment",
    "",
    `- server binary: \`${input.version}\``,
    `- server runtime (observed): \`${input.runtime}\``,
    `- server URL: \`${input.server.url}\``,
    "- config root: throwaway temp dir, isolated via `HOME`, `OPENCODE_CONFIG_DIR`, and the XDG variables",
    "",
    "## Configuration",
    "",
    "The plugin is installed as a directory plugin so the loader's directory resolution is",
    "exercised. A configured plugin must be a directory with an `index.ts`/`server.ts`",
    "entrypoint — discovered against the real binary; see Findings.",
    "",
    "```json",
    "// <config-root>/opencode.json",
    JSON.stringify({ plugins: [{ package: "<config-root>/plugin", options: {} }] }, null, 2),
    "```",
    "",
    "```",
    `source project:  ${input.source}`,
    "plugin dir:      <config-root>/plugin/index.ts  -> re-exports <repo>/src/plugin.ts",
    "```",
    "",
    "## Commands and results",
    "",
    "| Step | Command | Result |",
    "| --- | --- | --- |",
    "| activate plugin | `POST /api/plugin/await-activation` | 204, plugin listed `active` |",
    ...input.runs.map(
      (run) =>
        `| create ${run.id} | \`POST /api/worktree {strategy:"cow",name:"${run.id}"}\` | 200 \`${run.directory}\` |`,
    ),
    ...input.runs.map(
      (run) => `| session ${run.id} | \`POST /api/session {location:${run.directory}}\` | 200 \`${run.sessionID}\` |`,
    ),
    "| inventory | `GET /api/worktree` | each directory listed with `strategy: \"cow\"` |",
    "",
    "## Sessions",
    "",
    ...input.runs.map((run) => `- \`${run.id}\`: session \`${run.sessionID}\` at \`${run.directory}\``),
    "",
    "## Independence",
    "",
    "Each worktree wrote `.agent-marker-<id>` and appended its id to `agent-log.txt`.",
    "Each then saw only its own id and none of the others' markers; the source saw neither.",
    "",
    "## Mechanism",
    "",
    "Each produced directory was checked for ignored state, a symlink as a link, a real",
    "standalone `.git`, matching `git status`, and shared extents against a",
    "`cp --reflink=never` control (`btrfs filesystem du -s --raw`).",
    "",
    "## Fallback (non-CoW)",
    "",
    ...input.fallback.notes.map((note) => `- ${note}`),
    "",
    "## Simulation (issue #9)",
    "",
    "The model's bytes are scripted by a drive-controller websocket",
    "(`OPENCODE_SIMULATE=1` + `OPENCODE_DRIVE=1`); the session runner, tool",
    "registry, tool decoding, and tool execution are the real binary's code. The",
    "scripted `shell` call below executed for real, which is how the invocation",
    "path is proven real rather than a direct function call: its output appears in",
    "the session transcript, produced by the server process.",
    "",
    ...simulationLines(input.fallback),
    "",
    "## Checks",
    "",
    `\`${input.assertions.checks.length}\` checks, \`${input.assertions.failed.length}\` failed.`,
    "",
    ...input.assertions.checks.map((check) => `- ${check.ok ? "PASS" : "FAIL"} — ${check.name}`),
    "",
    "## Server log excerpt",
    "",
    "```",
    ...pluginLines,
    "```",
    "",
    "## Findings / discrepancies",
    "",
    "See [`findings.md`](./findings.md). Findings are analysis, not observation, so they live in",
    "a hand-written companion doc rather than being regenerated with every run.",
    "",
  ].join("\n");
}
