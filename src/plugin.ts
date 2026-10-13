import type { Context } from "@opencode-ai/plugin";
import { stat } from "node:fs/promises";
import { probeCowCapability } from "./capability";
import { fallbackPolicy, postCreateHooks, targetRoot } from "./config";
import { deviceOf, isDirectory } from "./device";
import { readMarkerFile, writeMarkerFile } from "./occupancy";
import { probeUncommitted } from "./uncommitted";
import { removeWorktree, runGit } from "./remove-tool";
import type {
  RemoveWorktreeDeps,
  RemoveWorktreeInput,
} from "./remove-tool";
import { listCowWorktrees, spawnWorkspace } from "./tool";
import type {
  FallbackPolicy,
  SpawnWorkspaceDeps,
  SpawnWorkspaceInput,
} from "./tool";
import { createCowStrategy } from "./strategy";

/**
 * The tool's input schema, as the v2 plugin API expects a JSON Schema. Kept a
 * plain object because the installed plugin package is a v1 build; the running
 * v2 binary decodes it.
 */
const spawnWorkspaceInput = {
  type: "object",
  properties: {
    sourceDirectory: {
      type: "string",
      description: "The project directory to clone or branch from.",
    },
    name: {
      type: "string",
      description: "Optional name for the worktree and its session.",
    },
  },
  required: ["sourceDirectory"],
  additionalProperties: false,
} as const;

/**
 * The tool's declared output, as a JSON Schema. A tool that returns an `output`
 * field must declare its schema: opencode2 treats an undeclared output as a
 * defect ("Tool result declared output without an output schema"), not as a
 * recoverable error. The reported mechanism is part of the contract, so the
 * structured result is declared rather than flattened into text.
 */
const spawnWorkspaceOutput = {
  type: "object",
  properties: {
    sessionID: {
      type: "string",
      description: "The session started in the created directory.",
    },
    directory: {
      type: "string",
      description: "The working directory that was produced.",
    },
    mechanism: {
      type: "string",
      enum: ["cow", "git"],
      description: "The mechanism that produced the directory.",
    },
    attached: {
      type: "boolean",
      description:
        "True when the session was attached to an existing worktree instead of a new clone.",
    },
    markerWarning: {
      type: "string",
      description:
        "Set when the occupancy marker could not be written after a successful session start.",
    },
  },
  required: ["sessionID", "directory", "mechanism"],
  additionalProperties: false,
} as const;

/**
 * `list_worktrees` takes no input. The empty object keeps the shape the tool
 * seam expects (a JSON Schema object) while declaring that no properties
 * exist.
 */
const listWorktreesInput = {
  type: "object",
  properties: {
    missing: {
      type: "string",
      enum: ["fail", "report", "prune"],
      description:
        "Policy for an inventory row whose directory is gone (stat ENOENT — a dangling " +
        'reference). "fail" (default) keeps the ADR 0003 contract: the list fails loudly. ' +
        '"report" lists the row with missing: true and no createdAt. "prune" de-registers ' +
        "the row through the worktree remove API and drops it from the listing; until " +
        "upstream candidate 8 lands, a gone directory cannot be de-registered, so prune " +
        "fails loudly naming candidate 8. A stat failure that is not ENOENT fails in " +
        "every mode: it is a real anomaly, not a dangling row.",
    },
  },
  additionalProperties: false,
} as const;

/**
 * `list_worktrees`' declared output, with the same rule as
 * `spawn_workspace`'s: a tool that returns an `output` field must declare its
 * schema. The four entry fields are exactly what `listCowWorktrees` derives.
 */
const listWorktreesOutput = {
  type: "object",
  properties: {
    worktrees: {
      type: "array",
      description: "The location's cow worktrees, in inventory order.",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The worktree directory's basename.",
          },
          directory: {
            type: "string",
            description: "The worktree directory, as the worktree inventory records it.",
          },
          strategy: {
            type: "string",
            enum: ["cow"],
            description: "Only cow worktrees are listed.",
          },
          createdAt: {
            type: "string",
            description:
              "ISO 8601 timestamp of the directory's birthtime, falling back to its " +
              "mtime when the filesystem reports no birthtime. Absent on an entry " +
              "reported with missing: true — there is no directory to stat.",
          },
          missing: {
            type: "boolean",
            description:
              "Present and true only under missing: \"report\", for an inventory row " +
              "whose directory no longer exists.",
          },
        },
        required: ["name", "directory", "strategy"],
        additionalProperties: false,
      },
    },
  },
  required: ["worktrees"],
  additionalProperties: false,
} as const;

/**
 * `remove_worktree`'s input: exactly one of `name` or `directory` (validated
 * in the execute path — the JSON Schema cannot express "exactly one of" two
 * properties, so the schema leaves both optional and the tool refuses
 * anything else). `force` is the same confirmation the TUI's remove carries:
 * proceed despite unlanded or uncommitted work.
 */
const removeWorktreeInput = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "The worktree's basename, as list_worktrees reports it.",
    },
    directory: {
      type: "string",
      description: "The worktree directory, as the worktree inventory records it.",
    },
    force: {
      type: "boolean",
      description:
        "Remove even when the worktree holds unlanded commits or uncommitted files.",
    },
  },
  additionalProperties: false,
} as const;

/**
 * `remove_worktree`'s declared output, under the same rule as the other two
 * tools: a returned `output` field must have a declared schema. Whether force
 * was used is reported in the text content only — the structured result is
 * the one fact every caller needs, the directory that is gone.
 */
const removeWorktreeOutput = {
  type: "object",
  properties: {
    directory: {
      type: "string",
      description: "The removed worktree directory, as the inventory recorded it.",
    },
  },
  required: ["directory"],
  additionalProperties: false,
} as const;

/**
 * Binds `spawnWorkspace`'s seams to the live opencode2 context. The tool is
 * the layer that owns the strategy choice, so the capability probe and the
 * worktree/session APIs meet here and nowhere else.
 *
 * The fallback policy and the Worktree target root arrive already validated —
 * `setup` read them from the plugin's options once and passes the values in.
 * The fallback defaults to `"none"`: a request for `cow` is a statement about
 * what the caller gets, so the tool never produces a Shallow worktree unless
 * the opt-in was set. The target root defaults to unset, which makes the tool
 * place the Worktree beside the source — the same-filesystem parent a CoW
 * clone requires.
 */
function liveDeps(
  ctx: Context,
  fallback: FallbackPolicy,
  worktreeRoot: string | undefined,
): SpawnWorkspaceDeps {
  return {
    probe: probeCowCapability,
    probeDevice: deviceOf,
    // The projectID-era API (20260915 nightlies onward) requires the project
    // id on every worktree call and no longer accepts a `location` query, so
    // all three seams derive it from the plugin's own location context.
    listWorktrees: () => ctx.worktree.list({ projectID: ctx.location.project.id }),
    isDirectory,
    createWorktree: (input) =>
      ctx.worktree.create({
        projectID: ctx.location.project.id,
        from: input.sourceDirectory,
        directory: input.parentDirectory,
        name: input.name,
        // Ignored by projectID-era binaries (the selected strategy wins);
        // honored by the 2.0.2-era API, where the git fallback needs it.
        strategy: input.strategy,
      }),
    createSession: async (directory, name) => {
      const session = await ctx.session.create({ title: name, location: { directory } });
      return session.id;
    },
    removeWorktree: (directory) =>
      ctx.worktree.remove({ projectID: ctx.location.project.id, directory, force: true }),
    // `ctx.session.get` exists on the v2 runtime but is untyped in the
    // installed beta; types/opencode2-worktree.d.ts declares the verified
    // `{ sessionID }` shape and the structural record slice the occupancy
    // guard reads.
    sessionGet: (id) => ctx.session.get({ sessionID: id }),
    readMarker: readMarkerFile,
    writeMarker: writeMarkerFile,
    now: Date.now,
    fallback,
    targetRoot: worktreeRoot,
  };
}

/**
 * Whether a path exists — the dangling-row pre-check's live binding. ENOENT
 * answers "no"; any other stat failure (a permission problem, an I/O error)
 * propagates, because an unreadable directory is a real anomaly the caller
 * must see, not a dangling row.
 */
async function directoryPresent(directory: string): Promise<boolean> {
  try {
    await stat(directory);
    return true;
  } catch (cause) {
    if ((cause as { code?: unknown }).code === "ENOENT") return false;
    throw cause;
  }
}

/**
 * The opencode2 plugin module.
 *
 * `setup` registers the `cow` Strategy through the worktree seam, and the
 * `spawn_workspace` and `list_worktrees` tools through the tool seam.
 * Registering the Strategy also selects it as the default; the projectID-era
 * create API has no per-request strategy field, so the selected strategy is
 * what every create uses. The create call still carries `strategy` for
 * 2.0.2-era binaries, where it is what lets the tool's opt-in `git` fallback
 * name the built-in git strategy.
 */
export default {
  id: "opencode-cow-worktree",
  async setup(ctx: Context): Promise<void> {
    // Every plugin option is validated exactly once, here, before anything is
    // registered: a misconfiguration must fail the plugin load, not surface
    // inside the first tool call or halfway through a create. The validated
    // values close over into the strategy and the tool bindings below, so
    // the tool path never re-reads — or re-throws on — `ctx.options`.
    const hooks = postCreateHooks(ctx.options);
    const fallback = fallbackPolicy(ctx.options);
    const worktreeRoot = targetRoot(ctx.options);
    await ctx.worktree.transform((editor) => {
      editor.add(createCowStrategy({ postCreate: hooks }));
    });
    // `?.`: the installed plugin package is a v1 build whose Context has no
    // tool domain; the v2 binary always provides it. Optional chaining keeps
    // setup usable with a context that predates the tool seam.
    await ctx.tool?.transform((editor) => {
      editor.add({
        name: "spawn_workspace",
        description:
          "Create a worktree and start a session in it, reporting the mechanism that produced the directory. " +
          "When a worktree with the requested name already exists and was produced by the cow strategy, the " +
          "session is attached to it instead of creating a new directory; anything else at that name is refused. " +
          "If the worktree's recorded session still shows activity, the attach is refused and the error names " +
          "the occupying session and the ways to recover.",
        input: spawnWorkspaceInput,
        output: spawnWorkspaceOutput,
        // A tool defaults into CodeMode, which advertises it to the model only
        // through `execute`. This tool must be callable by name, so it is kept
        // on the provider's native tool list.
        options: { codemode: false },
        execute: async (input: SpawnWorkspaceInput) => {
          const result = await spawnWorkspace(input, liveDeps(ctx, fallback, worktreeRoot));
          // The text is what tells attach from create: on attach `mechanism`
          // reports the found directory's mechanism, and the caller must never
          // read that as a fresh clone having happened. A marker-write failure
          // never fails the call; it rides along as a warning line.
          const content =
            (result.attached
              ? `Attached to existing cow worktree at ${result.directory} (session ${result.sessionID}); no new worktree was created.`
              : `Created ${result.mechanism} worktree at ${result.directory} (session ${result.sessionID}).`) +
            (result.markerWarning === undefined ? "" : `\nwarning: ${result.markerWarning}`);
          return {
            output: result,
            content,
          };
        },
      });
      editor.add({
        name: "list_worktrees",
        description:
          "List this location's cow worktrees: each entry carries the directory's basename as " +
          "name, the directory, the strategy, and createdAt from a stat of the directory " +
          "(birthtime, falling back to mtime when the filesystem reports none). Derived from " +
          "opencode2's worktree inventory alone — there is no sessions field, because server " +
          "plugins cannot enumerate sessions (ADR 0003). The list fails rather than skipping " +
          "when an inventory row's directory cannot be read: the inventory is truth. Pass " +
          "missing: \"report\" or \"prune\" to opt out for dangling rows (a row whose " +
          "directory is gone); see the missing knob's description for the exact policy.",
        input: listWorktreesInput,
        output: listWorktreesOutput,
        // Same reason as spawn_workspace above: callable by name, not routed
        // through CodeMode.
        options: { codemode: false },
        execute: async (input: { readonly missing?: "fail" | "report" | "prune" }) => {
          const worktrees = await listCowWorktrees({
            // Own minimal deps, not liveDeps: this call touches the inventory,
            // one stat per row, and — in prune mode only — the remove API.
            // None of spawn_workspace's other seams. (Option validation happens
            // once in setup, so there is no validation side effect to dodge
            // either way.)
            listWorktrees: () => ctx.worktree.list({ projectID: ctx.location.project.id }),
            statEntry: stat,
            missing: input.missing,
            // The prune seam goes through the same DELETE route every other
            // removal uses, forced: a dangling row's directory is already gone,
            // so the strategy's dirty probe has nothing to protect.
            removeEntry: (directory) =>
              ctx.worktree.remove({ projectID: ctx.location.project.id, directory, force: true }),
          });
          const summary =
            worktrees.length === 0 ? "0 cow worktree(s)" : `${worktrees.length} cow worktree(s):`;
          return {
            output: { worktrees },
            content: `${summary}\n${JSON.stringify(worktrees, null, 2)}`,
          };
        },
      });
      editor.add({
        name: "remove_worktree",
        description:
          "Remove a finished cow worktree so its directory and inventory row are cleaned up " +
          "together — no rm -rf, no hand-editing opencode's SQLite. Takes exactly one of name " +
          "(a basename from list_worktrees) or directory (a row's directory). A guard refuses " +
          "while the worktree still holds unlanded work — commits not on the landing ref " +
          "(origin/HEAD, else main, else master) or uncommitted files — naming the counts; " +
          "an undetectable landing ref also refuses. force: true removes anyway. Only worktrees " +
          "the cow strategy created are removable; rows whose directory is already gone cannot " +
          "be cleared through the API yet (upstream candidate 8) and are refused.",
        input: removeWorktreeInput,
        output: removeWorktreeOutput,
        // Same reason as spawn_workspace above: callable by name, not routed
        // through CodeMode. permission follows the host convention since
        // v2.0.27 (PR anomalyco/opencode#53981): removal is an edit-approved
        // mutation, so `edit: deny` hides the tool.
        options: { codemode: false, permission: "edit" },
        execute: async (input: RemoveWorktreeInput) => {
          const result = await removeWorktree(input, {
            listWorktrees: () => ctx.worktree.list({ projectID: ctx.location.project.id }),
            // Force passes through verbatim: on the guard-passed clean path
            // `false` lets the strategy's own dirty probe run (and pass); at
            // `true` the strategy skips it. The quarantine mechanics stay in
            // the strategy.
            removeWorktree: (directory, force) =>
              ctx.worktree.remove({ projectID: ctx.location.project.id, directory, force }),
            directoryExists: directoryPresent,
            runGit,
            probeUncommitted,
          } satisfies RemoveWorktreeDeps);
          // The text is what carries the force story: the structured output is
          // only the directory, so a caller reading `output` alone still learns
          // the one fact that matters — this directory is gone.
          const content =
            `Removed cow worktree ${result.directory}.` +
            (result.forced ? " Force was used: the landed-ness guard was bypassed." : "");
          return {
            output: { directory: result.directory },
            content,
          };
        },
      });
    });
  },
};
