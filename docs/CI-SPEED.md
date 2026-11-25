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

## Item 4: split slow unit files (LKM-817, 2026-11-25)

The six slow scripts now have independently scheduled parts. Existing assertions and
fixtures remain in their original scripts; small registered entrypoints select each
part. `conversation-owner` separates parity, the two live-checkout waits, remaining
agent checks and recovery. `repository-owner` divides its 14 Git suites into two
groups and runs its other sections in a third. Scenario counters guard complete
coverage in `resolved-lessons` (20) and `peer-coordination` (16). The real maximum
`peer_wait` still takes about 100 s; splitting its bound checks cannot remove that
floor. The Swift build cache remains in place. No workflow or Forge `check:`
configuration changed.

The before column is the local eight-worker full-run observation from this plan.
The focused after numbers came from eight workers for the first pass, then four
for narrower repair passes; load and worker count differ. The subsequent full
Forge check took **511.5 s** (359 PASS, 2 FAIL, 3 SKIP), compared with **428.5 s**
for LKM-776's warm-cache full check: 83.0 s slower (19%). It sits inside the
older 505–556 s full-check range. This is one run, with different test counts and
machine load; two failures make it an invalid passing gate. Neither the focused
timings nor the single full run establish a speed gain or regression caused by
the split. The task barred running a full unit tier in this worktree. GitHub
p50/p95 was not remeasured because the existing workflow was unchanged.

A second full Forge check took **432.5 s** (360 PASS, 1 FAIL, 3 SKIP).
`repository-owner-part-2` and `preview-apply-layers` passed there; the sole failure
was `browser-verify-bounds`. Its 8 s run-budget attempt took 13.7 s because the
test's wall-clock assertion forgot the required browser-session close, which has
its own 15 s cap. The corrected assertion includes that cap and still checks that
the hung wrapper and its child are gone; a focused run passed in 20.6 s. The
preview fixture now orders its window before loading the page so WebKit has a
drawable surface for snapshots. A local focused run still stopped at page load
amid sandbox-denied WebKit service extensions; it cannot validate that change.
Typecheck and lint passed. At that point, no passing full Forge check on this
head had been recorded. No `check:` change was proposed.

A third full Forge check took **458.9 s** (360 PASS, 1 FAIL, 3 SKIP).
`browser-verify-bounds` passed; `turn-tracker-prep-failure` timed out waiting for
turn-b to land in its rejected-peer-read case. A focused rerun passed in 11.9 s.
The failed log contains no owner phase or transition history, so it does not
identify the stalled step. The test now records the owner's phase, its terminal
and landed transitions, and recent turn events if this wait fails again. Its
focused run passed in 12.8 s; typecheck and lint passed. The 20 s landing
assertion remains. The full Forge gate was still open after this run.

A fourth full Forge check took **481.2 s** (360 PASS, 1 FAIL, 3 SKIP).
`turn-tracker-prep-failure` passed; `branch-safety` failed when its second
publish reached scripted `gh pr create` without a pushed `trezi/main` at that
instant. A focused rerun passed in 12.6 s. The failed run did not retain its
scratch remote, so it cannot establish whether the push was absent or the ref
was removed afterward. The assertion now reports both branch tips, remote
heads and the scripted gh calls on failure. This is still a failed full gate,
not a measured speed result or acceptance of the split.

The next full Forge check on this head passed in **469.2 s**: **361 PASS, 0 FAIL,
3 SKIP**. This closes the passing full-check gate for LKM-817; the three skips
remain skips. It was 40.7 s slower than LKM-776's 428.5 s warm-cache run (9.5%)
and 42.3 s faster than LKM-817's first 511.5 s run (8.3%). These single runs
had different test counts, machine load and failure outcomes, so the difference
does not establish a speed gain or regression from splitting the files. The
focused part timings below show the scheduling effect, not a full-run speed
claim. No Forge `check:` change is needed; GitHub p50/p95 was not remeasured
because the workflow did not change.

PR #475's first GitHub run (45698158897, attempt 1) failed at 15 minutes:
macOS unit shards 1 and 3 and the app build never acquired hosted runners. GitHub
annotated the cancelled jobs with failed runner acquisition and macOS arm64
capacity constraints; they produced no test logs. The combined gate read the unit
matrix as `abandoned`, while shard 2, typecheck and dependency audit passed. A
rerun of the **same commit** (689c951f, attempt 2) acquired all runners and
passed all jobs, including the combined gate, in **531 s** from attempt start to
gate completion. Its three unit jobs took **468 / 407 / 512 s** from runner start
to completion. This is a single successful GitHub after-run, not a p50/p95
estimate or evidence that the split changed total time. No workflow, timeout or
Forge configuration change followed the infrastructure cancellation.

| Former file | Before, full run | After, focused parts (seconds) | After, full Forge parts (seconds) |
| --- | ---: | --- | --- |
| `resolved-lessons` | 247 | 178.6 / 159.5 | 132.8 / 108.1 PASS |
| `conversation-owner` | 199 | 2.2 / 132.6 / 132.3 / 69.2 / 4.9 | 1.5 / 133.8 / 133.4 / 68.7 / 5.7 PASS |
| `peer-coordination` | 182 | 60.9 / 64.9 | 40.1 / 46.7 PASS |
| `repository-owner` | 172 | 92.9 / 116.9 / 94.0 | 39.7 PASS / 77.5 FAIL / 61.5 PASS |
| `peer-wait-deadline` | 169 | bound 3.4 / service 112.2 | bound 0.7 / service 102.8 PASS |
| `service-process` | 126 | supervision 9.7 / XPC lookup blocked by this sandbox | supervision 4.1 / XPC 45.8 PASS |

The local XPC part reached its peer-rejection assertion, then this sandbox denied
service lookup with Cocoa error 4099. The unsandboxed Forge XPC part passed in
45.8 s. The Forge run's `repository-owner-part-2` failure was in its `chat-landing`
suite: landing reported that no check passed on the exact source. That part passed
a focused rerun in 116.9 s. `preview-apply-layers` timed out waiting for a WebKit
snapshot in Forge. A focused rerun in this sandbox timed out earlier at page load,
with denied WebKit service extensions; it does not reproduce or explain Forge's
snapshot timeout. Neither Forge failure is established as caused by the split, and
that first full run was a failed gate. The other focused parts, `test-selection`,
typecheck and lint passed. The focused run wall clocks were 137.2 s for the five
conversation parts plus selection and 116.9 s for the three repository parts plus
selection; these are separate runs and not additive.

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
4. **Split slow files** (implemented in LKM-817; later full Forge check passed;
   local full run, seconds): `resolved-lessons` 247,
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
Forge's second full check took 427.8 s: 349 PASS, 2 FAIL, 3 SKIP.
`native-chat-send-follow` passed concurrently in 141.3 s. The failures were
`native-composer-layout` (its fixed scroll-settle window missed a delayed
main-queue callback) and `spawn-phases` (a setup-time comparison against a
different run became false under load: 1807 ms setup, 1154 ms lease wait).
Both fixtures now assert state or phase ordering directly; together they pass
in a focused 37.8 s local run. A third full Forge check took **645.2 s**:
**335 PASS, 10 FAIL, 6 TIMEOUT, 3 SKIP**. `native-chat-send-follow` passed
concurrently in 115.0 s. Failures and timeouts spanned Swift, service, provider
and UI tests, including `spawn-phases` and `sidebar-marquee`. The shared Mac's
load average exceeded 550; contention is a hypothesis, not proof of each cause.
After 19 leaked idle simulators were shut down, the manager authorized one
quiescent full check on the reconciled head. Before that gate, typecheck, lint
and a focused four-test run passed (105.7 s wall; send/follow 105.7 s). Its
full-check result is pending Forge's gate.
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
