# Native Swift previews: staged plan (toward Scraib)

How Trezi's native component previews (`docs/SWIFT-PREVIEWS.md`, LKM-271) grow from a
hand-listed demo into previews of a real multi-module macOS app such as Scraib. The
stages are Agent OS decision 9a00253c. Every stage lives on the `trezi-native-demo` line
of branches and is not merged to main without review. A status says what was built and
checked, not what was intended.

Status words: **done (demo)** means implemented and covered by tests on the demo
branch; **partial** means some of it exists and the rest is listed; **not started**
means no code yet.

| Stage | Scope | Status |
| --- | --- | --- |
| 1 | Discovery, opening, multi-module builds | done (demo), LKM-273 |
| 2 | Toolchain selection and `#Preview` (2A), compiler settings, SwiftPM dependencies, incremental builds | partial: 2A (LKM-274) and 2B (LKM-275) done (demo); mixed-language targets not started |
| 3 | Component selection, sample states, environment/dependency injection, resources | partial: selection, `#Preview` reuse, generated samples, mixed-repo choice done (demo), LKM-276; StoreKit and the remaining resources not started |
| 4 | Service-owned host lifecycle, driver packaging in the distributed app, OS-level input, glass/material render fidelity | not started |
| 5 | Agent diagnostics and source feedback | partial |
| 6 | Practical Scraib acceptance on disposable copies | done (demo) for the scope below, LKM-277: unchanged Scraib-xcode previews `FloatingLoaderView` in Trezi; Scraib-open renders through ScraibKit with the rest named |
| 7 | Full macOS app integration | not started |
| 8 | iOS simulator | not started |

## Stage 1: discovery, opening and multi-module builds (LKM-273): done (demo)

- Discovery of `.xcworkspace`, `.xcodeproj` and `Package.swift` up to two folders deep
  (`src/swift-preview/discovery.ts`), mirrored in the project detectors
  (`src/main/project-detect.ts`, `src/service/RuntimeDetect.swift`; parity cases in
  `test/runtime-owner.mjs`). A folder with only a native project opens as a Swift
  project and reports its structure. A repo with a `package.json` that the JS or Expo
  detection can launch keeps that launch and only gains a `native` report; making the
  native preview available there is Stage 3 (the choice) and Stage 4 (the second
  server), see below.
- The scheme and target graph (`src/swift-preview/graph.ts`, `pbxproj.ts`):
  `project.pbxproj` through `plutil` (works with the command-line tools alone; Xcode 16
  synchronized folders and exception sets included), `xcodebuild -list -json` for
  schemes (falls back to the shared scheme files when only the command-line tools are
  installed), `xcodebuild -showBuildSettings -json` for targets set by `.xcconfig`
  files, and `swift package describe --type json` for packages. Every tool call has a
  timeout and kills its process group; missing Xcode or tools give a sentence, not a
  stack.
- The build plan (`src/swift-preview/plan.ts`): dependencies first, each into its own
  module and dylib, the selected target last, `@main`/`main.swift` files left out.
  The host imports library modules publicly and the app module with
  `@testable import`. Blockers stop the build with a reason; warnings name what may not
  compile or render.
- Diagnostics carry the module (`Build failed in StudioKit: 1 error.`,
  `[StudioKit] StudioKit/StudioFormat.swift:6:…`). A failed module keeps the last good
  host; any edit, including a new file in a synchronized folder, rebuilds.
- A Trezi-side manifest per project in app data
  (`<userData>/swift-previews/<hash>/trezi-previews.json`) wins over the repo's
  `trezi-previews.json`, which stays supported. Stage 1 reads it; nothing writes it yet.
- The graph is served by the driver (`GET /graph`), read by the backend
  (`project:native`, which asks only Trezi's own driver, never a user's dev server) and
  shown in the page's Project panel.
- Coverage: `test/swift-preview-graph.mjs` (discovery, pbxproj, scripted `xcodebuild`
  including a hang and a CLT-only machine, SwiftPM describe, plan rules, mixed repos,
  `project:native`), `test/swift-preview-target.mjs` (the target-graph build of
  `test/fixtures/swift-multi-module`, a library error and recovery, the Trezi-side
  manifest, setup state, driver `/graph`) and the native smoke check `swift-graph`
  (`src/native/smoke-swift-graph.ts`). Evidence: `docs/evidence/lkm-273/`.
- Not done in Stage 1: no UI to choose a target or write the Trezi-side manifest, no
  native preview in a mixed repo that also launches as JS, and the graph was exercised
  against real `xcodebuild` output only through scripted fixtures (that run had only
  the command-line tools selected; Stage 2A selects a full Xcode when one is installed).

## Stage 2: toolchain and `#Preview`, compiler settings, SwiftPM dependencies, incremental builds: done except mixed-language targets

### 2A: toolchain selection and `#Preview` (LKM-274): done (demo)

`#Preview` is an external macro whose implementation, `PreviewsMacros`, ships only in
full Xcode (`libPreviewsMacros.dylib` in the macOS platform's compiler plugins). The
command-line tools do not have it; `swiftc` from a full Xcode expands an intact
`#Preview` with its normal flags. So the requirement is a full Xcode **selected for
Trezi's processes**, not source changes: files with `#Preview` compile unmodified.

- Discovery and selection (`src/swift-preview/toolchain.ts`): every
  `/Applications/Xcode*.app` (versioned names included), `xcode-select -p`, the
  command-line tools and `DEVELOPER_DIR`, each with its Xcode and Swift version, macOS
  SDK and whether `PreviewsMacros` is present. Order: an explicit setting (the
  manifest's `developerDir`, else the app's `TREZI_DEVELOPER_DIR`), then `DEVELOPER_DIR`
  from the environment, then the newest full Xcode whose probe passes, then
  `xcode-select -p`. The selection records its reason.
- The capability probe compiles a tiny intact `#Preview` with the selected toolchain
  and normal compiler flags; the result is cached by toolchain path, versions, SDK and
  the plugin file, so an Xcode update or a switch probes again. Results: supported,
  unsupported (no `PreviewsMacros`: install or select full Xcode), broken (a broken or
  incompatible plugin: reinstall or select another Xcode) and unavailable (the
  compiler's plugin server cannot start because Trezi runs inside another sandbox; not
  cached, and never worked around by disabling the compiler's sandbox).
- The selected `DEVELOPER_DIR` goes to every tool the driver spawns (`xcodebuild`,
  `swift package`, `xcrun swiftc`, the SDK lookup, the host build), never to the
  machine: `xcode-select` is only read. Module and graph caches are keyed by the
  selection.
- Reported through the driver (`/state`, `/graph`), the backend (`project:native`
  `toolchain`) and the page (a header chip and the Project panel's Toolchain section).
- Coverage: `test/swift-preview-toolchain.mjs` (scripted toolchains: CLT global with
  Xcode installed, CLT only, broken plugin, environment failure, precedence, cache
  invalidation, `DEVELOPER_DIR` reaching `xcodebuild`, then a real intact `#Preview`
  through the driver with `xcode-select -p` unchanged) and the native `swift-graph`
  check (the toolchain in the page and in `project:native`).
- Not done in 2A: no settings UI to pick a developer directory (the manifest field and
  `TREZI_DEVELOPER_DIR` only), and `#Preview` bodies compile but are not shown as
  previews (Stage 3).

### 2B: native build authority (LKM-275): done (demo)

Per item:

- **Resolved settings: done.** `src/swift-preview/build-settings.ts` runs
  `xcodebuild -showBuildSettings -json` for the scheme that builds the target (one
  named like it first), `-configuration Debug -destination platform=macOS`, with
  `-derivedDataPath` in Trezi's derived data and `-disableAutomaticPackageResolution
  -skipPackageUpdates`. Package targets use `swift package dump-package` (their
  `swiftSettings`, the tools version or `swiftLanguageModes`, the macOS platform).
  Without either (no scheme, xcodebuild fails), the project file's Debug settings are
  used, with `$(inherited)` resolved from the project level but xcconfig files ignored.
  The page and `project:native` name the source per module.
- **Mapping and allowlist: done.** `src/swift-preview/settings.ts` maps SWIFT_VERSION
  (`-swift-version`), SWIFT_ACTIVE_COMPILATION_CONDITIONS (`-D`),
  GCC_PREPROCESSOR_DEFINITIONS (`-Xcc -D`), SWIFT_STRICT_CONCURRENCY,
  SWIFT_DEFAULT_ACTOR_ISOLATION, SWIFT_UPCOMING_FEATURE_*, MACOSX_DEPLOYMENT_TARGET
  (`-target <arch>-apple-macosx<version>`), SDKROOT (`-sdk` when the folder exists) and
  framework, header and import search paths. OTHER_SWIFT_FLAGS pass only through an
  explicit allowlist (`-D`, upcoming/experimental features, `-default-isolation`, a few
  warning flags). Every other flag, and every setting Trezi does not apply (linker
  flags, bridging headers, whole-module or optimized builds, unresolved, relative,
  recursive or missing search paths), is recorded with its reason and shown as
  "Dropped …". `PRODUCT_MODULE_NAME` renames a module.
- **Dependencies: done for local packages, pinned remote packages and macOS framework
  slices.** `src/swift-preview/dependencies.ts` reads the project's package references
  and `Package.resolved` (versions 1–3). Local packages inside the project, remote
  packages at their pinned version or revision, and `.framework`/`.xcframework` macOS
  framework slices are built or linked. The packages are built by
  `src/swift-preview/package-build.ts` as one generated wrapper package (`swift build`
  in Trezi's derived data, SwiftPM's sandbox left on). Unsupported kinds are named with
  their reason in the plan, the page and the API: products no package provides,
  packages outside the project or without `Package.swift`, remote packages without a
  pin (Trezi never resolves or updates), library-only or missing binaries, frameworks
  without a macOS slice, targets in another project, CocoaPods and Carthage. Remote
  packages need the network on their first build.
- **App target vs importable module: done.** The app target's sources minus its entry
  point (`@main`, `main.swift`, `@NSApplicationMain`) compile with its resolved settings
  into a module named like the target, and the previews `@testable import` that module.
  The app executable itself is never imported and never built.
- **Resources: asset catalogs and `Bundle.module` done, others bounded.**
  `src/swift-preview/resources.ts` compiles each module's catalogs with the selected
  toolchain's `actool`, including generated asset symbols (`Color(.brand)`) when the
  target turns them on, and one combined `Assets.car` into the host app bundle's
  `Bundle.main`, with the global accent color. Each module's own `Assets.car` is also
  placed beside its dylib, the `Bundle(for:)` the generated symbols resolve. Plain files (fonts, JSON) are copied.
  Package resources come from SwiftPM's own bundles (`Bundle.module`). Not compiled,
  and named as not bundled: String Catalogs (and their symbols), storyboards and XIBs,
  Core Data models, Metal, `.icon` and StoreKit files. A self-compiled package target
  (a package opened as the project) gets no `Bundle.module`.
- **Caching: done.** Everything lives under `<userData>/swift-previews/DerivedData/
  <project hash>`: xcodebuild's derived data per toolchain, the package build keyed by
  toolchain, wrapper manifest, pins and local package files, the catalogs keyed by
  toolchain, deployment target and catalog files, and each module keyed by toolchain,
  SDK, resolved flags, package key, its dependencies' keys and its sources. xcodebuild
  writes nothing to `~/Library/Developer/Xcode/DerivedData`.
- **The project is only read: shadows, not cleanup.** `xcodebuild -list`/
  `-showBuildSettings` create `project.xcworkspace/xcshareddata/swiftpm/configuration`
  in the `.xcodeproj`, and `swift package describe`/`dump-package`/`swift build` create
  `.swiftpm/configuration`, `.swiftpm/xcode` (and may write `Package.resolved`) in a
  package folder. Creating and removing them is still a write, so no such tool runs on
  the project (`src/swift-preview/shadow.ts`). xcodebuild and the package reads run in a
  Trezi-owned shadow under `<derived data>/shadow/` (project folders symlinked, the
  `.xcodeproj`/`.xcworkspace` bundles and each package's `Package.swift` and
  `Package.resolved` copied, `.git`/`.build`/`.swiftpm` not mirrored, the layout of local
  packages outside the project kept) that is removed when the run ends, and the paths in
  their output are mapped back to the project's. `swift build` runs on the generated
  wrapper whose local packages are Trezi's mirror of them (`packages/toolchain-<key>/
  locals/`, `Sources` and `Resources` symlinked). If a shadow cannot be made the tool
  does not run (an error, never the project as fallback). The tests compare the whole
  project tree, empty folders and mtimes included, before and after
  (`test/swift-preview-shadow.mjs`, `-settings.mjs`, `-build.mjs`, the native
  `swift-build` check).
- **Limitations of the shadow:** a package outside the 5-level, 4000-folder scan of the
  project and not referenced by a manifest or the project file is not in the shadow, so
  a tool cannot see it; hidden folders are not scanned for packages; a crashed run can
  leave a shadow until the next run sweeps shadows older than 6 hours (in Trezi's
  derived data, never in the project); each tool run copies the `.xcodeproj` and links
  the project's top-level entries, which is cheap but not free on a very large project.
- **Sandboxing: nothing new turns a sandbox off.** `swift build`, `dump-package`,
  `xcodebuild` and `actool` run with their default sandboxing. Where Trezi itself runs
  inside another sandbox they fail with a reason that says so. The pre-existing
  `swift package describe` fallback (LKM-274's disclosure) is unchanged and not reused.
  `test/swift-preview-settings.mjs` asserts this for every command and source file.
- Coverage: `test/swift-preview-settings.mjs` (scripted tools: settings mapping, the
  allowlist and dropped flags, package settings, pins, every dependency kind and
  message, the wrapper, cache keys, `-showBuildSettings`, the package build, actool and
  the whole build authority on `test/fixtures/swift-package-app`, with the project's tree
  compared before and after); `test/swift-preview-shadow.mjs` (the shadow itself);
  `test/swift-preview-build.mjs` (the real toolchain: the fixture builds and renders,
  then a disposable Scraib-xcode copy whose settings match an independent xcodebuild
  run; fixture and copy trees, empty folders and mtimes included, are identical before
  and after, and the original is byte-compared); and the native `swift-build` check
  (`src/native/smoke-swift-build.ts`).
- Not done in 2B: Clang, Objective-C and mixed-language targets; static library
  `.xcframework` slices; xcconfig files without xcodebuild; run-script phases and other
  generated sources besides asset symbols; xcconfig or project edits are picked up on
  the next graph read, Package.resolved changes on a rebuild.

### The rest of Stage 2: not started

- Clang, Objective-C and mixed-language targets.

## Stage 3: component selection, sample states, environment injection, resources: partial

LKM-276 is the flow open → target → `#Preview` or component → render, with no manifest
and no edit to the project. User-facing description: `docs/SWIFT-PREVIEWS.md`
([Generated previews](SWIFT-PREVIEWS.md#generated-previews-lkm-276)).

- Target choice: done (demo). Without a manifest, the macOS Swift targets that nothing
  else in their project depends on are the choices (`src/swift-preview/targets.ts`).
  One choice is used without asking; several show "Choose what to preview" on the page
  and in `project:native`; the choice (`POST /configure`) is saved in Trezi's data
  (`selection.json`), and a saved target that disappeared asks again.
- `#Preview` discovery and translation: done (demo). `src/swift-preview/PreviewScanner.swift`
  (compiled against the selected Xcode's own SwiftSyntax by `scanner.ts`, cached in
  Trezi's derived data) reports each file's `#Preview` blocks with their lexical
  context, `#if` conditions, `@available` attributes, traits, `@Previewable`
  declarations and the identifiers they use, plus every type's access level,
  inheritance, initializers and environment properties (`scanner.ts`). `catalog.ts`
  turns them into entries; `generate.ts` writes one factory per entry with the body
  copied verbatim under `#sourceLocation`, `@Previewable` declarations as the stored
  properties of a wrapper view, layout traits as the frame size, availability and
  `#if` conditions kept.
- Private same-file declarations: done (demo). An entry that uses a `private` or
  `fileprivate` declaration of its file is built from an overlay: the original text
  under `#sourceLocation` plus the factories, compiled in place of the original in
  Trezi's folder. `#sourceLocation` makes diagnostics name the original file and line
  (unit-tested with a real compile error in an overlaid file); errors in generated
  code are mapped to their entry (`failedEntries` in `generate.ts`). The original is
  never rewritten.
- Unsupported cases with reasons: done (demo). Listed in the catalog (`/state`,
  `/graph`, `project:native`) and on the page: preview modifier traits, unknown traits,
  previews inside a type, previews in the `@main` file, `@Previewable` after other
  statements, unavailable on macOS, generic components, private nested types, view
  controllers loaded from a nib or storyboard, parameters or environment values Trezi
  cannot make, and entries the compiler ruled out (the build retries without them, at
  most twice, and names the compiler's reason, e.g. compiled out by `#if os(iOS)`).
- Component picker: done (demo). SwiftUI `View`s, AppKit `NSView` and
  `NSViewController` subclasses (with `loadView`) and `PreviewProvider`s of the target
  and its modules, grouped apart from the `#Preview` blocks, each with an inferred
  sample (`samples.ts`: names for strings, small numbers, constant bindings, first enum
  cases, simplest initializers two levels deep) shown as a tooltip.
- Environment injection: partial. A component's `@Environment(Type.self)` and
  `@EnvironmentObject` properties get a sample of their type (an initializer Trezi can
  call) through `.environment(_:)` / `.environmentObject(_:)`; a `#Preview` body keeps
  its own modifiers. StoreKit configuration files and `StoreKitTest` are not started.
- Generated declarations in Trezi's data: done (demo). `sidecar.ts` is the only writer:
  `<userData>/swift-previews/<hash>/generated` (the build cache folder when the driver
  runs without one); it refuses a folder inside the project, paths that leave its folder and
  symlinks, and writes only changed files. The in-repo and Trezi-side manifests still
  win when present.
- Mixed JS + native repos: done (demo) for the choice. Detection is unchanged (TS/Swift
  parity); `src/shared/preview-choice.ts` adds a `previewChoice` on top. A web JS app
  with native roots keeps its JS launch until the user picks "Switch JS / Native
  Preview" (toolbar "…" menu); the choice is stored in the project's launch spec by the
  workspace owner. React Native and Expo keep the simulator and say why. Running both
  at once (a second server) is Stage 4.
- Resources: asset catalogs (`actool`), package `Bundle.module`, a host `Bundle.main`
  and copied plain files are done in 2B (LKM-275). Still open: String Catalogs,
  storyboards and XIBs, Core Data models, Metal libraries and the `Info.plist` values
  the code reads.
- Not done in Stage 3: `PreviewModifier` traits (their async shared context), previews
  nested in types, generic components, nib-loaded controllers, StoreKit; samples are
  heuristics from types, not real data; generated previews need a full Xcode with
  SwiftSyntax (the scanner is built from it).

## Stage 4: host lifecycle, packaging, OS-level input, render fidelity: not started

- A service-owned host lifecycle: the XPC service supervises the driver and host
  (start, stop, crash recovery), and runs the native preview beside a JS dev server for
  a mixed repo.
- Driver packaging in the distributed app: today the driver runs from Trezi's checkout
  on the bundled Bun.
- OS-level input instead of posted `NSEvent`s.
- Glass and material render fidelity: offscreen windows do not paint Liquid Glass or
  materials, and animations are captured once a second.

## Stage 5: agent diagnostics and source feedback: partial

- Exists (LKM-271, LKM-273): the landing check hands a compile error to the chat's next
  prompt, and diagnostics carry module and file.
- Open: structured diagnostics for the agent, mapping a rendered component back to its
  source file and line, and warnings (not only errors) in the feedback.

## Stage 6: practical Scraib acceptance on disposable copies: done (demo), LKM-277

Previews of real Scraib components built on disposable copies, with evidence. Earlier
progress is below. Nothing here means "Scraib supported" or "any macOS app works".

LKM-277 adds two native smoke checks, both in group `core`:
`src/native/smoke-scraib-xcode.ts` and `src/native/smoke-scraib-open.ts`. Each runs only
when its original is on the machine, and otherwise writes `ran: false`. The launcher
watchdog gets extra time for them (`src/native/scraib-originals.ts`). Evidence and an
inspected description of each capture: `docs/evidence/scraib-acceptance/README.md`.

- Scraib-xcode (`580051800e`), unchanged, with no manifest or harness:
  - Opening the copy picks `scraib` and builds the whole target with Xcode 26.5 selected
    process-locally. That gives all seven `#Preview` blocks plus 26 components.
  - `FloatingLoaderManager`'s `#Preview` renders `FloatingLoaderView`.
  - `ShortcutRecorderView` responds to clicks.
  - Three chat-landed turns (fixture provider, no synthetic writes) cover an edit that
    rebuilds, a compile error that keeps the last good build with the landing-check row,
    and the fix with the diagnostic in its prompt.
- Scraib-open (`dfc42b1e02`): Sparkle and posthog-ios at their pins and the local
  ScraibKit package build. `LiquidGlassPanelBackground` from a file that imports
  ScraibKit renders. The 12 views not shown each carry a reason:
  - they need ScraibKit types (`RewriteCoordinator`, `LicenseValidator`,
    `RewriteProgress` from the environment);
  - they take `ButtonStyleConfiguration` or `any Theme`;
  - or they are generic.
- The originals' content and stat digests are identical before and after.
  `xcode-select -p` stays `/Library/Developer/CommandLineTools`.
- Fixed on the way: generated memberwise initializers now follow swiftc for an
  optional `var` (nil default) and for private wrapped properties (no parameter).
  `ShortcutRecorderView`'s `@State private var monitor: Any?` broke the first run.
- Limits: unbundled resources (app icon, StoreKit configuration). Samples only for types
  from the target's own sources. No full-app windows, menu-bar panel or cursor tracking
  (Stage 7). No StoreKit. Offscreen glass and material fidelity (Stage 4). Samples are
  heuristics: `FloatingLoaderView` shows its `.error` state, and
  `LiquidGlassPanelBackground` draws at a 20×44 pt intrinsic size.

## Stage 7: full macOS app integration: not started

Build the scheme with `xcodebuild` into Trezi's DerivedData, launch the app as a child
and stream its window (ScreenCaptureKit needs a Screen Recording grant; input needs
Accessibility; signing and entitlements are project-specific).

## Stage 8: iOS simulator: not started

Simulator destinations (`-sdk iphonesimulator`, `simctl install/launch`) on the
existing simulator preview path; UIKit and SwiftUI on iOS. Stage 1 marks non-macOS
targets as blockers.

## Out of scope for Stage 1 (LKM-273)

Each of these is reported (as a blocker or warning) where Stage 1 can see it, and is
picked up by the stage named:

| Item | Stage |
| --- | --- |
| Binary or remote SwiftPM dependencies (Sparkle, PostHog) | 2B (pinned remote packages and macOS framework slices: done, LKM-275) |
| StoreKit | 3 (environment and dependency injection) |
| Resources and asset catalogs | 2B (catalogs and `Bundle.module`: done, LKM-275), 3 (the rest) |
| `#Preview` | 2A (compiling the files intact with a selected full Xcode: done, LKM-274), 3 (as previews from generated declarations: done, LKM-276) |
| OS-level input | 4 |
| Render fidelity | 4 |
| Driver packaging | 4 |
| Native preview in a mixed repo with a JS dev script | 3 (the choice: done, LKM-276), 4 (the second server) |
| Full app launch | 7 |
| iOS | 8 |

## Scraib: Stage 6 progress, not support

Checked only on disposable copies (Scraib's repositories are read-only):
`docs/evidence/lkm-273/scraib-xcode-discovery.json` (from
`scripts/swift-preview-discover.ts` and
`docs/evidence/lkm-273/scraib-validation/check-target.mjs`).

- scraib-xcode: one `scraib.xcodeproj` with the shared scheme `scraib` (read from the
  scheme file; `xcodebuild` needs Xcode). Targets: `scraib` (app, 41 Swift files, no
  target dependencies, no packages), `scraibTests` and `scraibUITests` (test targets,
  depend on `scraib`). The plan for `scraib` is one module of 40 files with
  `scraib/scraibApp.swift` (`@main`) left out, no blockers, and two warnings: seven files
  use `#Preview`, and `AppIcon.icon`, `Monthly.storekit` and `Assets.xcassets` are not
  bundled.
- With the command-line tools selected (LKM-273), the target-graph build of `scraib`
  **failed** with exactly those seven `#Preview` errors (`plugin for module
  'PreviewsMacros' not found`), attributed to module `scraib`. Leaving the seven files
  out does not help: `ClipboardRewriter.swift` then misses `FloatingLoaderManager`,
  which one of them defines. The cause was the toolchain, not the files: a manager-run
  diagnosis on a disposable copy (2026-10-17, outside the test suite) with Xcode 26.5
  as the process's developer directory built the whole `scraib` target, all seven
  files intact, into a preview host. Stage 2A now selects that Xcode automatically;
  a Scraib build through it is still to be recorded as Stage 6 evidence. StoreKit
  (`Monthly.storekit`, `StoreKitManager`) and the resources (Stage 3) come next.
- With 2B (LKM-275), `test/swift-preview-build.mjs` builds a disposable copy of
  scraib-xcode with the settings from `xcodebuild -showBuildSettings` (scheme `scraib`)
  and checks them against an independent xcodebuild run: SWIFT_VERSION 5, DEBUG,
  macOS 14. `Assets.xcassets` is now compiled by actool; `AppIcon.icon` and
  `Monthly.storekit` are still named as not bundled. The original is byte-compared after
  the run. Where the test process cannot run the real tools (another sandbox around it),
  the check says ENVIRONMENT instead of passing.
- scraib-open (XcodeGen, local `ScraibKit` package, Sparkle and PostHog) was covered by
  LKM-271's `libraries` check. 2B can build its local package and pinned remote
  packages (the first build needs the network); it has not been checked against
  scraib-open yet.
