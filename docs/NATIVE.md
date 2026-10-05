# Trezi on macOS

```sh
bun run dev:native
bun run dev:native --project /absolute/path/to/project
bun run build:native
bun run test:native
```

The native application UI is Swift/AppKit/SwiftUI. It does not build or load the
Trezi React renderer. WebKit is used only for the user's project preview and
Web Inspector. Bun runs the shared agent, Git, filesystem and project-server
services. `bun run dev` now launches this native runtime; Electron has been removed.

Requires macOS 13.3+, Bun, command-line tools with the macOS 26 SDK, and
`bun install`. Liquid Glass requires macOS 26; older systems use native visual
effect materials. This migration was verified on macOS 26.4.1, not every supported
OS version. Start through `scripts/start-native.mjs` (via the CLI/dev/start scripts):
the source-built host requires launch arguments and its bundled XPC service.

## Native ownership

| Surface | Implementation |
| --- | --- |
| Window, toolbar, sidebar, split views | AppKit |
| Welcome, loading/errors, animated pixel cat | SwiftUI |
| Conversation, Markdown tables/code, cards/questions | SwiftUI |
| Composer, attachments and slash completion | AppKit NSTextView and native controls |
| Settings/providers, new project, memory, Git/publish, review, feedback | SwiftUI forms in standalone AppKit windows with Bun controllers |
| Activity | AppKit selectable log, bounded buffer |
| Source files, search/replace, media, pop-outs | AppKit outline/NSTextView/AVKit |
| Layers | AppKit outline with selection and drag reordering |
| Properties, styles, tokens, custom/animation controls | SwiftUI with shared editing services |
| Project website and DOM instrumentation | WKWebView with isolated preview script |

The sidebar starts with Open Project and New Project buttons, separated by a gap
from projects with consistent native outline folder symbols and a More menu for
memory, ordering and closing. History above the chat provides open/saved sessions,
rename and review/resume. Background runs appear as actionable chat cards. Project
and chat state persists in the native profile. The toolbar keeps the sidebar toggle, chat
and preview actions aligned with their columns. Preview controls include domain
and branch, selection/device, code/layers/expand, and Publish.

AppKit owns all geometry; no DOM rectangle observer controls native layout.
Repeated divider drags, collapse/restore and window resizing retain the native
surfaces. The chat and panel sizes persist. The preview background extends behind
the toolbar with a single full-height divider and adaptive toolbar contrast.
The actual project viewport stays below the toolbar. Mobile mode adds native
phone artwork around that viewport.

The composer uses native Liquid Glass, a multiline text view, a plus menu and
unbordered provider/model/permission selectors below the field. Labels size to
content up to 60 points. Enter submits, Shift+Enter inserts a newline, and marked
IME text bypasses submission. Slash completion supports keyboard and pointer
selection. Readable image attachments are limited to 10 MiB; failed image reads
and oversized pasted images show an actionable chat error. Composer tiles and sent
images share 72 pt thumbnails (`src/native/AttachmentThumbnail.swift`): aspect kept,
transparent images (SVG, PNG) on a checkerboard, a wrapping row in the sent bubble,
the file name on hover and a larger preview on click. The original cat animates for idle/running/question/completion
states, pauses when hidden and respects Reduce Motion.
Queued messages appear in a rounded stack tucked behind the composer, with
one-line previews, attachment counts, copy/remove actions and Resume when paused.
The stack shows up to three rows before scrolling; queue order stays unchanged.

Chat has selectable text, native disclosure controls, fenced-code coloring,
Markdown tables, bottom-following and a sticky request when scrolling through a
response. Source editing provides a folder tree, back/forward navigation, line
reveal, native find/replace, undo, dirty/conflict state, save, external-editor
opening and reusable pop-out windows. Drafts survive file navigation and docking.
Syntax coloring is deliberately lightweight; it is not a language server.

The inspector sidebar opens from the selection toolbar only. Picking elements
updates an open inspector without reopening a closed one.

Native inspectors retain source/schema validation, token references, live style
scrubbing and post-HMR reconciliation. Linked margin/padding writes share an undo
group. Custom controls support repair/removal and animation Replay. Content
editor windows were removed in LKM-114.

## Build and transport

`scripts/build-native.mjs` bundles the Bun entrypoint and isolated preview preload,
compiles and ad-hoc signs the Swift host, bundled XPC service and rollback guard,
and copies native image/cat assets. It removes stale
`out/native/renderer` and `preload.js` from older hybrid builds. The build audits
its dependency graph against application renderer/React imports and records
`out/native/build-inputs.json`. There is no Vite/Tailwind application build or
loopback renderer asset server in native mode. `TREZI_NATIVE_PORT` is obsolete.

The native platform (`src/native/platform.ts`) is imported directly by backend
services. Its `main` object is a trusted service sender, not a hidden browser. Swift refuses creation of any
application WebView other than `preview`.

The host connects to the separate Swift service through authenticated, versioned
XPC. The service relays existing AppKit actions to Bun controllers over private
pipes; Bun remains the sole writer of unmigrated domains. Preview messages are stamped by their actual WebView and limited
to allowed selection/comment/style/layer events. The preview cannot invoke agent,
filesystem or application commands. Its script runs in a named isolated
WKContentWorld, and preview storage is ephemeral. Main-frame navigation stays on
the assigned project origin; external clicked HTTP(S) links open the browser.

WebKit downloads use a native save sheet. Camera/microphone requests from the
assigned origin ask through a native permission sheet; they are never silently
granted. Develop → Show Preview Web Inspector (⌥⌘I) and JavaScript Console (⌥⌘C)
use the system inspector. Opening it programmatically uses guarded WebKit SPI in
`src/native/Inspector.swift`; the context-menu inspector remains available.
Repeated WebKit process failures stop automatic reload and show a retry surface.

## Profiles and lifecycle

Backend state lives in `~/Library/Application Support/Trezi Native`, separately
from Electron. The directory keeps that name although the app is now `Trezi.app`:
renaming it would need a profile migration. Swift holds a shared-launcher flock and reserves the legacy PID lock
before starting Bun. A guardian retains the flock during service-crash cleanup.
Workspace state
lives in `workspace.json` and versioned native UI preferences in
`preferences.json`; the Swift service alone writes both (the Bun rollback writers
were removed in LKM-111). Earlier hybrid builds imported legacy native browser values
once; the React-free build retains those files and no longer creates a WebView to
read browser storage. It does not import Electron history or custom endpoints.
Existing provider CLI sign-ins can be reused.

Custom endpoint keys use AES-GCM with the encryption key in macOS Keychain. Values
reach the cipher helper through stdin, not argv. No real credentials are written
by the integration tests.

Trezi owns project servers. Quit and terminal signals drain Bun under Swift
supervision; connection loss allows a bounded same-process reconnect before drain.
Lifetime guardians stop Bun and detached server/Simulator groups even after an
owner crash. Backend cleanup has a one-second grace; detached guards use half a
second before group SIGKILL. Repeated shutdown joins existing cleanup. See the
[service boundary](SWIFT-BACKEND-SERVICE.md) for protocol and rollback limits.
Native dialog windows are dismissed during host shutdown. Updates
use the current tracked branch, require a clean checkout and no running chat or
unsaved source/composer drafts, fast-forward, install with Bun, rebuild native and
restart. Failures remain in a native dialog window. Updates never discard work or switch
branches automatically.

## Verification

Use `bun run typecheck`, `bun run typecheck:native`, relevant `test/native-*.mjs`
controller checks, and `bun run test:native`. Do not run Electron suites during
native-only work. `TREZI_NATIVE_BACKGROUND_TEST=1` skips pointer/animation checks;
it is partial UI evidence. Native integration asserts that only the preview
WebView exists throughout project navigation, sheets, editing, chat and Inspector.
The test drives native commands and service results, without renderer evaluation.
It includes queued/streaming chat, permission/question cards, marked-text input,
style/source edits, undo/redo, source pop-out/dock geometry and preview bridge isolation. Artifacts are in
`test/artifacts/native/`.

Foreground checks separately cover native composer input/Unicode paste, source
tree/navigation/find, repeated divider drags, selection-driven inspectors and
download cancellation. Controller tests cover conflicts, stale actions, provider
forms, recipes, token writes, workspace restore and update failure paths. Real
publishing, update pulls, credential writes and paid provider turns are not part
of deterministic verification. `TREZI_NATIVE_TEST_PROVIDER=codex bun run
test:native-live` opts into a real fixture edit. iOS Simulator integration and
older-macOS visual behavior still require platform-specific release testing.

See [migration scope](NATIVE-MIGRATION.md) and [measurements](RUNTIME_BENCHMARK.md).

App forms use titled, closable, minimizable and resizable native windows. Content
scrolls above a fixed action bar: auxiliary actions on the left, Cancel and the
primary action on the right. Return invokes nondestructive primary actions;
Escape, Command-W and the close traffic light dismiss through the Bun controller.
System file pickers and permission alerts retain their standard AppKit presentation.

Settings is a standard macOS settings window, opened from Trezi → Settings…
(Command-,) with or without a project; the main window's sidebar has no gear. Like
Xcode's, it is a full-size-content window whose `NSSplitViewController`
(`src/native/SheetSidebar.swift`) starts with a non-collapsible
`NSSplitViewItem(sidebarWithViewController:)` (180–260 points) under the traffic
lights. Its `.sourceList` outline selects General, AI Providers or Experimental
with SF Symbols, by click or arrow keys, and the window title names the selected
section. It shares the projects sidebar's source-list setup, row cells and scroll
view (`src/native/SourceList.swift`). The detail pane shows a large title and
grouped rows (label and description on the left, control on the right). AI
Providers is edited inline, and the window reopens on the last selected section
(`trezi:settings-section:v1`). Form windows without sections keep the layout above
(`src/native/SheetSections.swift`).

Settings and project memory save automatically after edits, coalescing typing and
serializing writes. Closing or navigating within the form waits for the latest
draft; a failed save keeps it open with an error. Close-only buttons are omitted
and actionless windows omit the footer. Provider credentials, source commits,
creation and destructive operations retain explicit actions.

Legacy profile/worktree paths and the identities kept on purpose are listed in
[legacy names](agent-guide/legacy-names.md).
