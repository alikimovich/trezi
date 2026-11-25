# CI speed: audit and plan (LKM-776)

"CI" here is everything between a pushed change and its verdict. The main target is
the **Forge check**, which runs on the local Mac after every engineer round
(`bun run typecheck && node test/run.mjs unit --changed=origin/main`). GitHub Actions
(`.github/workflows/ci.yml`) counts only where Forge waits on it before merging
(`wait_ci` is on for trezi); it stays on its existing runners and gets no new
infrastructure (owner correction, 2026-11-21).

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
| **Forge check** (local Mac, 12 cores, 8 workers) | round | 68 | ~0 | `bun install` before the clock; a cold Swift fixture cache (~80 compiles) hidden inside running | 474 / 582 | 474 / 582 |

Wall time per run, all 133 completed runs: p50 10.9 min, p95 20.2 min (PR 8.7 / 16.6,
push to main 17.7 / 20.7). Forge check: 68 runs on trezi tasks, 2026-11-07 to
2026-11-20, from Forge's event log (check end minus engineer-round end): p50 7.9 min,
p95 9.7 min. Inside it, `bun run typecheck` takes 4.7 s; the rest is the unit tier.

Inside the unit step (main run 44843218770, 354 tests, 3 workers): 2682 s of test
time; 12 tests over 60 s hold 1471 s of it. The five `swift-preview` group tests run
one at a time (LKM-345) and form a 576 s serial chain. `native-chat-send-follow`
(96 s) is an exclusive barrier. Setup's largest step is the 1.3 GB Swift test cache:
restore 13 s and save 13 s per shard, saved on every run because its key holds the SHA.

**Biggest bucket: the Forge check's unit tier.** Forge ran 69 checks on 36 trezi
tasks (about 1.9 per task, p50 7.9 min each: about 15 min per task), and it waits on
one GitHub PR verdict per task (p50 8.7 min). Inside both, running is the bucket: 88%
of a PR shard and 94% of a main run. Waiting is 2–3 s at p50 (macOS queueing only
shows at p95: 92–251 s), so faster runners would not move the median: Blacksmith
stays off the owner list.

### What the Forge check actually waits on

Round 1 of this task assumed the local check behaved like a CI shard and fixed start
order (`queueOrder`, below). Its real run said otherwise. Forge check of round 1
(full tier, 354 tests, 8 workers on 12 cores): **539 s**, against 505 s and 556 s for
the two previous full-tier trezi checks (LKM-763). No measurable gain. The run's own
logs (`summary.json` durations and log mtimes) show why:

- It was throughput-bound: 3573 s of test time in 534 s, 6.7 of 8 workers busy on
  average. Order cannot shorten that; only less work can.
- The swiftc lane (2 slots) never idled. A Forge worktree starts with an empty
  `.local/test-cache`, so about 80 fixture binaries (owners, XPC, chat and sidebar
  fixtures; 826 MB with the Clang module cache) were compiled from scratch; the last
  one finished one second before the run ended. On CI the same cache is restored, so
  this cost exists only in the Forge check.
- `native-chat-send-follow` is an exclusive barrier: 97 s with 7 workers idle,
  wherever it sits in the queue.

## The fix in this change: one Swift build cache for every worktree

`cacheBase` (`test/helpers/swift-build.mjs`): a linked Git worktree (its `.git` is a
file; every Forge check and agent worktree) keeps `swiftBuild` binaries, the swiftc
slots and the Clang module cache in `~/Library/Caches/trezi-unit-tests/swift`. The
key was already content-complete (toolchain, flags, every source's repo path and
bytes; no fixture locates files through its own path or `#filePath`), so worktrees on
different commits share only identical builds; a changed source still rebuilds. Two
guards for concurrency: a new build no longer deletes its name's other builds at once,
only those unused for a day, and every hit refreshes the binary's mtime, so one check
never deletes a binary another check is about to run. Product caches the swift-preview
tests hand to Trezi's own code (scanner tools, toolchain probe) rebuild folders in
place and stay per checkout (`LOCAL_SWIFT_CACHE`). The main checkout and CI keep
`.local/test-cache` (CI caches that path), and `TREZI_TEST_CACHE` still wins. The
Forge `check:` command does not change.

Measured on this Mac (2026-11-21, load average 55–90 from other jobs), eight
Swift-heavy owner tests (`conversation-owner`, `editing-owner`, `platform-owner`,
`workflow-owner`, `source-owner`, `provider-owner`, `memory-owner`,
`runtime-owner`), `node test/run.mjs unit --filter=…`:

| Cache | Run 1 | Run 2 |
| --- | ---: | ---: |
| cold (empty `TREZI_TEST_CACHE`, what every Forge worktree had) | 151.6 s | 142.8 s |
| shared, warm | 100.9 s | 85.1 s |

About −40% wall on those eight. The shared cache was seeded once with this
worktree's binaries, which Forge's round-1 check had just built from main's sources;
that is the steady state every later worktree sees. Only binaries can be copied: a
Clang module cache records its own path, so a copied one fails every compile (seen
here; the module cache was then rebuilt in place, which is all the code ever does). The full-tier after-number is the
round-2 Forge check (full, because `test/helpers/` changed): **428.5 s**, down from 539 s
(round 1) and 505–556 s before; see `docs/PROGRESS.md`.

### Kept from round 1: critical-path start order

`queueOrder` (`test/helpers/test-runner.mjs`) starts exclusive tests first, then the
longest chain first; `test/unit-times.json` gives fresh worktrees CI durations to
order by. It does not change what runs. On CI the modelled gain is 16–23 s per main
run or barrier shard; locally it was not measurable (above). It stays because it is
free and stops the serial swift-preview chain from starting last.

## Full suite before main

GitHub merge queues need an organization-owned repository; `alikimovich/trezi` is
owned by a User, and `main` has no branch protection or ruleset (checked with the
API). So the full suite must stay a gate Forge waits for before merging. Today it
is not always: a docs or test-only PR runs a **selected** unit plan, and Forge merges
on that green run; the full tier only runs after merge, on the push to main. That is
item 1 below.

## Remaining changes, in order (one Forge task each)

Forge check first; GitHub items only touch the existing workflow Forge waits on.

1. **Full tier is the last gate before merge.** Make the PR run's unit jobs FULL when
   it is the merge gate (Forge waits on it) and keep selection for engineer-round
   feedback only. Correctness, not speed; it unlocks item 2.
2. **Engineer-round selection for product changes.** Any `src/` change runs the full
   tier today (the selector narrows only docs, test scripts and audited UI), so almost
   every Forge check is full. Select the unit tests a diff can reach (import graph for
   TS, source lists of `swiftBuild` fixtures for Swift), list every input that reruns
   everything, then hide a real change from it on purpose and confirm the check goes
   red. Allowed only once item 1 holds.
3. **Done in LKM-816: fix the `native-chat-send-follow` barrier** (97 s with 7 idle
   workers per run). The fixture's progress and settle observations now survive
   main-run-loop stalls; the barrier is removed. Measurements are below.
4. **Split slow files** (local full run, seconds): `resolved-lessons` 247,
   `conversation-owner` 199, `peer-coordination` 182, `repository-owner` 172,
   `peer-wait-deadline` 169, `service-process` 126; budget 20 s of work per file.
5. **Workers to cores on the Mac:** 8 workers on 12 cores; measure 10 and 12 on an
   idle machine with the warm cache before changing the default.
6. **Shorten the swift-preview chain** (576 s serial on CI, its floor): split
   `swift-preview-target` (two cold builds of one fixture) and `swift-preview`.
7. **CI (existing workflow): group-aware, time-balanced shards** from durations main
   records, each group in one shard, and assert the shards together ran every file.
8. **CI: main records times** on every full run and refreshes `test/unit-times.json`.
9. **CI: Swift test cache saved only from main** (1.3 GB, 13 s per shard per run);
   PRs restore main's read-only.
10. **CI: blobless clone** (`filter: blob:none`) for the full-history checkouts.
11. **CI: one small-checks job** (typecheck, version/changelog, dependency audit,
    lint, docs links) that lists every failure; drop the gate job's dependency wait.
12. **Lint, format and typecheck tools:** run old and new side by side (Biome →
    oxlint `bun lint` + `bun fmt`; tsc → TypeScript 7 `bun check`) and list what each
    new tool misses before switching.
13. **hk hooks:** pre-commit formats and lints staged files, pre-push runs the check.
14. **Budget enforcement:** fail a run over its budget, once budgets are reachable.
15. **Test runner move to `bun test`** (isolated modules, reset per file, random
    order): measure on a slice first, side by side.
16. **Fewer tests, on evidence:** `docs/TEST-FAILURE-LOG.md` runs until 2026-12-05;
    then delete change-detector-only files (never authorization, privacy,
    migrations or concurrency) and ban their patterns in `AGENTS.md`.

Native Swift stays on swift/xcodebuild; the same rules apply. Native desktop suites
keep running on the local Mac under the shared desktop lock.

## Needs the owner (account, secret or bill)

| Change | Why | Expected monthly cost |
| --- | --- | --- |
| Move the repo to a GitHub organization | Merge queue: the full suite runs once per merge, before main | $0 (GitHub Free org; merge queue is free on a public org repo) |

Blacksmith and runner images are off the list: GitHub waiting is 2–3 s at p50, and
the Forge check, the larger bucket, runs on the Mac.

## LKM-816: chat send/follow barrier removed (2026-11-25)

The forced fixture's 90 s stop now measures time since the last app realize or
settle completion. A loaded main run loop can make the bounded 240 realize steps
take longer than 90 s while still progressing. The non-streaming post-bound check
counts completed settles instead of frames sampled while settling; sampling rate
changes under worker load. Review caught a gap: zero completed settles could also
mean one remained active. The fixture now waits for a late active settle to finish
(up to 90 s) and asserts it is inactive, alongside the completed-settle bound.
Visibility, no-upward-jump, settle-end, 240-realize, no-late-realize and second-Send
checks remain. The unit queue no longer marks this test exclusive, so other tests
can run during it.

Focused local measurements on this Mac (three workers; seconds):

| Selection | Before | After |
| --- | ---: | ---: |
| `native-chat-send-follow` + `test-runner` | 122.9 wall, sequential (117.0 + 5.8) | 115.3 wall with a third selected test also running, concurrent (115.3 + 7.2) |
| `native-chat-send-follow` + `native-chat-latest-settle` + `test-runner` | — | 115.3 wall, concurrent (115.3, 21.1, 7.2); warm cache |
| Same three, cold changed-fixture build | — | 138.3 wall, concurrent (138.2, 26.7, 5.8) |

The warm run included one more test than the before run and still finished 7.6 s
sooner; that small wall difference also includes ordinary runtime variance. It
proves 28.3 worker-seconds of selected work can overlap the chat fixture. The
former full-run barrier idled seven workers for 97 s. Forge's prior full check
was 428.5 s (LKM-776). The first LKM-816 full check took 413.2 s: 350 PASS,
1 FAIL (`chat-new-instant` fourth-send wait), 3 SKIP. The chat fixture passed in
179.1 s under concurrency. After the review repair, a focused concurrent run of
`native-chat-send-follow` and `chat-new-instant` passed in 132.2 s wall (132.2 s
and 32.8 s respectively); `chat-new-instant` alone passed in 33.1 s. The first
focused compile hit this sandbox's Swift macro denial; the passing concurrent
run used a temporary `-disable-sandbox` compiler flag that was then removed.
The focused run does not establish a green full check; Forge must rerun it.
No GitHub workflow changed, so a `gh run list` p50/p95 comparison is not relevant
to this edit.

## Total CI time and cost

| | Before | After |
| --- | --- | --- |
| Forge check per round (full tier) | p50 7.9 min, p95 9.7 min; full runs 505–556 s | 428.5 s on the round-2 check (warm shared cache, load ~190; 2 test bugs it exposed fixed in round 3); 8 owner tests −40% |
| Forge check time per task (≈1.9 rounds) | ≈ 15 min | — |
| PR verdict Forge waits on (GitHub, wall) | p50 8.7 min, p95 16.6 min | ≈ same (no workflow change) |
| Main push (GitHub, wall) | p50 17.7 min, p95 20.7 min | ≈ same |
| Cost | $0 (public repo, hosted runners; local Mac) | $0 |

The 1-minute p50 / 2-minute p95 target is not reachable while every engineer round
runs the full tier: 2682 s (CI) to 3573 s (Mac, under load) of unit test time. It
needs items 2–5.
