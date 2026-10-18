# Scraib acceptance on disposable copies (Stage 6, LKM-277)

Real Trezi window captures and the JSON that the native smoke checks `scraib-xcode`
(`src/native/smoke-scraib-xcode.ts`) and `scraib-open` (`src/native/smoke-scraib-open.ts`)
wrote. Both checks are in group `core` and share `src/native/smoke-scraib.ts`. The
files come from the passing Agent OS native verification of group `core` (38/38 checks)
on 2026-10-17. Each PNG was opened and inspected; what it shows is described below.
This is acceptance on two real apps, not a claim that every macOS app works.

## Provenance

| What | Value |
| --- | --- |
| Trezi | `Trezi 0.1.0 (build 1095, 2ac96f5)`: HEAD `2ac96f5d6771fa449def0767a8a5f5a03d997d4d` on `agent-os/lkm-277-22588d96` plus this ticket's uncommitted changes (`trezi.stamp.dirty: true`) |
| Scraib-xcode | `/Users/panda/dev/scraib-xcode` at `580051800eb3ec014b8a9e40a200aa5718e75398` (the original's `git status` shows one untracked file, `DATABASE_MIGRATION_AUDIT.md`) |
| Scraib-open | commit `dfc42b1e0231e05b2f88bc4cd8cc88f88bdb6ef1` |
| DEVELOPER_DIR (process-local, chosen by Trezi) | `/Applications/Xcode-26.5.0.app/Contents/Developer` |
| Xcode / Swift / SDK | Xcode 26.5 (17F42), Swift 6.3.2, macOS SDK 26.5, `libPreviewsMacros.dylib` present |
| `xcode-select -p` | `/Library/Developer/CommandLineTools` before and after both checks |

The originals' digests are taken over every file (content SHA-256 and a stat digest with
sizes and mtimes) before the copy and again after the check, in `finally`:

| Original | Before | After |
| --- | --- | --- |
| Scraib-xcode, 487 files, 747 entries | content `9ac1c2e3…a2dcdc`, stat `e97d11da…bcb77e1` | identical (`original.unchanged: true`) |
| Scraib-open (build output compared by stat only) | content `fcff4629…aed7de` | identical (`original.unchanged: true`) |

The copies live under the native run's temporary directory. Only `.git` and `.claude`
are left out of the Scraib-xcode copy. The Scraib-open copy also leaves out its build
output (`build`, `.build`, `.swiftpm`, `DerivedData`). Each copy is checked to be
byte-identical to its source, then turned into a fresh Git repository so that Trezi can
open it.

## Scraib-xcode: unchanged sources, full `scraib` target

No source edits, no `trezi-previews.json` and no harness: the check opens the copy
through the workspace like a user would. Trezi picks `scraib` because it is the only
previewable target ("Previewing scraib (the only previewable target)"). Trezi resolves
its settings with `xcodebuild` (scheme `scraib`), compiles `Assets.xcassets` and builds
all 40 sources with `scraibApp.swift` (`@main`) left out. The first build took 24 s and
gave 33 previews: all seven `#Preview` blocks plus 26 generated components. One more,
`CustomInstructionsView`, is not shown because it needs `NavigationPath`.
`AppIcon.icon` and `Monthly.storekit` are named as not bundled.

| Capture | What it shows |
| --- | --- |
| `scraib-xcode-floating-loader.png` | `FloatingLoaderManager #Preview` selected and Ready: the loader capsule with a spinner and "Rewriting..." (frame 248×80) |
| `scraib-xcode-component.png` | the generated `FloatingLoaderView` component with the sample `FloatingLoaderView(state: .error, operationType: .rewriting)`: the red "Error, check Scraib" state |
| `scraib-xcode-catalog.png` | the picker with the seven `#Preview` blocks, the components and the "not shown" list |
| `scraib-xcode-interaction-idle.png`, `scraib-xcode-interaction.png` | `ShortcutRecorderView`: idle, then after a click on its button, recording ("Press sh…" in red). A second click stops recording and returns to the idle frame (same digest) |
| `scraib-xcode-edited.png` | chat turn 1 landed: the `#Preview` now says "Rewriting your selection..." (generation 2, frame 458×80) |
| `scraib-xcode-error.png` | chat turn 2 landed a call to the missing `widthForStates`. The page shows "Build failed in scraib: 1 error. Showing the last good build." with `FloatingLoaderManager.swift:491:23`. The generation 2 frame stays dimmed above it, and the chat shows the landing check's "1 new console error after landing" row |
| `scraib-xcode-recovered.png` | chat turn 3 ("Fix the build.") recovered: Ready, generation 3, with the edited text still shown |

**Chat-landed versus synthetic writes.** The edit, the error and the fix are three chat
turns through the real composer, the chat worktree `trezi/chat-183a9321` and the landing
commit on the live tree. Before each landing the live tree was checked to be clean
(`liveUntouchedBeforeLanding`). The fix turn's prompt carried the landing check's
diagnostic (`diagnosticInPrompt: true`). `provenance.syntheticDirectWrites` is empty.
Only the model is a fixture (`stubAgentSendForSmoke` applies a scripted edit; no
provider call). Clicks are DOM events on the preview page, not OS input.

## Scraib-open: app target through ScraibKit and remote packages

Trezi picked `Scraib` and built Sparkle 2.9.2 and posthog-ios 3.58.3 at their
`Package.resolved` pins, plus the local `ScraibKit`, into one wrapper package in its
derived data in 14 s. The app module took 9 s. There are no unsupported dependencies
and no plan blockers. The four components it can build are `ShortcutRecorderView`,
`EightBitScanlines`, `LiquidGlassPanelBackground` and `RamsDial`. The check picks every
built view whose file has `import ScraibKit` and captures the largest.

| Capture | What it shows |
| --- | --- |
| `scraib-open-component.png` | `LiquidGlassPanelBackground(cornerRadius: 0.5)` from `Scraib/Theme`, compiled against ScraibKit, Ready. It draws at its intrinsic size, only 20×44 pt, because it is a background with no content. The capture shows that a build through the dependency path rendered. It says little about how the view looks |
| `scraib-open-catalog.png` | the "12 not shown" list with each reason (below) |

These are not rendered, each for the reason Trezi gives:

- `MenuPanelView` needs a `RewriteCoordinator` and `SettingsView` needs a `LicenseValidator`.
  Both are ScraibKit types, and generated samples only construct types from the target's
  own sources.
- `EightBitLoaderView`, `LiquidGlassLoaderView`, `RamsLoaderView` and `SystemLoaderView`
  read `RewriteProgress` (a ScraibKit type) from the environment, so the same rule applies.
- `EightBitBlock`, `LiquidGlassButtonRow`, `RamsKey` and `SystemMenuRow` take a SwiftUI
  `ButtonStyleConfiguration`, which cannot be constructed.
- `ThemePreviewCard` takes `any Theme` (an existential), and Trezi does not choose a
  conforming type.
- `SettingsWindowChrome` is generic.

## Found and fixed during this ticket

The first native run failed on Scraib-xcode: the generated `ShortcutRecorderView` sample
passed `monitor:` for `@State private var monitor: Any?`. That property defaults to nil
and is private, so Swift's memberwise initializer leaves it out. Three entries failed
one after another and used up the two retries. `memberwise()` in
`src/swift-preview/samples.ts` now follows swiftc 6.3's rules (checked with probes):

- An optional `var` defaults to nil, whether plain or `@State`.
- A private wrapped property with a default is not a parameter.
- Any other private stored property makes the initializer private.

Unit cases are in `test/swift-preview-generate.mjs`. The run above is after the fix.

## Limits (honest)

- **Resources and dependencies.** App icons, StoreKit configuration, String Catalogs,
  storyboards, Core Data, Metal and run-script sources are not bundled. Samples can only
  be made for types from the target's own sources: no ScraibKit types, no
  `ButtonStyleConfiguration`, no existentials or generics. The Scraib-open package build
  needs the network the first time.
- **Full-app windows and cursor tracking.** These are component previews in Trezi's
  host, not Scraib's app with its `@main`, menu-bar item, panels, global hot keys or
  cursor-following loader. Launching the full app is Stage 7.
- **StoreKit.** `Monthly.storekit` is not used and `StoreKitManager` is not injected.
- **Offscreen glass and material fidelity.** The loader's `.thinMaterial` capsule and
  `LiquidGlassPanelBackground` render in offscreen windows, which do not paint Liquid
  Glass or materials the way a foreground window does (Stage 4).
- **Generated samples are heuristics.** `FloatingLoaderView` shows its `.error` state
  because that is the first case without associated values.
- **Worker sandbox.** Inside the agent worker's sandbox, the compiler's macro plugin
  server, actool, SwiftPM's own sandbox and port binding are unavailable. The sandboxed
  `xcodebuild` also reported no deployment target, so modules were built for 26.0. All
  real execution above is from Agent OS native verification. No sandbox-disabling flags
  were added.
- Not a claim of universal macOS app support: two apps, one machine, one Xcode.
