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
   components". When the turn lands in the live tree the driver rebuilds and swaps in
   the new host.
7. A change that does not compile turns the status pill into "Build failed". The page
   lists each error as `file:line:column: message` and keeps the last good build on
   screen. The page also logs the first error with `console.error`, where Trezi's
   landing checks read preview console errors after a chat turn (this hand-off is not
   covered by a test). The next successful build recovers.

## Declaring previews

A project opts in with `trezi-previews.json` at its root (and no `package.json`):

```json
{
  "name": "Swift components demo",
  "sources": ["Sources/DemoComponents"],
  "previews": ["Previews"],
  "exclude": []
}
```

- `sources` are the component files; `previews` are the declaration files, which are
  compiled only into the preview host. Both take folders or files and must stay inside
  the project. `exclude` removes paths (for example the app's `@main` file).
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
  - the driver's token and Host checks.

  Captures go to `test/artifacts/swift-preview/`.
- The native smoke check `swift-preview` (group `core`, `src/native/smoke-swift-preview.ts`)
  runs the same flow inside Trezi. It writes `test/artifacts/native/swift-preview-*.png`
  and `swift-preview.json`.
- The captures from the branch run are kept in `docs/evidence/lkm-271/`.

## Limits and follow-ups

- **`#Preview` reuse is not supported.** Xcode's `#Preview` macro expands into
  registry types that only Xcode's preview agent reads. Trezi asks for explicit
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
- **Multi-module projects:** everything compiles into one module. A project that
  imports its own library (Scraib's app imports `ScraibKit`) needs that module built
  first (`swift build`) and passed with `-I`/`-L`. Its `@main` and Sparkle/updater
  files also need excluding. Scraib was inspected read-only for this; the demo uses
  the fixture.
- **No incremental build:** each rebuild is a whole-module `swiftc` run (about 1.5 s for
  the fixture; large projects will be slower).
- **Rendering:** offscreen windows do not paint Liquid Glass or materials, and
  `.borderedProminent` buttons render flat. Animations are captured once a second or
  after input, not continuously.
- **Inspection:** Trezi's element picker, styles and layers work on HTML and do not
  apply to native frames. `describe` exposes accessibility values and text field
  contents only.
- **Verification:** the chat edit is exercised by writing the change to the live tree
  (where a landed chat turn writes); no live provider was run for this demo.
