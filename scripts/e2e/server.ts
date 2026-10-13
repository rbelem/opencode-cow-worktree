// SPDX-License-Identifier: MIT
/**
 * Starts a real `opencode2 serve` against a throwaway config root, discovers
 * its listen address and auth, and waits until the plugin is activated.
 *
 * The server prints `server listening on <url>` to stderr; the password is
 * pinned through `OPENCODE_PASSWORD` (see `ConfigRoot.env`) so it is known
 * before startup rather than parsed out of the logs.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { makeApi, type Api, type ConfigRoot } from "./lib";

export interface Server {
  readonly process: ChildProcess;
  readonly url: string;
  readonly api: Api;
  readonly output: () => string;
  readonly stop: () => Promise<void>;
}

const READY_TIMEOUT_MS = 30_000;
const PLUGIN_ID = "opencode-cow-worktree";

export async function startServer(
  config: ConfigRoot,
  options: { readonly port: number; readonly location: string },
): Promise<Server> {
  const child = spawn(
    "opencode2",
    ["serve", "--port", String(options.port), "--print-logs", "--log-level", "debug"],
    { env: config.env, cwd: options.location, stdio: ["ignore", "pipe", "pipe"] },
  );
  let buffer = "";
  child.stdout?.on("data", (chunk) => (buffer += chunk));
  child.stderr?.on("data", (chunk) => (buffer += chunk));

  const base = `http://127.0.0.1:${options.port}`;
  const password = config.env.OPENCODE_PASSWORD!;
  const api = makeApi(base, password, options.location);

  const stop = async () => {
    child.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  // If readiness or activation fails, do not leak the spawned server.
  try {
    await waitForHealth(api);
  } catch (error) {
    await stop();
    throw error;
  }

  const server: Server = {
    process: child,
    url: base,
    api,
    output: () => buffer,
    stop,
  };
  try {
    await waitForPlugin(server);
  } catch (error) {
    await stop();
    throw error;
  }
  return server;
}

async function waitForHealth(api: Api): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // /api/health lost its handler on the 20260915 nightly — 404 with auth,
    // 401 without (the auth guard fires on every /api/* path, so the 401 says
    // nothing about route existence; the authenticated 404 does). Readiness
    // polls /api/plugin instead, which both pinned and nightly binaries
    // serve; whether the plugin activated is waitForPlugin's question, one
    // phase later.
    const { status } = await api.json("GET", "/api/plugin").catch(() => ({ status: 0 }));
    if (status === 200) return;
    await Bun.sleep(100);
  }
  throw new Error(`server did not become healthy within ${READY_TIMEOUT_MS}ms`);
}

/**
 * A plain `GET /api/plugin` does not await activation, so the plugin list is
 * empty until `POST /api/plugin/await-activation` runs. Both facts were
 * discovered against the real binary; see the run log. On the 20260917
 * nightly `POST /api/plugin/await-activation` answers 404 (route gone), so
 * activation is detected through `GET /api/plugin` alone; the loop keeps
 * polling both.
 */
async function waitForPlugin(server: Server): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last: unknown;
  while (Date.now() < deadline) {
    const activated = await server.api.json("POST", "/api/plugin/await-activation");
    const { body } = await server.api.json("GET", "/api/plugin");
    const plugins = (body as { data?: Array<{ id?: string; state?: { status?: string } }> }).data ?? [];
    const found = plugins.find((entry) => entry.id === PLUGIN_ID);
    if (found) {
      if (found.state?.status !== "active") {
        throw new Error(`plugin ${PLUGIN_ID} loaded but is ${found.state?.status ?? "unknown"}`);
      }
      return;
    }
    last = { activated: activated.status, ids: plugins.map((entry) => entry.id).slice(0, 3) };
    await Bun.sleep(150);
  }
  throw new Error(
    `plugin ${PLUGIN_ID} was not activated within ${READY_TIMEOUT_MS}ms. last: ${JSON.stringify(last)}\n` +
      `plugin/worktree log lines:\n${pluginLogLines(server).join("\n")}`,
  );
}

/** Server output lines mentioning the plugin, for the failure path. */
export function pluginLogLines(server: Server): string[] {
  return server
    .output()
    .split("\n")
    .filter((line) => /plugin|cow|LoadError|worktree/i.test(line))
    .slice(-40);
}
