# workmux (raine/workmux) — patterns worth stealing for the cow workflow

**Scope:** primary-source read of `github.com/raine/workmux`, shallow clone at
`8deb029f36892b5080a4ec634a7f117d7384bb17` (2026-09-13). The repo is **Rust**
(~66k lines under `src/`), not Go. Every claim below was verified in source,
not taken from the README. Motivating question: workmux is an orchestration
layer over the same worktree primitive our plugin provisions — what does its
workflow do that ours doesn't?

---

## Summary

workmux ties **git worktrees + a multiplexer (tmux/zellij/kitty/wezterm) + AI
coding agents** into one CLI. Comparing it to `opencode-cow-worktree`
highlights a clear gap: our plugin owns *provisioning* (cow clone, dirty-guard
refusal, `spawn_workspace`) but has **no registry, no teardown lifecycle, no
hooks, and no listing**. workmux solves all four with patterns that transfer
cleanly to a plugin: a **repo-local git-config registry** (zero extra files),
**ordered pre-remove hooks with structured env**, **identity-captured
quarantine deletes** (TOCTOU-safe, background-deletes heavy dirs), and
**`list --json` with TTY-vs-piped formatting** so agents — not just humans —
can enumerate worktrees.

**Bottom line:** the highest-fit, plugin-layer items are (1) git-config
per-worktree metadata, (2) an idempotent `spawn_workspace` re-call (attach
instead of collide), (3) identity-captured removal, (4) a `list --json`.
Per-project declarative defaults + post-create hooks are the next tier.
Multiplexer UI, merge/PR orchestration, and statusline integration do **not**
belong in this plugin.

---

## 1. Domain model

- **Handle**: worktree basename = canonical address for everything (mux
  window, branch, agent). Derived in `src/naming.rs: derive_handle()` —
  explicit `--name` > config `worktree_naming` + `worktree_prefix` >
  slugified branch; `validate_handle()` rejects path traversal, whitespace,
  empty.
- **Window vs session** (`MuxMode`, `src/config.rs:1140`): default one tmux
  *window* per worktree; `mode: session` gives a full session (`windows`
  config; mutually exclusive with `panes`, enforced at load *and* in
  `src/workflow/create.rs: create_impl()`).
- **Pane layouts**: `Config.panes: Vec<PaneConfig>` (`src/config.rs:823`) —
  per-pane `command`, `focus`, `split`, `size`, `target`, `zoom`; named
  layouts via `layouts: HashMap<String, LayoutConfig>` (`-l`).
- **Registry = repo-local git config** (`src/git/worktree.rs:
  set_worktree_meta_in()`): per-worktree metadata stored as
  `workmux.worktree.<handle>.<key>` — `attachment`, `mode`, `target-window`,
  `target-session`, `window-token`, stored branch base. **Zero extra files**,
  survives with the repo metadata, transactional-ish with git itself.
- **Agent state**: separate XDG `StateStore` (`src/state/store.rs`,
  `~/.local/state/workmux`, `src/xdg.rs: state_dir()`): per-pane JSON agent
  records (pane PID, boot ID, command, title) for status, dashboard,
  resurrect.

Key insight: **git config as the worktree registry** — no daemon, no dotfile
litter, and the data lives exactly where git worktree state already lives.

## 2. Creation flow (`src/workflow/create.rs: create_impl()`)

Ordered pipeline, fail-loud throughout:

1. Validate config invariants (`panes` XOR `windows`; session-mode rules).
2. Collision handling: mux target exists + worktree missing + non-explicit
   name → auto-suffix with `<project_slug>` and **announce on stderr**;
   `open_if_exists` delegates to open; explicit collision → hard error with a
   `--name` hint.
3. Branch detection: create if missing; default base = current branch;
   `--remote` fetch flow with PR refspec fallbacks; detached HEAD → error
   pointing at `--base`.
4. Path-collision safety: orphan dir (unregistered, no `.git`) → auto-remove
   with logging; dir with `.git` but unregistered → **refuse — "Please remove
   it manually to prevent data loss"**; registered → error.
5. **`GitConfigLock::acquire()`** (`src/git/config_lock.rs`): flock
   serializing `.git/config` writes across concurrent `workmux add`
   processes.
6. Store metadata *before/with* `git worktree add`.
7. Headless mode: metadata-write failure → **rollback** (`cleanup_headless`,
   force cleanup, keep pre-existing branch); double failure → error chains
   both.
8. Environment provisioning (`src/workflow/setup.rs:
   provision_environment()`): file ops (copy/symlink globs) → `post_create`
   hooks → pane commands / agent launch with prompt file.

Idempotency: `workmux open` (`src/command/open.rs`) re-attaches to an
existing worktree's window/session **without re-running hooks or file ops**
(`SetupOptions { run_hooks: false, run_file_ops: false, ... }`). Creation
never silently reuses; it opens, errors, or announces an auto-suffix.

## 3. Lifecycle: close / remove / merge / cleanup

- **`close`** (`src/command/close.rs`): closes the mux window/session only,
  not the worktree; refuses if workmux doesn't manage the target; resolves
  handle from branch, directory, or cwd.
- **`remove`** (`src/command/remove.rs`): bulk-capable; classifies each
  candidate into safe / **uncommitted (blocking)** / unmerged (promptable
  y/N). Uncommitted → hard error listing handles + "Use --force to override".
  The same fail-closed philosophy as our `src/dirty.ts` guard, at fleet
  scale.
- **`merge`** (`src/workflow/merge.rs`): merge/rebase/squash into base (base
  resolution: `--into` > stored base from `add` > `main_branch`), `pre_merge`
  hooks, then cleanup: worktree + window + branch. Refuses to touch the main
  worktree ("Refusing to clean up the main worktree").
- **Stale-state reconciliation**, two layers:
  - `src/workflow/cleanup.rs`: captures a **worktree identity**
    (device+inode+`RepositoryIdentity.common_dir`) before any destructive
    step; **quarantine-rename** (`.workmux_trash_<name>_<pid>_<nonce>`)
    re-validated immediately before rename, so a recycled path can never
    redirect deletion to a different worktree; removes git's `locked` admin
    file; `git worktree prune` then verifies deregistration; heavy dirs
    (`node_modules`) die in a **deferred background worker** with bounded
    retries (`cleanup_retry.rs`).
  - `src/state/store.rs: reconcile_agents_from_snapshot()`: batched live-pane
    query; drops records whose pane PID changed (recycled pane), whose
    foreground command changed (`node`→`zsh` = agent exited), or that failed
    liveness validation; records survive server restarts (`boot_id`) for
    `resurrect` (`src/workflow/resurrect.rs`).
- **CWD discipline**: every destructive op does
  `context.chdir_to_main_worktree()` first (avoids "Unable to read current
  working directory" when run from inside the worktree being deleted).

## 4. Hooks / extensibility

Four hook groups (`src/config.rs:561`): `post_create`, `pre_merge`,
`pre_remove`, per-pane `command`s. Execution (`src/cmd.rs:
shell_command_with_env_mode()`, `src/workflow/setup.rs`):

- Configurable shell via `hook_shell: Vec<String>` (argv; command appended as
  final arg; default fallback in `cmd.rs:245`).
- Sequential, cwd = worktree, output inherited; **first failure aborts with
  context** ("Failed to run post-create command: '<cmd>'") — fail-loud, no
  fallback.
- Structured env: `WORKMUX_HANDLE`, `WM_HANDLE`, `WM_WORKTREE_PATH`,
  `WM_PROJECT_ROOT`, `WM_CONFIG_DIR` (canonicalized). `pre_remove` runs
  *before* any fs mutation, ordered before prompt-file cleanup.
- Everything skippable per invocation (`--no-hooks`, `run_hooks/run_file_ops/
  run_pane_commands`) — hooks are opt-out, not opt-in.
- Agents are first-class: `agents: BTreeMap<String, AgentEntry>`, with
  `AgentEnvValue::{Literal, FromEnv}` for secret-safe env injection (interpolated
  at shell time, quoted). Global-only "for security" per config docs.
- Hook progress logged with step counters (`step = idx+1, total`).

## 5. Config

- `.workmux.yaml` per project + global config + `--config` override +
  "frozen config" for sandbox guests (`src/frozen_config.rs`), merged in
  `Config::load_with_location_from_sources()` (`src/config.rs:2381`). Errors
  are explicit (dir vs file, frozen+override conflicts, guest restrictions).
- serde for shape; semantic validation in dedicated fns
  (`validate_panes_config`, `validate_windows_config`) called from both load
  and create; mutual-exclusion and enum constraints; rustdoc comments double
  as the rendered schema.
- Defaults via `#[serde(default)]` (`wm-` window prefix, `main__worktrees`
  dir, merge strategy).

## 6. UX

- **`workmux list`** (`src/command/list.rs`): human table (project, branch,
  age, PR status, agent status, mux status, unmerged dot) **and `--json`**;
  icons only on TTY, plain labels when piped ("for agents"). `--all`
  discovers other projects via reconciled agent state.
- **`status --json`** (`src/command/status.rs`): machine-readable per-agent
  status for statuslines/scripts.
- tmux window-name integration, dashboard/sidebar, and `send`/`capture`/`wait`
  verbs for agent-to-agent communication.
- No fuzzy finder (selection left to tmux). Bundled **Claude Code skills**
  (`skills/coordinator`, `skills/worktree`) teach an orchestrator agent to
  spawn/monitor/merge via pure CLI (`project:handle` addressing).

## 7. Git integration

Real `git worktree add` per workspace (`src/git/worktree.rs`), always via
`get_main_worktree_root()` (consistent under nested invocation). Metadata in
local git config (§1). Branch lifecycle owned: auto-create, stored base for
review diffs, delete-on-cleanup with `--keep-branch` escape hatch.
Uncommitted/untracked probes gate all destructive paths. PR-aware
(`github.rs`/`gitlab.rs`).

---

## Transferable patterns for opencode-cow-worktree

Our plugin = strategy + `spawn_workspace`; it owns creation, dirty-guard, and
session spawn, with **no registry, no teardown lifecycle, no hooks, no
listing**.

| # | Pattern | workmux | Fit for us | Layer |
|---|---------|---------|------------|-------|
| 1 | **Git-config worktree registry** | `workmux.worktree.<handle>.<key>` in repo-local git config; the *entire* state model, zero extra files | Store `{strategy, cloneMechanism, targetRoot, createdAt, sessionId}` per created worktree → enables `list`, `close`, stale detection without a global state dir. We already run git probes. | Plugin |
| 2 | **Pre-remove hook + ordered teardown with live env** | `pre_remove` runs before any fs mutation, cwd=worktree, `WM_*` env | We fail-closed on dirty worktrees but have no remove *UX*; dirty-check → optional hook → identity-verified teardown is the missing half of the lifecycle | Plugin |
| 3 | **Identity-captured quarantine delete** | dev+inode+repo identity re-validated immediately before rename-to-trash; prune + verify; deferred background delete of `node_modules` | Upgrades our dirty-guard to TOCTOU-safe (swapped dir can't be deleted) and solves "agent still holds CWD/node_modules" — rename frees the path instantly | Plugin |
| 4 | **`list --json`, TTY-vs-piped formatting** | Table for humans, JSON for agents | `spawn_workspace` is fire-and-forget; agents can't enumerate cow worktrees or find sessions. A JSON `list` makes the plugin composable in swarms | Plugin |
| 5 | **Idempotent re-call (open-if-exists)** | `add` on existing target opens, auto-suffixes with announcement, or errors with a hint | Second `spawn_workspace` call with the same target should attach to the existing worktree/session, not collide — removes a whole agent failure mode | Plugin |
| 6 | **Rollback on partial creation** | Headless create failure → forced cleanup, keep pre-existing branch; double failure chains errors | Our create flow is multi-step (dir, clone, session spawn); rolling back the worktree dir when session spawn fails prevents orphan reflink clones | Plugin |
| 7 | **Parallel-creation lock** | `GitConfigLock` serializes `.git/config` writes | Relevant only with pattern #1 + concurrent `spawn_workspace` (swarms do exactly this). Cheap flock | Plugin |
| 8 | **Declarative per-project defaults + post-create hooks** | `.workmux.yaml`: worktree_dir, naming, file copy/symlink globs, hooks, agents | Per-repo `targetRoot`/`fallback`/post-create commands (e.g. `bun install`, restore `.env`) directly address our known deep-clone edges (stale `node_modules`, missing ignored files) | Split: config+hooks = plugin; worktree *location* defaults arguably upstream |
| 9 | **Structured env into created sessions** | `WM_WORKTREE_PATH`, `WM_PROJECT_ROOT` handed to hooks/panes | Inject `COW_WORKTREE_PATH` / session id so agents can self-report and scripts can address them | Plugin |
| 10 | **Per-worktree agent status model** | State store + reconcile + statusline | Mostly upstream (opencode already knows session state); we'd only surface it in `list --json` | Upstream; plugin reads |

## Not applicable, and why

- **Multiplexer pane layout engine** (windows/panes/split/zoom, Lima
  pre-boot, sandbox guests): tmux territory; opencode2 owns session/terminal
  concerns. Our plugin correctly delegates to `spawn_workspace`.
- **Dashboard, sidebar, statusline, window-title formatting**: interactive
  TUI features; wrong host.
- **Merge/PR lifecycle** (`merge`, rebase, GitHub/GitLab): branch-workflow
  orchestration, not worktree provisioning.
- **Fuzzy finder**: workmux has none.
- **Sandbox/Lima/VM guest machinery**: orthogonal security domain.
- **Rust-specific mechanics** (XDG dirs, `Cmd` builder): pattern-level only.

## Open questions

1. If opencode2 upstream grows a first-class worktree registry/listing,
   pattern #1 should target that schema instead of inventing `cow.*`
   git-config keys.
2. Session ownership when the parent agent dies: is a `cow reap` wanted, and
   can we piggyback on opencode's session liveness instead of process probes
   (workmux's PID/command-change reconciliation)?
3. Would upstream accept a `post-create` hook point in the worktree-strategy
   interface (any strategy gets it), or must hooks stay plugin-local?
4. Deferred background delete relies on a spawned OS process outliving the
   CLI exit — acceptable inside opencode's plugin sandbox, or should we use
   rename-now + explicit follow-up check?
5. Collision policy for `spawn_workspace`: auto-suffix-with-announcement or
   explicit-error-with-hint (workmux supports both)? Product decision.
