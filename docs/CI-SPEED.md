# CI speed: audit and plan (LKM-776)

"CI" here is everything between a pushed change and its verdict: the GitHub Actions
workflow `.github/workflows/ci.yml` and the Forge project check that runs after every
engineer round (`bun run typecheck && node test/run.mjs unit --changed=origin/main`).
Both count as required jobs.

Rules that outrank speed: the full suite runs before anything reaches main; no
retries, wider timeouts or skips; lint rules and required checks only stay or grow.

## Audit (2026-11-21)

Source: the last 150 `CI` runs (2026-11-05 to 2026-11-21: 81 PR and 52 push runs
completed, 17 cancelled), job and step timestamps from the Actions API. Bucket
times use the 93 green runs. **Waiting** is job created to job started (runner
queue). **Setup** is everything before the job's own work: set up job, checkout,
Bun, toolchain, install, selection and cache restore. **Running** is the rest: the
work step plus cache save, log upload and teardown. Seconds, p50/p95.

| Job | Event | n | Waiting | Setup | Running | Total |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| unit tests (PR shard, 3 per PR, macos-26) | PR | 147 | 3 / 92 | 34 / 45 | 374 / 514 | 423 / 595 |
| unit tests (whole tier, 1 runner, macos-26) | push | 44 | 3 / 118 | 34 / 43 | 980 / 1148 | 1046 / 1204 |
| app build (macos-26) | PR | 49 | 3 / 251 | 18 / 25 | 297 / 387 | 331 / 582 |
| app build (macos-26) | push | 44 | 3 / 22 | 18 / 23 | 322 / 407 | 346 / 441 |
| typecheck (ubuntu) | PR | 49 | 2 / 2 | 7 / 9 | 18 / 23 | 31 / 36 |
| typecheck (ubuntu) | push | 44 | 2 / 3 | 8 / 12 | 17 / 23 | 31 / 39 |
| dependency audit (ubuntu) | both | 93 | 2 / 3 | 8 / 10 | 1 / 1 | 13 / 16 |
| typecheck + unit tests (gate) | both | 93 | 2 / 3 | 0 / 1 | 0 / 1 | 5 / 6 |
| **Forge check** (local Mac, 12 cores, 8 workers) | round | 68 | ~0 | `bun install` (Forge setup step, before the clock) | 474 / 582 | 474 / 582 |

Wall time per run, all 133 completed runs: p50 10.9 min, p95 20.2 min (PR 8.7 / 16.6,
push to main 17.7 / 20.7). Forge check: 68 runs on trezi tasks, 2026-11-07 to
2026-11-20, from Forge's event log (check end minus engineer-round end): p50 7.9 min,
p95 9.7 min. Inside it, `bun run typecheck` takes 4.7 s; the rest is the unit tier.

Inside the unit step (main run 44843218770, 354 tests, 3 workers): 2682 s of test
time; 12 tests over 60 s hold 1471 s of it. The five `swift-preview` group tests run
one at a time (LKM-345) and form a 576 s serial chain. `native-chat-send-follow`
(96 s) is an exclusive barrier. Setup's largest step is the 1.3 GB Swift test cache:
restore 13 s and save 13 s per shard, saved on every run because its key holds the SHA.

**Biggest bucket: running, in the unit tier.** It is 88% of a PR shard and 94% of a
main run, and all of the Forge check. Waiting is 2–3 s at p50 (macOS queueing only
shows at p95: 92–251 s). Setup is 34 s.

### Why the Forge check was slow

A Forge worktree is fresh, so it has no `.local/test-times.json` and the runner kept
`test/tiers.mjs` list order. That list puts the five `swift-preview` tests, the
longest serial chain, at positions 345–352 of 354: the chain started after nearly
everything else had finished. `native-chat-send-follow` sat at position 128, so the
queue drained there and then ran it alone. A scheduler model that mirrors `runQueue`
reproduces the real PR shards to the second (309 / 306 / 268 s, real and modelled).
With CI test times and 8 workers it gives 959 s in list order and 672 s with the new
order (chain + barrier, the floor while the group stays serial): **−30%**.

## The fix in this change: critical-path ordering everywhere

`queueOrder` (`test/helpers/test-runner.mjs`) starts exclusive tests first, then the
longest chain first (a grouped test ranks by its group's total). `test/run.mjs` reads
committed CI durations (`test/unit-times.json`) under the local times file, so fresh
worktrees get the same order as CI. Nothing is skipped, retried or re-timed; only
start order changes. Modelled with real CI durations:

| Run | Before | After (model) |
| --- | ---: | ---: |
| Forge check (8 workers, list order before) | 959 s CI-equivalent; real p50 7.9 min | 672 s CI-equivalent; expected ≈ 5.5 min |
| main push, whole tier (3 workers) | 974 s (real 1062 s) | 958 s |
| PR shard holding the barrier | 309 s (real) | 286 s |
| PR slowest shard | 309 s | 306 s |

Local spot check (this Mac, 2026-11-21, under heavy load from other jobs): the
swift-preview chain took 155 s and `native-chat-send-follow` 115 s, run with the new
order, so the local floor is about 4.5 min while the group stays serial.

Real after-numbers: the Forge check and the PR's own CI run of this branch (both
run the full tier because `test/` runner files changed). See `docs/PROGRESS.md`.

## Full suite before main

GitHub merge queues need an organization-owned repository; `alikimovich/trezi` is
owned by a User, and `main` has no branch protection or ruleset (checked with the
API). So the full suite must stay a gate Forge waits for before merging. Today it
is not always: a docs or test-only PR runs a **selected** unit plan, and Forge merges
on that green run; the full tier only runs after merge, on the push to main. That is
item 1 below.

## Remaining changes, in order (one Forge task each)

1. **Full tier is the last gate before merge.** Make the PR run's unit jobs FULL when
   it is the merge gate (e.g. Forge runs the full check or waits for a full CI job),
   and keep selection for engineer-round feedback only. Correctness, not speed.
2. **Shorten the swift-preview chain** (576 s serial on CI, the floor of every unit
   run now). Split `swift-preview-target` (252 s: two cold builds of the same
   fixture, 118 s and 88 s) and `swift-preview` (158 s) into files under 20 s of
   work each, or give the group a width that scales with cores, measured on the
   hosted runner first.
3. **Group-aware, time-balanced shards.** `shardTests` weighs by timeout budgets and
   ignores groups; balance from the durations main records, keep each group in one
   shard, and assert the shards together ran every file.
4. **Main records times on every full run** and refreshes `test/unit-times.json`
   (or a published artifact) so ordering and shards never go stale.
5. **Swift test cache: save only from main.** 1.3 GB saved per shard per run (13 s)
   and evicts other entries; PRs restore main's cache read-only. Seed from main.
6. **Blobless clone** (`filter: blob:none`) for the full-history checkouts (6–9 s).
7. **Split slow non-group files** over 20 s: `resolved-lessons` 193 s,
   `repository-owner` 152 s, `host-warnings` 124 s, `skills-projection` 106 s,
   `peer-wait-deadline` 103 s, `conversation-owner` 97 s.
8. **One small-checks job** (typecheck, version/changelog, dependency audit, lint,
   docs links) that lists every failure; drop the gate job's dependency wait.
9. **Lint, format and typecheck budgets:** run old and new side by side (Biome →
   oxlint `bun lint` + `bun fmt`; tsc → TypeScript 7 `bun check`) and list what each
   new tool misses before switching. Lint today: Biome over `src` + `test`.
10. **hk hooks:** pre-commit formats and lints staged files, pre-push runs the CI check.
11. **Budget enforcement:** fail any job over its budget (per-job step that reads its
    own timing), after the budgets are reachable.
12. **Selection red-team:** hide a real change from `test/select.mjs` on purpose and
    confirm CI goes red; list every input that reruns everything.
13. **Test runner move to `bun test`** (isolated modules, reset per file, random
    order): a large migration; first measure on a slice, side by side.
14. **Fewer tests, on evidence:** `docs/TEST-FAILURE-LOG.md` runs until 2026-12-05;
    then delete change-detector-only files (never authorization, privacy,
    migrations or concurrency) and ban their patterns in `AGENTS.md`.

Native Swift stays on swift/xcodebuild; the same rules apply (measure, cache,
parallelize, select on PRs with the full tier before main). Native desktop suites
keep running on the local Mac under the shared desktop lock.

## Needs the owner (account, secret or bill)

| Change | Why | Expected monthly cost |
| --- | --- | --- |
| Move the repo to a GitHub organization | Merge queue (full suite before main, run once per merge); Blacksmith installs on organizations | $0 (GitHub Free org); merge queue on a public org repo is free |
| Blacksmith runners, macOS M4 6 vCPU for unit shards and app build, Linux for the rest | Waiting <5 s, twice the cores of `macos-26` (3 vCPU), warm machines | ≈ $275–320 at ~$0.08/min for ≈ 3,500–4,000 macOS minutes (today ≈ 6,850 hosted macOS minutes/month that would roughly halve), Linux ≈ $1; verify on blacksmith.sh/pricing |
| Runner image with Xcode, Bun and deps baked in | Setup <15 s | Included with Blacksmith; none on GitHub-hosted |

## Total CI time and cost

| | Before | After this change |
| --- | --- | --- |
| PR verdict (GitHub, wall) | p50 8.7 min, p95 16.6 min | ≈ same (−3 to −23 s on the barrier shard) |
| Main push (GitHub, wall) | p50 17.7 min, p95 20.7 min | ≈ −16 s (model) |
| Forge check per round | p50 7.9 min, p95 9.7 min | expected ≈ 5.5 min |
| Hosted runner minutes | ≈ 6,850 macOS + 200 Linux per month | ≈ same |
| Cost | $0 (public repo; ≈ $425 at the $0.062/min list price) | $0 |

The 1-minute p50 / 2-minute p95 target is not reachable on 3-vCPU hosted macOS
runners: 2682 s of unit test time over 9 vCPUs is about 5 min before any setup.
It needs items 2, 3 and 7 plus more cores (the owner list).
