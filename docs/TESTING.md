# Testing Trezi

The test runner is `node test/run.mjs unit|native|live|all`. Unit checks run with
bounded concurrency (by default `max(min(4, cores), min(cores - 2, 8))` workers) and
one exclusive barrier (`native-chat-send-follow`, LKM-371). Swift compiles share a
cache and a 2-wide lane, and the real-toolchain `swift-preview` tests run one at a
time beside the rest, see
[Unit tier speed](#unit-tier-speed-lkm-167). `service-process` keeps a 240 s budget
and `keychain-rebuild` (LKM-144) 300 s for a cold cache. Keychain tests use only password-made
temporary keychains and calls that cannot prompt. Native desktop and live provider checks are serial. Logs and JSON summaries are written to `test/artifacts/runs/`;
a lock prevents overlapping runner invocations. PASS, SKIP, FAIL, timeout and
cancellation remain distinct outcomes. Each test is killed after 120 s by default
(`--timeout-ms=<ms>` overrides it).

```sh
bun run typecheck
bun run typecheck:native
node test/run.mjs unit
node test/run.mjs unit --filter=trezi-cli,native-workspace-controller
node test/run.mjs unit --serial
bun run test:quick   # node test/run.mjs unit --typecheck --report
bun run test:native
```

`bun run test` runs unit and native tiers. `bun run verify` adds live provider
turns; those require explicit authorization and credentials. The native-runtime test
builds the app; focused native checks reuse that build and skip when unavailable.
`bun run test:native` runs native-runtime and then native-chat-scroll with
`--require-build`, so a missing host there fails instead of skipping. Chat-scroll
never builds; it runs the host native-runtime just built. Then
`test/browser-setup-packaged.mjs --require-build` (LOCAL-WEBKIT-4) copies that app
elsewhere and checks its WebKit linkage, packaged browser launcher and detection with
a private HOME, no CLI and scripted tools only. Native test builds use the
fast test profile and a shared Swift binary cache, see
[Native build speed](#native-build-speed-lkm-175).
The packaged-app check proves `otool` WebKit linkage, not a real WebKit launch from
the copy (the backend cannot start away from its checkout). The unit test
`browser-setup-recovery` covers hung tools, executable-identity Ready, failing
`get url`/`close` and the broken-shell Repair with scripted tools.
Electron/Playwright application tests were removed when the runtime was retired.
Their historical coverage is not claimed as native parity.

Native integration uses a disposable profile/project, Swift host and real Bun
controllers. It checks project switching, sheets, streaming/queues, permissions,
source/content/style writes, window geometry, docking, preview input isolation and
that exactly one WebKit view exists. `TREZI_NATIVE_BACKGROUND_TEST=1` skips real
pointer gestures/animation timing, which must be reported as reduced coverage.
`test:native-live` separately submits a real provider turn against a fixture.

### Focused verification (LOCAL-TEST-AUDIT)

Use exact registered test names with `--filter`; inspect the selection with `--list`
before running it. Listing validates tiers and names, prints tab-separated tier/name
pairs (including requested typechecks), and exits without acquiring a lock or creating
artifacts. Empty, unknown and wrong-tier selections fail with exit 2.

```sh
bun test/run.mjs unit --filter=test-runner,display-path --list
bun test/run.mjs unit --filter=test-runner,display-path
bun test/run.mjs native --list
```

For test, runner, docs or copy-only changes with unchanged application behavior,
run typecheck, lint and the relevant focused tests. A runner change also needs its
CLI selection regressions; console-only temporary fixtures cover native/live dispatch
without launching the desktop or calling providers. This scoped evidence does not
claim full-suite acceptance. Native UI behavior changes still need native evidence;
the manager schedules desktop suites under its shared desktop lock. Listing a native
tier is safe and does not build or launch the app. See `docs/TEST-CLEANUP-AUDIT.md`
for this cleanup's preserved coverage and validation limits.

### Changed-file selection (LOCAL-TEST-CLEANUP-V2)

`node test/run.mjs unit --changed=<base-ref>` diffs the working tree (staged,
unstaged and untracked) against the merge base of `<base-ref>` and `HEAD`, prints a
plan with a reason for every test, and runs only that plan. `--list` prints the
selection (reasons on stderr) and runs nothing. `node test/select.mjs --base=<ref>`
prints the same plan; `--path=<path>` plans a hypothetical edit; `--json` and
`--github-output` are for tools and CI. Rules live in `test/helpers/test-plan.mjs`,
tier membership only in `test/tiers.mjs`.

| Change | Plan |
| --- | --- |
| Markdown at the top level or under `docs/` (added, edited, deleted or renamed) | the readers of that doc, no typecheck, no app build |
| A registered unit test script, edited, that nothing else names | that test plus the scanners of `test/` (`lint`, `no-system-preferences`, `legacy-names-audit`) |
| A file in an audited fixture folder (`FIXTURES`) | that fixture's tests plus scanners |
| An audited Swift UI source (`UI_SOURCES`, now `src/native/SidebarIcon.swift`) | its unit Swift fixtures, every registered test naming its type, the scanners of `src/native`; the app build stays required, and the plan names the native smoke groups still owed (`--only=sidebar,settings`), which the unit tier never runs |
| Anything else: other Swift or TypeScript source, helpers, unaudited fixtures, `package.json`, configs, new, deleted, renamed or unregistered tests, native/live tests, `test/run.mjs`, `test/tiers.mjs`, `test/select.mjs`, the selector, `.github/` | **everything** (with the paths that forced it) |
| No changed paths, more than 40 paths, an unknown Git status | **everything** |
| A ref that is not a commit, no merge base, unexpected `git diff` output | exit 2; nothing runs |

The docs and scanner readers (`READERS`) were audited from every registered test and
helper. `test/test-selection.mjs` fails when a test starts walking the tree or naming
a repository doc without being listed as a reader or an audited exemption, when a
registered test names an audited UI type without being its consumer, and on any
narrowing of the fallbacks above. Narrowed plans never run the typecheck: none of
their paths is a TypeScript program input. Native UI changes still need native
evidence (`bun test/native-runtime.mjs --only=…` on a Mac); a selected unit plan is
not that evidence. To audit another UI source, add it to `UI_SOURCES` with its
fixtures and groups after checking every reader of it.

### Unit tier speed (LKM-167)

- **Swift build cache.** Every unit test that compiles Swift calls
  `swiftBuild(name, args)` in `test/helpers/swift-build.mjs`. The binary is cached
  under `.local/test-cache/swift/` (or `$TREZI_TEST_CACHE/swift`), keyed by
  `swiftc --version`, the SDK path, the flags and every source file's bytes, so an
  unchanged fixture is never rebuilt and a changed source always is. All compiles
  share one Clang module cache: a cold module cache costs about 25 s per compile.
  Tests that sign, bundle or replace a binary pass `{ out }` and get a private copy.
  `keychain-rebuild` must really rebuild, so it uses `swiftCompile` (uncached, shared
  module cache). Delete the folder any time.
- **swiftc lane.** At most 2 compiles run at once across all test processes
  (`.local/test-cache/swift/slots/`; a dead owner's slot is taken over). That is why
  no unit test needs to be an exclusive barrier any more. Each cached binary also has
  a build lock (`<binary>.lock`): a process that needs a binary another process is
  building waits for that build instead of compiling it again in the second slot; a
  failed or dead builder lets the next one build (LOCAL-TEST-CLEANUP-V2,
  `test/swift-build-lock.mjs`).
- **Order.** `--report` prints the 20 slowest tests and merges each PASS duration into
  `.local/test-times.json`. The next run starts the slowest tests first. Without the
  file, tests run in list order.
- **Groups (LKM-345).** Unit tests in one `UNIT_GROUPS` group (`test/tiers.mjs`) never
  run at the same time. A free worker takes the first waiting test whose group is not
  running, so the other workers keep running the rest of the tier. The `swift-preview`
  group is the five tests that build through a real `PreviewSession` (`swift-preview`,
  `-target`, `-toolchain`, `-build`, `-generate`). Their builds run outside the swiftc
  lane: Xcode metadata queries, a `#Preview` probe with an empty module cache,
  xcodebuild, SwiftPM, actool, swiftc and a preview host, each under a product tool
  limit of 20–120 s. Longest-first ordering started them together. On the 3-vCPU
  hosted runner they then starved each other past those limits and their own budgets.
  One at a time, each sees the load it was sized for. `test/test-runner.mjs` checks
  the rule.
- **`native-chat-send-follow` (LKM-371).** An exclusive barrier in the unit queue: its
  offscreen AppKit fixture drives long main-run-loop settles whose observations were
  stretched by other unit workers on the 1-shard runner. Only that test runs alone;
  other tests keep their usual concurrency. Its fixed observation windows remain
  behavioral coverage for the forced stream cases. Ordinary sends wait on the app's own
  settle signals instead of a sample count: after the end push the fixture turns the
  run loop until `latestSettling` is clear and `latestSettles` has stayed unchanged for
  0.5 s and 20 turns (deadline 30 s), and the test asserts both that quiet was reached
  and that at most 6 settles ran after the turn. A settle that restarts after every pin
  (LKM-354) never gets quiet; a slow runner only lengthens the wait.
- **Typecheck.** `--typecheck` runs `bun run typecheck` next to the tier and counts it
  as a result (`[typecheck]`). `bun run test:quick` is `unit --typecheck --report`.
  It also runs `bun run typecheck:native` unless that checks the same program as
  `typecheck:node` (part of `typecheck`): today `tsconfig.native.json` only extends
  `tsconfig.node.json` with the default `composite: false` and the same `lib`, so
  `tsc --showConfig` resolves both to the same options and files. The runner prints
  `NOT RUN [typecheck] typecheck-native` with the reason and records it under
  `notRun` in `summary.json`. Once the configs or scripts diverge (or cannot be
  read), both run again (`typecheckPlan`, `test/helpers/test-plan.mjs`). The
  `typecheck:native` command itself is unchanged (LOCAL-TEST-CLEANUP-V2).
- **Long tests split, sleeps bounded.** `workflow-owner` runs the scenarios;
  `workflow-durability` runs the same file's tool and durability checks in a second
  process. The composer fixture waits for the pin to land (at most 5 s) instead of
  one fixed 0.2 s run-loop turn, which flaked under 8 workers.
- **Wall-clock budgets.** A timing check asserts the median of `TIMING_RUNS` (5) runs
  after one warm-up through `src/native/smoke-timing.ts`, never a single sample. Locally
  the median must meet the product target; with `CI` set the budget is twice the target,
  so a 2× regression still fails (LKM-211).

Measured on the operator Mac (12 cores, 8 workers), 2026-10-05:

| Run | Before | After |
| --- | --- | --- |
| Unit tier, wall time | 328.6 s (4 workers, 2 exclusive barriers) | 83.1 s (manager quick verify, warm cache); 55.7 s locally with `--typecheck` |
| Unit tier, cold Swift cache | 328.6 s | 122.1 s with `--typecheck` |
| Quick verification (typecheck, typecheck:native, unit) | 5-7 min | 87.2 s |
| Sum of test durations | 867 s | 512 s |
| `keychain-rebuild` | 65.6 s | 3.8 s |
| `service-process` | 44.4 s | 7.2 s |
| `memory-owner` / `workspace-owner` / `preferences-owner` | 53.1 / 52.4 / 52.3 s | 22.8 / 23.1 / 25.0 s |
| `operation-ledger` | 47.2 s | 17.4 s |
| `workflow-owner` | 51.3 s | 9.1 s + `workflow-durability` 48.3 s, in parallel |
| `git-messages` / `service-contract` / `service-session` | 28.0 / 19.2 / 22.2 s | 0.3 / 0.8 / 1.2 s |

`workflow-durability` no longer waits on client deadlines: its fixtures pass a manual
clock that expires on the fixture's exit or a dropped reply (LKM-209). It and
`workflow-owner` have a 240 s budget because CI compiles the workflow fixture cold.
Since LKM-314 that budget is 420 s, because three unit runs sharing the Mac took them past 240 s.

The remaining long tests are runtime, not compile: the composer and settings layout fixtures
(run-loop turns), and the repository, platform and preferences owners.

### Parallel load check (LKM-313, LKM-314)

The manager runs quick verification for several worktrees at once. To prove the unit tier holds
up under that load, run it in three checkouts of the same commit at once. The run lock is per
checkout, so they must be separate worktrees, each with its own `bun install`:

```sh
node test/run.mjs unit --timeout-ms=120000 --report   # in all three at the same moment
```

Repeat for 5 rounds in a row. A round passes only when all three exit 0 (their `SUMMARY:` line
lists only PASS and SKIP). Keep each run's `Report:` file (`summary.json`). Fix a test that fails here
as the others were fixed: give a longer budget only where a real process starts, share no
state, and keep every assertion. If it still fails, move it to `NATIVE` in `test/tiers.mjs`
and add a note to `docs/PROGRESS.md`.

### Native build speed (LKM-175)

`scripts/build-native.mjs` compiles through `scripts/native-swift.mjs`:

- **Binary cache.** Each Swift product (TreziService, TreziHost, TreziSecrets) is
  keyed by its sorted source names (repo-relative) and bytes, its flags (profile,
  target, frameworks), `xcrun swiftc --version` and the SDK version/build. A hit copies
  the unsigned binary to the bundle instead of compiling; Bun bundling and signing run
  after it as before. The cache is `~/Library/Caches/Trezi/build/<product>/<hash>`,
  the 20 most recently used entries per product, shared by every worktree. Most
  tickets touch no Swift, so their builds compile nothing.
- **Module cache.** `~/Library/Caches/Trezi/module-cache`, also shared, so the
  AppKit/SwiftUI Clang modules (about 20 s per compile when cold) are built once.
- **Profiles.** `TREZI_BUILD_PROFILE=release` (default; `bun run build`, `bun run
  dev`) keeps `-O`. `TREZI_BUILD_PROFILE=test` compiles with `-Onone`,
  `-no-whole-module-optimization` and `-j<cores>`. `bun run test:native`,
  `test/native-runtime.mjs` and `bun run dev:native --test` select it. A test build
  says "(test profile, -Onone)" in its last line; run `bun run build` before using
  that app for real. TreziSecrets is always compiled release, so its bytes (and the
  Keychain approval tied to them) are the same in both profiles. `-enable-batch-mode`
  is not used: with Swift 6.3 its frontends exit without writing their objects.
- **Parallel steps.** The three swiftc products and the esbuild bundles run at
  the same time. Each swiftc gets a private temporary folder under
  `out/native/swift-tmp/`, and its compiler output prints in one block when it ends.
- **Timing lines.** Every step prints `[build] <step>: <s> s (cache hit … | compiled
  <profile> <flag>)`, then `[build] total`. native-runtime and native-chat-scroll print
  `[timing]` lines with their own durations.
- **Overrides.** `TREZI_BUILD_CACHE=<dir>` moves both caches; `TREZI_BUILD_CACHE=off`
  compiles every product and keeps the module cache in `out/native/module-cache`. A
  cache folder that cannot be created is reported once and the build compiles without
  it. Delete `~/Library/Caches/Trezi` any time.
- **Signing.** Unchanged: test builds use `TREZI_SIGN_IDENTITY` when set and never
  create an identity. `TREZI_SIGN_IDENTITY=-` no longer even lists the keychain's
  identities.

`test/native-build-cache.mjs` (unit tier) covers the key, pruning, hits, misses, the
unusable-cache fallback and the profile wiring with a stand-in compiler.

Build timings, 12-core operator Mac, measured in the agent sandbox on 2026-10-05:

| Build | Before | After (test profile) | After (release) |
| --- | --- | --- | --- |
| Cold: fresh `out/`, empty module and binary caches | 154 s | 45.8 s | 92.0 s |
| Fresh worktree, warm caches, no Swift change | 154 s (module cache lived in `out/`) | 0.4 s | 0.4 s (hit) |
| Same worktree, no Swift change | 121 s | 0.4 s | 0.4 s (hit) |
| One host Swift file changed (`Toast.swift`) | 114 s | 6.0 s | not measured |
| `ServiceContract.swift` changed (host and service) | not measured (same full recompile) | 9.1 s | not measured |

Manager native verification (all seven smoke groups, then chat-scroll), 2026-10-05:
231 s in total, against about 8 min before. The build took 72.7 s, its first run
with an empty `~/Library/Caches/Trezi` while other worktrees were busy. The smoke and
direct-launch checks took 88 s and chat-scroll 68.9 s. Chat-scroll time is mostly
foreground captures and deliberate time-point samples: send-visibility samples at
+60/200/500 ms, and acceptance waits 1.6 s for the overlay scroller to hide. Its
fixed waits that only paced a poll were removed: the 80 ms pause before each
visibility poll, and the 1.2 s timer-tick sleep, which now polls for the next second.

### Native smoke summary

The native smoke (`src/native/smoke-core.ts`, run by `test/native-runtime.mjs`)
is a list of named checks run by `src/native/smoke-runner.ts`. A failing check
does not end the run. Its failure is recorded, the window is captured to
`test/artifacts/native/failure-<check>.png`, the check's own cleanup runs, and
then the shared restore (`src/native/smoke-restore.ts`) runs. The restore closes
sheets, menus and popovers, re-keys the main window, turns select mode off,
reselects the first fixture project in desktop viewport and reloads its page if
needed. After that the remaining checks run. A check that declares `dependsOn`
is skipped when any of those checks did not pass. Checks with no
dependency on the failed one still run. A failed cleanup or restore is logged as
`WARN [smoke] <check> <cleanup|restore> after failure: …` and does not stop the
run. If the native host exits, every remaining check is skipped. Each check
logs `START`, `PASS`/`FAIL` or `SKIP [smoke] <check>` as it runs, and the run
ends with:

```text
NATIVE SMOKE SUMMARY: <passed> passed, <failed> failed, <skipped> skipped (<total> checks)
FAILED <check>
  assertion: <first non-empty line of the error message>
  at: <smoke-*.ts:line:column of the failing assertion, when the stack has one>
  capture: <absolute path of failure-<check>.png, or "unavailable (<reason>)">
SKIPPED <check>
  skipped: depends on <first dependency that did not pass, or "native host (it exited)">
```

Failures and skips are listed in run order. If any check did not pass, the smoke
exits non-zero. `NATIVE CORE PASS` is printed only when every check passed. To see
the collect-all behaviour in a real run, set
`TREZI_NATIVE_SMOKE_FAIL=<check>[,<check>]`. Each named check then fails
deliberately without running, and its dependents are skipped. Unknown names are
rejected before anything runs. `test/native-smoke-runner.mjs` (unit tier) runs a
fixture list that includes a deliberately failing check. It asserts that later
checks still run and that dependents are skipped with their reason, and it
checks the exact summary text.

### Focus guard, failure lines and exit codes (LKM-176)

**Focus guard.** In a foreground run, the runner calls the host's `smokeFocus`
test command (`src/native/SmokeFocus.swift`, test profile only) before and after
every check. The command checks that Trezi is the active app with one of its own
windows key (an open sheet counts). If not, or if focus was taken away since the
last call, it activates Trezi. When no window became key it also calls
`makeKeyAndOrderFront` on the main window. It waits at most 2 s and asks for
activation again every 0.5 s. It never reads or changes system settings. A
restore logs `FOCUS [smoke] <check> — focus restored before the check` or
`… during the check`. A loss is the app resigning active (another app or a system
dialog took focus) or the simulation. If a check fails and focus was lost during
it, the runner runs the check's cleanup and the shared restore, logs `RETRY [smoke]
<check> — focus was lost during the check; retrying once: <assertion>` and runs the
check once more. If focus cannot be had within 2 s, the runner logs `WARN [smoke]
<check> — focus not obtainable …: <reason>` and still runs the check. Background
runs (`TREZI_NATIVE_BACKGROUND_TEST=1`) have no focus guard.

**Simulated focus loss.** `TREZI_NATIVE_SMOKE_STEAL_FOCUS=<check>[,<check>]` takes
focus away through the same test command right before the named checks' first
attempt. An invisible 1×1 Trezi window becomes key, so the main window resigns key
just as when another app takes focus. No other app is involved. `bun run
test:native` sets it to `chat-ready` by default, so every native run loses focus
once in the prelude. The later foreground checks pass only because the guard
restored focus. The log then contains `focus taken away (simulated by the host
test command)` and `focus restored during the check`. Set it to an empty value to
turn the simulation off. Unknown names are rejected before anything runs.

**Failure lines.** After the summary, the smoke prints one line per failed check:

```text
SMOKE FAIL <group>/<check>: <assertion message> (expected <value>, actual <value>) [artifact: <path>]
SMOKE ENV <reason>
```

- `<group>` is the check's group from `src/native/smoke-groups.ts`. Groups are
  joined with `+` (`islands+shadow-light`). Prelude checks report `prelude`.
- `(expected …, actual …)` comes from an `AssertionError`'s values, compacted to
  one line and truncated after 160 characters. It is omitted when the error has
  no values.
- A timed-out wait (`waitFor`/`inspectUntil` in `src/native/smoke-wait.ts`) reports
  `timed out after <s> s at <smoke-*.ts:line> waiting for <label>`. The location is
  the step that waited. `actual` is the last state the wait inspected.
- `[artifact: …]` is the failure capture, `unavailable (<reason>)`, or `none`.
- `SMOKE ENV <reason>` follows the fail lines, once for each distinct environment
  reason.

The launcher (`scripts/start-native.mjs`) receives these lines in the test
directory's `smoke-result.json`. After the host exits, it prints them again as the
last lines of the run. If the host exited without a result or was killed by a
signal, the launcher adds `SMOKE FAIL host/exit: native host exited with <exit code
N|signal S> … [artifact: test/artifacts/native/host-exit.log]` and up to 12 of the
host's last product log lines (`  host log: …`). A failure outside any named check
reports as `run/setup`. A filtered run that `test/native-runtime.mjs` stopped after 300 s,
or a full-suite run stopped after 600 s,
reports as `run/timeout`. Missing sidebar evidence reports as `sidebar/evidence`.
`test/native-smoke-report.mjs` (unit tier) covers the formatter, the timeout and
host-exit lines and the exit codes. `test/native-smoke-runner.mjs` covers restore,
retry and classification.

**Exit codes.** A failed check is an environment failure when focus was not
obtainable before it, was lost during its last attempt, or could not be restored
after it. The display being asleep also counts. Any other failure is a product
failure. `bun run test:native` (and `dev:native --test`) exits **1** when any
failure is a product failure, **3** when every failure is an environment failure,
and 0 on a pass. Skips follow a failure or a host exit and do not change the code.
The host and service still exit 1; the launcher maps the result to 3.

`node test/native-source-window.mjs` checks the popped-out editor's initial size,
programmatic resizing, code viewport, docking/reopening and draft retention using
a disposable native host. It requires an existing build and writes
`test/artifacts/native/source-window.png`. It does not exercise pointer resizing.

`node test/native-chat-scroll.mjs` uses a disposable native host with fixture
snapshots to check that sent questions and streamed responses remain visible
above the floating composer across short/long histories and shrinking drafts.
It also reveals a nested chat island (mid-history, starting offscreen) at 440pt
and the 320pt minimum chat width:
each top/bottom reveal must settle with its anchor within 8pt of the reading
edge, and overlapping pairs (top→bottom, bottom→top, top→top) must reject the
older request as superseded (naming the newest revision) while the newest
settles. It requires an existing native build and makes no provider calls.
Captures are written to `test/artifacts/native/chat-scroll/`, including
`reveal-<width>-{top,bottom}.png`, `reveal-<width>-overlap-<first>-<second>.png`
and the measured revisions/frames in `reveal-<width>.json`.

LKM-139: after the shell send, the `send-visibility` stage
(`test/helpers/chat-send-visibility.mjs`) sends into a long transcript at
440/320pt with a fixed and a growing composer and samples `chatInspect` after
send, mid-stream and done: visible rows > 0, offset ≤ maxOffset and an unchanged
scroll view/document. It writes `send-after-send.png`, `send-mid-stream.png` and
`send-visibility.json`. The windowless unit test `test/native-chat-latest-settle.mjs`
covers the same follow path. Its fixture's `--no-settle` mode (the pre-fix
view) is for manual reproduction only: whether it blanks depends on SwiftUI's
layout timing, so the test does not assert it (LKM-353).
LKM-312: `test/native-chat-bottom-marker.mjs` hosts the real `NativeChat` (its
sticky-request overlay included) offscreen and requires the end marker measured
at the reading edge and each follow settled within one run, after load, streaming
and completion. `CHAT_SWIFT=<path>` builds it against another `Chat.swift`.
LKM-354: `test/native-chat-send-follow.mjs` hosts the real `NativeChat` the same
way and samples each send every ~30 ms: the prompt or reply in the reading area
within 1 s and throughout the turn (new, short and long chats, a chat switch and
restore, a send while the previous turn runs), no jump back up, and no settle
still running after the turn, also when cards after the reply fill the view.
Two more cases (long and short chat) drop the model's message frames after a
send (the verification hook `messageFramesFilter`), the reporter's state of no
row measured in view: the bounded settles (at most 240 realize scrolls) must end
and then stay ended with no realize scroll and the clip put, and once
the frames are measured again the sent rows are in the reading area, the clip at
the end. Two further cases do the same while the reply streams a chunk every 0.1 s
(each chunk is a content request). Ended is the app's own signal (LKM-365): more
unresolved settles in a row than `ChatLatestSettle.unresolvedRestarts` (the
diagnostic `latestUnresolved`), after which nothing may realize until a request
resets the count. It is not a quiet time: on the loaded 1-shard main CI a 1.5 s
pause mid-bound read as ended and the rest of the bound as a restart. They must end
before more than 240 realize scrolls run, not within a time (LKM-359): the bound is
in settle steps, which a loaded runner only stretches. A 90 s cap only stops a hung
run. Then none may realize, and the clip make no move up of over 40 pt, for 1.5 s
and 30 samples after (streaming: 3 s and 20 samples, with the chunks still
arriving). `leak-stream` also lets the first two frame reports after each realize
scroll through, then loses the frames again, at the latest when that settle ends.
Every forced case ends by sending a second prompt with the frames still dropped and
the bound spent: a realize scroll must follow (`realizedOnSend`) before that Send's
settles spend the bound again, because a new message restarts the count. A failure
prints the case's timeline: settle ends with the realize scrolls so far and the
unresolved count, each realize scroll and move up after the end. It takes
`CHAT_SWIFT` too.
LKM-357: the 1 s runs from the app's own Send moment (`sendRevision` raised in
`NativeChat.update`) to the first frames the conversation reports with a sent row
in the reading area (read through a pass-through `messageFramesFilter`), not from
the harness's push to its next sample. Locally the limit is 1 s; with `CI=true`
or `GITHUB_ACTIONS=true` it is 2 s, about twice the 1.04 s a loaded GitHub runner
once read (locally 0.003–0.017 s). A failure lists every case's Send and shown
times, the delta and the limit used.

LKM-103 acceptance runs at the end of native-chat-scroll, which `bun run test:native`
invokes with `--require-build` after native-runtime (a missing host fails there
instead of skipping). The standalone command still works.

**Verification never changes the user's macOS settings.** It must not
read-modify-write system preferences: no `defaults`, CFPreferences writes,
system domains, or preference broadcasts. `test/no-system-preferences.mjs`
(unit tier) fails if app code, helpers or the harness do any of these.
Scroller and accessibility modes are switched through `ChatSystemEnvironment`
(`src/native/ChatEnvironment.swift`), an in-process override that only the
ephemeral-profile `chatAcceptance` host command can set:
`{ environment: { scrollers: 'Always'|'WhenScrolling' } }`,
`{ environment: { accessibility: { increaseContrast, reduceTransparency, reduceMotion } } }`
and `{ environment: { clear: true } }`. The override dies with the test host.

With no override, the provider returns the real `NSScroller.preferredScrollerStyle`
and `NSWorkspace` accessibility values, read live. The probe applies the
scroller style to the conversation's NSScrollView. Accessibility values feed
the SwiftUI environment keys (`colorSchemeContrast`,
`accessibilityReduceTransparency`, `accessibilityReduceMotion`) that the chat's
views and the composer beam read. AppKit's own high-contrast drawing of native
controls cannot be forced per view (`NSAppearance` maps the accessibility names
back to Aqua/DarkAqua), so the scroll view's appearance is never replaced and
the native scroller keeps following macOS. The acceptance asserts this
(`scrollAppearance` empty). Diagnostics include `system` (read-only real values),
`accessibility` (effective), `rendered` (what SwiftUI views read) and
`environmentOverridden`.

Inspect these artifacts under `test/artifacts/native/chat-scroll/`:

- `acceptance-{440,320}-{1,6,80}-lines.png/.json`: full foreground chat column,
  all three exterior gaps equal 10, contained/aligned/hittable controls, whole
  latest row above clearance, latest-message OCR, capped versus uncapped input.
- `acceptance-{440,320}-resized-{short,tall}.png/.json` (capped draft, then
  resize) and `acceptance-{440,320}-short-1-line`/`-short-then-grow[-tall]`
  (short window, then growth to the cap): latest row remains reachable in
  both orders while composer height and viewport size change. `pinCount`
  records the probe's settled-metric follow pins; `pinned`/`userScrollCount`
  record the probe's user-input-owned latest state (wheel, live scroll, keys).
  Input reaches the app as window-targeted events via `NSApp.postEvent` (never
  `postToPid`, whose events have no window). If a wheel check fails, read
  `monitorCallbacks`, `scrollWheelEvents` and `lastInputRejection` to see
  where the event stopped. `probeShowsLatest`/`modelShowsLatest` show whether
  the latest button should be visible and whether SwiftUI received it.
  The thumb drag queues its dragged/up events and then delivers the mouseDown
  with `window.sendEvent`, so the hit-tested NSScroller's own tracking loop
  consumes them (`src/native/ScrollerDrag.swift`). `lastDrag` in every
  inspection, and `acceptance-<mode>-<n>-drag.json`, record the hit target, the
  consumed/leftover counts and scrollY before/after.
- `acceptance-{WhenScrolling,Always}-*-{idle,active,hover,dragged,latest}.png/.json`:
  actual SwiftUI probe attachment, native small scroller, wheel and thumb movement,
  real latest-button click, no hover/drag viewport-width jump, live scroller-mode
  override reaching the probe, and visible non-autohiding Always scroller. Review resting/active
  visual prominence; numeric geometry alone cannot prove the intended appearance.
- `acceptance-accessibility-{true,false}[-latest].png/.json`: all three modes
  switched through the override and received by the conversation's SwiftUI
  environment (`rendered`), plus functional wheel/latest scrolling and stable layout.
- `acceptance-{440,320}-scrolled-up.png/.json` (LKM-141): the latest button scrolled
  into history, asserted round, centered over the column, `latestButtonGap` above
  `composerTop`, below `readingHeight` (never over the reading area) and labelled.
  LKM-190: the conversation is unmasked, so every latest-button check also asserts
  its own backdrop (`latestButtonBackdrop`, `latestButtonBackdropFills`) and that a
  click at its centre hit-tests to it (`latestButtonHit`). `acceptance-{440,320}-scrolled-up-{light,dark}.png/.json`
  force the window's appearance (never the system's) and require `latestBandInk`
  (text pixels beside the button, from `latestButtonGap` above it to the composer)
  above 40, nudging the history up to three times past a gap between messages.
- `tokens-{running,done}-{440,320}.png` and `tokens-{440,320}.json` (LKM-141): a
  turn's counter after "Thinking…" while running, then under Copy/Revert, with
  the footer's height and bottom unchanged by completion.
- `acceptance-results.json`: successful assertion summary; `acceptance-failure.*`
  retains failure diagnostics and foreground pixels when capture remains available.

The core suite also writes `test/artifacts/native/composer-visible-{440,320}-*.png`
and JSON for real attachment-dialog/file, model, Auto, AppKit typing and submission
checks. The draft is multiline at 440 points and capped at 320 points. These
fixtures must run in the foreground; no background-coverage exception is applied.
`bun test/no-system-preferences.mjs` is the system-settings guard described above.

`node test/native-next-hmr.mjs` checks Next.js 16.3.5 in Webpack mode through
Trezi's managed dev server and system WebKit. It installs dependencies into a
disposable copy of the Next fixture (registry access/cache required), checks
ordinary component edits plus chat-island commits and Undo, and asserts that the
page is never reloaded. It needs an existing native build and runs in the native
tier after `native-runtime`. No provider calls are made. Static-site live reload
coverage alone does not verify framework Fast Refresh.

Shadow Light verification requires macOS 14.4+ for ScreenCaptureKit's
current-process window capture. It captures only Trezi's own foreground window,
then crops to chat pixels and checks visible labels with OCR. It does not launch
an external screen recorder or request access to other applications. Inspect
`shadow-light-{initial,adjusted,restored}.png` and their `-bottom` companions against
the approved mockup; OCR presence is not a substitute for layout review. Capture
or OCR failures fail verification without an offscreen fallback.

The same check drags the light through 8 frames of one gesture (LKM-140). A
page-world sampler records the card's computed box-shadow every animation frame.
Gaps, out-of-order values and foreign values must all be 0, and the source must
not change before the release. It writes `shadow-light-drag.png` (mid-drag),
`shadow-light-released.png` and `shadow-light-drag.json` (the counts). The unit
test `test/island-flicker.mjs` models a gap HMR to record the same counts before
and after the fix. With TreziHost built, `test/island-flicker-frameworks.mjs` runs
the same drag on real Next.js Webpack HMR and a Vite/CSS module fixture. It is in the
native tier (LKM-313: it was a unit test, and real dev servers failed it under parallel
load), so it runs serially with `bun run test:native` or `node test/island-flicker-frameworks.mjs`.
`test/dependency-refresh-vite.mjs` (LKM-197) runs real Vite with a local `file:`
dependency through the Swift runtime owner and WebKit: after the dependency's CSS
changes, the watch's clean restart and hard reload show the new computed style. It
SKIPs without a native build, a working `bun install` or local port binding.
`test/island-override.mjs` runs the preview override module on a fake DOM. It checks
that the override survives HMR remounts and that it is removed only on the final value.

Read screenshots in `test/artifacts/native/` for UI verification. Offscreen
AppKit captures do not faithfully paint Liquid Glass; visible inspection may be
necessary. Never start the target project server manually alongside Trezi.

Sidebar icon acceptance runs inside the normal native project-switching fixture.
`sidebar-{260,180}-{0,1}-{rest,hover}.png` captures only the foreground sidebar
through ScreenCaptureKit, with matching JSON containing OCR and row geometry.
Three projects must be visible (LKM-372): Folder Alpha with a 16×16 PNG favicon,
Folder Beta with none, and Folder Invalid Icon (not `chat-gate`'s Folder Gamma),
opened for this check and closed and removed in teardown, whose `favicon.png` has a PNG signature but a corrupt body. Alpha and
Beta are selected in turn. The favicon row must show its decoded favicon (not a
template, fitted to 16 points, painted, centre pixel near #F06A1C); the other two
must show the template folder with selection tint. Every row needs a painted slot,
icon and label centres within a point, the exact 16×16 icon frame at an integral origin, a seven-point gap to the label's
alignment rect (its frame adds AppKit's 2-point cell padding), icon and label
x equal to Open Project's, containment, accessibility action label and correct
More visibility. Blank captures or missing project labels fail.
`sidebar-interactions.json` records native menu tracking/cancel, the Project Memory
menu action opening its form, and production pasteboard/validate/accept-drop
callbacks plus backend order changes at both widths. Drag checks reject no-op and
nested drops and preserve selection. They exercise delegates with a local test
drag object, not physical pointer travel. Hover uses native enter/exit callbacks.
After the menu/Project Memory step, after reorder and in teardown (which also runs
on failure), `sidebarFocus` cancels tracking menus, ends sheets/modals, dismisses
Trezi's sheet window and popovers, clears hover and re-keys the main window. The
fixture then requires no tracking menu, sheet or popover, a key and main window,
and an active app, naming any leftover. Each capture is preceded by the same
report. A failed capture keeps the guard's message and appends the report; it is
never retried. `test/sidebar-focus.mjs` covers this logic without a window.
`sidebar-selection.json` records the project/chat/preview assertions from the
existing native selection callback checks after opening the second fixture.
Review the PNGs for outline glyph fidelity and contrast; physical drag animation
and pointer targeting remain manual review checks. After a passing smoke run, `test/native-runtime.mjs` fails unless all eight
captures, their JSON, `sidebar-selection.json` and both widths' menu/reorder
records were freshly written by that run. `test/sidebar-evidence.mjs`
rejects deliberately blank, clipped, misaligned and incorrect-state evidence
without launching a desktop.
`test/sidebar-sizing.mjs` exercises AppKit split layout without a window, checking
that requested content widths account for sidebar wrapper insets after reveal.
`test/sidebar-icon.mjs` lays out a windowless source list and Open Project button
with `SidebarIconView` across symbol scales at 260/180 points: each folder frame
must be exactly 16×16, integral, pixel aligned and free of symbol alignment insets.
`test/sidebar-favicon.mjs` decodes PNG (including 1×1 and 32×16), SVG (base64 and
percent-encoded) and ICO favicons through `SidebarFavicon`. Each must keep its colours
and aspect and fill the 16-point slot. Missing, non-image, bad-base64, truncated and
corrupt data must return nil, so the row keeps its folder. Favicon and folder rows
must then share the slot, label gap and vertical centre, selected and unselected, with
painted pixels.

New tests belong in the appropriate array in `test/tiers.mjs`. Pure tests must own
their temporary directories/ports and clean up processes. Use injected service
registries when testing lifecycle behavior without the desktop. Renderer-specific
unit tests were removed; retained backend generation tests use React as a dev
fixture to verify that generated project code actually renders.

### Native smoke groups

`bun run dev:native --test --only=group,group` (or
`bun test/native-runtime.mjs --only=…`) runs only the named groups. It
filters which of the named smoke checks run (see "Native smoke summary"); failure
collection is unchanged. The `startup`, `open-project`, `chat-ready` and
`final-shell` checks (setup, and the closing capture plus one-WebKit-view check)
always run; with no flag every group runs. `src/native/smoke-groups.ts` maps each
check to its group, and a check with no group there is an error:

| Group | Covers |
| --- | --- |
| `core` | mobile viewport/reload, source stamps, toolbar/preview surface, divider/expand, layers, selection input, inspector style edit and floating island (preview width open/closed, resize, hit targets, scrolling), text edit + undo/redo, popped-out source editor, preview Web Inspector |
| `islands` | `chat-islands`, generic part: Swift rendering, point commit, Undo, landing gate |
| `shadow-light` | `chat-islands`, Shadow Light part (same fixture scope; the check runs when either group is selected) |
| `sidebar` | project switching and visible sidebar captures/interactions |
| `settings` | sheets and forms: running servers, New project, project memory, Settings (General, inline AI Providers, Skills (`smoke-skills.ts`), Experimental), feedback, diagnose, activity; attached alert sheets, the feedback error sheet and toast (`smoke-alerts.ts`) |
| `chat` | native chat streaming/queues/permissions (`smoke-chat.ts`); sent-bubble attachment thumbnails, wrapping and preview (`smoke-sent-attachments.ts`); comment result rows collapsed/expanded in light and dark (`smoke-comment-rows.ts`); post-landing check: a pass adds no row, problem warning rows (not loaded, dev-server error, blank, console errors) with their actions in light and dark (`smoke-landing-check.ts`); a background agent's question card in light and dark, expanded and answered (`smoke-agent-question.ts`); whole-message selection, Copy and Select All in light and dark (`smoke-chat-text.ts`); answer components (options mid-turn with skeletons, form) in light and dark, with the pick and submit reaching a stubbed provider with their summaries (`smoke-chat-ui.ts`); the sidebar's chat status: a background chat's row spinning and reading Running, then the green unread dot, and the dot clearing when the chat is opened from the sidebar (`smoke-sidebar-status.ts`, `sidebar-status-unread.png`); an answer's `trezi-code:` links clicked through `ChatTextView`'s link entry point: the exact range selected, banded and visible in Trezi's editor, no AppKit/NSWorkspace handoff (`ChatTextView.appKitLinks` stays 0, Trezi stays frontmost), `..`/symlink/absolute links refused in chat, repeat and alternate clicks re-reveal, stale links after a conversation or project switch reveal nothing, the draft kept and no file written (`smoke-code-link.ts`, `code-link-*.png/json`) |
| `composer` | composer growth/paste/attachments, per-chat drafts, slash commands, visible composer |
| `agent-browser` | `agent-navigation` only (also in `core`): the private agent page's open against navigations it did not start, for a focused run |
| `selection` | `selection-input` and `text-edit` (also in `core`): WebKit edit/selection lifecycle, Finder blur/refocus, and source apply/undo/redo; prelude retained |
| `changes` | `changes-panel` only: the editor's read-only Changes list over a temp Git project (`smoke-changes-fixture.ts`: base branch, committed edit/add/rename/delete/binary, staged, unstaged, untracked): merge-base label, committed apart from uncommitted sections with +/− counts, file and hunk rows opening the exact range over a kept draft, Refresh as the only control, HEAD/branches/index/work tree unchanged, a project switch refreshing without leaking rows (`smoke-changes-panel.ts`, `SourceNavigationVerification.swift`, `changes-panel-*.png/json`). The fixture's rows and ranges are also checked against the real `branchDiff`/`openDiff` in the unit tier (`test/native-changes-fixture.mjs`) |

LKM-366's targeted run is `bun test/native-runtime.mjs --only=chat,changes` (the focused
300 s launcher timeout); its captures and JSON land in `test/artifacts/native/`.

An unknown or empty group name fails before the build. `--live` requires `core`
(the live turn edits the heading the core group writes). `native-runtime` only
demands fresh sidebar evidence when `sidebar` ran. Acceptance still needs the
full suite.

## GitHub CI

`.github/workflows/ci.yml` runs `typecheck + unit tests`, `app build`, and
`dependency audit` with read-only repository permissions and bounded timeouts.
Superseded runs for the same PR or branch are cancelled.

- **The split (LKM-327).** `typecheck + unit tests` used to be one macOS job: setup,
  both typechecks, then the whole unit tier on the runner's 3 cores, about 12 min
  on PR #300. It is now three kinds of job:

  | Job | Runner | What |
  | --- | --- | --- |
  | `typecheck` | `ubuntu-latest` | version/changelog check, frozen install, `bun run typecheck`, `bun run typecheck:native` |
  | `unit tests (i/n)` | `macos-26`, a matrix | the unit tier with `--shard=i/n`: **3 shards on a pull request, 1 (the whole tier) on a push to `main`** |
  | `typecheck + unit tests` | `ubuntu-latest` | the gate: needs both, runs `if: always()`, and passes only when the typecheck and every shard passed |

  The gate keeps the check name the single job had, so anything that waits for
  that check still does. A failed, cancelled or skipped shard fails the gate; it
  never reports as skipped. tsc reads no Swift and no SDK, so the typechecks need
  no macOS runner; Linux is case-sensitive, so an import whose case differs from
  the file name fails there.

  `node test/run.mjs unit --shard=<i>/<n>` runs shard `i` of `n` of the selected
  unit tests (after `--changed` or `--filter`) and prints `Shard i/n: x of y
  selected unit tests`; `summary.json` records the shard and its tests. It takes
  only the unit tier and refuses `--typecheck`. The split (`shardTests` in
  `test/helpers/test-plan.mjs`) is greedy, heaviest test first onto the lightest
  shard. Its weights are committed data only: a test's `UNIT_TIMEOUT_MS` budget,
  else `SHARD_WEIGHT_MS` (30 s). It never reads `.local/test-times.json`, because
  each shard restores its own cache and the shards must agree on one split, so
  every test runs in exactly one shard. `test/test-selection.mjs` checks that the
  shards are disjoint, cover the input and stay balanced. Inside a shard the times
  file still starts the slowest tests first. A narrowed pull-request plan with
  fewer tests than shards leaves a shard empty; that shard passes with nothing to
  run. Measured locally (8 workers, 2026-10-23), the three PR shards hold 464 s,
  433 s and 394 s of the tier's 1291 s of test time.

  Each shard keys its Swift cache as `unit-swift-<os>-<i>of<n>-<sha>` and restores
  its own last cache first, then main's whole-tier `1of1` cache, then any. The
  "Swift test cache result" step logs the exact hit and the restored key, so a
  cold cache shows in the job log. The cache is saved after a passing or failing
  run (not a cancelled one), so a red push does not recompile on the next one.
  Logs upload as `unit-test-logs-<i>of<n>`.

  A pull request uses 4 macOS runners at once (3 shards and `app build`); a push
  to `main` uses 2. A busy account queues runs beyond its macOS concurrency limit.

- **Triggers.** It runs on a push to `main` and on every pull
  request. Pushes to other branches (throwaway and worker branches) do not start
  a run.
- **Runner.** The unit shards run on `macos-26`, GitHub's hosted macOS 26 (Tahoe) arm64
  image. The Swift service owners compile against the macOS 26 SDK
  (`MIN_SDK` in `scripts/requirements.mjs`). That image's default Xcode 26
  provides it, so the job needs no `xcode-select`. An Ubuntu runner cannot build
  them, and an older macOS image ships an older SDK. The "Toolchain" step prints
  the selected Xcode, `swiftc --version` and `git --version` (Git's wording
  differs between versions, LKM-150), then runs
  `bun scripts/requirements.mjs --build`. If the image ever ships an older SDK,
  that step fails before any tests run.
- **Commands.** The `typecheck` job and each unit shard run:

  ```sh
  bun install --frozen-lockfile
  bun run typecheck            # typecheck job
  bun run typecheck:native     # typecheck job
  node test/run.mjs unit --report --timeout-ms=120000 --log-tail=150 --shard=<i>/<n>
  ```

  The unit step has no `--typecheck`, `--filter`, `--serial` or `--jobs`, so every
  unit test (on a pull request, every planned one; see below) runs in exactly one
  shard with the default worker count. Locally `bun run test:quick` keeps running
  them together (`--typecheck`). On CI they used to start with the first three
  workers: typecheck took 85-93 s, and `swift-preview-target` hit its 300 s limit on
  merged-main run 39721071506 (attempts 1 and 2). That load is an inference, not a
  proven cause; the typechecks later moved to a step before the unit tier, and now
  to their own job. `test/dependency-audit.mjs` pins the jobs, the gate and the unit
  command. `test/swift-preview-target.mjs` prints `[elapsed] start|done <stage>`
  lines, so the last finished stage is in the log if it times out again;
  `swift-preview` and `swift-preview-build` print the same lines (LKM-345). Since
  LKM-345 the real-toolchain `swift-preview` tests also run one at a time (see
  "Groups" under [Unit tier speed](#unit-tier-speed-lkm-167)).
  The `Typecheck` step calls both scripts directly, so the `typecheckPlan` skip of
  an equivalent `typecheck-native` applies only to `--typecheck` runs, never to CI.

  On a pull request the unit command adds `--changed=<event base SHA>`
  (`github.event.pull_request.base.sha`, passed through the environment; the
  checkout fetches full history for the merge base), so it runs the
  [changed-file plan](#changed-file-selection-local-test-cleanup-v2). A push to
  `main` always runs the whole tier, and both typechecks run on every event. There
  is no `paths-ignore`: every job runs and reports its check on every pull request.
  `actions/cache/restore` restores
  `.local/test-cache` and `.local/test-times.json` from the latest run (key per
  shard and commit, restored by prefix; see the split above), so unchanged Swift
  fixtures are not recompiled ([Unit tier speed](#unit-tier-speed-lkm-167)).

- **App build.** A separate `macos-26` job runs the same toolchain check and
  frozen install, then `TREZI_SIGN_IDENTITY=- bun run build`. It checks that
  the host, bundled Bun, secrets helper, XPC service, backend bundles, syntax
  bundle and icon are nonempty; `test/distribution.mjs` and
  `test/versioning.mjs` inspect the assembled app and matching version stamps.
  `codesign --verify --deep --strict` checks its ad hoc signature. There are no
  distribution signing credentials in Actions. On a pull request it first runs
  `node test/select.mjs --base=<event base SHA> --github-output`; only a plan with
  no product change (docs, test scripts, audited fixtures) skips the build steps,
  and the job still reports its check. A push to `main`, an audited UI change and
  every fallback build; a selection error fails the job. The selection guards
  against accidental narrowing, not a hostile pull request: the PR's own workflow
  and selector run, so review of `.github/` and selector changes stays the control.
- **Dependency audit.** An `ubuntu-latest` job runs `bun audit --json`, which
  reads the full resolved `bun.lock` graph, including transitive and dev
  packages. The script refuses a lockfile with zero resolved packages or an
  invalid/failed audit response. On PRs it also audits the base commit and
  blocks only new high or critical package/advisory pairs. All findings,
  including existing and lower-severity ones, are printed for triage. Pushes
  to `main` report the current baseline without treating existing findings as
  newly introduced. The audit service requires network access; an unavailable
  advisory endpoint fails the job. GitHub dependency review is not used because
  the dependency graph's documented manifest list does not establish that it
  parses `bun.lock` for this repository.

  Each unit shard uploads `test/artifacts/runs/` as
  `unit-test-logs-<i>of<n>`, pass or fail.
  CI runs no native GUI tier and no live tier. The runner has no desktop session
  for the smoke suite and no provider credentials. Run those tiers on a Mac.
  Branch protection and required check contexts must be configured only after
  successful hosted runs establish their exact names. Public repositories on
  GitHub Free can use these protections; availability can differ if the repo
  later becomes private.
- **Skips off macOS.** Unit tests that compile Swift call the gates in
  `test/helpers/darwin.mjs`. The service-owner fixtures in `test/helpers/*-fixture.mjs`,
  the ledger, preferences, memory, workspace and platform owner tests, and every
  suite that loads `with-service-owners.mjs` use `skipUnlessDarwin`. The
  AppKit fixture tests (sidebar, slider, composer, settings layout, chat reveal)
  check `process.platform` themselves. On Linux each of these tests prints
  `<NAME> SKIP — <reason>` and exits 0. `test/run.mjs` reports it as `SKIP`, never
  `PASS`, and a unit run with only PASS and SKIP exits 0. `service-contract` uses
  `skipUnlessSwift`: the contract builds with swift-corelibs-foundation, so on
  Linux it still runs when `swiftc` is on `PATH`. On macOS a missing or broken
  toolchain fails instead of skipping, so the macOS job cannot go green by
  skipping Swift checks.
