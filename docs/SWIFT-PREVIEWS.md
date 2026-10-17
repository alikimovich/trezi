# Native Swift component previews (demo, LKM-271)

A vertical slice in which Trezi opens a native macOS Swift project and previews its
declared SwiftUI and AppKit components. The preview is interactive, rebuilds when the
source changes (including after a chat turn), and shows compiler errors without losing
the last good build. This is a demo on an isolated branch; it is not merged to main.

## Try it

1. Build Trezi as usual (`bun run build`) and open it.
2. Open the folder `test/fixtures/swift-components` (or a copy of it) as a project.
   Xcode or the command-line tools must provide `xcrun swiftc` for macOS.
3. The preview pane shows "Swift previews". The first build compiles the Clang module
   cache and can take 20–30 s; later builds of the fixture take about 1.5 s.
4. Pick Profile card (SwiftUI), Rating control (AppKit `NSView`) or Search panel
   (AppKit `NSViewController` hosting a SwiftUI badge) in the header.
5. Click and type into the frame. Clicks, drags, scroll and keys are forwarded to the
   component; Cmd-R/W/Q stay with Trezi.
6. Ask the chat to change a component, e.g. "rename the search panel title to Find
   components". The chat edits in its own worktree (`trezi/chat-<id>`); when the turn
   lands in the live tree the driver rebuilds and swaps in the new host.
7. A change that does not compile turns the status pill into "Build failed". The page
   lists each error as `file:line:column: message` and keeps the last good build on
   screen. The page also logs the first error with `console.error`. After a landing,
   the landing check (`src/native/landing-check.ts`) waits for a running Swift build
   to finish, reads the console error and puts it in front of the chat's next prompt,
   so the next turn can fix it. The next successful build recovers.

## Declaring previews

A project opts in with `trezi-previews.json` at its root (and no `package.json`):

```json
{
  "name": "Swift components demo",
  "sources": ["Sources/DemoComponents"],
  "previews": ["Previews"],
  "exclude": [],
  "libraries": []
}
```

- `sources` are the component files; `previews` are the declaration files, which are
  compiled only into the preview host. Both take folders or files and must stay inside
  the project. `exclude` removes paths (for example the app's `@main` file).
- `libraries` (optional) are separately built modules the sources `import`. Each has a
  `name` (the module name) and its `sources`. The driver builds each one first with
  `swiftc -emit-module -emit-library -module-name <name>` into a per-build folder, then
  compiles the host with `-I`, `-L`, `-l<name>` and an rpath to that folder. Editing a
  library source rebuilds the library and the host. Library sources must not be listed
  in `sources`. `test/fixtures/swift-library-app` is a minimal example (app module
  importing `GreetKit`). Library dependencies are not resolved: only system frameworks
  work, and a SwiftPM package that needs remote packages does not.
- Hidden folders, `.build`, `DerivedData`, `build`, `Pods`, `Carthage`, `node_modules`
  and `*.xcodeproj` are skipped. Symlinks are not followed.
- The declaration files define `enum TreziPreviews { @MainActor static var all: [TreziPreview] }`
  and build each sample with its own state and dependencies:
  - `.swiftUI(id, title, size:) { SomeView(...) }`
  - `.appKit(id, title, size:) { SomeNSView() }`
  - `.viewController(id, title, size:) { SomeViewController(...) }`

  For example, `test/fixtures/swift-components/Previews/TreziPreviews.swift`.

## How it works

- Detection: `src/main/project-detect.ts` and `src/service/RuntimeDetect.swift` (kept
  in parity by `test/runtime-owner.mjs`) report `framework: 'swift'` with an empty dev
  command when the manifest is present.
- Launch: the project never supplies a command. `src/main/devserver-service.ts` passes
  the runtime owner the bundled Bun and `src/swift-preview/driver.ts` from Trezi's own
  checkout (`src/main/swift-preview.ts`). The runtime owner's normal lifecycle applies:
  port, readiness, stop and crash handling.
- The driver (`src/swift-preview/driver.ts`, `session.ts`) is a small HTTP server on the
  preview port. It compiles `src/swift-preview/PreviewHost.swift` together with the
  manifest's files using `xcrun --sdk macosx swiftc -parse-as-library -Onone`, one
  module and no Xcode project. It also polls file size and mtime for changes, and
  swaps in a new host only once that host reports ready.
  - Libraries build into `libs-<pid>-<n>` next to the host binary and are removed with it.
  - Builds are cached per project under the temporary directory, and the Clang module
    cache is shared between projects.
  - A failed build keeps the old host and reports parsed diagnostics.
- The host (`PreviewHost.swift`) is an accessory app that never activates or shows a
  window on screen.
  - Each preview lives in its own offscreen borderless window. Frames are 2x PNGs from
    `cacheDisplay`.
  - Input arrives as JSON lines on stdin and is posted as real `NSEvent`s, routed by a
    per-window tag. Views that refuse the first mouse get their `mouseDown` delivered
    directly.
  - `describe` returns accessibility values and text field contents for tests.
- The page (`src/swift-preview/page.ts`) is what Trezi's WebKit preview shows. It has
  the picker, the frame, status, error list and input forwarding. Mutating requests
  need a per-run token embedded in the page, and the driver rejects foreign `Host`
  headers.

## Evidence

- `test/swift-preview.mjs` (unit tier) runs a real swiftc build and real AppKit hosts
  against a copy of the fixture. It checks:
  - rendering, plus SwiftUI and AppKit clicks and typing;
  - an edit that rebuilds;
  - a compile error (`SearchPanelController.swift:59`, last good build kept);
  - recovery;
  - the driver's token and Host checks;
  - a library module: manifest and compile-argument parsing, then a real build of
    `test/fixtures/swift-library-app` (app module importing a separately built
    `GreetKit`), its render, and a rebuild after a library edit.

  Captures go to `test/artifacts/swift-preview/`.
- The native smoke check `swift-preview` (group `core`, `src/native/smoke-swift-preview.ts`,
  with `src/native/smoke-swift-chat.ts`) runs the flow inside Trezi, and every project
  edit goes through the real chat pipeline: composer, `agent:send`, the chat's own
  worktree, the landing commit on the live checkout and a rebuild. Only the provider is
  a fixture (`stubAgentSendForSmoke`; it also skips the title, memory and commit-message
  provider calls), so no model runs. The suite switches the production post-landing check
  off, so the smoke starts the real `LandingChecks` itself from the same `merged`
  isolation event the production hook uses. Three turns are sent:
  1. "Search components" becomes "Find components": the smoke asserts the live tree stayed
     clean until landing, then holds the change; the driver rebuilt (`search-panel`
     generation 2) and `describe` shows the new text.
  2. A compile error (`index.serch`) lands the same way: the page fails and keeps the
     old host, and the landing check's `errors` row reaches the chat with the
     `SearchPanelController.swift:59` diagnostic.
  3. The fix turn: its prompt must carry that landing-check problem before the fixture
     provider applies the fix; generation 3 is `ready`.

  It writes `test/artifacts/native/swift-preview-*.png` and `swift-preview.json`, which
  records the chat-landed steps (branch, commit, files, trailer) under
  `provenance.chatLanded` and lists synthetic direct writes separately (none).
- The captures from the branch run are kept in `docs/evidence/lkm-271/`.

## Limits and follow-ups

- **`#Preview` reuse is not supported.** Xcode's `#Preview` macro expands into
  registry types that only Xcode's preview agent reads, and bare `swiftc` cannot even
  compile a file that uses it (no `PreviewsMacros` plugin; seen on Scraib). Such files
  must be left out of `sources`. Trezi asks for explicit
  `TreziPreviews` declarations instead. Follow-up: generate them from `#Preview`
  bodies, or load the expanded `DeveloperToolsSupport` registry.
- **Full macOS app launch is not done.** The host previews components, not an app
  with its `@main`, menus, entitlements or bundle resources (`Bundle.main` is the host).
  Path: `xcodebuild` the app scheme into DerivedData, launch it as a child, and stream
  its window with ScreenCaptureKit. That needs a Screen Recording grant (a TCC prompt),
  input injection (Accessibility) and project-specific signing.
- **iOS is not supported.** It would need an iOS simulator destination
  (`xcodebuild -sdk iphonesimulator`, `simctl install/launch`) and the existing
  simulator preview path. Previews would have to target UIKit/SwiftUI on iOS. The
  host here is macOS-only.
- **Multi-module projects:** the app side compiles into one module; separately built
  library modules are supported through `libraries` (see above) but not SwiftPM
  resolution, remote packages, resource bundles or Swift 6 / strict-concurrency
  settings from a package manifest (the driver uses the compiler default).
- **Scraib (read-only inspection and disposable-copy checks; not "supported").**
  Nothing in either Scraib repository was modified. The checks ran on copies under the
  temporary directory with the same driver (`docs/evidence/lkm-271/scraib-validation/`:
  `check.mjs` plus the two preview files).
  - `scraib-xcode` (the Mac App Store app): one Xcode target, no SwiftPM packages,
    only system frameworks (macOS 14 target, Swift 5), `@main` in
    `scraib/scraibApp.swift`, resources in `Assets.xcassets`, `Info.plist` and
    `scraib.entitlements`. Compiling the whole `scraib` folder with `@main` excluded
    **fails**: seven files carry `#Preview`, and bare `swiftc` has no `PreviewsMacros`
    plugin (`plugin for module 'PreviewsMacros' not found`). Listing only the files a
    component needs (`ShortcutRecorderView`, `ProviderAPIKeyField`, `AIProviderModels`,
    `GlobalHotKeyManager`) **builds and renders** both views (frames in
    `docs/evidence/lkm-271/scraib-xcode-*.png`). `WelcomeView` needs the
    `StoreKitManager` environment object, and the whole-folder attempt hit the same
    `#Preview` error, so it was not rendered.
  - `scraib-open` (XcodeGen `project.yml`, Swift 6, macOS 26): the app target is
    `Scraib/`; the local SwiftPM package `ScraibKit` (library at
    `ScraibKit/Sources/ScraibKit`, 29 files, system frameworks only) is imported by the
    themes, settings and `FloatingLoader`. Remote packages Sparkle (`UpdaterController`)
    and PostHog (`Analytics/PostHogBackend`) need network resolution and are not
    reachable from the driver, so those files must stay out of `sources`.
    The manifest `{"sources": ["Scraib/Theme"], "libraries": [{"name": "ScraibKit",
    "sources": ["ScraibKit/Sources/ScraibKit"]}]}` with a one-view preview file builds
    ScraibKit as a library and **renders** `ThemePreviewCard`
    (`docs/evidence/lkm-271/scraib-open-theme-card.png`).
  - Still unproven for Scraib: the Settings views, `FloatingLoader` and `MenuPanelView`
    (they depend on Sparkle, PostHog or the app's environment), the Metal shader
    resources, fonts and asset catalogs (`Bundle.main` is the host), and the entitlements
    and hardened runtime (a component preview needs none).
- **No incremental build:** each rebuild is a whole-module `swiftc` run (about 1.5 s for
  the fixture; large projects will be slower).
- **Rendering:** offscreen windows do not paint Liquid Glass or materials, and
  `.borderedProminent` buttons render flat. Animations are captured once a second or
  after input, not continuously.
- **Inspection:** Trezi's element picker, styles and layers work on HTML and do not
  apply to native frames. `describe` exposes accessibility values and text field
  contents only.
- **Verification:** the edit, the compile error and the fix are chat-landed through the
  real composer, worktree and landing pipeline, and the native check also covers the
  diagnostic hand-off to the landing check and the next prompt (see the native status
  below: that part is written but not yet run natively). The provider is a fixture and no live
  provider ran, so what is not covered is a real model choosing the edit. The unit test
  `test/swift-preview.mjs` still writes files directly; the native check does not.
- **Native status of that check:** the last native run (core group) got through turn 1
  (composer, worktree, landing commit on the live tree, rebuild to generation 2,
  "Find components" described) and landed the compile error (page `failed`, last good
  build kept), then timed out waiting for the landing-check row because the smoke suite
  runs with the post-landing check disabled. The smoke now drives the real check; that
  last change, and so turns 2 and 3 end to end (diagnostic row, next-prompt context,
  recovery), have **not** been run natively, because the session's native runs were used up.
  Run `bun run test:native -- --only=core` to confirm. The check's logic itself is covered
  by `test/landing-check.mjs` (a build that finishes after the settle time).
