# Ecosystem listing drafts

For the owner to review, edit, and submit. Nothing here is posted
automatically. Both targets accept new plugins from any author; there is no
review gate beyond their normal curation.

## opencode.ai ecosystem page

The plugin list lives at <https://opencode.ai/docs/ecosystem/#plugins>.
Entries are one or two sentences with a link.

> **opencode-cow-worktree** — Copy-on-write worktrees for parallel agents.
> A Deep clone of the whole project, `node_modules` and ignored files
> included, in milliseconds via reflink, registered as opencode2's default
> worktree strategy. Linux btrfs/XFS, macOS APFS.
> <https://github.com/rbelem/opencode-cow-worktree>

## awesome-opencode

Repository: <https://github.com/awesome-opencode/awesome-opencode>.
Entries are list items under the plugins section.

> - [opencode-cow-worktree](https://github.com/rbelem/opencode-cow-worktree) —
>   CoW worktree strategy: reflink Deep clones (ignored files included) so
>   parallel agents start ready to run. Linux btrfs/XFS, macOS APFS.

## Submission notes

- Install line to include in any PR body:
  `"plugins": [{ "package": "opencode-cow-worktree@latest" }]`.
- The honest-limits section of the announcement applies here too: Desktop
  cannot select plugin strategies today; the default-strategy blast radius is
  documented in the README.
