# Snapshot/index investigation — 2026-09-09

Retaining a private Git index is a substantially better performance candidate than
CoW workspace creation. The expensive step is repeatedly hashing/staging the tree
with `git add -A` after discarding its cached metadata. However, a naïve retained
index is not equivalent to today's fresh snapshot under all conditions. No
production behavior changed during this investigation.

## Results

The scripts `scripts/benchmark-snapshot-index.mjs` and `scripts/probe-snapshot-index.mjs`
reproduced these against the TS snapshot code; LKM-111 removed both with that code (the
Swift repository owner's `RepositoryGit.swift` now takes the snapshot). Both used disposable repositories
and remove their fixtures. Benchmark fixtures export committed source revision
`49a159a15c239c773521e62e0fcd2a2bebd98eb6`; the user's live index is never used as
cache input or changed. Recorded data: [snapshot-benchmark.jsonl](snapshot-benchmark.jsonl)
and [snapshot-probes.jsonl](snapshot-probes.jsonl).

Host: macOS/arm64, Bun 1.3.13, Apple Git 2.50.1, same APFS machine as the CoW
investigation. The base fixture has 417 files totaling 5.94 MiB. Five measured
samples per workload/mode, rotating execution order.
Each mode first receives one separately recorded cold-index call (not a cold-disk
measurement). Correctness comparisons and fixture creation are outside timings.

Median snapshot capture times, milliseconds:

| Fixture / workload | Production | Retained index, always commit | Retained index + commit reuse |
| --- | ---: | ---: | ---: |
| Trezi / clean | 93.1 | 58.9 | 50.4 |
| Trezi / unchanged WIP | 97.2 | 61.2 | 54.3 |
| Trezi / external edit | 102.2 | 61.2 | 63.0 |
| +5,000 small files / clean | 411.8 | 69.6 | 59.1 |
| +5,000 small files / unchanged WIP | 406.8 | 70.3 | 63.8 |
| +5,000 small files / external edit | 416.9 | 76.1 | 73.0 |
| +64 MiB random assets / clean | 194.9 | 55.8 | 48.1 |
| +64 MiB random assets / unchanged WIP | 201.8 | 59.5 | 55.8 |
| +64 MiB random assets / external edit | 209.8 | 67.4 | 65.9 |

The clean workload improves by approximately 46%, 86%, and 75% with combined
reuse. These are snapshot-only, warm-index prototype results, not end-to-end
chat latency or guaranteed production gains. Added assets remain unchanged and
tracked; external-edit workloads change one small untracked file. Large modified
or untracked assets would still require hashing. Installed dependencies, network
filesystems, filters and sparse checkouts are not represented by these timings.

The fresh-index instrumented control was close to production. It resolves HEAD
and its tree together, uses a pinned HEAD SHA in subsequent commands, and records
each step. Aggregated per-step medians across its workloads:

| Step | Trezi fresh → retained | Many files fresh → retained | Assets fresh → retained |
| --- | ---: | ---: | ---: |
| `git add -A` | 40.9 → 11.5 | 321.6 → 18.2 | 142.1 → 10.8 |
| `git write-tree` | 12.6 → 9.4 | 37.1 → 11.2 | 13.2 → 9.4 |
| `git commit-tree` | 9.9 → 9.2 | 10.8 → 9.8 | 9.7 → 9.2 |

Individual process overheads are around 9–15 ms here. Component medians should
not be added to reconstruct a total median. The biggest reduction is in `add`.
Simply returning HEAD when the captured tree equals HEAD's tree keeps fresh-index
semantics and avoids one roughly 10 ms commit process; it does not remove the
expensive scan. Its complete measured control (`clean-head`) is in the raw data.

## What was tested

The prototype owns an index outside the working tree, seeds it from HEAD using
`git read-tree -m -i <head>`, stages current files, restores excluded paths, and
writes a tree. Git documents that single-tree `-m` preserves stat information for
matching entries; `-i` suppresses working-tree checks during this index-only step.
An early `-m`-only experiment fell back to rebuilding on external WIP changes;
the final measurements use `-m -i`. Nothing checks out or overwrites live files.

It reseeds from HEAD every time. Merely keeping an old snapshot index and running
`git add -A` causes formerly untracked files to remain tracked in that private
index after ignore rules change. The hazard probe reproduces that mismatch.

Optional commit reuse returns HEAD for equal trees and reuses a previous snapshot
only when both parent HEAD and captured tree match. Corrupt/missing indexes rebuild.
The implementation is isolated to the benchmark script, not imported by the app.

Thirteen oracle comparisons against production `captureBase` pass: clean HEAD,
staged plus unstaged content with new files, repeated dirty snapshots, rapid
same-length writes, restored mtime under default stat settings, changed ignore
rules, delete/rename/mode/symlink changes, runtime/sidecar exclusions, corrupt and
missing caches, independent HEAD advancement, and user assume-unchanged/skip-worktree
flags. Every comparison checks the user's real index remains byte-for-byte intact.
These finite checks do not prove concurrency or crash safety.

## Confirmed hazards and implementation requirements

The separate probes found three mismatches; rebuilding the index restored
equivalence in every case:

- Without HEAD reseeding, a newly ignored untracked file remains in the snapshot.
- Adding `.gitattributes` with text normalization changes the fresh snapshot's
  blob, while a cached stat match skips reprocessing the unchanged source file.
- With `core.trustctime=false`, an equal-length edit with restored mtime can be
  missed by the retained index. The fresh index detects it. Default stat settings
  passed the corresponding check. A separate autocrlf-change probe matched on
  this fixture; that is not proof that arbitrary filter/config changes are safe.

A production implementation therefore needs:

1. **Explicit cache invalidation.** Account for relevant `.gitattributes` files
   (including ignored ones), `.git/info/attributes`, global attributes, effective
   Git config and filters. Uncertain or unsupported cases must use a fresh index.
   The cost of complete invalidation checks is not included in prototype timings.
2. **Defined stat-cache guarantees.** Fall back for settings/filesystems that cannot
   provide the required change detection, or deliberately force appropriate stat
   checks. Do not silently inherit assume-unchanged flags from the user's index.
3. **Serialization at the cache boundary.** A shared index needs one lock per
   canonical repository. Interactive chat creation/sync uses the repository queue,
   while comment creation calls `createWorktree` through its separate creation
   chain. Startup recovery also calls `captureBase`. Existing call-site locks
   cannot simply be assumed to protect one new shared index. Lock ordering must
   avoid recursively acquiring a repository queue already held by the caller.
4. **Recovery and lifetime rules.** Invalidate after interrupted operations or
   unusable cache state, handle stale locks, and define eviction/cleanup. A cached
   dangling commit may disappear after Git GC: either keep it reachable or verify
   and regenerate it before returning a memoized SHA. HEAD-only reuse avoids that
   additional lifetime problem.
5. **Configuration and integration coverage.** Verify attributes/config changes,
   filters, sparse/split indexes, linked repos, restart/GC, and queued concurrent
   chats. Capturing still scans the live filesystem; it is not an atomic snapshot
   against the user's external editor, just as the existing implementation is not.

## Recommendation

Prioritize a private-index fast path over CoW, with conservative invalidation and
the existing fresh-index path as fallback. Start with retaining stat metadata;
it provides most of the benefit without memoizing dangling commits. Returning
HEAD for identical trees is a separate small optimization with fewer new risks.
Benchmark again including invalidation/locking overhead before enabling the fast
path. Keep worktree isolation, landing and recovery unchanged.

References: [Git read-tree](https://git-scm.com/docs/git-read-tree),
[Git racy-index safeguards](https://git-scm.com/docs/racy-git).
