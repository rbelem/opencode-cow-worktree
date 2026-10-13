#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
/**
 * e2e dogfood harness for opencode-cow-worktree (issue #8).
 *
 * Starts a real `opencode2 serve` against a throwaway config root, installs the
 * plugin by directory, activates it, then fans out worktrees through the real
 * HTTP API and proves the produced directories are independent Deep clones.
 *
 * Run: `bun scripts/e2e/harness.ts [--keep]`
 *
 * The harness never touches the user's real opencode2 config: every XDG path
 * and the config dir point inside a fresh temp root, and everything is removed
 * on exit unless `--keep` is passed.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { pluginLogLines, startServer, type Server } from "./server";
import { Assertions } from "./assertions";
import { join } from "node:path";
import {
  assertDeepClones,
  assertInventory,
  fanOut,
  proveIndependence,
  removeWorktreeMissingDirectory,
  removeWorktrees,
  runFallbackScenarios,
  runNonCowServer,
  type WorktreeRun,
} from "./scenarios";
import { runSimulationScenario, runAttachScenario, runListScenario, runHooksScenario } from "./simulation";
import { writeRunLog } from "./runlog";
import { makeConfigRoot, makeSourceProject, installPlugin, declarePlugin, removePath } from "./lib";

const FANOUT = Number(process.env.E2E_FANOUT ?? 3);
const PORT = Number(process.env.E2E_PORT ?? 45980);
const keep = process.argv.includes("--keep");

function log(message: string): void {
  console.log(message);
}

async function main(): Promise<number> {
  const config = await makeConfigRoot();
  const pluginDir = await installPlugin(join(config.root, "plugin"));
  await declarePlugin(config, pluginDir);
  const source = config.project;
  await makeSourceProject(source);

  const assertions = new Assertions();
  let server: Server | undefined;
  try {
    server = await startServer(config, { port: PORT, location: source });
    const runtime = detectRuntime(server);
    log(`server up at ${server.url} (runtime: ${runtime})`);

    const runs: WorktreeRun[] = await fanOut(server, source, assertions, FANOUT);
    await proveIndependence(assertions, source, runs);
    await assertDeepClones(assertions, source, runs);
    await assertInventory(assertions, server, runs);
    const fallback = await runFallbackScenarios(server, config, assertions);
    await removeWorktrees(assertions, server, runs);
    // Recreates one worktree to reproduce issue #12 and prove nobody is stuck.
    await removeWorktreeMissingDirectory(assertions, server, runs);

    // §6 fallback on a real non-CoW filesystem. `POST /api/worktree` invokes
    // the strategy directly, so the fallback tool is not reached here; this
    // proves the strategy's fail-loud contract on tmpfs instead.
    const nonCow = await runNonCowServer({ port: PORT + 1, fallback: "none" });
    assertions.check(
      "non-CoW + strategy cow: create fails (strategy fail-loud)",
      (nonCow.disabledStatus ?? 0) >= 400,
      `${nonCow.disabledStatus} ${nonCow.disabledText}`,
    );
    assertions.check(
      "non-CoW + strategy cow: error names the unsupported condition",
      /not supported|copy-on-write|CoW|fallback|failed to clone/i.test(nonCow.disabledText ?? ""),
      (nonCow.disabledText ?? "").slice(0, 200),
    );
    assertions.check(
      "non-CoW + strategy cow: no directory left behind",
      nonCow.enabledMechanism === undefined,
      String(nonCow.enabledMechanism),
    );
    const nonCowOptIn = await runNonCowServer({ port: PORT + 2, fallback: "git" });
    assertions.check(
      "non-CoW + plugin fallback git: API create still selects cow (fallback is tool-only)",
      (nonCowOptIn.enabledStatus ?? 0) >= 400,
      `${nonCowOptIn.enabledStatus} ${nonCowOptIn.enabledText}`,
    );
    fallback.notes.push(...nonCow.notes, ...nonCowOptIn.notes);

    // Issue #9: reach the fallback through a real tool invocation. The model's
    // bytes are scripted by the drive controller; the session loop, tool
    // registry, and tool execution are production code.
    const simulation = await runSimulationScenario({
      port: PORT + 3,
      fallback: "git",
      scriptedTool: { name: "shell", input: { command: "echo sim-shell-ran" } },
    });
    assertions.check(
      "simulation: a real session ran the scripted tool call",
      simulation.scriptedToolStatus === "completed",
      `${simulation.scriptedToolStatus} ${simulation.scriptedToolOutput ?? ""}`,
    );
    assertions.check(
      "simulation: the scripted shell command actually executed",
      (simulation.scriptedToolOutput ?? "").includes("sim-shell-ran"),
      simulation.scriptedToolOutput ?? "no output",
    );
    const spawnScenario = await runSimulationScenario({
      port: PORT + 4,
      fallback: "git",
      scriptedTool: { name: "spawn_workspace", input: { name: "sim" } },
    });
    assertions.check(
      "simulation: spawn_workspace is offered to the session by name",
      spawnScenario.pluginToolOffered === true,
      spawnScenario.toolNames.join(", "),
    );
    assertions.check(
      "simulation: the real session executed spawn_workspace",
      spawnScenario.scriptedToolStatus === "completed",
      `${spawnScenario.scriptedToolStatus} ${spawnScenario.scriptedToolOutput ?? ""}`,
    );

    // The fallback policy, end to end, through a real tool invocation on a real
    // non-CoW filesystem. Each scenario needs its own root: it creates and
    // commits its source repo.
    const nonCowGitRoot = await mkdtemp(join("/dev/shm", "cow-harness-fb-"));
    const fallbackGit = await runSimulationScenario({
      port: PORT + 5,
      fallback: "git",
      sourceRoot: nonCowGitRoot,
      scriptedTool: { name: "spawn_workspace", input: { name: "fb" } },
    });
    // The projectID-era create API has no strategy field, so the fallback
    // cannot request the built-in git strategy: the selected (cow) strategy
    // runs and refuses the non-CoW source. The refusal — not a schema error —
    // is the pass condition: it proves the request reached the strategy. On
    // 2.0.2-era binaries this scenario completed with mechanism "git".
    assertions.check(
      "simulation fallback: non-CoW source + fallback git is refused by the cow strategy",
      (fallbackGit.scriptedToolStatus ?? "").includes("cow strategy failed to clone"),
      `${fallbackGit.scriptedToolStatus ?? ""} ${fallbackGit.scriptedToolOutput ?? ""}`,
    );
    const nonCowNoneRoot = await mkdtemp(join("/dev/shm", "cow-harness-fl-"));
    const fallbackNone = await runSimulationScenario({
      port: PORT + 6,
      fallback: "none",
      sourceRoot: nonCowNoneRoot,
      scriptedTool: { name: "spawn_workspace", input: { name: "fl" } },
    });
    assertions.check(
      "simulation fallback: non-CoW source + fallback none fails loudly",
      (fallbackNone.scriptedToolStatus ?? "").includes("not supported") &&
        (fallbackNone.scriptedToolStatus ?? "").includes("no fallback"),
      fallbackNone.scriptedToolStatus ?? "no status",
    );

    fallback.notes.push(...simulation.notes.map((note) => `simulation: ${note}`));
    fallback.notes.push(...spawnScenario.notes.map((note) => `simulation(spawn_workspace): ${note}`));
    fallback.notes.push(...fallbackGit.notes.map((note) => `simulation(fallback git): ${note}`));
    fallback.notes.push(...fallbackNone.notes.map((note) => `simulation(fallback none): ${note}`));
    fallback.simulation = simulation;
    fallback.spawnSimulation = spawnScenario;
    fallback.simulationFallbackGit = fallbackGit;
    fallback.simulationFallbackNone = fallbackNone;

    // Issue #1 + #15: attach. Round 1 creates and marks the worktree; round 2
    // must be refused by the occupancy guard (round 1's session is
    // seconds-fresh); round 3 walks the refusal's own recovery — deleting the
    // occupying session out of band — and must attach and rewrite the marker;
    // a legacy raw worktree (no marker) must attach as before, marked, with
    // git status clean.
    const attach = await runAttachScenario({ port: PORT + 7 });
    assertions.check(
      "attach: first spawn_workspace created the worktree",
      attach.firstStatus === "completed",
      `${attach.firstStatus} ${attach.firstOutput ?? ""}`,
    );
    assertions.check(
      "attach: first create left exactly one inventory row for the name",
      attach.worktreeDirectory !== undefined,
      String(attach.worktreeDirectory),
    );
    assertions.check(
      "attach: second spawn_workspace refused on the fresh occupancy marker",
      (attach.secondStatus ?? "").includes("refusing to attach") &&
        /occupancy|session \S+ appears/i.test(attach.secondStatus ?? ""),
      `${attach.secondStatus} ${attach.secondOutput ?? ""}`,
    );
    assertions.check(
      "attach: the refusal materialized no second directory",
      attach.inventoryCount === 1,
      String(attach.inventoryCount),
    );
    assertions.check(
      "attach: the marker after round 1 names the occupying session",
      (attach.occupantSessionID ?? "").length > 0,
      String(attach.occupantSessionID),
    );
    assertions.check(
      "attach: DELETE of the occupying session was accepted",
      (attach.deleteStatus ?? 0) >= 200 && (attach.deleteStatus ?? 0) < 300,
      String(attach.deleteStatus),
    );
    assertions.check(
      "attach: third spawn_workspace attached after the delete",
      (attach.thirdOutput ?? "").includes("Attached to existing"),
      `${attach.thirdStatus} ${attach.thirdOutput ?? ""}`,
    );
    assertions.check(
      "attach: round 3 rewrote the marker for the new session",
      attach.thirdMarkerSessionID !== undefined &&
        attach.thirdSessionID !== undefined &&
        attach.thirdMarkerSessionID === attach.thirdSessionID,
      `${attach.thirdMarkerSessionID} vs ${attach.thirdSessionID}`,
    );
    assertions.check(
      "attach: legacy worktree without a marker still attaches",
      (attach.legacy?.attachOutput ?? "").includes("Attached to existing"),
      `${attach.legacy?.attachStatus} ${attach.legacy?.attachOutput ?? ""}`,
    );
    assertions.check(
      "attach: legacy attach wrote the marker",
      (attach.legacy?.markerSessionID ?? "").length > 0,
      String(attach.legacy?.markerSessionID),
    );
    assertions.check(
      "attach: legacy worktree's git status stays clean with the marker present",
      attach.legacy?.gitStatus === "",
      JSON.stringify(attach.legacy?.gitStatus),
    );
    fallback.notes.push(...attach.notes.map((note) => `attach: ${note}`));
    fallback.attach = attach;

    // Ticket 02: list_worktrees, end to end. Two worktrees are created
    // through the real API, then a real scripted session calls the tool; its
    // text must name both with strategy cow, agreeing with the inventory.
    const list = await runListScenario({ port: PORT + 8 });
    assertions.check(
      "list: both API-created worktrees returned a directory",
      list.created["lst-one"] !== undefined && list.created["lst-two"] !== undefined,
      JSON.stringify(list.created),
    );
    assertions.check(
      "list: the real session executed list_worktrees",
      list.listStatus === "completed",
      `${list.listStatus} ${list.listOutput ?? ""}`,
    );
    assertions.check(
      "list: the tool's answer names both worktrees with strategy cow",
      (list.listOutput ?? "").includes("lst-one") &&
        (list.listOutput ?? "").includes("lst-two") &&
        (list.listOutput ?? "").includes('"strategy": "cow"'),
      list.listOutput ?? "no output",
    );
    assertions.check(
      "list: the inventory records both rows as cow (the fact the tool derives from)",
      list.inventoryCowRows.length === 2 &&
        list.inventoryCowRows.every((row) => row.strategy === "cow"),
      JSON.stringify(list.inventoryCowRows),
    );
    fallback.notes.push(...list.notes.map((note) => `list: ${note}`));
    fallback.list = list;

    // Ticket 05: post-create hooks, end to end. One server whose hooks write a
    // marker into the fresh clone; one whose hook fails and must abort the
    // create with no orphan directory.
    const hooks = await runHooksScenario({ port: PORT + 9 });
    assertions.check(
      "hooks: the API create returned a directory",
      hooks.createdDirectory !== undefined,
      String(hooks.createdDirectory),
    );
    assertions.check(
      "hooks: the hook wrote its marker into the new worktree",
      hooks.marker === "hook-marker",
      String(hooks.marker),
    );
    assertions.check(
      "hooks: the hook saw the absolute source directory in COW_SOURCE_DIRECTORY",
      hooks.sourceEnv === hooks.source,
      `${hooks.sourceEnv} vs ${hooks.source}`,
    );
    assertions.check(
      "hooks: the inventory records the hooked worktree as cow",
      hooks.inventoryCowRows === 1,
      String(hooks.inventoryCowRows),
    );
    assertions.check(
      "hooks: a failing hook makes the API create fail",
      (hooks.failStatus ?? 0) >= 400,
      `${hooks.failStatus} ${hooks.failText?.slice(0, 120) ?? ""}`,
    );
    assertions.check(
      "hooks: the failure names the hook, its step, and the exit code",
      /post-create hook failed \(step 1 of 1\)/.test(hooks.failText ?? "") &&
        /exit code 3/.test(hooks.failText ?? ""),
      hooks.failText?.slice(0, 240) ?? "no text",
    );
    assertions.check(
      "hooks: the failed create left no orphan directory",
      hooks.orphanGone === true,
      String(hooks.orphanGone),
    );
    fallback.notes.push(...hooks.notes.map((note) => `hooks: ${note}`));
    fallback.hooks = hooks;

    await writeRunLog({ config, source, server, runtime, runs, assertions, fallback, version: serverVersion() });

    log("");
    for (const check of assertions.checks) log(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}`);
    log("");
    log(`${assertions.checks.length} checks, ${assertions.failed.length} failed`);
    return assertions.failed.length === 0 ? 0 : 1;
  } catch (error) {
    if (server) {
      log("--- server output (last plugin/worktree lines) ---");
      for (const line of pluginLogLines(server)) log(line);
    }
    throw error;
  } finally {
    await server?.stop();
    if (!keep) await removePath(config.root);
    else log(`kept temp root: ${config.root}`);
  }
}

/** The server is a Bun single-file build; record that, do not assume it. */
function detectRuntime(server: Server): string {
  const match = server.output().match(/Bun v([0-9.]+)/);
  if (match) return `bun ${match[1]}`;
  // The serve path does not print its runtime banner; the binary is a Bun
  // single-file build (verified by `strings`), so state that with the evidence.
  return "bun (single-file build; no runtime banner printed)";
}

function serverVersion(): string {
  try {
    return execFileSync("opencode2", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

await main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
