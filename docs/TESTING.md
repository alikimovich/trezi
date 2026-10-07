# Testing Trezi

The test runner is `node test/run.mjs unit|native|live|all`. Unit checks run with
bounded concurrency (by default `max(min(4, cores), min(cores - 2, 8))` workers) and
no exclusive barriers: Swift compiles share a cache and a 2-wide lane, see
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
never builds; it runs the host native-runtime just built. Native test builds use the
fast test profile and a shared Swift binary cache, see
[Native build speed](#native-build-speed-lkm-175).
Electron/Playwright application tests were removed when the runtime was retired.
Their historical coverage is not claimed as native parity.

Native integration uses a disposable profile/project, Swift host and real Bun
controllers. It checks project switching, sheets, streaming/queues, permissions,
source/content/style writes, window geometry, docking, preview input isolation and
that exactly one WebKit view exists. `TREZI_NATIVE_BACKGROUND_TEST=1` skips real
pointer gestures/animation timing, which must be reported as reduced coverage.
`test:native-live` separately submits a real provider turn against a fixture.

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
  no unit test needs to be an exclusive barrier any more.
- **Order.** `--report` prints the 20 slowest tests and merges each PASS duration into
  `.local/test-times.json`. The next run starts the slowest tests first. Without the
  file, tests run in list order.
- **Typecheck.** `--typecheck` runs `bun run typecheck` and `bun run typecheck:native`
  next to the tier and counts them as results (`[typecheck]`). `bun run test:quick`
  is `unit --typecheck --report`.
- **Long tests split, sleeps bounded.** `workflow-owner` runs the scenarios;
  `workflow-durability` runs the same file's tool and durability checks in a second
  process. The composer fixture waits for the pin to land (at most 5 s) instead of
  one fixed 0.2 s run-loop turn, which flaked under 8 workers.

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

The remaining long tests are runtime, not compile: `workflow-durability` (client
deadlines after injected crashes), the composer and settings layout fixtures
(run-loop turns), and the repository, platform and preferences owners.

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
reports as `run/setup`. A run that `test/native-runtime.mjs` stopped after 300 s
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
covers the same follow path with a `--no-settle` negative control.

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
the same drag on real Next.js Webpack HMR and a Vite/CSS module fixture.
`test/dependency-refresh-vite.mjs` (LKM-197) runs real Vite with a local `file:`
dependency through the Swift runtime owner and WebKit: after the dependency's CSS
changes, the watch's clean restart and hard reload show the new computed style. It
SKIPs without a native build, a working `bun install` or local port binding.
`test/island-override.mjs` runs the preview override module on a fake DOM. It checks
that the override survives HMR remounts and that it is removed only on the final value.

Read screenshots in `test/artifacts/native/` for UI verification. Offscreen
AppKit captures do not faithfully paint Liquid Glass; visible inspection may be
necessary. Never start the target project server manually alongside Trezi.

Sidebar folder acceptance runs inside the normal native project-switching fixture.
`sidebar-{260,180}-{0,1}-{rest,hover}.png` captures only the foreground sidebar
through ScreenCaptureKit, with matching JSON containing OCR and row geometry.
Both projects must be visible, one with stored raster artwork and one without;
each is selected in turn. Assertions require the folder image, template tint,
exact 16×16 icon frame at an integral origin, a seven-point gap to the label's
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

New tests belong in the appropriate array in `test/run.mjs`. Pure tests must own
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
| `settings` | sheets and forms: running servers, New project, project memory, Settings (General, inline AI Providers, Experimental), feedback, diagnose, activity; attached alert sheets, the feedback error sheet and toast (`smoke-alerts.ts`) |
| `chat` | native chat streaming/queues/permissions (`smoke-chat.ts`); sent-bubble attachment thumbnails, wrapping and preview (`smoke-sent-attachments.ts`); comment result rows collapsed/expanded in light and dark (`smoke-comment-rows.ts`); post-landing check rows (clean, console errors, not checked) with the preview thumbnail in light and dark (`smoke-landing-check.ts`); a background agent's question card in light and dark, expanded and answered (`smoke-agent-question.ts`); whole-message selection, Copy and Select All in light and dark (`smoke-chat-text.ts`) |
| `composer` | composer growth/paste/attachments, per-chat drafts, slash commands, visible composer |

An unknown or empty group name fails before the build. `--live` requires `core`
(the live turn edits the heading the core group writes). `native-runtime` only
demands fresh sidebar evidence when `sidebar` ran. Acceptance still needs the
full suite.

## GitHub CI

`.github/workflows/ci.yml` runs one job, "typecheck + unit tests".

- **Triggers.** It runs on a push to `main` or `candidate` and on every pull
  request. Pushes to other branches (throwaway and worker branches) do not start
  a run.
- **Runner.** The job runs on `macos-26`, GitHub's hosted macOS 26 (Tahoe) arm64
  image. The Swift service owners compile against the macOS 26 SDK
  (`MIN_SDK` in `scripts/requirements.mjs`). That image's default Xcode 26
  provides it, so the job needs no `xcode-select`. An Ubuntu runner cannot build
  them, and an older macOS image ships an older SDK. The "Toolchain" step prints
  the selected Xcode, `swiftc --version` and `git --version` (Git's wording
  differs between versions, LKM-150), then runs
  `bun scripts/requirements.mjs --build`. If the image ever ships an older SDK,
  that step fails before any tests run.
- **Commands**, in order:

  ```sh
  bun install --frozen-lockfile
  node test/run.mjs unit --typecheck --report --timeout-ms=120000
  ```

  Both typechecks run next to the unit tier. `actions/cache` restores
  `.local/test-cache` and `.local/test-times.json` from the latest run (key per
  commit, restored by prefix), so unchanged Swift fixtures are not recompiled
  ([Unit tier speed](#unit-tier-speed-lkm-167)).

  If a step fails, the run uploads `test/artifacts/runs/` as `unit-test-logs`.
  CI runs no native GUI tier and no live tier. The runner has no desktop session
  for the smoke suite and no provider credentials. Run those tiers on a Mac.
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
