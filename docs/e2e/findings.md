# e2e findings

Analysis that accompanies [`run-2026-09-11.md`](./run-2026-09-11.md). Every finding
below was produced by running `scripts/e2e/harness.ts` against the real
`opencode2 v0.0.0-next-20260910` binary, not by reading its source. This is the
ticket's most valuable output: what the design got wrong about the real server.

## 1. The config key is `plugins` (plural), not `plugin` (singular)

Declaring `plugin: [{ package, options }]` produces:

```
configuration normalization diagnostic source=... path=$.plugin.0 kind=invalid
  action="skipped malformed recognized value"
```

and the plugin silently never loads. The schema
(`packages/schema/src/config/plugin.ts`) names the field `plugins`. The #1 spike's
note that "the plugin configuration key is `plugin` (singular)" does not hold for
this build. `src/config.ts` reads the plugin's `options`; the field that carries
those options is `plugins`.

## 2. A configured plugin target must be a directory, not a file

Pointing an entry at the repo's `src/index.ts` logs
`configured plugin path must be a directory` and skips it entirely. The target
must be a directory from which `Host.resolve` finds an `index`/`server` entrypoint.
The harness installs a directory whose `index.ts` re-exports the repo's
`src/plugin.ts`, which is the same shape a user installing a plugin directory
would get.

## 3. `GET /api/plugin` does not await activation

Immediately after boot the list is empty (or the builtin set); the configured
plugin appears only after `POST /api/plugin/await-activation` resolves. The
handler for `plugin.list` reads the inventory directly, while `plugin.check` and
the worktree handlers await activation first. A client that lists without awaiting
activation concludes, wrongly, that the plugin is absent.

## 4. `GET /api/worktree` returns a bare array

Every other endpoint read here wraps its payload in `{ data }` (sessions, plugins,
location). The worktree list returns the array itself. A client written against
the wrapper shape reads `undefined` and reports no worktrees.

## 5. The fallback is tool-only, so the API-direct backbone cannot reach it

This is the largest discrepancy. `POST /api/worktree` invokes the selected
*strategy* directly (`packages/core/src/worktree.ts`:

```ts
const created = yield* selected.create({ directory, sourceDirectory, branch }).pipe(...)
```

). The fallback policy lives in the `spawn_workspace` *tool*
(`src/tool.ts`), which runs only when an agent invokes it. On a non-CoW source,
`POST /api/worktree {strategy:"cow"}` therefore fails loudly with `cow strategy
failed to clone into …` regardless of `options.fallback` — which is the strategy's
correct fail-loud contract, but it means the design's §6 expectation ("with
`options.fallback: "git"` assert the API produces a worktree reported as git") is
not achievable through the API.

Consequence: the fallback opt-in end-to-end is **deferred**. It is covered at the
tool seam by `test/plugin-fallback.test.ts` (#6), and reaching it against the real
server needs an agent session invoking the tool, which needs provider credentials
(finding 6).

## 6. A real agent fan-out needs provider credentials the isolated config lacks

A prompted session produces the `user` message and nothing else;
`POST /api/session/:id/wait` never returns; the server logs a 401 fetching
provider config. Credentials live in the server's database (not `~/.local/share/opencode/auth.json`,
which is a v1 leftover), and seeding them would mean touching the user's real auth
or fabricating a provider. The harness therefore uses the design's recommended
deterministic backbone (§4(b)): it drives `POST /api/worktree` and
`POST /api/session` directly and performs the per-worktree edits itself. The
independence proof is unaffected — it tests whether the worktrees share mutable
state, which is exactly what a shared working directory would get wrong.

**Resolved in #9.** The credential problem is avoidable without touching the
user's auth: a config-only `providers.sim` entry (with `settings.apiKey`)
satisfies the configured-auth check, and the compiled-in simulation harness
(`OPENCODE_SIMULATE=1` + `OPENCODE_DRIVE=1`) answers the provider from a
drive-controller websocket. No `credential` row is needed. See finding 10 for
the resulting real-session run.

## 7. The server runtime is Bun

The single-file binary contains `Bun v${…}` build strings. So
`COPYFILE_FICLONE_FORCE` reaches the Linux clone path and the `cow` mechanism is
genuine. This is corroborated independently by the shared-extent measurement: the
clone reports its extents as `shared` and almost nothing exclusive, while the
`cp --reflink=never` control shares nothing.

## 8. A non-CoW source must be a project opencode2 has recorded

On `/dev/shm` the first `POST /api/worktree` returned
`Worktree source not found: /dev/shm/cow-e2e-…` until the tmpfs source was a git
repository **and** `POST /api/worktree/refresh` had run. `Worktree.create`'s
`source()` consults the project's recorded worktree inventory, not merely the
filesystem, so a bare directory is not enough.

## 9. A plugin tool is hidden behind CodeMode by default

This finding was first recorded as "plugin tools are never offered to a session",
which is **wrong**. A plugin tool is registered, but by default it is routed
through CodeMode rather than the provider's native tool list, so the model sees
`execute` and not the tool's own name. Two defects in this plugin were fixed:

1. **`options.codemode` was unset.** opencode2 splits tools at snapshot time
   (`packages/core/src/tool.ts`): `codemode === false` goes on the provider's
   native list, anything else — including unset — goes behind CodeMode, which
   advertises only `execute`. `packages/core/src/tool/AGENTS.md` states the
   default is CodeMode. The registration now sets `options: { codemode: false }`,
   and the model is offered `spawn_workspace` by name:

   ```
   edit, glob, grep, question, read, shell, skill, spawn_workspace, subagent,
   webfetch, websearch, write, execute
   ```

2. **The tool returned an `output` field without declaring an output schema.**
   opencode2 treats that as a defect, not a recoverable error:
   `Effect.die("Tool result declared output without an output schema")`
   (`packages/core/src/tool/runtime.ts`). The registration now declares
   `output`, so the `{sessionID, directory, mechanism}` result survives as
   structured output.

With both fixed, the simulation path reaches `spawn_workspace` end-to-end. The
earlier "not reachable" conclusion came from running the pre-fix plugin: the
tool was registered and functional, but never advertised to the model.

## 10. A scripted model still proves the loop is real

Acceptance criterion 4 ("the invocation path is a real session/tool call, not a
direct function call") is satisfied. The `shell` call in the run log executed
inside the real server process (`sim-shell-ran`, exit 0) with its output in the
session transcript, and `spawn_workspace` likewise executed through the same
loop. Only the model's bytes are scripted; the session loop, tool registry, tool
decoding, and tool execution are production code.

The drive endpoint must be parsed from the server's own matched log line, not
from a split of the whole captured buffer: stdout and stderr interleave without
a separator, so `buffer.split("opencode drive backend websocket: ")[1]` captures
the rest of the stream, not the URL.

## What the harness proves

- The plugin installs through the real loader and reaches `active`.
- A fan-out of three worktrees, each with a session started in its own directory,
  through the real HTTP API.
- Each worktree is independent: it sees only its own marker and its own line in
  the shared-named log, and the source is untouched.
- Each produced directory is a Deep clone: ignored files present, symlinks are
  links, a real standalone `.git` with no alternates, matching `git status`.
- Extents are genuinely shared (btrfs measurement, with a byte-copy control).
- `GET /api/worktree` lists each directory with `strategy: "cow"`.
- Removing the worktrees through the API leaves no directories and no inventory
  entries.
- On a real non-CoW filesystem, requesting `cow` fails loudly and leaves no
  directory.
- A real session is offered `spawn_workspace` by name and executes it.
- Through that real invocation, the fallback policy holds end to end: a
  non-CoW source with `fallback: "git"` produces a git worktree and reports the
  `git` mechanism; the same source with `fallback: "none"` fails loudly and
  leaves nothing behind.
- Under the compiled-in simulation harness, a real session runs and a scripted
  builtin tool call executes in the server process (finding 10).

## What the harness cannot prove

- Anything about macOS/APFS from the local harness — #7 is verified by CI
  measuring shared extents on real arm64 and x86_64 macOS runners instead.
- Correctness on filesystems other than btrfs (positive) and tmpfs (negative).
- The fallback opt-in against the real server (finding 5/6).
- That the plugin's `spawn_workspace` *tool* is reachable from a session
  (finding 9): the compiled-in simulation harness drives a real session, but
  opencode2 offers the session only its builtin tools.
- That the plugin is "tested enough" — a release judgement made by a person over
  time, deliberately not encoded in this ticket.
- Agent reasoning: the harness asserts filesystem facts, not model behaviour.

## 11. Directory discovery already loads a `plugins/` child; declaring it too double-loads it

Found while installing the plugin into a real opencode2 config. Every
`.ts`/`.js` under `plugins/` is auto-discovered, and so is a directory there
whose entrypoint resolves. A `plugins/opencode-cow-worktree/index.ts` is
therefore loaded **without any `plugins` array entry**.

Declaring that same path as `{ package: "~/.config/opencode/plugins/opencode-cow-worktree" }`
loaded the tree twice: the discovered copy reported

```
opencode-cow-worktree [local] active
```

and the package-sourced copy reported

```
{"source":{"type":"package","target":"~/.config/opencode/plugins/opencode-cow-worktree"},
 "state":{"status":"failed","error":"Plugin failed to load","ref":"err_bda47926"}}
```

The package loader does not follow the `node_modules` symlink a local install
uses. Removing the array entry leaves one active copy and no failures.

## 12. The default worktree target is on the wrong device for a reflink

`Worktree.create` defaults the parent to
`path.join(global.data, "worktree", projectID.slice(0, 6))` — i.e. under
`$XDG_DATA_HOME/opencode/worktree/<6 chars>` — and opencode2 creates that parent
itself, then hands the Strategy `path.join(parent, name)`. On this machine that
is a different device from the project (device 60 vs 43), and a reflink cannot
cross a device boundary, so:

```
400 WorktreeError: Worktree strategy cow failed to create:
cow strategy failed to clone into /home/rodrigo/.local/share/opencode/worktree/a5922b/real-cow
```

The built-in `git` strategy is unaffected (a git worktree shares no extents), so
`cow` is the strategy that breaks on the default. opencode2 exposes the setting
`worktree.directory`, described as *"relative to the project's primary checkout
when not absolute"*; its builtin `opencode.config.worktree` plugin resolves it
with `path.resolve(location.project.canonical, directory)`. A **relative** value
therefore lands on the source's own filesystem by construction:

```json
{ "worktree": { "directory": ".opencode/worktrees" } }
```

`Worktree.service` has an internal `editor.configure({ directory })`, and that is
exactly what opencode2's own builtin `opencode.config.worktree` plugin calls. It
is **not exposed to user plugins**: the editor handed to a plugin forwards only
`add` (`packages/core/src/plugin/host.ts:491-502`, and the promise adapter in
`packages/plugin/src/promise/adapter.ts:553-566`), and the published
`WorktreeEditor` type declares `add` alone. A plugin therefore cannot set the
default target; it can only register a Strategy. The setting above is the
mechanism, and because `ConfigWorktreePlugin` activates in the `post` group
(`packages/core/src/plugin/internal.ts:242`), it reliably lands after any user
plugin's transforms.

The strategy is the one that adds a same-device constraint the host never
promised: the built-in `git` strategy is unaffected because a git worktree
shares no extents.

## 13. A target inside the source made the clone recurse forever

A direct consequence of finding 12: once the target is a subdirectory of the
project, `cloneDirectory` walked into it and cloned the target into itself:

```
Error: ENAMETOOLONG: name too long, open
  .../project/.opencode/worktrees/one/.opencode/worktrees/one/.opencode/worktrees/one/.../.git/objects/c2/6
```

The clone succeeded with a sibling target and failed with a nested one. Fixed by
skipping the resolved target subtree during the walk; a target that *contains*
the source is now rejected before anything is created. This is the natural
configuration (finding 12), not an edge case, and it was only reachable by
running the plugin against a real config with a real relative target.

## 14. The terminal UI renders no Strategy name, but a plugin can add one

No stock surface names the Strategy. The CLI's worktree dialog reads `strategy`
only to sort entries and to pick a fallback (it never displays it), and the two
TUI worktree dialogs resolve a target through `POST /api/worktree` without
naming the mechanism that produced it. The `.git` shape is the only
out-of-band tell: a `.git` **directory** means the `cow` clone, a `.git`
**file** with a `gitdir:` pointer means a git worktree.

That is a UI gap, not a protocol gap: `GET /api/worktree` already returns the
Strategy per entry. The protocol's list schema is
`Worktree.Directory = { directory, strategy? }`
(`packages/schema/src/worktree.ts:34-37`), so the data a badge needs is already
on the wire. The two `worktree.*` events are not usable for this:
`worktree.ready` carries only `name` and an optional `branch`, and
`worktree.failed` only a `message` — neither carries the Strategy.

The CLI is extensible through a documented plugin runtime, so the badge belongs
in a plugin rather than a fork. `@opencode/plugin/tui` accepts a
`Plugin.define({ id, setup })` module, and `Host.resolve` looks for a bare `tui`
entrypoint beside the server one (`packages/plugin/src/host.ts:43`). `setup`
receives `context.client` (the same generated client), and version-control data
is already exposed through `context.data.location.vcs`. Slots include `app`,
`home.footer`, `prompt.footer`, `prompt.footer.status`, `prompt.footer.file`,
`session.composer.top`, `session.panel`, `sidebar.content`, and
`sidebar.footer` (`packages/plugin/src/tui/context.ts:191-201`), each with
`prepend`/`append`/`before`/`after`/`replace` placement.

The **desktop and web app have no equivalent seam**. Nothing under
`packages/app` or `packages/desktop` registers UI slots, `ui.slot` exists only
in the terminal runtime, and the published app type is a name/version/channel
record. Documented plugin UI is CLI-only. Naming the Strategy in the desktop
app therefore means patching opencode2 itself or building a separate client on
the same protocol; it is not reachable from a plugin.

## 15. The desktop app *cannot select the default Strategy*, and a missing
worktree directory is not a stuck row

Two ways a registered default fails to apply, found while clearing up after the
badge work. Both are upstream, not plugin-reachable. Issues #12 and #14.

**The desktop app hardcodes its Strategy.** `packages/app/src/workspaces/create.ts:14`
sends `strategy: "git"` as a literal, so `input.strategy ?? current.selected`
(`core/src/worktree.ts:236`) never falls through to the selected default. Both
desktop flows route through that one helper. The TUI omits `strategy` at both
call sites and therefore does reach `cow`. Registering a definition with id
`"git"` would hijack the built-in for the Location and mis-route removals
(discovery stamps `strategy:"git"` on every non-root git worktree, while the
checkout root is recorded with no strategy), so it is not a workaround worth
taking.

**`DELETE /api/worktree` refuses a directory that is already gone, but the row
is not stuck.** `Worktree.remove` runs `Le` — resolve, then `isDir` — *before* it
reads the recorded strategy:

```js
var Le = e.fnUntraced(function*(H,t){
  let L = DH.make(yield*H.resolve(t));
  if(!(yield*H.isDir(L))) return yield*new pL({directory:t});
  return L;
});
```

so a missing directory raises `DirectoryUnavailableError` and the strategy's
`remove` is never reached. Two notes correct an earlier reading of this:

- `resolve` does *not* raise on a missing path; it swallows `NotFound` and
  returns the literal path. The `isDir` on the next line is the gate.
- The built-in `git` strategy fails identically (`repo.discover` on a missing
  directory), so this is not specific to `cow`. v1 returned success for exactly
  this case (`packages/opencode/src/worktree/index.ts:407-414`), so v2 is a
  regression.

The row is not stranded: `Worktree.list` calls `refresh()`, which deletes every
row whose directory fails `isDir`. So `GET /api/worktree` (or
`POST /api/worktree/refresh`) is a supported recovery, and `mkdir -p <dir>` then
re-DELETE also works. `removeWorktreeMissingDirectory` in
`scripts/e2e/scenarios.ts` pins the prune rather than a successful DELETE.

## 16. `cow`'s `remove` forwards opencode2's `force` into `rm`'s `force`

They mean different things. `node:fs` `rm`'s `force` is "ignore a nonexistent
path"; opencode2's `force` is "proceed despite uncommitted changes" — the git
strategy maps it to `--force` and raises `forceRequired` when git refuses,
which the TUI turns into a confirmation and retries at `force: true`.
Forwarding it means a dirty worktree is **deleted** at `force: false` where git
would have stopped, and `cow` can never raise `forceRequired` because `rm` never
refuses. Issue #13. The near-miss to avoid: hardcoding `force: true` there would
delete the protocol seam rather than implement it.
