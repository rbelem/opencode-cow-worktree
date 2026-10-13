#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
/**
 * Native-path compat matrix: proves the plugin's contract holds when worktree
 * actions arrive through the host's built-in `opencode.worktree_*` tools
 * (v2.0.27+) rather than the plugin's own tools. The built-ins call the same
 * `ctx.worktree` seams the REST API exposes, so REST-level assertions cover
 * the shared semantics (PR anomalyco/opencode#53981).
 *
 *   A. race: on a fresh server whose FIRST worktree-relevant call is a create
 *      (no strategy field, no prior plugin query), the create still lands on
 *      the cow strategy — or the lazy-activation race is real.
 *   B. inheritance: an activated server's strategy-less create reports
 *      strategy "cow" in the inventory, materializes a Deep clone (ignored
 *      file present, standalone .git), and writes no occupancy marker
 *      (native creates bypass spawn_workspace by design).
 *   C. spawn-interop precondition: the B tree is cow-membersible and
 *      marker-less — exactly the input the attach path accepts
 *      (src/tool.ts: marker absent -> probe absent -> proceed, rewrite false).
 *   D. refusal passthrough: a force-less DELETE of a dirty cow tree fails and
 *      the body carries the strategy's own refusal reason.
 *   E. force parity: the same tree under force:true is removed, ignored
 *      files and all.
 *
 * Run: bun scripts/e2e/native-matrix.ts   (requires opencode2 on PATH)
 */
import { spawn } from "node:child_process";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  declarePlugin,
  exists,
  installPlugin,
  makeApi,
  makeConfigRoot,
  makeSourceProject,
  projectIdOf,
  removePath,
  type Api,
} from "./lib";

const PORT = 46190;
const RACE_PORT = 46191;
const PASSWORD = "native-matrix";
const MARKER_NAME = ".cow-session.json";
const MATRIX_LOG = "/tmp/opencode/native-matrix-results.txt";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures += 1;
  void appendFile(MATRIX_LOG, `${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}\n`, "utf8").catch(
    () => {},
  );
}

async function createWorktree(api: Api, projectID: string, name: string): Promise<string | undefined> {
  const created = await api.json("POST", "/api/worktree", { name, projectID });
  if (created.status !== 200) {
    check("worktree create succeeded", false, `${created.status} ${created.text.slice(0, 200)}`);
    return undefined;
  }
  return (created.body as { directory?: string }).directory;
}

async function inventoryStrategy(api: Api, projectID: string, directory: string): Promise<string | undefined> {
  const listed = await api.json("GET", `/api/worktree?projectID=${encodeURIComponent(projectID)}`);
  return inventoryEntries(listed.body).find((entry) => entry.directory === directory)?.strategy;
}

/** The inventory answers as a bare array on 2.7.50 and as {data} on older builds. */
function inventoryEntries(body: unknown): Array<{ directory: string; strategy?: string }> {
  if (Array.isArray(body)) return body as Array<{ directory: string; strategy?: string }>;
  return (body as { data?: Array<{ directory: string; strategy?: string }> }).data ?? [];
}

async function main(): Promise<number> {
  await rm(MATRIX_LOG, { force: true });

  // --- A. the race: first worktree call precedes any plugin query ---------
  const race = await makeConfigRoot({ password: PASSWORD });
  const racePlugin = await installPlugin(join(race.root, "plugin"));
  await declarePlugin(race, racePlugin);
  const raceSource = join(race.root, "project");
  await makeSourceProject(raceSource);
  const raceChild = spawn(
    "opencode2",
    ["serve", "--port", String(RACE_PORT), "--print-logs", "--log-level", "debug"],
    { env: race.env, cwd: raceSource, stdio: ["ignore", "pipe", "pipe"] },
  );
  let raceOutput = "";
  raceChild.stdout?.on("data", (chunk) => (raceOutput += String(chunk)));
  raceChild.stderr?.on("data", (chunk) => (raceOutput += String(chunk)));
  try {
    // Server-up probe: any HTTP answer at all (any status counts; the point
    // is to create before any plugin-flavored query primes activation).
    const raceApi = makeApi(`http://127.0.0.1:${RACE_PORT}`, PASSWORD, raceSource);
    const deadline = Date.now() + 30_000;
    let up = false;
    while (Date.now() < deadline && !up) {
      const answered = await raceApi.json("GET", "/api/plugin").catch(() => null);
      up = answered !== null;
      if (!up) await Bun.sleep(150);
    }
    check("race server answered", up);
    if (up) {
      const raceProjectID = await projectIdOf(raceApi);
      const raceDir = await createWorktree(raceApi, raceProjectID, "race");
      if (raceDir !== undefined) {
        const strategy = await inventoryStrategy(raceApi, raceProjectID, raceDir);
        check(
          "race: first-create inherited cow (no lazy-activation gap)",
          strategy === "cow",
          `strategy=${JSON.stringify(strategy)}`,
        );
        if (strategy !== "cow") {
          check(
            "race: server log shows plugin loading",
            /loading plugin/.test(raceOutput),
            raceOutput.split("\n").filter((line) => /plugin/i.test(line)).slice(-3).join(" | ").slice(0, 300),
          );
        }
        await raceApi.json("DELETE", "/api/worktree", { directory: raceDir, force: true, projectID: raceProjectID });
      }
    }
  } finally {
    raceChild.kill();
  }

  // --- B-E. the activated-server matrix -----------------------------------
  const config = await makeConfigRoot({ password: PASSWORD });
  const pluginDir = await installPlugin(join(config.root, "plugin"));
  await declarePlugin(config, pluginDir);
  const source = join(config.root, "project");
  await makeSourceProject(source);
  const { startServer } = await import("./server");
  const server = await startServer(config, { port: PORT, location: source });
  try {
    const api = server.api;
    // Location services can lag plugin activation ("503 service_starting");
    // give project discovery a bounded retry instead of failing the matrix.
    let projectID: string | undefined;
    for (let attempt = 0; attempt < 40 && projectID === undefined; attempt += 1) {
      projectID = await projectIdOf(api).catch(() => undefined);
      if (projectID === undefined) await Bun.sleep(250);
    }
    check("project id discovered", typeof projectID === "string");
    if (projectID === undefined) return failures;

    const directory = await createWorktree(api, projectID, "native");
    if (directory === undefined) return failures;
    check("B: native-path create returned a directory", true);

    const strategy = await inventoryStrategy(api, projectID, directory);
    check("B: inventory records strategy cow (literal id)", strategy === "cow", `strategy=${JSON.stringify(strategy)}`);

    const ignoredPresent = await Bun.file(join(directory, "debug.log")).exists().catch(() => false);
    check("B: the worktree is a Deep clone (ignored file present)", ignoredPresent, directory);
    const standaloneGit = await Bun.file(join(directory, ".git", "HEAD")).exists().catch(() => false);
    check("B: standalone .git (not a Shallow worktree)", standaloneGit, `${directory}/.git`);

    const marker = await Bun.file(join(directory, MARKER_NAME)).exists().catch(() => false);
    check("C: native create wrote no occupancy marker", !marker, MARKER_NAME);
    check("C: attach precondition holds (cow member, marker-less)", strategy === "cow" && !marker);

    // D. dirty the tree: a tracked edit plus a fresh ignored file, then a
    // force-less DELETE must fail with the strategy's own reason. 2.7.50's
    // DELETE route requires the force key, so it goes in explicitly.
    await writeFile(join(directory, "tracked.txt"), "dirty\n", "utf8");
    await mkdir(join(directory, "local-state"), { recursive: true });
    await writeFile(join(directory, "local-state", "db.sqlite"), "precious\n", "utf8");
    const refused = await api.json("DELETE", "/api/worktree", { directory, force: false, projectID });
    const body = refused.text;
    check(
      "D: force-less delete of a dirty cow tree is refused",
      refused.status >= 400 && refused.status < 500,
      `${refused.status} ${body.slice(0, 200)}`,
    );
    check(
      "D: the refusal carries the strategy's reason verbatim",
      /cow refuses to remove/.test(body),
      body.slice(0, 300),
    );
    check("D: the tree survived the refusal", await exists(directory));

    // E. force parity: the destructive path, through the same route the
    // built-in tool drives. Ignored files (local-state/) die with it.
    const forced = await api.json("DELETE", "/api/worktree", { directory, force: true, projectID });
    check(
      "E: force delete succeeded through the shared route",
      forced.status === 200 || forced.status === 204,
      `${forced.status} ${forced.text.slice(0, 200)}`,
    );
    check("E: the directory is gone", !(await exists(directory)));

    // F. #54354 interop: the main checkout vanishes; a surviving cow clone
    // is expected to keep the project answerable. Observation only: the
    // exact semantics belong to the host, the plugin only consumes them.
    const surviving = await createWorktree(api, projectID, "survivor");
    check("F: created a survivor clone", surviving !== undefined);
    if (surviving !== undefined) {
      await removePath(source);
      const fromClone = makeApi(server.url, PASSWORD, surviving);
      const listed = await fromClone.json("GET", `/api/worktree?projectID=${encodeURIComponent(projectID)}`);
      check(
        "F: inventory answers from the surviving clone's location",
        listed.status === 200,
        `${listed.status} ${listed.text.slice(0, 200)}`,
      );
      const stillCow = listed.status === 200 ? await inventoryStrategy(fromClone, projectID, surviving) : undefined;
      check("F: the survivor still records strategy cow", stillCow === "cow", `strategy=${JSON.stringify(stillCow)}`);
      const removed = await fromClone.json("DELETE", "/api/worktree", {
        directory: surviving,
        force: true,
        projectID,
      });
      // Known host behavior, unchanged on 2.7.50 and documented in
      // src/remove-tool.ts: with the project checkout gone, the worktree
      // route refuses at the host layer ("Worktree directory unavailable")
      // before any strategy code runs. Removal falls to the by-hand path the
      // plugin's refusal message names.
      check(
        "F: checkout-gone removal refuses at the host layer (documented behavior)",
        removed.status === 400 && /Worktree directory unavailable/.test(removed.text),
        `${removed.status} ${removed.text.slice(0, 200)}`,
      );
      await mkdir(source, { recursive: true }).catch(() => {});
    }
  } finally {
    await server.stop();
  }

  console.log("");
  console.log(failures === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures})`);
  return failures;
}

process.exitCode = await main();
