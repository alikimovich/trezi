# Copy-on-write workspace investigation — 2026-09-09

Recommendation: keep Git worktrees and the existing landing/recovery contract.
Investigate the recurring snapshot cost before adding a native CoW creation path.
CoW is promising for large working files, but this experiment does not establish
enough end-to-end benefit to justify replacing worktrees.

Follow-up: [SNAPSHOT-INVESTIGATION.md](SNAPSHOT-INVESTIGATION.md) profiles recurring
capture costs, measures private-index reuse, and reproduces its correctness hazards.

## Measurements

`scripts/benchmark-workspace-cow.mjs 5` produced these on macOS with Command Line Tools;
LKM-111 removed it with the TS workspace functions it imported. The script exported
this repository's committed HEAD into disposable repositories, added staged and
untracked WIP, imported the production workspace functions of the time and removed its
fixtures afterwards. It never changed the original repo's Git state.
Raw output is in [cow-benchmark.jsonl](cow-benchmark.jsonl).

Machine: macOS 26.4.1, arm64, APFS (filesystem type 26), Bun 1.3.13,
Node v26.7.0, Apple Git 2.50.1. Source revision:
`c202fcb0dce137fdef69c11530b5c3780aa8b861`.
Five samples per operation, alternating current/hybrid creation order; no cache
flush or separate warmup. Timings include subprocess overhead, exclude fixture
generation, compiler startup, verification and teardown, and are local observations.

Median milliseconds:

| Fixture | Current creation | CoW hybrid creation | Raw CoW source copy | Capture base |
| --- | ---: | ---: | ---: | ---: |
| Trezi: 414 files, 5.92 MiB | 213.5 | 196.0 | 49.3 | 118.4 |
| +5,000 small files: 5,414 files, 10.58 MiB | 1,193.1 | 917.3 | 482.1 | 446.7 |
| +8 random 8 MiB assets: 422 files, 69.92 MiB | 370.3 | 304.1 | 49.5 | 216.7 |

Hybrid creation medians are 8%, 23%, and 18% lower respectively, but the small
Trezi sample is noisy: current ranged 196–236 ms, hybrid 168–419 ms. This is not
evidence of a reliable 8% product speedup. File count still matters: clones need
directory traversal and per-file metadata even when data blocks are shared.

The hybrid retains `captureBase`, registers a linked worktree using
`git worktree add --no-checkout`, clones the quiescent fixture's source files,
and initializes its Git index using `read-tree`. Thus it preserves shared Git
objects and refs. It is an optimistic prototype, not a deployable fast path:
verification is outside its timing and it lacks production filtering, fallback,
runtime dependency setup, and concurrent-live-edit protection. Current creation
includes its existing runtime-link checks, though fixtures have no dependencies.

Raw CoW copies exclude `.git`, root `node_modules`, and `.env`. They have no
independent Git history/index or merge base and cannot replace a complete Trezi
workspace. Comparing their 49 ms directly with 214 ms would overstate the benefit.
Whole-repository clones, installed dependencies, cold caches, other filesystems,
Git filters/LFS/submodules, and recovery/landing performance were not benchmarked.
Logical bytes are reported; physical shared-block savings were not measured.

## Recurring cost matters more than initialization

Current unchanged turn-start sync medians were 151.4 / 607.8 / 359.7 ms across the
three fixtures. Current sync after changing one small live file was
166.9 / 468.2 / 251.5 ms. Changed sync starts attached; unchanged sync starts detached,
so these are different lifecycle operations, not a claim that edits accelerate sync.

Both workspace types run the same `syncFromLive` implementation. Differences in
their samples may reflect cache/index/filesystem effects and noise; this experiment
does not demonstrate a recurring CoW speedup. The complete samples are retained.

`captureBase` seeds a fresh temporary index from HEAD, stages the current tree,
filters excluded staged paths, writes a tree, and creates a snapshot commit. It
does this even when source content is unchanged. In particular, its comment that
a clean tree simply returns HEAD does not match the current implementation.
`syncFromLive` then compares trees and attaches the chat branch or resets to live.

A follow-up should profile these subprocesses and index scans separately and
evaluate safe snapshot/index reuse or avoiding redundant snapshot commits. Such
an optimization must preserve untracked files, staged state and external edits;
the repository queue serializes Trezi writers but cannot lock out the user's editor.
Snapshot time is not entirely removable: changed content still needs capturing.

## Compatibility and correctness findings

- Native `clonefile` succeeded on this machine. Node v26.7.0's
  `COPYFILE_FICLONE_FORCE` returned `ENOSYS` on the same filesystem. This is an
  observation about this runtime, not all Node or Electron versions. A product
  implementation must probe the actual Electron runtime and source/destination.
- The benchmark compiles a small native helper and uses per-file
  `copyfile(..., COPYFILE_CLONE_FORCE)`. Unsupported cloning fails; it cannot
  silently time an ordinary copy. macOS `cp -c` can fall back to an ordinary copy,
  so its successful exit alone would not prove CoW.
- Native recursive `COPYFILE_CLONE_FORCE` is unsupported. The helper walks
  directories itself, preserving symlinks and cloning individual files. Apple
  also discourages using `clonefile` directly on entire directory hierarchies.
- All fixtures passed content comparisons against the captured base, inclusion
  of tracked/untracked WIP, independent workspace writes, unchanged/changed sync,
  and preservation of the live staged diff. These are checks of a quiet fixture;
  they do not establish concurrent snapshot or crash safety.
- A per-file directory clone is not an atomic snapshot. Source changes between
  Git capture and copying could make workspace contents disagree with its base.
  A hybrid needs an exact file/mode manifest and Git-aware content verification,
  followed by repair or normal-checkout fallback. Filters and line endings matter.
- Do not copy a linked worktree's `.git` pointer into an unrelated directory:
  it would point to existing worktree administration. A hybrid must register a new
  worktree. An independent full-repository CoW clone instead needs its own Git
  metadata and explicit commit/object transfer for Trezi's current landing APIs.
- Runtime dependencies are currently shared symlinks. Cloning the actual
  dependency files could allow independent package changes, but cloning a symlink
  preserves the shared target. That is a separate feature requiring install/build
  checks and a measured file-count cost.
- Workspaces live under app data while projects can be on other volumes.
  Cross-volume or unsupported-filesystem cases need a normal-worktree fallback.

## Scope of a possible implementation

A hybrid could preserve the existing Worktree shape, branch lifecycle, repository
queue, and parked-work recovery, changing only initial file materialization.
It would not remove branch administration or cleanup complexity. A complete CoW
workspace replacement would move that bookkeeping into an independent snapshot,
diff, merge-base, and recovery layer; no simplification has been demonstrated here.

Before shipping a hybrid, measure creation including validation in the actual
Electron runtime and representative user repos, then exercise concurrent writes,
interruption, modes/symlinks, exclusions, unsupported-volume fallback and restart
recovery. Keep the production implementation unchanged until that benefit is clear.

References: [Git worktree](https://git-scm.com/docs/git-worktree.html),
[Apple APFS](https://developer.apple.com/documentation/foundation/about-apple-file-system),
[Node filesystem flags](https://nodejs.org/api/fs.html).
Native behavior was checked against this machine's `man clonefile`, `man copyfile`,
and `man cp`, plus direct syscall and forced-clone experiments.
