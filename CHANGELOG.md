# Changelog

## 0.6.0

Compatibility with opencode2 v2.0.27's built-in worktree tools (PR
anomalyco/opencode#53981), which moved `worktree_create`, `worktree_list`,
and `worktree_remove` into the host.

- **Native creates produce cow clones.** The built-in create carries no
  strategy field and uses the location's default strategy, which this plugin
  registers. Verified on 2.7.50: strategy-less creates report `cow` in the
  inventory and materialize Deep clones, including when the create is the
  server's first worktree call — no lazy-activation gap. The new native-path
  matrix (`scripts/e2e/native-matrix.ts`, 18 checks) pins the contract.
- **`remove_worktree` now requires edit approval** (`permission: "edit"`,
  the host's removal convention since v2.0.27). With `edit: deny` the tool
  is hidden, same as the built-in remover.
- The strategy's force-less refusal reason carries through the native remove
  path verbatim, and `force: true` discards ignored files on both surfaces.
  Cow clones hold env files and local state that exist nowhere else, so
  treat force on a cow lane as destructive.
- Suite: 348 tests; the e2e harness (112 checks) and the native-path matrix
  (18 checks) pass against opencode2 2.7.50.

## 0.5.0

The plugin is renamed: `opencode2-cow-worktree` is now `opencode-cow-worktree`.

- **The package name, plugin id, and TUI id carry the new name.** Install with
  `opencode2 plugin add opencode-cow-worktree`, or
  `"package": "opencode-cow-worktree@latest"` in `opencode.json`. The GitHub
  repository moved to `rbelem/opencode-cow-worktree`; GitHub redirects old
  links.
- **CoW capability probes write scratch directories prefixed
  `.opencode-cow-capability-`** (was `.opencode2-cow-capability-`). Leftover
  scratch from older versions is inert: cleanup is in-process and nothing
  scans for the old prefix.
- The dogfood install check now matches the 20260917 nightly's API: readiness
  polls `GET /api/plugin` (`/api/health` lost its handler on the 20260915
  nightly), activation is detected by polling the plugin list, and worktree
  endpoints carry `projectID`.
- Suite: 348 tests; the dogfood install check passes 12/12 against the
  20260917 nightly.

## 0.4.1

Fixes a false refusal class in `remove_worktree`: a lane whose work already
landed on the remote is no longer refused.

- **The landed-ness guard refreshes stale refs before refusing** (#16). A cow
  lane is a separate clone whose `origin/*` refs freeze at clone time, so a
  commit that landed through a merged PR read as unlanded, and the guard
  refused — training operators to reach for `force`. On the refusal path the
  guard now runs one `git fetch origin`, re-judges on the fresh refs, and
  reports that verdict. A pass on stale refs is already sound for
  fast-forward remotes, so the happy path never fetches. A failed fetch
  keeps the refusal and names the verdict as stale-limited, preserving the
  guard's fail-closed posture.
- Suite: 348 tests. The live-git repro of the issue and three new
  decision-table rows pin the refresh, the failed refresh, and the
  unchanged verdict.

## 0.4.0

The cow lifecycle is complete: worktrees can now be removed by the agent, not
only created and listed. And a class of project roots that could never clone
at all — those carrying a live socket — now clone cleanly.

- **`remove_worktree`**: agent-facing removal wrapping the strategy remove
  path. The call names the worktree by `name` or `directory` (exactly one of
  the two, resolved against the inventory), refuses anything the inventory
  does not know as a cow worktree, and refuses rows whose directory is
  already gone — until upstream candidate 8 lands, a dangling row cannot be
  de-registered through the API. The landed-ness guard fails closed: HEAD
  must be an ancestor of the landing ref (`origin/HEAD`, else `main`, else
  `master`), or the tree must be clean with no unique commits; `force: true`
  bypasses the guard and the result says so.
- **`list_worktrees` gains the `missing` knob** (ADR 0003's dangling-row
  story). An ENOENT on a listed directory still fails the listing loudly by
  default; `missing: "report"` returns the row flagged `missing: true`
  without a derived `createdAt`, and `missing: "prune"` de-registers the row
  through the inventory's own remove (forced) and drops it from the listing.
  Any non-ENOENT stat failure remains a hard failure in every mode. Prune is
  gated on upstream candidate 8: `Worktree.remove` resolves the real path
  before reading the record, so a gone directory answers 400 even at force.
- **Clone skips sockets, FIFOs, and device nodes** (#17). A live daemon
  socket at a project root (e.g. `.codegraph/daemon.sock`) classified as a
  plain file, failed FICLONE with `EOPNOTSUPP`, and rolled the whole clone
  back — every cow clone on such a root aborted. The entries are now
  classified "special" and omitted: runtime state the clone's own daemons
  recreate, never tree content. Pinned by a real `node:net` unix-socket
  integration test that runs on any filesystem.

Also in this release:

- Docs: upstream candidates 9-11 filed from the 2026-09-20 field run.
- The coverage gate is green again at 100% lines on all 22 gated files:
  `remove_worktree`'s plugin wiring (the live `ctx.worktree` remove calls,
  force pass-through, result text, and the prune seam) and the live git
  binding are now pinned by tests. Suite: 344 tests.

## 0.3.0

Adapted to the projectID-era opencode2 worktree API (20260915 nightlies and
later; verified against `0.0.0-next-20260917`). The API now requires the
project id on every worktree call, dropped the per-request `strategy` field,
and dropped the `location` query. `spawn_workspace` and `list_worktrees`
derive the id from the plugin's own location context, pass the source as
`from`, and still send `strategy` for 2.0.2-era binaries, where it is what
selects the git fallback's mechanism.

Behavior notes:

- On projectID-era binaries the `git` fallback cannot be requested through
  the create API: a non-CoW source fails with the cow refusal, and the
  refusal is final. The option still works on 2.0.2-era builds. Documented
  in the README.
- Create no longer assembles `<parent>/<name>` verbatim when the path is
  taken; the server suffixes `name-2` through `name-10`. Named
  `spawn_workspace` calls are unaffected: the tool refuses anything it
  cannot attach to before create runs.

Also in this release:

- Issue #14 (Desktop hardcodes `strategy: "git"`) resolved upstream by the
  same refactor and closed.
- The e2e harness speaks the projectID-era API end to end: 112 checks, 0
  failed against a real `0.0.0-next-20260917` server
  (`docs/e2e/run-2026-09-17.md`). Unit suite: 307 tests, coverage gate at
  100% lines on all 21 shipped files.

## 0.2.0

`spawn_workspace` refuses to attach a new session onto a cow worktree a live
session is still using (ADR 0004). The tool records occupancy itself: on both
the create and attach flows it writes `.cow-session.json` at the worktree root
(kept out of `git status` through `.git/info/exclude`), and at attach time it
probes the recorded session through the session API. Only a positive proof
that the session is gone lets attach proceed: a 404, or silence past a
60-minute window. A live session, a malformed marker, or a probe failure that
proves nothing refuses the attach and names the occupying session plus the
three recoveries (pick another name, delete the session out of band, remove a
known-stale marker). Legacy worktrees without a marker keep today's fail-open
behavior and gain a marker; the git fallback is untouched. A failed marker
write never fails the call; the result carries an "unguarded" warning.

Verified against a real `opencode2 serve` (`0.0.0-next-20260912.3`): the
attach scenario refuses on a live session, proceeds after the occupying
session is deleted, and backfills markers onto legacy worktrees
(`docs/e2e/run-2026-09-16.md`). Unit suite: 307 tests, coverage gate at 100%
lines on all 21 shipped files.

Also in this release:

- The e2e harness stays runnable across the 20260915 nightly split; its
  readiness probe polls `/api/plugin` because the nightly answers 404 on
  `/api/health`. The pinned `0.0.0-next-20260912.3` is unaffected.
- Docs: ADR 0004, the announcement draft, the ecosystem listing draft, and
  upstream filing candidates 6-8 (the nightly's `/api/health` 404, its
  `projectID` requirement that breaks plugin worktree creates, and the
  realpath-first `Worktree.remove` that strands dangling rows).

## 0.1.1

Documentation-only release; no code changes. It carries the new install
story to the npm package page: the plugin installs as a single config entry
(`opencode2` downloads it from npm at startup) or one
`opencode2 plugin add` command, with options in the same entry and the
checkout recipe kept for development. Also new: user-side verification with
`opencode2 plugin list`, the plugin-cache reset for stuck updates, the
recorded release procedure, and the ecosystem listing draft.

## 0.1.0

The first release: tagged `v0.1.0` and published to npm.

- **`cow` Strategy**: Deep clones via forced reflink (Linux
  `COPYFILE_FICLONE_FORCE`, macOS `copyfile(3)` through `bun:ffi`), a fail-loud
  capability probe, and a same-device pre-flight. Refuses an occupied target
  before the first write, and a failed create removes only what it cloned.
- **`spawn_workspace`**: create-plus-session with attach-to-existing semantics
  (`attached: true`), `mechanism` reporting, an opt-in `git` fallback, and a
  loud refusal of anything at the target path the inventory does not know as a
  cow worktree.
- **`list_worktrees`**: the location's cow worktrees, derived from opencode2's
  inventory alone.
- **Post-create hooks** (`hooks.postCreate`): sequential `sh -c` in the new
  worktree, `COW_WORKTREE_PATH`/`COW_SOURCE_DIRECTORY` in the environment, a
  five-minute per-command timeout, stdin detached, captured output capped in
  errors, and a first failure that rolls the create back.
- **Removal**: an uncommitted-work guard that fails closed on unknown state, an
  identity-captured quarantine rename, and two-phase deletion with an async
  tail for `node_modules`.
- Every plugin option validated once at setup; misconfiguration fails the
  plugin load rather than surfacing mid-session.
- macOS backend verified on real APFS by CI (arm64 and x86_64, shared extents
  measured). A 31-scenario parallel-agent swarm and a four-scenario e2e
  harness are recorded under `docs/e2e/`.
- Development: `scripts/lane.ts` spawns and absorbs parallel CoW lane clones
  (origin-stripped, `--no-ff` absorb); conventions in `docs/lane-workflow.md`.
