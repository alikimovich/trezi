# Native UI migration plan

Status: application UI migration implemented, 2026-09-24, on candidate.
The native build has no Trezi React renderer or application WebViews. Final
verification and measurement evidence is recorded in NATIVE.md, PROGRESS.md and
RUNTIME_BENCHMARK.md; older-macOS/iOS Simulator release testing remains separate.
This plan preserves Electron support and shared application services.

## Target

Swift/AppKit owns window geometry, native text input, menus, shortcuts and view
lifecycle. SwiftUI owns application screens, lists, forms and conversation
presentation. Bun owns workspace/session state, persistence, provider agents,
Git, filesystem work, project startup and source-edit operations.

WKWebView remains for the user's website preview and WebKit's Web Inspector.
Preview DOM inspection, selection, inline editing, annotations and 3D overlays
remain JavaScript inside the preview's isolated bridge. Removing React from
Trezi does not remove JavaScript or React from a user's previewed project.

Completion means the native build does not bundle or load the Trezi React
renderer, including property-panel and pop-out editor entrypoints. Bun stays;
rewriting the shared backend in Swift is a separate project with little direct
benefit to this UI migration. Electron keeps its renderer and runtime.

## Completed inventory

| Area | Owner |
| --- | --- |
| Sidebar, toolbar, file tree, layers, source editor | AppKit + Bun |
| Chat, loading/cat, settings, review, feedback | SwiftUI + Bun |
| Properties/styles/tokens, custom/animation/content tools | SwiftUI + shared source services |
| Composer, layout, media, downloads and permission prompts | AppKit/WebKit platform APIs |
| Workspace/session persistence and update/relaunch | Bun controllers with native presentation |
| User's website, DOM selection and Web Inspector | The sole WKWebView and isolated preview script |

The native build no longer runs Vite over `src/renderer`. The build audits its
input graph and removes stale hybrid renderer assets. Core integration asserts
that no main, panel or editor WebView exists. Electron retains its independent
React build and API; Bun continues sharing the backend services.

The stages below document the migration scope and acceptance criteria. Native
controller/integration checks and foreground interaction checks are recorded with
their limits rather than implying every OS/provider combination was exercised.

## Implementation order

### 1. Move workspace control into Bun

Create a workspace controller alongside the chat controller. Move open/create/
close/select project, project restore, recent projects, chat creation/selection/
history/resume, background-session bookkeeping, preview restart and branch/publish
orchestration out of App.tsx and React subscriptions. Reuse existing service
implementations rather than translating Git/provider logic to Swift.

Define typed native commands and snapshots, with explicit project/session IDs,
request errors and stale-result protection. Swift sidebar, toolbar and welcome
actions call this controller directly. It supplies chat context and handles chat
effects directly, replacing native-chat-shell.ts and conversation mirrors to
Zustand in native mode. Include selection, setup, tokens, annotations and spawned
agent state; moving project switching alone does not complete this step.

Move renderer-owned preferences into versioned profile storage: recents, model
defaults, project UI choices, publish mode, sidebar/chat/layer presentation.
Import legacy native web preferences once while their WebView is still available.
Keep native/Electron profiles separate; do not silently merge credentials.

**Exit check:** with renderer event delivery disabled, open and switch projects,
create/resume chats, restore after restart, use branch/publish actions, and receive
background results in the correct session. Failure/cancel and rapid switching
must not overwrite the newly active project. Existing server cleanup still passes.

### 2. Make Swift authoritative for layout

Own sidebar/chat/preview/panel frames, split widths, collapse/expand animation,
minimum sizes and persisted dimensions in AppKit. Remove the DOM geometry loop
through NativeChatSurface, PreviewPane, PanelHost and ResizeObserver. Native
composer growth informs the native chat layout directly.

Move preview device sizing/readout, loading/error/retry surfaces, full-window
background, panel placement and modal visibility into native views. Preserve the
preview's actual viewport below the toolbar, Web Inspector, keyboard focus,
selection input isolation and smooth resizing.

**Exit check:** repeated drags, expand/restore, window resizing, sidebar toggles,
composer growth and native sheets work without querying DOM rectangles. Validate
light/dark mode, small windows and Reduce Motion.

### 3. Remove the main UI WebView from normal operation

Wire host startup directly to the Bun workspace controller. Route service events
to typed native subscribers rather than treating mainView.webContents as the UI
event bus. Remove native dependence on the full TreziApi preload and renderer
menu dispatch for migrated features.

Until remaining panels are replaced, load each legacy panel only when requested,
with explicit inputs/actions. A temporary panel must not secretly run the full
App or own workspace state. This is a transitional milestone, not completion.

**Exit check:** launch, restore, chat, select objects and navigate a preview with
no main UI WebView created. Opening a remaining legacy panel must not introduce
a second workspace controller. Measure startup/memory before and after.

### 4. Replace supporting screens with native windows and sheets

Implement settings/provider connections and defaults; new-project flow; project
memory; GitHub connection/publish and Git-update/conflict flows; session review;
diagnosis/retry; feedback and update/relaunch notices. Add a native selectable
activity log with copy, clear and bounded buffering.

Reuse service validation, authentication flows and error messages. Keep browser
authentication in the external browser where already appropriate. Native sheets
must coordinate focus and preview input without web-dialog detection.

**Exit check:** every application menu and sidebar action opens a native surface.
Provider settings persist, cancellation is safe, failures remain actionable,
history/review and update recovery retain existing behavior.

### 5. Replace visual editing panels

Migrate layers tree, property controls, computed styles, token pickers, custom
controls, content/animation tools and annotation management. Extract any pure
validation/prompt-building logic from React into shared TypeScript modules first.
Retain existing schema/source-edit services and the isolated preview DOM script.

**Exit check:** selection drives native controls; editing, undo/redo, layer
selection/reordering, annotations and token operations update the real project
and survive preview reload. Cover projects without source instrumentation.
Remove the property-panel WebView once its complete feature set is replaced.

### 6. Replace source editing and finish chat parity

Use AppKit text editing for the source editor, with a native file tree, source
location reveal, save/dirty state, undo, search/replace, syntax highlighting,
language-aware navigation where currently supported, media viewing and pop-out
windows. Inventory CodeDrawer behavior before replacing CodeMirror; a plain
NSTextView alone is not feature parity. Evaluate highlighting/parser dependencies
during implementation rather than selecting an unverified library now.

Finish chat tables, code highlighting, scroll anchoring/sticky user context,
attachment thumbnails/errors, accessibility and input-method handling. Complete
sidebar/history rename, ordering and background-agent presentation.

**Exit check:** source edits, save conflicts, search, navigation, pop-out closure,
large files, chat streaming/selection and IME behave correctly. No React editor
or content-editor bundle remains in native mode.

### 7. Remove compatibility UI and verify the finished build

Remove native Vite/React/Tailwind UI build steps, renderer assets, main/panel/editor
WebViews and obsolete UI bridge handlers. Retain the preview instrumentation
build. Audit the loopback asset server and Electron adapter: remove pieces only
after confirming shared services no longer need them. The trusted app command
channel must remain separate from untrusted preview events.

Finish native updater/relaunch, browser download/permission handling and recovery
behavior. Treat safe profile import as an explicit feature, not permission for
simultaneous Electron/native writes.

**Exit check:** a clean native build contains no Trezi React UI bundles; only
the project preview and its inspector require browser surfaces. Core integration
runs with no renderer evaluation helpers. Re-measure packaged size, cold/warm
startup, preview readiness, process-tree memory, idle CPU and streaming behavior
on the same fixture and account for WebKit helper processes.

## Delivery and validation

Ship one stage in reviewable slices, keeping the native app usable throughout.
The implementation now covers all seven stages. Broader platform/provider
release coverage does not reintroduce a React dependency.

Use pure controller tests and native integration after each slice. Native tests
must progressively stop depending on renderer DOM/state test hooks. Exercise
native actions, persistence and service outcomes directly, including interrupted
startup, terminal shutdown, hidden windows and concurrent background chats.
Visible desktop verification is required for pointer gestures, animation, IME and
accessibility before claiming full parity. Background checks are partial evidence.

Do not run Electron tests during native-only iterations. Preserve its build and
shared API behavior; a paired final benchmark or cross-runtime release validation
is a separately identified step. No performance improvement is promised until
measured. The editor and schema-driven inspector are the largest UI parity tasks;
workspace ownership is the dependency that should be tackled first.
