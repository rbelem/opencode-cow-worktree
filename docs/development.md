# Development and verification

The end-user documentation lives in the README. This page is for working on
the plugin: what is proven, how it is tested, and the workflow this repository
is developed with.

## What is proven, and by what

The implementation registers the `cow` Strategy through opencode2's worktree
seam, ships the `spawn_workspace` and `list_worktrees` tools, runs configured
post-create commands, and has a Linux backend (per-file
`COPYFILE_FICLONE_FORCE` reflink) and a macOS backend (`copyfile(3)` with
`COPYFILE_CLONE_FORCE` through `bun:ffi`) behind a platform seam. Concretely:

- A 31-scenario parallel-agent live swarm on `opencode2
  v0.0.0-next-20260912.3` — clone/isolation/extents, remove + dirty guard,
  `spawn_workspace` options, fresh-binary install/defaults — all passing
  (`docs/e2e/run-2026-09-12-swarm.md`), re-proven against the projectID-era
  API on `v0.0.0-next-20260917` (`docs/e2e/run-2026-09-17.md`).
- A four-scenario e2e harness (105 checks) against a real opencode2 server:
  create + isolation, attach, list, hooks. Each run is recorded under
  `docs/e2e/`.
- macOS/APFS on real hardware: CI measures shared extents with
  `F_LOG2PHYS_EXT` on arm64 and x86_64 runners (block-level Jaccard overlap
  1.000000), and mutating a byte moves the block while leaving the source
  unchanged (ADR 0002).
- The fallback exercised through a real tool invocation against the server;
  the plugin installed and dogfooded in a real opencode2 config
  (`scripts/dogfood-install-check.ts`).

What the e2e runs do **not** prove: they drive `POST /api/worktree` and
`POST /api/session` directly and perform the per-worktree edits themselves.
The isolated config has no provider credentials, so this is not a real
multi-agent LLM fan-out — they prove filesystem isolation, not model
behaviour. Filesystems other than btrfs (positive) and tmpfs (negative) are
likewise unproven locally; the macOS backend is proven by CI, not the local
harness.

## Testing

```sh
bun test                          # unit tests
bun run typecheck                 # tsc --noEmit
bun run test:coverage             # 100% lines+functions gate on src/
bun scripts/e2e/harness.ts        # e2e; needs opencode2 on PATH, git, cp, btrfs
bun scripts/dogfood-install-check.ts  # proves a real config install
```

The unit tests cover capability classification (including the cache
contract), the Deep clone and its occupancy refusal, platform dispatch and the
Darwin decision logic (with an injected syscall), the post-create hooks, the
dirty-worktree guard and its git probe, the quarantine removal, the device
seam, the tool's decision table including attach and the fallback, and plugin
registration wiring.

The e2e harness starts a real `opencode2 serve` against a throwaway config
root that never touches your real config, installs the plugin, activates it,
and runs the create, attach, list, hooks, independence, Deep-clone, inventory,
non-CoW fail-loud, and removal checks.

## How it plugs in

opencode2 owns Worktree lifecycle; this plugin supplies how a directory is
materialized, plus the agent-facing tools.

```ts
// src/plugin.ts (condensed)
export default {
  id: "opencode-cow-worktree",
  async setup(ctx: Context): Promise<void> {
    // Every option is validated here, once: a bad value fails the plugin load.
    const hooks = postCreateHooks(ctx.options);
    await ctx.worktree.transform((editor) => {
      editor.add(createCowStrategy({ postCreate: hooks })); // registers `cow`, and makes it the Location default
    });
    await ctx.tool?.transform((editor) => {
      editor.add({ name: "spawn_workspace" /* input, execute */ });
      editor.add({ name: "list_worktrees" });
    });
  },
};
```

```ts
// src/strategy.ts (condensed)
export function createCowStrategy(
  { postCreate }: { readonly postCreate: readonly string[] },
): WorktreeDefinition {
  return {
    id: "cow",
    async create(input, { signal }) {
      signal.throwIfAborted();
      // Deep clone; refuses an occupied target before the first write.
      await cloneDirectory(input.sourceDirectory, input.directory);
      await runPostCreateHooks(postCreate, input.directory, input.sourceDirectory);
      return { directory: input.directory };
    },
    async remove(input) {
      // guard first, then the quarantine removal described in the README
      await removeQuarantined(input.directory);
    },
    list: async () => [], // inventory lives in opencode2, not in the Strategy
  };
}
```

Everything else is inherited from the worktree subsystem: create, remove,
list, refresh, the strategy recorded at removal time, and the project setup
script. `ctx` meets the seams in exactly one place (`liveDeps` in
`src/plugin.ts`); the tool layer composes the strategy and never the reverse.

## Upstream watch

opencode2 is consolidating worktree tooling into core. v2.0.27
(2026-10-12) shipped the built-in `opencode.worktree_*` Code Mode tools,
and upstream PR anomalyco/opencode#53981 removed the internal plugin copies
once they shipped. Watch the two surfaces this plugin depends on: the tool
registration and override semantics, and the `ctx.worktree.transform`
strategy-registration seam, which is the plugin's actual mechanism.

## Parallel lanes

This repository is developed with parallel CoW lane clones: `bun
scripts/lane.ts spawn|absorb` spawns them and absorbs them back. The
conventions are in [`lane-workflow.md`](lane-workflow.md); the verified merge
mechanics are in
[`research/lane-merge-mechanics.md`](research/lane-merge-mechanics.md).

## Cutting a release

1. Bump `version` in `package.json` and write the CHANGELOG entry. One
   concern per commit, as always.
2. `npm publish` from the working tree — the tarball packs what `files`
   lists, so there is no build step. The npm account enforces security-key
   2FA (`auth-and-writes`): the first run exits `EOTP` with a
   `www.npmjs.com/auth/cli/...` URL. Open it, approve the key, then run
   `npm publish` again. `bun publish` hangs instead of printing the URL and
   is not usable with this account.
3. Verify before celebrating: `npm view <name> version` resolves, and
   `npm install <name>` into a scratch plugin directory imports the entry
   under Bun with the expected `default.id`. npm's success notice
   (`+ name@version`) precedes registry visibility by minutes — poll the
   registry doc (`curl -H "cache-control: no-cache"
   https://registry.npmjs.org/<name>`) instead of re-publishing.
4. Tag and release: `git tag -a vX.Y.Z`, push the tag, then
   `gh release create vX.Y.Z --title "vX.Y.Z" --notes "$(sed -n '/^## X.Y.Z/,$p' CHANGELOG.md)"`.
5. Land any README changes the publish exposed as a follow-up commit. The
   npm package page shows the README inside the published tarball, so docs
   commits after a release reach npm only with the next version bump.

Design history: ADRs 0001 (rollback on failed create), 0002 (Darwin backend),
and 0003 (derive listing/attach from the upstream inventory, no plugin-owned
registry) live in `docs/adr/`, with research notes in `docs/research/`.
