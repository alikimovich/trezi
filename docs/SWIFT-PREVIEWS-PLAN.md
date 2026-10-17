# Native Swift previews: staged plan (toward Scraib)

How Trezi's native component previews (`docs/SWIFT-PREVIEWS.md`, LKM-271) grow from a
hand-listed demo into previews of a real multi-module macOS app such as Scraib. Every
stage lives on the `trezi-native-demo` line of branches and is not merged to main
without review. A status says what was built and checked, not what was intended.

Status words: **done (demo)** means implemented and covered by tests on the demo
branch; **partial** means some of it is done and the rest is listed; **not started**
means no code yet.

## Stage 1: project discovery and target-graph builds (LKM-273): done (demo)

- Discovery of `.xcworkspace`, `.xcodeproj` and `Package.swift` up to two folders deep
  (`src/swift-preview/discovery.ts`), mirrored in the project detectors
  (`src/main/project-detect.ts`, `src/service/RuntimeDetect.swift`; parity cases in
  `test/runtime-owner.mjs`). A folder with only a native project opens as a Swift
  project and reports its structure; a repo with a `package.json` that the JS or Expo
  detection can launch keeps that launch and only gains a `native` report.
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
  (`project:native`) and shown in the page's Project panel.
- Coverage: `test/swift-preview-graph.mjs` (discovery, pbxproj, scripted `xcodebuild`
  including a hang and a CLT-only machine, SwiftPM describe, plan rules, mixed repos),
  `test/swift-preview-target.mjs` (the target-graph build of
  `test/fixtures/swift-multi-module`, a library error and recovery, the Trezi-side
  manifest, setup state, driver `/graph`) and the native smoke check `swift-graph`
  (`src/native/smoke-swift-graph.ts`). Evidence: `docs/evidence/lkm-273/`.
- Not done in Stage 1: no UI to choose a target or write the Trezi-side manifest; no
  switch to Swift previews in a mixed repo that also launches as JS; schemes are not
  used to pick the build (the manifest names a target); the graph was exercised against
  real `xcodebuild` output only through scripted fixtures, because this machine has only
  the command-line tools.

## Stage 2: compile what real projects contain: not started

- Files that use `#Preview` must compile: strip or stub the macro in a shadow copy
  (bare `swiftc` has no `PreviewsMacros` plugin). This is the first Scraib blocker.
- Local Swift package products (`XCLocalSwiftPackageReference`, path dependencies):
  build their library targets as modules in the same plan.
- Clang and Objective-C targets, module maps, mixed-language targets.

## Stage 3: resources: not started

Asset catalogs (`actool`), resource bundles and `Bundle.module`, `Bundle.main`
redirection for the host, fonts, Metal libraries, `Info.plist` values the code reads.

## Stage 4: remote and binary package dependencies: not started

`swift package resolve` into Trezi's cache (network, authentication), binary targets
and `.xcframework`s (Sparkle, PostHog in scraib-open), `Package.resolved` pinning.

## Stage 5: app environment and preview authoring: not started

Environment objects and sample data a view needs (Scraib's `WelcomeView` needs
`StoreKitManager`), StoreKit configuration files and `StoreKitTest`, reuse of
`#Preview` bodies as Trezi previews, and a UI that writes the Trezi-side manifest.

## Stage 6: fidelity, input and packaging: not started

On-screen rendering (Liquid Glass and materials do not paint offscreen), continuous
frames, OS-level input instead of posted `NSEvent`s, incremental builds, and packaging
the driver and host inside `Trezi.app` instead of running from the checkout.

## Stage 7: full app launch: not started

Build the scheme with `xcodebuild` into Trezi's DerivedData, launch the app as a child
and stream its window (ScreenCaptureKit needs a Screen Recording grant; input needs
Accessibility; signing and entitlements are project-specific).

## Stage 8: iOS: not started

Simulator destinations (`-sdk iphonesimulator`, `simctl install/launch`) on the
existing simulator preview path; UIKit and SwiftUI on iOS. Stage 1 marks non-macOS
targets as blockers.

## Out of scope for Stage 1 (LKM-273)

Each of these is reported (as a blocker or warning) where Stage 1 can see it, and is
picked up by the stage named:

| Item | Stage |
| --- | --- |
| Binary or remote SwiftPM dependencies (Sparkle, PostHog) | 4 |
| StoreKit | 5 |
| Resources and asset catalogs | 3 |
| Reuse of `#Preview` | 5 (compiling files that contain it: 2) |
| OS-level input | 6 |
| Render fidelity | 6 |
| Driver packaging | 6 |
| Full app launch | 7 |
| iOS | 8 |

## Scraib: progress, not support

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
- The target-graph build of `scraib` **fails** with exactly those seven `#Preview`
  errors (`plugin for module 'PreviewsMacros' not found`), attributed to module
  `scraib`. Leaving the seven files out does not help: `ClipboardRewriter.swift` then
  misses `FloatingLoaderManager`, which one of them defines. Stage 2's `#Preview`
  handling is the next blocker; StoreKit (`Monthly.storekit`, `StoreKitManager`) and
  the resources come after it.
- scraib-open (XcodeGen, local `ScraibKit` package, Sparkle and PostHog) was covered by
  LKM-271's `libraries` check and needs Stages 2 and 4 for a target build.
