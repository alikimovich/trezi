# LOCAL-TEST-CLEANUP-V2 — 2026-10-20

Execution-cost cleanup against `ce213841` (LKM-297, reopened after LOCAL-TEST-AUDIT).
Status: locally review-ready after the review repair, publication held. Not "Done": no
full unit, native or GitHub CI run was made for this change (see [Limits](#limits)). No test file, fixture
or assertion was deleted; what changed is how many processes run, and when.

Evidence (logs, runner summaries, plans): `docs/evidence/test-cleanup-v2/`. Host:
the manager's Mac (arm64), one Bun 1.3.13 / Node 26 session, same checkout and caches
for every before/after pair. Historical CI numbers come from the original baseline run
(`run-jLv3Yt`, `baseline-ci.log`, a 3-core `macos-26` runner) and are only context:
no local time below is subtracted from a CI time.

## What changed

1. **Duplicate typecheck removed from `--typecheck`.** `tsconfig.native.json` extends
   `tsconfig.node.json` and only adds `composite: false` (the default) and the same
   `lib`. `tsc --showConfig` resolves both to the same options and the same file list;
   `tsc --listFilesOnly` gives 1083 identical files. `typecheck-native` re-checked the
   program `typecheck` (via `typecheck:node`) already checks. `typecheckPlan`
   (`test/helpers/test-plan.mjs`) now drops it only while the configs and the three
   package scripts are provably that pair; any divergence, extra key, comment or
   unreadable file runs both again. `bun run typecheck:native` is unchanged.
2. **One swiftc run per cached fixture binary.** `swiftBuild`
   (`test/helpers/swift-build.mjs`) takes a per-binary build lock before a swiftc
   slot, so a second process needing the same binary waits for the first build
   instead of compiling it again in the other of the two slots. A failed or dead
   builder's lock does not block the next build (`test/swift-build-lock.mjs`).
3. **Changed-file selection** (`node test/run.mjs unit --changed=<ref>`,
   `test/select.mjs`, rules in `docs/TESTING.md` "Changed-file selection"): docs,
   edited unit test scripts, one audited fixture folder and one audited Swift UI
   source narrow to their tests and readers; everything else runs everything.
4. **Tier membership in one place**: `test/tiers.mjs` (moved verbatim from
   `test/run.mjs`, checked equal to `ce213841`'s lists), read by the runner and the
   selector.
5. **CI**: pull requests run the plan for their diff against the event's base SHA;
   pushes to `main` run everything; the app build is skipped only for a plan with no
   product change. No `paths-ignore`; every job still reports.

## Process counts

| Run | Before (`ce213841`) | After |
| --- | ---: | ---: |
| Full `unit --typecheck` (main push, CI fallback): unit processes | 256 | 258 (+`test-selection`, +`swift-build-lock`) |
| Full `unit --typecheck`: typecheck entries / `tsc` program checks | 2 / 3 | 1 / 2 |
| Full: top-level result processes | 258 | 259 |
| Same fixture binary requested by 4 processes at once (**estimated** from per-child CPU, >0.3 s user) | about 2 swiftc runs | about 1 swiftc run |
| PR, docs only (sample: `docs/TESTING.md`, `docs/agent-guide/verification.md`, `CHANGELOG.md`) | 258 + app build | 3 unit, 0 typecheck, app build skipped |
| PR, test only (sample: `test/display-path.mjs`) | 258 + app build | 4 unit, 0 typecheck, app build skipped |
| PR, audited UI (`src/native/SidebarIcon.swift`) | 258 + app build | 7 unit, 0 typecheck, app build runs, native `--only=sidebar,settings` owed |
| PR, anything else | 258 + app build | 259 + app build (full fallback) |

A full run gains one process: the removed typecheck entry is replaced by two small
safety tests. Its saving is CPU (one `tsc` program check, and fewer duplicate swiftc
runs on a cold cache), not process count.

## Measurements

Matched local before/after (same host and cache, each run once):

| Check | Before | After | Log |
| --- | --- | --- | --- |
| `bun run typecheck:native` alone (what the runner no longer runs) | 3.00 s wall, 5.41 s user | not run | `before-typecheck-native.txt` |
| `bun run typecheck` alone (unchanged) | 3.82 s wall, 6.92 s user | same command | `before-typecheck.txt` |
| `node test/run.mjs unit --typecheck --filter=docs-links` | 3.78 s wall, 12.02 s user, 0.69 s sys | 3.65 s wall, 6.17 s user, 0.39 s sys | `before-/after-runner-typecheck.*` |
| 4 processes build `sidebar-icon` at once, warm modules | 1.29 s user + 0.59 s sys child CPU (est. 2 swiftc runs) | 0.78 s + 0.36 s (est. 1 run) | `swift-dedupe-before/after.txt` |
| 4 processes build the shared skills-owner fixture at once | 10.20 s user + 2.30 s sys child CPU, 6.43 s wall (est. 2 runs) | 5.39 s + 1.11 s, 6.24 s wall (est. 1 run) | `swift-dedupe-*-skills.txt` |

Wall time barely moves for either change: the typecheck entries ran concurrently, and
duplicate compiles ran in parallel. Both are aggregate CPU savings on a shared runner.
The duplicate compile also held the second swiftc slot, delaying a different fixture.
How often that happens in a full cold run was not measured. The measurement driver is
kept as `swift-dedupe-driver.mjs.txt`.

**Correction (review repair):** the swiftc run counts above (and in the logs'
`children-that-ran-swiftc`) are **estimates, not counts of compiler invocations**. A
child counted as compiling when its user CPU was above 0.3 s; children that only waited
used about 0.06 s. The driver's original header wrongly said it counted `.tmp` outputs
with a directory watch: that approach failed with EMFILE and was dropped, leaving an
unused import. The inodes it prints prove nothing either way. The CPU totals are real
measurements. The direct behavioral evidence for "one build, others wait" is
`test/swift-build-lock.mjs`: a second process never compiles while a live builder
holds the lock, and a helper without the lock fails it. No new benchmark was run for
this correction.

Selected commands (plans from `node test/select.mjs --path=…`, the same
`planChanges` that `--changed` uses; execution `node test/run.mjs unit
--filter=<plan>`, which is what `--changed` runs after planning):

| Scenario | Plan | Wall | Logs |
| --- | --- | --- | --- |
| Docs only | `legacy-names-audit`, `docs-links`, `versioning`; plan 0.05 s | 1.53 s (3 PASS) | `plan-docs.*`, `run-docs.*` |
| Test only | `display-path`, `no-system-preferences`, `legacy-names-audit`, `lint` | 0.78 s (4 PASS) | `plan-test.*`, `run-test.*` |
| UI, cold Swift cache | `native-settings-layout`, `no-system-preferences`, `native-slider-ticks`, `sidebar-evidence`, `sidebar-icon`, `legacy-names-audit`, `retirement-census` | 48.09 s (7 PASS) | `plan-ui.*`, `run-ui.*` |
| UI, warm cache (same command again) | same | 8.46 s (7 PASS) | `run-ui-warm.*` |
| Broad fallbacks | product TS, helper, unaudited fixture, other Swift, this change itself: FULL with the forcing paths; bad ref: exit 2 | — | `plan-fallback.txt` |

When this evidence was taken, `--path` did not check its input. Every path used above
was an existing tracked file, so these plans stand. Since the review repair,
`select.mjs --path` exits 2 for a path that is not an existing tracked or untracked
file. A typo or a deleted file used to get a confident, wrong plan.

There is **no matched full-suite speedup claim**: running the whole unit tier before
and after was outside this worker's budget. Historical context, labelled as such: the
baseline CI unit job took 647.9 s wall for 258 results; there, `typecheck-native` took
52.4 s and `typecheck` 60.9 s side by side. The same three docs tests took 1.8 s, the
four test-only tests 3.8 s and the seven UI tests 27.6 s. The app build job ran about
4 min 53 s. A PR selection avoids most of the unit tier and, for docs and test-only
plans, the app build. The size of that saving on GitHub is unmeasured until a hosted
run.

The final focused run (`final-focused.*`, 17 PASS, typecheck-native NOT RUN with its
reason) covered the selection, runner, lock, every docs reader and the UI consumers.

## Coverage preserved per change

| Change | What no longer runs | Why nothing unique is lost |
| --- | --- | --- |
| `typecheck-native` out of `--typecheck` | a second `tsc` over the same 1083 files with the same options | Same program as `typecheck:node`; `test-selection` asserts `tsc --showConfig` equality and that any divergence restores it: lib, include, files, extends, scripts, comments, an unreadable file, a non-object `compilerOptions`, and every `composite` other than exactly `false` or absent (`true`, and since the review repair the invalid falsy `0`, `''`, `null`, `'false'` that tsc rejects) |
| Build lock | a second swiftc on identical inputs | Same cache key, so the same binary bytes; a failed or dead builder still lets the waiter compile and report its own error |
| PR docs plan | tests that cannot read a Markdown doc | Readers audited from every registered test and helper (literal doc paths, `git grep`, `ls-files`, tree walks); drift guard in `test-selection` |
| PR test-only plan | tests that do not import, spawn or name the edited script | Any other file under `test/`, `src/`, `scripts/`, `bin/`, `.github/` that names it forces a full run; scanners of `test/` always run |
| PR UI plan | unit tests that do not compile, name or scan `SidebarIcon` | Consumers: the fixture tests compiling it (`sidebar-icon`, `native-settings-layout`), `sidebar-evidence` (names the type), every registered test naming the type at plan time, scanners of `src/native` Swift; a helper, unregistered test or unclaimed fixture naming it forces a full run. Native behavior is not claimed: the plan names `--only=sidebar,settings` as owed and the app build still runs |
| Main push | nothing | Full tier, full typecheck, app build, as before |

Fixtures were not consolidated. The Swift wrappers that look alike compile different
sources or measure different layouts. For example, `settings-layout` and
`sidebar-icon` both compile `SidebarIcon.swift`, but one checks the shared settings
row geometry and the other the folder frame across symbol scales. Shared service
fixtures already compile once per key; the lock removes the remaining duplicate.
Security, keychain, provider, ledger, owner, Swift preview and data-integrity tests
are unchanged and still run in every full run.

## Selector safety tests

`test/test-selection.mjs` (1.8 s) covers: docs, CHANGELOG and backend-doc readers;
added, deleted and renamed docs and paths with spaces; test-only selection;
referenced, unregistered, new, deleted, renamed and native/live test scripts; shared
helpers; unaudited and audited fixtures, including additions; the UI mapping and a
helper naming the UI type; other Swift and TypeScript sources; every selector file and
`.github/` (also mixed with docs); `package.json`; empty, broad and odd-status diffs;
`git diff -z` parsing; and real Git (staged rename, unstaged edit, deletion, untracked
file with spaces, bad and option-like refs, unrelated history, clean tree). It also
runs the runner CLI on a temp repository: listing, execution of exactly the plan with
`plan.json`, refusals with exit 2, `--github-output`, and the selector-change fallback.
It checks the typecheck plan, the audited names against tiers and smoke groups, and
the tree-walk and doc-read drift guards. A mutation that dropped the `.github/`
fallback failed it. `test/swift-build-lock.mjs` (≈3.6 s) failed against a helper
without the lock.

Added in the review repair:
- The invalid falsy `composite` values and non-object `compilerOptions` must run both
  typechecks. Restoring the old "drop any falsy `composite`" rule fails the test.
- `--path` refuses a typo'd or missing file with exit 2.
- Audited-fixture users are found by the folder's bare name, so
  `join(TEST_DIR, 'fixtures', 'sidebar-icon')` counts. A registered unit test that
  names the folder that way joins the plan; a helper or an unregistered script forces
  the full run. A mutation that ignored helpers fails the test.

## CI audit (local only)

`ci.yml` was parsed (Bun YAML) and its conditions evaluated by hand. A push leaves
`steps.plan` unset, so it builds. A PR plan with `app_build=false` skips Toolchain,
Install, Build and Check. Any other PR plan builds, and a selection error fails the
job. The test job passes the base SHA through `env`, never inlined into the script,
and fetches full history for the merge base. `dependency-audit` and
`check-version` are unchanged. **No GitHub run was made**; the YAML's behavior on
hosted runners is unverified until the first PR after publication.

## Manager validation after the first pass

These results were recorded by the manager on implementation head `a0502c2d`, outside
the worker sandbox. They are in the run's artifacts directory, not in this repository:
`manager-validation.json`, `manager-real-git-e2e.json` and the `manager-*.log` files.

- `bun test/settings-skills.mjs`: exit 0 on the host, which allows loopback binding.
- Real Git `--changed` on a verification worktree, one commit per scenario:
  - **docs** (`README.md`): executed 2 PASS (`legacy-names-audit`, `docs-links`),
    251 ms.
  - **test** (`test/display-path.mjs`): executed 4 PASS (`display-path`,
    `no-system-preferences`, `legacy-names-audit`, `lint`), 2.8 s.
  - **UI** (`src/native/SidebarIcon.swift`): listing only. It listed the same 7 tests
    as the worker's plan, required the app build, owed `--only=sidebar,settings` and
    ran no typecheck.
- No full unit or native suite was run.

These results came before the review repair. The repair changes the typecheck
equivalence, `--path` validation and fixture-user detection; none of those changes
the plans of these scenarios. The rechecked plans give the same counts.

## Limits

- No full unit tier, native desktop suite, live provider run or GitHub CI run.
  `SidebarIcon.swift` was not edited, so no native evidence is due for this change; a
  real UI PR still owes `--only=sidebar,settings` on a Mac.
- Worker limitation, kept for the record: `settings-skills` failed in the worker
  sandbox with `EADDRINUSE` on `listen(0, '127.0.0.1')`, because the sandbox forbids
  local port binding. The manager has since passed it on the host (above).
- Worker limitation, kept for the record: a scratch clone with a committed docs-only
  change was refused, so the worker showed end-to-end `--changed` execution only with
  stub tests in `test-selection`'s temp repository; its real-tree scenarios used
  `select.mjs --path` plus `--filter`. The manager has since run real-Git `--changed`
  executions for docs and test changes, and a UI listing (above). No real-Git `--changed`
  run has executed the UI plan's Swift tests; they were run through `--filter`.
- The swiftc run counts are estimates from per-child CPU; see the correction under
  [Measurements](#measurements).
- The selector guards against accidental narrowing, not a hostile PR: a PR's own
  workflow and selector run, and review of `.github/` and the selector remains the
  control. Main always runs everything.
- The drift guards are textual. A test that reads docs or walks the tree through a
  computed path with none of the matched patterns would be missed. The audited lists
  hold the 2026-10-20 reading. Fixture users are matched by the folder's bare name,
  so a path built from smaller pieces (e.g. `'sidebar' + '-icon'`) would still be
  missed.
- `test/test-runner.mjs` always forces a full run, because `test/run.mjs` names
  `helpers/test-runner.mjs`. This is conservative and intended.
- Only one UI source is audited. Adding another means checking its readers first.

## Overlap with held work

- **LKM-294 (Queue) / LKM-295 (Skills)**: their new registrations go in
  `test/tiers.mjs`, no longer `test/run.mjs` (expect a conflict where they added names
  to `run.mjs`). Skills tests are listed in the drift guard's exemptions
  (`skills-registry*`, `skills-projection`, `skills-github*`); a new Skills test that
  walks folders or names docs must be classified there. The shared skills fixture
  benefits from the build lock. `docs/TESTING.md`, `AGENTS.md` and the agent guide
  have small edits here; `package.json` is untouched.
- **LKM-296 (toolbar)**: if it edits `SidebarIcon.swift` or makes a new test name
  `SidebarIcon`, the UI mapping's consumer check decides (an unlisted registered
  test is added; anything else falls back). Its acceptance evidence is its own.
- `.github/workflows/ci.yml`, `docs/PROGRESS.md` and `docs/TASKS.md` need union
  merges at integration. Nothing was integrated here.

## Adoption onto main 1632c67d (2026-10-22)

The reviewed commits `a0502c2d` + `96a8a8fd` (diff `ce213841..96a8a8fd`, 46 files,
byte-identical to the reviewed patch) were adopted onto main `1632c67d`, which had
gained LKM-294, the preview edit fix and LKM-300 since `ce213841`. 41 files applied
unchanged. The five that conflicted were merged by hand; everything above this
section is the original record, numbers included, and is not rewritten.

- **`test/run.mjs` / `test/tiers.mjs`.** Main's only runner change was registering
  `preview-edit-lifecycle`; it moved into `test/tiers.mjs` at the same position. The
  tier lists, timeouts and typechecks were checked equal to main's (`UNIT` gains only
  `test-selection` and `swift-build-lock`: 257 → 259; `NATIVE`, `LIVE`,
  `UNIT_TIMEOUT_MS`, `TYPECHECKS` unchanged). The unregistered `test/*.mjs` scripts
  are the same 16 as on main.
- **CI.** LKM-300's separate `Typecheck` step (both scripts, before the unit tier) is
  kept and runs on every event, so the "0 typecheck" PR rows under
  [Process counts](#process-counts) now mean "no `--typecheck` entry"; CI still
  typechecks. The `typecheckPlan` skip affects only local `--typecheck` runs. The
  reviewed `if`/`else` with two runner calls became one call,
  `node test/run.mjs unit --report --timeout-ms=120000 --log-tail=150 "$@"`, where `$@`
  is `--changed="$TREZI_TEST_BASE"` on a pull request and empty otherwise.
  `test/dependency-audit.mjs` keeps every LKM-300 assertion (step order, both
  typechecks, no `--typecheck|--filter|--serial|--jobs`, one runner call, 45 min) and
  now pins that exact command, the PR-only `TREZI_TEST_BASE` expression and that the
  only extra argument is `--changed`. The test job checks out full history; the app
  build's `Selection` step and its conditions are as reviewed.
- **`docs/TESTING.md`.** The reviewed sections were added; the GitHub CI text keeps
  LKM-300's explanation and adds the PR `--changed` and app-build selection notes.
- **`docs/PROGRESS.md` / `docs/TASKS.md`.** The reviewed entries were inserted at their
  date, plus an adoption entry.

Real current-source plans (throwaway clone with this tree committed as a temporary
base; probe edits appended and restored; `node test/run.mjs unit --changed=<base>
--list`; `adoption-1632c67d/real-git-plans.json`):

| Edit | Plan |
| --- | --- |
| `src/native/ComposerQueue.swift` (narrow native, unaudited) | FULL, 259 |
| `docs/TESTING.md` + `src/native/ComposerQueue.swift` | FULL, 259 |
| `src/shared/api.ts`, `src/service/BackendSupervisor.swift`, `package.json`, `test/helpers/swift-build.mjs`, `test/fixtures/composer-layout/main.swift`, an unknown top-level file, a deleted test, a clean tree | FULL, 259 each |
| `src/native/SidebarIcon.swift` (audited UI) | 7: `native-settings-layout`, `no-system-preferences`, `native-slider-ticks`, `sidebar-evidence`, `sidebar-icon`, `legacy-names-audit`, `retirement-census`; app build required; `--only=sidebar,settings` owed |
| `docs/TESTING.md` | 1: `legacy-names-audit` |
| new `docs/probe-dir/sub/note.md` (untracked directory) | 2: `legacy-names-audit`, `docs-links` |
| `test/preview-edit-lifecycle.mjs` (registered on main after the review) | 4: `preview-edit-lifecycle`, `no-system-preferences`, `legacy-names-audit`, `lint` |

The last plan was executed once with `--report` (`adoption-1632c67d/run-test-only.*`):
4 PASS, runner wall 2.1 s. For context only, not a speedup: the recorded full local
unit run in the LKM-294 closeout was 256 PASS in 359.7 s (`--jobs=3`, a different
tree and run), and the original CI baseline above was 647.9 s for 258 results.

Still owed before Done: the coordinator's candidate gates on the canonical tree
(full unit tier, native groups as required) and a GitHub CI run in which a pull
request exercises `--changed` and the app-build `Selection` step.

## Reconcile onto main e3567469 (2026-10-22)

The reviewed adoption commit `493de503` (base `1632c67d`, patch SHA256
`832a1ca6d0e3d4696c9bcf31b5faf3889adf2a87662cab010ea8ad33dfd1aa16`) was applied once to
main `e3567469`, which had gained LKM-295 (Skills copy in `settings-controller.ts`) and
LKM-296 (toolbar overflow fix, `smoke-toolbar-overflow.ts`). 49 of its 50 files applied
unchanged. Only `docs/PROGRESS.md` conflicted (both sides added entries at the top);
the three reviewed entries are inserted verbatim. Nothing above this section is
rewritten, and no code, test, CI or assertion was edited during the reconcile.

Inventory on this tree, checked against main's `test/run.mjs`:

| Item | Main `e3567469` | This tree |
| --- | --- | --- |
| `UNIT` | 257 | 259 (+`test-selection`, +`swift-build-lock`; same order, none removed) |
| `NATIVE` / `LIVE` | 5 / 2 | 5 / 2, equal |
| `UNIT_TIMEOUT_MS`, `TYPECHECKS` | — | deep-equal to main |
| Duplicate names across tiers; byte-identical unit scripts | 0; 0 | 0; 0 |
| Local `--typecheck`: entries / `tsc` program checks | 2 / 3 | 1 / 2 (`typecheckPlan`) |
| CI `Typecheck` step: `tsc` program checks | 3 | 3 (unchanged, see below) |
| CI unit tier, push to `main` | 257 | 259 (full) |
| CI unit tier, PR plans (`select.mjs --path`, this tree) | 257 | `README.md` 2, `docs/TESTING.md` 1, a test script 4, `SidebarIcon.swift` 7; `settings-controller.ts`, `ToolbarOverflowVerification.swift`, `smoke-toolbar-overflow.ts` FULL 259 |

Removed execution, and where each unique assertion still runs:

- the second `tsc` program check in local `--typecheck` runs: same program as
  `typecheck:node`, which still runs; `test-selection` restores it on any divergence.
- the second swiftc build of an identical fixture binary: same cache key, same
  bytes; `swift-build-lock` proves one build and waiting.
- per-PR unit tests and app builds that cannot read the change: each still runs on
  every push to `main` and on any unaudited change.

No test case was deleted. Remaining duplication found and **left in place**: CI's
LKM-300 `Typecheck` step still runs `bun run typecheck:native`, re-checking the
program `typecheck:node` checks in the same step. `test/dependency-audit.mjs` pins
both lines, and the adoption instructions keep the separate CI typechecks, so removing
it is a separate decision. No runtime was re-measured for this reconcile; the numbers
above this section are historical.
