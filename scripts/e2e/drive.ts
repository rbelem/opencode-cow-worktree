// SPDX-License-Identifier: MIT
/**
 * A drive controller: the model's scripted bytes.
 *
 * `opencode2` embeds a simulation harness. With `OPENCODE_SIMULATE=1` the
 * `HttpClient` layer is swapped for a `SimulatedProvider` that answers
 * `POST .../chat/completions` from events a controller sends over a websocket
 * (`OPENCODE_DRIVE`). Only the model's bytes are scripted — the session runner,
 * tool registry, tool decoding, and plugin tools stay production code.
 *
 * The wire protocol is JSON-RPC 2.0. This module implements the controller
 * side: `simulation.handshake`, `llm.attach` (which starts a stream of
 * `llm.request` notifications), then answering each request with `llm.chunk`
 * items and an `llm.finish`. See `packages/protocol/src/simulation.ts` in the
 * opencode2 source tree for the schema this mirrors.
 */
export interface ChatRequest {
  readonly id: string;
  readonly url: string;
  readonly body: {
    readonly stream?: boolean;
    readonly messages?: ReadonlyArray<{ role?: string; content?: unknown }>;
    readonly tools?: ReadonlyArray<{
      readonly type?: string;
      readonly function?: { name?: string; description?: string; parameters?: unknown };
    }>;
    readonly [key: string]: unknown;
  };
}

/** One scripted model turn: the items to stream, and why generation stopped. */
export type Turn =
  | { readonly kind: "tool-call"; readonly name: string; readonly input: unknown }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "stop" };

export interface DriveController {
  /** Every `llm.request` the server sent, in order. */
  readonly requests: ChatRequest[];
  /** Resolves once the controller has answered `turns.length` requests. */
  readonly done: Promise<void>;
  /** The tool names the server exposed on each request (diagnostic). */
  readonly toolNames: readonly string[];
  close(): void;
}

const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Connects to the drive backend and scripts `turns`, one per `llm.request`.
 *
 * The first request is expected to carry the tool definitions and no assistant
 * tool result; the second carries the tool result. The controller answers them
 * in order, then finishes with `stop` for any extra request.
 */
export async function driveModel(
  endpoint: string,
  turns: readonly Turn[],
): Promise<DriveController> {
  const socket = new WebSocket(endpoint);
  const requests: ChatRequest[] = [];
  const toolNames: string[] = [];
  let nextId = 1;
  let turnIndex = 0;
  let settleDone: () => void = () => {};
  let rejectDone: (error: Error) => void = () => {};
  const done = new Promise<void>((resolve, reject) => {
    settleDone = resolve;
    rejectDone = reject;
  });

  const call = (method: string, params?: unknown): void => {
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method,
        ...(params === undefined ? {} : { params }),
      }),
    );
  };

  socket.addEventListener("message", (event) => {
    const message = parseMessage(event.data);
    if (message === undefined) return;
    if (message.method === "llm.request" && message.params) {
      recordRequest(message.params, requests, toolNames);
      void answer(message.params);
    } else if (message.error !== undefined && message.id !== undefined) {
      rejectDone(new Error(`drive rpc ${message.id} failed: ${JSON.stringify(message.error)}`));
    }
  });

  async function answer(request: ChatRequest): Promise<void> {
    const turn = turns[turnIndex] ?? { kind: "stop" as const };
    turnIndex += 1;
    try {
      if (turn.kind === "tool-call") {
        call("llm.chunk", {
          id: request.id,
          items: [
            {
              type: "toolCall",
              index: 0,
              id: `call_${turnIndex}`,
              name: turn.name,
              input: turn.input,
            },
          ],
        });
        call("llm.finish", { id: request.id, reason: "tool-calls" });
      } else if (turn.kind === "text") {
        call("llm.chunk", { id: request.id, items: [{ type: "textDelta", text: turn.text }] });
        call("llm.finish", { id: request.id, reason: "stop" });
      } else {
        call("llm.finish", { id: request.id, reason: "stop" });
      }
      if (turnIndex >= turns.length) settleDone();
    } catch (error) {
      rejectDone(error instanceof Error ? error : new Error(String(error)));
    }
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("drive handshake timed out")), HANDSHAKE_TIMEOUT_MS);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      call("simulation.handshake", {
        client: { name: "opencode-cow-worktree-e2e", version: "0.0.1" },
        expectedRole: "backend",
        offeredVersions: [1],
        requiredCapabilities: [],
        optionalCapabilities: [],
      });
      call("llm.attach");
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("drive websocket failed to connect"));
    });
  });

  return {
    requests,
    toolNames,
    done,
    close: () => socket.close(),
  };
}

interface DriveMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: ChatRequest;
  readonly error?: unknown;
}

function parseMessage(data: unknown): DriveMessage | undefined {
  try {
    return JSON.parse(String(data)) as DriveMessage;
  } catch {
    return undefined;
  }
}

function recordRequest(
  request: ChatRequest,
  requests: ChatRequest[],
  toolNames: string[],
): void {
  requests.push(request);
  for (const tool of request.body.tools ?? []) {
    const name = tool.function?.name;
    if (name) toolNames.push(name);
  }
}
