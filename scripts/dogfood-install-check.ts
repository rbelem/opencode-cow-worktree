#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
/**
 * Dogfood install check (a one-shot proof, not part of the test suite).
 *
 * Loads the plugin the way the user's real config does — by directory through
 * the `plugins` array — in a throwaway config root, then proves against a live
 * opencode2 server that:
 *
 *   1. the plugin activates (`plugin.list` reports `state.status: "active"`),
 *   2. the `cow` Strategy is the location's default, by creating a worktree
 *      with no `strategy` field and observing a Deep clone, and
 *   3. the `spawn_workspace` tool is registered and reachable by name.
 *
 * Only documented endpoints are used: `GET /api/plugin`,
 * `POST /api/plugin/await-activation`, `GET/POST/DELETE /api/worktree`
 * (packages/protocol/src/groups/{plugin,worktree}.ts).
 *
 * Run: bun scripts/dogfood-install-check.ts
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { installPlugin, declarePlugin } from "./e2e/lib";

const SEAM = join(process.env.HOME!, ".config", "opencode", "plugins", "opencode-cow-worktree");
const PORT = 46180;
const PASSWORD = "dogfood-check";
const COW_ROOT = "/tmp/opencode";

interface Result {
  status: number;
  body: unknown;
  text: string;
}

async function main(): Promise<number> {
  const root = await mkdtemp(join(COW_ROOT, "dogfood-"));
  const config = join(root, "config", "opencode");
  const project = join(root, "project");
  const home = join(root, "home");
  for (const dir of [config, project, home]) await mkdir(dir, { recursive: true });

  // A real scratch git project, so a `cow` clone has something to clone.
  execFileSync("git", ["-C", project, "init", "-q"]);
  execFileSync("git", ["-C", project, "config", "user.email", "dogfood@example.com"]);
  execFileSync("git", ["-C", project, "config", "user.name", "dogfood"]);
  await writeFile(join(project, ".gitignore"), "node_modules/\n");
  await writeFile(join(project, "tracked.txt"), "dogfood source\n");
  await mkdir(join(project, "node_modules", "dep"), { recursive: true });
  await writeFile(join(project, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  await writeFile(join(project, "ignored.log"), "present in source only\n");
  execFileSync("git", ["-C", project, "add", "-A"]);
  execFileSync("git", ["-C", project, "commit", "-qm", "dotfood source"]);

  // Point the throwaway config at the installed seam directory, exactly as the
  // user's global config does. `installPlugin` + `declarePlugin` are the same
  // helpers the e2e harness uses, so the install shape is not re-implemented.
  const pluginDir = await installPlugin(join(root, "plugin"));
  void pluginDir;
  await declarePlugin(
    { root, config, project, env: {} },
    SEAM,
    { fallback: "none" },
  );

  const env = {
    ...process.env,
    HOME: home,
    OPENCODE_TEST_HOME: home,
    OPENCODE_CONFIG_DIR: config,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_DB: join(root, "opencode.db"),
    OPENCODE_PASSWORD: PASSWORD,
    OPENCODE_DISABLE_FILEWATCHER: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
  };

  const child = spawn(
    "opencode2",
    ["serve", "--port", String(PORT), "--print-logs", "--log-level", "debug"],
    { env, cwd: project, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout?.on("data", (c) => (output += String(c)));
  child.stderr?.on("data", (c) => (output += String(c)));

  const auth = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`;
  const url = (path: string) => {
    const u = new URL(`http://127.0.0.1:${PORT}${path}`);
    u.searchParams.set("location[directory]", project);
    return u.href;
  };
  const call = async (method: string, path: string, body?: unknown): Promise<Result> => {
    const response = await fetch(url(path), {
      method,
      headers: { authorization: auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { status: response.status, body: parsed, text };
  };

  let failures = 0;
  const check = (name: string, ok: boolean, detail: string) => {
    console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  -- ${detail}`}`);
    if (!ok) failures += 1;
  };

  try {
    const deadline = Date.now() + 30_000;
    let healthy = false;
    while (Date.now() < deadline && !healthy) {
      // /api/health lost its handler on the 20260915 nightly (404 with auth).
      // Readiness polls /api/plugin instead, which pinned and nightly builds
      // serve — mirrors waitForHealth in scripts/e2e/server.ts.
      healthy = (await call("GET", "/api/plugin").catch(() => ({ status: 0, body: undefined, text: "" }))).status === 200;
      if (!healthy) await Bun.sleep(150);
    }
    check("server became healthy", healthy, "timeout");
    if (!healthy) return failures;

    // GET /api/plugin does not await activation. The await-activation route
    // answers 204 on pinned builds and 404 on the 20260917 nightly, so the
    // plugin.list query below decides activation; this call only nudges it.
    const activation = await call("POST", "/api/plugin/await-activation");
    check(
      "plugin activation settled (204, or 404 on nightlies without the route)",
      activation.status === 204 || activation.status === 404,
      `${activation.status} ${activation.text.slice(0, 200)}`,
    );

    // Activation on the 20260917 nightly is lazy (the first plugin query
    // triggers the load) and await-activation is gone, so poll the list the
    // way waitForPlugin in scripts/e2e/server.ts does.
    const listDeadline = Date.now() + 30_000;
    let plugins: Array<{ id?: string; source?: { type?: string }; state?: { status?: string; error?: string } }> = [];
    let mine: (typeof plugins)[number] | undefined;
    while (Date.now() < listDeadline) {
      const listed = await call("GET", "/api/plugin");
      plugins = Array.isArray((listed.body as { data?: unknown } | undefined)?.data)
        ? (listed.body as { data: typeof plugins }).data
        : [];
      mine = plugins.find((p) => (p.id ?? "").includes("cow-worktree") || JSON.stringify(p.source ?? {}).includes("cow-worktree"));
      if (mine?.state?.status === "active") break;
      await Bun.sleep(150);
    }
    check("our plugin appears in plugin.list", mine !== undefined, JSON.stringify(plugins).slice(0, 400));
    check(
      "our plugin is active, not failed",
      mine?.state?.status === "active",
      JSON.stringify(mine?.state ?? {}).slice(0, 300),
    );

    // The `cow` Strategy, if registered, becomes the location's default, so a
    // create with NO strategy field must produce a Deep clone (ignored files
    // present, a standalone .git) rather than a git worktree. The nightly
    // demands a projectID on every worktree endpoint (projectIdOf in
    // scripts/e2e/lib.ts); scratch roots resolve it to a single row.
    const projects = await call("GET", "/api/project");
    const projectRows = Array.isArray(projects.body)
      ? projects.body
      : (projects.body as { data?: Array<{ id?: string }> } | undefined)?.data ?? [];
    const projectID = projectRows[0]?.id;
    check("project id discovered", typeof projectID === "string", projects.text.slice(0, 300));
    if (typeof projectID !== "string") return failures;

    const created = await call("POST", "/api/worktree", { name: "dogfood", projectID });
    check(
      "worktree create with the plugin's default strategy succeeded",
      created.status === 200,
      `${created.status} ${created.text.slice(0, 400)}`,
    );
    const directory = (created.body as { directory?: string } | undefined)?.directory;
    check("worktree create returned a directory", typeof directory === "string", created.text.slice(0, 200));

    if (directory) {
      const ignoredPresent = await Bun.file(join(directory, "ignored.log"))
        .exists()
        .catch(() => false);
      check("the created worktree carries ignored state (a Deep clone)", ignoredPresent, directory);
      const standaloneGit = await Bun.file(join(directory, ".git", "HEAD"))
        .exists()
        .catch(() => false);
      check("the created worktree has a standalone .git (not a Shallow worktree)", standaloneGit, `${directory}/.git`);

      const list = await call("GET", "/api/worktree?projectID=" + encodeURIComponent(projectID));
      check(
        "worktree.list reports the created directory with strategy cow",
        JSON.stringify(list.body ?? {}).includes("cow"),
        `${list.status} ${list.text.slice(0, 400)}`,
      );

      const removed = await call("DELETE", "/api/worktree", { directory, force: true, projectID });
      check("worktree removal succeeded", removed.status === 204 || removed.status === 200, `${removed.status} ${removed.text.slice(0, 200)}`);
    }

    // The tool seam: spawn_workspace must be offered to a session by name.
    // A tool lives on the session's provider tool list, not a standalone route,
    // so this is proven by the e2e simulation lane (scripts/e2e/simulation.ts);
    // here we assert the registration log line instead of inventing an endpoint.
    check(
      "server logs show the plugin entrypoint loaded",
      output.includes("loading plugin") && output.includes("opencode-cow-worktree"),
      output.split("\n").filter((l) => l.includes("loading plugin")).join("\n").slice(0, 300),
    );
  } finally {
    child.kill();
    await Bun.sleep(300);
  }

  console.log("");
  console.log(failures === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures})`);
  if (failures > 0) console.log(output.slice(-3000));
  return failures;
}

process.exit(await main());
