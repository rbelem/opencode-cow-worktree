# opencode-cow-worktree

A copy-on-write worktree strategy for [opencode2](https://opencode.ai). Each
agent gets a complete, independent copy of the project: tracked files,
`node_modules`, build caches, local env files, all of it, cloned in
milliseconds at almost no disk cost. Where a `git worktree` carries tracked
files only, a **Deep clone** here carries everything, so the agent can run the
test suite immediately.

Current release: [v0.5.0](https://github.com/rbelem/opencode-cow-worktree/releases/tag/v0.5.0),
also on [npm](https://www.npmjs.com/package/opencode-cow-worktree). Install
from a local checkout (form A below) or from the npm registry.

## Requirements

- opencode2's server runs on **Bun**. The macOS backend needs Bun (`bun:ffi`);
  it does not work under Node.
- Linux: **btrfs**, or XFS with reflink enabled. macOS: **APFS**.
- The worktree directory must be on the **same filesystem** as the project. A
  reflink cannot cross a device boundary, and the plugin fails loudly rather
  than degrading to a full copy. Configure it as shown below; the default
  location opencode2 picks is usually on a different filesystem.

## Install

**What installing changes.** Registering the plugin makes `cow` opencode2's
default worktree strategy everywhere — TUI, API, and tool calls. There is no
capability gate on that default: on a filesystem that cannot reflink (ext4,
tmpfs), worktree creation fails loudly until you remove the plugin. Install
it only on machines whose projects meet the Requirements above. opencode2
Desktop cannot select plugin strategies today, so it ignores the plugin
entirely
([`docs/research/desktop-strategy-hardcode.md`](https://github.com/rbelem/opencode-cow-worktree/blob/main/docs/research/desktop-strategy-hardcode.md)).

### The short version

opencode2 installs the plugin itself from npm. Add the package to the
`plugins` array of your `opencode.json`:

```json
{
  "plugins": [{ "package": "opencode-cow-worktree@latest" }]
}
```

Or let the CLI write that entry:

```sh
opencode2 plugin add opencode-cow-worktree
```

On the next startup opencode2 downloads the package into its own cache
(`~/.cache/opencode/node_modules/`) and loads it. That is the whole install:
the `cow` marker in the TUI sidebar ships in the same package and loads with
it — no seam files, no checkout, no symlink. The first startup waits for the
download, so give it a few extra seconds.

Declare the plugin exactly once. A duplicate declaration (registry entry plus
local path, or a discovered plugin directory plus the array) makes one of the
two loads fail with `Plugin failed to load`.

### Options

Options ride in the same entry:

```json
{
  "plugins": [
    {
      "package": "opencode-cow-worktree@latest",
      "options": {
        "hooks": { "postCreate": ["corepack use pnpm@latest"] }
      }
    }
  ]
}
```

`hooks`, `fallback`, and `targetRoot` are all optional; anything omitted takes
its default. Each is described below.

### Development install

To work on the plugin itself, point the entry at a checkout instead of the
registry. Because opencode2's runtime is Bun and the path points at the
working tree, tracked edits are live with no build step:

```json
{
  "plugins": [{ "package": "/path/to/opencode-cow-worktree" }]
}
```

### Verify

Confirm the plugin loaded:

```sh
opencode2 plugin list
```

`opencode-cow-worktree` should appear with state `active`.

For a deeper check — that a worktree create with no `strategy` field
materializes a Deep clone, proving `cow` became the default — the repository
ships a script:

```sh
bun scripts/dogfood-install-check.ts
```

Run it from a repository checkout; the script ships with the repo, not the
npm package. It boots a throwaway server against the installed plugin and
asserts that the plugin activates and that the default create is a Deep
clone.

Two gotchas when checking by hand: `GET /api/plugin` does not await
activation, so a list taken right after boot can look empty — resolve
`POST /api/plugin/await-activation` first. And if the plugin is present both as
a discovered directory and in the `plugins` array, one of the two loads fails
with `Plugin failed to load`; remove one of the declarations.

## Configure

### `worktree.directory` — set this first

opencode2's default worktree parent lives under its data directory, which is
often on a different filesystem from your projects. Point it inside the
project's own filesystem:

```json
{ "worktree": { "directory": ".opencode/worktrees" } }
```

A relative value resolves against the project checkout, which puts every clone
on the source's filesystem by construction. An absolute value is used as-is
and must be on the same filesystem as each project. Without this, `cow`
creates fail on most setups while the built-in `git` strategy keeps working.

### Plugin `options`

All three options are validated when the plugin loads. A malformed value fails
the plugin load with a message naming the option; it never degrades silently.

**`fallback`** — what `spawn_workspace` does when the source filesystem cannot
clone (default `"none"`):

- `"none"`: a request for `cow` produces a Deep clone or fails. Never a
  shallow worktree.
- `"git"`: on a non-CoW filesystem the tool may build a regular `git`
  worktree instead and report `mechanism: "git"`. This works on opencode2
  builds whose worktree create still accepts a `strategy` request
  (2.0.2-era). From the projectID-era API onward (20260915 nightlies,
  v2.0.3+) the create always runs the selected strategy and ignores the
  field, so the non-CoW refusal surfaces and the fallback cannot engage.

**`targetRoot`** — where `spawn_workspace` places the worktree. Unset (the
default) means a sibling of the source, on the source's filesystem by
construction. A path is used verbatim and must share the source's filesystem
for `cow`.

**`hooks.postCreate`** — commands run at the end of every `cow` create,
whatever started it (HTTP API, TUI, `spawn_workspace`):

```json
{
  "plugins": [
    {
      "package": "/path/to/opencode-cow-worktree",
      "options": {
        "hooks": {
          "postCreate": [
            "corepack use pnpm@latest",
            "cp $COW_SOURCE_DIRECTORY/.env.local ."
          ]
        }
      }
    }
  ]
}
```

Commands run sequentially via `sh -c` in the new worktree, with
`COW_WORKTREE_PATH` and `COW_SOURCE_DIRECTORY` (absolute) in the environment.
A five-minute timeout applies per command; stdin is detached, so a command
that waits on input fails instead of hanging. The first failure removes the
just-created clone (no orphan directory) and the error names the failed
command, its 1-based step, and its captured output.

Hooks are your own configuration and run with full shell rights inside the
new worktree: treat the list like a shell script you wrote.

**Per-project values**: opencode2 merges plugin `options` from a project-level
`opencode.json` the same way as the global one, so a project can declare its
own `hooks.postCreate` (or `fallback`/`targetRoot`) and every other project
keeps the global default.

## Using it

Registering the plugin makes `cow` the **default strategy**: a worktree create
from the TUI, the API, or a tool call materializes a Deep clone. Passing
`strategy: "git"` explicitly still selects opencode2's built-in strategy.

**`spawn_workspace`** (for agents): creates a worktree and starts a session in
it, returning `{ sessionID, directory, mechanism, attached }`. `mechanism`
tells a `cow` Deep clone from a `git` shallow worktree, so an agent that
relies on ignored files knows whether it has them.

If the requested name already belongs to a cow worktree, the call attaches: a
new session binds to the existing directory and `attached: true` comes back —
nothing is cloned. Attach only happens for worktrees this strategy
materialized; anything else already at that path (a `git` worktree, an unknown
directory) is refused before anything changes. If the worktree's recorded
session still shows activity, the attach is refused and the error names the
occupying session and the ways to recover.

A create whose target path already exists is refused before the first write:
`cow` never merges into, or deletes, a directory it did not create. Resolve
the path and re-run.

**`list_worktrees`**: lists the location's cow worktrees — `name` (the
directory basename), `directory`, `strategy`, and `createdAt`. Derived from
opencode2's inventory alone; it has no session information.

**Removal**: the strategy refuses to delete a worktree with uncommitted
changes unless you confirm with force — and if it cannot tell (no git
metadata, a failed probe), it refuses too. Past that guard the directory is
renamed to a sibling `.cow-removing-<name>-<random>` and deleted from there,
so an agent holding a working directory inside does not block the removal.
`node_modules`-class directories are deleted in the background right after;
a `.cow-removing-…` sibling that lingers means a deletion failed midway and
its error was logged — the remains hold nothing else and are safe to delete
by hand once no process is using them.

The fallback policy is tool-only: `POST /api/worktree {strategy: "cow"}` calls
the strategy directly, which always fails loudly on a non-CoW source
regardless of `fallback`. Only `spawn_workspace` consults the policy.

## Troubleshooting

- **"the target is on a different filesystem"** — set `worktree.directory` as
  shown above, or point `targetRoot` at the source's filesystem.
- **`cow` fails on an ext4 or tmpfs project** — expected: that filesystem
  cannot clone. On opencode2 builds from the projectID era (20260915
  nightlies, v2.0.3+) the `git` fallback cannot be requested through the
  create API, so the refusal is final; on 2.0.2-era builds the `fallback:
  "git"` option produces a regular git worktree for tool calls.
- **The plugin is stuck on an old version** — opencode2 caches the package
  under `~/.cache/opencode/node_modules/`. Remove the plugin's cache
  directory and restart: `rm -rf ~/.cache/opencode/node_modules/opencode-cow-worktree`.
- **Plugin looks absent right after boot** — resolve
  `POST /api/plugin/await-activation` before reading `GET /api/plugin`.
- **`Plugin failed to load`** — the plugin is declared twice (discovered
  directory plus `plugins` array). Keep one.
- **A `.cow-removing-…` directory that will not go away** — a background
  deletion failed; the server log names the cause. Delete it by hand once no
  agent holds a directory inside it.

## Development and verification

The unit suite (`bun test`), typecheck (`bun run typecheck`), coverage gate
(`bun run test:coverage`), and the e2e harness (`bun scripts/e2e/harness.ts`)
are described in
[`docs/development.md`](https://github.com/rbelem/opencode-cow-worktree/blob/main/docs/development.md),
along with the recorded live runs and the parallel-lane tooling this
repository is developed with.

Terms the output uses: a **Workspace** is a logical handle, a **Location** is
where a session runs, and a **Worktree** is a directory materialized by a
**Strategy** — more in
[CONTEXT.md](https://github.com/rbelem/opencode-cow-worktree/blob/main/CONTEXT.md).

## License

MIT
