# Announcement draft (ticket 07)

Ready to paste. Posting is the owner's; timing is the owner's
(TODO(owner): pick the moment). Every claim traces to a repo doc, listed at
the bottom.

## X / Twitter — thread of four

**1/4**

I published opencode-cow-worktree: a copy-on-write worktree strategy for
opencode2. Every parallel agent gets a complete clone of the project —
node_modules, ignored files, .env included — in milliseconds, and the clones
share extents, so it costs almost no extra disk.

**2/4**

It registers as opencode2's default worktree strategy: a worktree create from
the TUI, the API, or a tool call materializes a Deep clone. spawn_workspace
creates the worktree and starts a session in it; ask for an existing name and
it attaches instead of cloning.

**3/4**

Install is two lines. In opencode.json:

    { "plugins": [{ "package": "opencode-cow-worktree@latest" }] }

or:

    opencode2 plugin add opencode-cow-worktree

Needs Linux btrfs/XFS (reflink) or macOS APFS, worktrees on the project's own
filesystem.

**4/4**

Receipts: a 100%-lines coverage gate across 20 files, a 31-scenario live
swarm of parallel agents, a 105-check e2e harness against real servers, and
APFS clone extents measured on macOS CI (arm64 and x64).

Known limits, in the README: opencode Desktop cannot select plugin
strategies yet, and a non-CoW filesystem fails loudly instead of pretending.

Repo: https://github.com/rbelem/opencode-cow-worktree
npm: https://www.npmjs.com/package/opencode-cow-worktree

## X / Twitter — single post (tight cut)

opencode-cow-worktree: every parallel agent gets a full project clone —
node_modules, ignored files, .env — in milliseconds via reflink, at
near-zero disk. Default worktree strategy for opencode2; install is one JSON
line or `opencode2 plugin add`. Gate: 100% lines across 20 files, plus a
31-scenario live-agent swarm. btrfs/XFS/APFS.

https://github.com/rbelem/opencode-cow-worktree

## Where each claim comes from

- Clone contents, reflink mechanism, same-filesystem requirement: README
  intro and Requirements.
- Default-strategy behavior, attach semantics: README "Using it"; verified
  live against a registry install (docs/development.md dogfood notes).
- 100% lines across 20 files: `bun run test:coverage` output, gate in
  `scripts/check-coverage.ts`.
- 31-scenario swarm: `docs/e2e/run-2026-09-12-swarm.md`.
- 105-check harness: `docs/e2e/run-2026-09-14.md`.
- APFS extents on CI (arm64, x64): `.github/workflows/ci.yml` APFS
  verification jobs.
- Desktop limitation: `docs/research/desktop-strategy-hardcode.md`.
- Install lines: README Install (verified against a registry install).
