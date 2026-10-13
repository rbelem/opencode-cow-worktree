# Merging agent lanes back into main — mechanics for reflink-clone lanes

**Scope:** our two live fixer lanes (`/home/rodrigo/Workspace/cow-lane-B` on
`lane-b`, `/home/rodrigo/Workspace/cow-lane-C` on `lane-c`) and the main
repo. All empirical claims verified read-only and lock-free
(`git --no-optional-locks`) against the actual repos at probe time; semantic
claims cite the official git docs (git 2.55.0 local, git-scm.com). Motivation:
the lanes are **independent full clones** (whole-directory reflink copy
including `.git`, via `src/clone.ts cloneDirectory`) — not `git worktree add`
linked worktrees — so merging them back has a fetch step and a set of things
that deliberately do *not* travel.

---

## Verified topology

- `rev-parse --git-dir` → real `.git` **directory** in all three repos (a
  linked worktree would show a `gitdir:` pointer **file** — git-worktree
  docs). Independent clones confirmed; `objects/info/alternates` absent in
  both lanes → fully self-contained, safe to delete at any time.
- `remote -v` → **every lane carries the live, credential-bearing GitHub
  origin**, inherited with the copied `.git`. This is the accidental-push
  surface (Risk register).
- Identity: `user.name`/`user.email` resolve from each clone's **local**
  config (repo-local override of global), identical across all three —
  authorship/committer continuity holds; `commit.gpgsign` unset everywhere.
- Branch state at probe time: both lanes on their branch at exactly the main
  tip (`98d9b68`), 3 refs each (`lane-x`, `main`, `origin/main`); ~1.2 MB odb
  per clone, byte-identical census to main at clone time.

## Merge procedure (recommended)

```bash
cd /home/rodrigo/Workspace/github.com/rbelem/opencode-cow-worktree
# 0. Preconditions: main clean; per-lane `--no-optional-locks status
#    --porcelain` empty; both fixer lanes terminal.
git remote add lane-b /home/rodrigo/Workspace/cow-lane-B   # namespaced refs
git fetch lane-b lane-b            # local transport: packs via upload-pack
git log --oneline main..lane-b/lane-b
git diff --stat main...lane-b/lane-b       # confirm expected conflict surface
git merge --no-ff lane-b/lane-b -m "merge: lane-b (removal hardening)"
# …resolve (expected: disjoint hunks; see below)…
git remote add lane-c /home/rodrigo/Workspace/cow-lane-C
git fetch lane-c lane-c
git rebase --onto main 98d9b68 lane-c/lane-c   # replay lane-c on updated main
git merge --ff-only lane-c/lane-c
```

**Why this sequence:** repo history is linear; two lanes forked from the same
tip. `--no-ff` for lane-b records the lane as one greppable unit. Lane-c is
then **rebased onto the updated main** rather than merged off the old base,
so any cross-lane collision (same-file hunks in `src/strategy.ts`, README
sections) resolves during the rebase while the lane's context is fresh, and
main stays near-linear. Rejected: octopus (git-merge docs flag it as unsuitable
when branches touch the same files); cherry-pick (we want whole lanes);
two `--no-ff` merges (fine, but lane-c would collide against pre-lane-b code
only at merge time).

Fetched refs land namespaced under `refs/remotes/<remote>/<branch>` — the
safe form; a bare `git fetch <path> <branch>` writes FETCH_HEAD and only
updates a local branch with an explicit refspec.

## The linked-worktree alternative (why clones)

`git worktree add` lanes would share **one odb and one ref namespace** —
lane commits visible in main with zero fetch, plain local merge. But a fresh
linked worktree materializes **tracked files only** — no `node_modules` —
so the test gates cannot run in-lane without a dependency bootstrap per
lane. It would also share failure domains: a lane running `gc`, ref
manipulation, or `worktree remove` touches the shared repo, and branch
checkouts must be globally unique (git-worktree docs). The clone approach
costs one fetch per lane plus ~1.2 MB object duplication and buys fully
isolated, immediately runnable environments — decisive when the gates run
inside the lane.

## What does NOT travel with the merge

fetch moves refs and objects only (git-fetch docs). Explicitly not carried:
uncommitted/staged work (pre-merge `status --porcelain` per lane must be
empty), stash, reflog (per-repository by definition), `.git/config` edits,
hooks (lanes carry only samples), ignored files (`node_modules` — main's is
unaffected), and untracked scratch files. Authorship/committer continuity
was verified; commits arrive unsigned exactly as created.

## Object/disk mechanics

Local-path fetch packs the negotiation result into main's odb as a new pack
(no loose spray). Hardlinking is a **`git clone` local optimization only**
(git-clone docs) — not fetch. We did not use `git clone --shared`
(alternates would couple each lane's lifetime to main and make `gc`
hazardous in both directions; our lanes have no alternates). btrfs reality:
clone-time files share extents with main; bytes written after cloning are
lane-exclusive, so deleting a lane post-merge frees only its exclusive bytes.

## Risk register

| Risk | Mitigation |
|---|---|
| Accidental push from a lane (live origin + stored credentials) | Current lanes: instruction-only ("never push"). **Future lanes: structural fix — `remote remove origin` (or re-point origin at the main repo path) as a post-clone step.** Structural beats instruction; candidate ticket. |
| Merging a moving branch | Fetch only after the lane's terminal result; pin the tip (`rev-parse`) at fetch and re-verify the lane ref immediately before merge. |
| `index.lock` contention with live lanes | All probes against live lanes use `git --no-optional-locks`. |
| Silent untracked-work loss | Untracked files never travel; copy out anything worth keeping before deleting a lane. |
| Stale lane clones post-merge | No alternates → self-contained; `rm -rf` after gates pass frees only exclusive bytes. |

## Orchestrator pre-merge checklist

1. Main tree clean (known untracked scratch documented).
2. Both fixer lanes terminal.
3. Per-lane `--no-optional-locks status --porcelain` empty.
4. Pin each lane tip (`rev-parse`).
5. Scope-diff review: `git diff --stat main...lane-x/branch` — expected files
   only; skim the full diff.
6. Merge sequence as above (lane-b `--no-ff` → lane-c rebase + ff).
7. Resolve conflicts in lane-c's rebase.
8. Full gates + live e2e harness on integrated main.
9. `remote remove lane-{b,c}`, delete lane refs, `rm -rf` lane clones.

## Open questions

1. Structural push-guard in `cloneDirectory` (post-clone `remote remove
   origin` or re-point) — touches the tool this repo tests; ticket candidate.
2. Rebase vs second `--no-ff` for subsequent lanes — pick once, encode in the
   orchestrator workflow.
3. Standard lane remote-naming scheme (directory basename) — pin explicitly.
4. Reflink-clone object-duplication ceiling on large-odb repos — re-evaluate
   `--shared` trade-off if it ever matters.
