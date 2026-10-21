# LOCAL-TEST-AUDIT — 2026-10-20

Bounded local audit against e61c3ad9. No application code, fixture, tier membership,
toolbar regression or native smoke check changed. No publication or remote state changes.

## Inventory and removals

| Inventory | Before | After |
| --- | ---: | ---: |
| Registered unit entries (including lint) | 256 | 256 |
| Registered native / live entries | 5 / 2 | 5 / 2 |
| Top-level `test/*.mjs` files | 279 | 279 |
| `native-build-cache.mjs` assertion calls | 45 | 43 |
| Slider consumer source-shape checks | 2 | 1 |

Three assertions removed, no test files deleted:

- `test/native-slider-ticks.mjs`: removed the `EditingInspector.swift` must contain
  `SnappedSlider(` regex. `test/fixtures/slider-ticks/main.swift` instantiates the real
  `InspectorFieldView` with default and explicit steps, requires one NSSlider with
  zero ticks and verifies emitted snapped values after its action. The regex only
  constrained an internal constructor name and could pass for dead code.
- `test/native-build-cache.mjs`: removed the exact
  `Promise.allSettled([bundles, service, host, secrets])` spelling check. It enforced
  orchestration syntax, not concurrency or correctness. No behavioral concurrency
  guarantee is claimed by this removal; subprocess/lane barriers remain covered in
  `test/test-runner.mjs` and the Swift build helper.
- Same file: removed the ban on literal `'-O'` / `-enable-batch-mode` in the build
  script. Profile flags are asserted directly by `optimizationFlags`, and captured
  compiler arguments verify test `-Onone` and release `-O`. The Secrets release-profile
  wiring and launcher/package profile checks remain, since these are distinct wiring.

## Preserved coverage and consolidation decisions

| Area inspected | Coverage retained / reason to keep |
| --- | --- |
| Sliders | Global no-stepped-Slider scan; nonempty scan guard; ChatIsland wiring (fixture uses SnappedSlider directly there); stepped negative control; all snapping, clamping and real inspector action checks |
| Build cache | Source/flags/toolchain/product invalidation, worktree equivalence, pruning/partial writes, cache hits, executable copy, compiler failure, fallback and profile wiring |
| Settings / sheets | `native-settings`, `native-sheets`: controller persistence, stale actions, limits, save failure and dismissal are distinct from Swift layout |
| Settings evidence | `native-settings-evidence`: mutated reports test evidence rejection; not redundant with `native-settings-layout` real Swift fixture |
| Composer / chat | `native-composer-layout`, `native-chat-latest-settle`, `native-chat-reveal`, `native-chat-text`, `chat-ui`: geometry/negative control, reveal state, text selection and controller delivery are different behaviors |
| Sidebar | `sidebar-icon`, `sidebar-focus`, `sidebar-sizing`: drawing, cleanup/failure handling and sizing are distinct; no toolbar or sidebar frame assertions removed |
| Inspector / boundary | `native-inspector`, `native-layers`, `native-editor`, `native-context`, `native-boundary`: retain writes, stale generations, source ownership and dependency boundaries |

Existing Swift wrappers already share `test/helpers/swift-build.mjs`. Similar wrapper
shape is not duplicate fixture behavior; no fixture consolidation was justified in
this bounded pass. Security, keychain, provider, ledger and data-integrity suites were
left intact. This is not a claim that every assertion in the repository was audited.

## Selection and execution policy

Existing `--filter=name,name` remains exact and tier-bound. New `--list` uses the
same validation, prints tier/name pairs in registration order, then exits before
locks, artifacts or tests. It lists requested typechecks too; it does not predict
duration-based execution order. No tag taxonomy, inferred changed-file selection or
automatic weakening of acceptance was introduced.

`test/test-runner.mjs` now checks console-only native/live dispatch, one-test focused
execution, exact listing, no listing artifacts, typecheck listing and invalid/empty/
wrong-tier selections (exit 2). These are CLI behavior regressions, not source mirrors.
`docs/TESTING.md`, AGENTS and the verification guide distinguish relevant focused
evidence for unchanged app behavior from full native acceptance. Suite cleanup and
execution policy are separate: removing three assertions does not reduce tier scope.

## Validation evidence

- `bun run typecheck`: exit 0 (node and preview TypeScript checks).
- `bun run typecheck:native`: exit 0.
- `bun run lint`: exit 0; existing repository warnings/infos remain.
- `bun test/run.mjs unit --filter=test-runner,display-path,docs-links --log-tail=20`:
  3 PASS, 2.7 s wall; `test/artifacts/runs/run-2mA0PM/summary.json`.
- `bun test/run.mjs all --list`: exit 0, 263 registered entries, no tests executed.
- Intermediate docs checks failed on a path-like prose phrase and AGENTS' 8192-byte
  limit. Both corrected; failed evidence retained in `run-Ohnu59` and `run-xF4BqG`.
- Final `bun test/run.mjs unit --filter=test-runner,native-build-cache,docs-links --log-tail=20`:
  3 PASS, 2.6 s wall; `test/artifacts/runs/run-g1PoYf/summary.json`. Includes exact
  plan output, no-artifacts listing, focused success and invalid/empty selection checks.
- `bun test/native-slider-ticks.mjs`: exit 0; real windowless Swift fixture reports
  inspector and island sliders draw no ticks and snap correctly. No desktop suite run.
- Final typecheck and lint rerun: exit 0; lint reports 425 warnings / 120 infos,
  no errors. Native TypeScript check also passed separately.

Measured times above describe focused commands only. Full-tier runtime savings were
not measured or estimated. The removed regex work is tiny; no native execution or
compile was eliminated. Historical 66 native / 256 unit results are not validation
of this tree. Final focused results are recorded below.

## Overlap and limits

- LKM-296: no edits to `test/fixtures`, `src/native`, toolbar checks or manual
  sidebar resizing assertions. The active toolbar followup must retain its own
  acceptance evidence; no other worktree was accessed.
- LKM-294 Queue: likely overlap at `test/native-composer-layout.mjs`, its composer
  fixture / ComposerQueue, `test/chat-send-queue.mjs`, and `test/run.mjs` registration.
  These paths were identified from this checkout only. No Queue integration or edits.
- LKM-295 Skills: likely overlap at runner Skills membership, `test/settings-skills.mjs`,
  `test/skills-*`, `test/native-settings.mjs` and settings fixture expectations.
  Their preserved worktrees were not inspected. Merge registration additions around
  the new list branch; do not replace their lists or expectations.
- Shared append-only progress/task logs may need union resolution on later integration.
- No full unit, native GUI/smoke, provider, signing or keychain suite run. The manager
  owns the configured diff check and desktop validation. No staging or commits performed.
