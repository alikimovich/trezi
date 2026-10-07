# Agent guide — architecture: Swift host, Bun services and isolated project WebKit

Moved from the old `CLAUDE.md` ("Architecture", "Why it's built this way") and
`AGENTS.md` ("Architecture"). Linked from [AGENTS.md](../../AGENTS.md). The Swift
XPC service and its domain owners are in [service-owners.md](service-owners.md);
the `src/main/` backend map is in [backend-map.md](backend-map.md).

## Native app, preview, shared contract

```
src/
  native/         Swift/AppKit/SwiftUI UI + Bun controllers
    index.ts        Bun entrypoint: service registration, project lifecycle and host bridge
    Host.swift      AppKit application lifecycle and JSON host protocol
    HostMenus.swift / HostInspect.swift   the host's menu bar (Window → Activity ⌘L)
                    and its test-broker inspect/perform/capture commands
    ServiceClient.swift / HostService.swift   the host's versioned XPC connection to
                    the Swift service (handshake, reattach, bounded outbox) and its
                    AppKit quit/restart/exit-status integration
    bridge.ts       private JSON bridge to the supervising service
    Shell.swift     sidebar/project actions, project/chat navigation, split view and
                    the column-aligned toolbar (sidebar toggle, chat actions, preview
                    controls, Publish)
    ProjectCell.swift  sidebar row rendering and native project drag reordering
    SourceList.swift   source-list outline, row cell, scroll view and sidebar split
                    item shared by the projects sidebar and Settings (SheetSidebar.swift)
    Chat.swift / Composer.swift   native conversation and text input. Bun
                    chat-controller.ts owns drafts, streaming, queues, model and
                    permission choices; shell-controller.ts owns workspace navigation
    ShadowIsland.swift  renders the Shadow Light compound chat block.
                    main/shadow-controls.ts validates its seven inputs and derives the
                    CSS or Tailwind output; main/chat-island-source.ts writes them
                    atomically. The current provider entrypoint is `chat_island`; it
                    shares the define-controls manifest schema. Binding checks,
                    statuses and short names: main/chat-island-bindings.ts; the
                    agent's show/clone ops: main/chat-island-tool.ts; referenced
                    island context: main/chat-island-context.ts; the composer's "#"
                    picker and reference chips: native/chat-island-refs.ts (LKM-181)
    ChatActivity.swift / StreamingText.swift   text-only live activity and native
                    word reveal. Cat.swift supplies cats for other app surfaces
    WorkspaceLayout.swift        authoritative view/divider geometry and AppKit divider input
    SourceEditor.swift / Layers.swift / EditingInspector.swift
                    native source, layers and property/style inspector; the Layers
                    and editing islands float over the preview (LayersLayout.swift
                    places Layers under its toolbar button, never over the other)
    SourceSyntax.swift  applies Shiki token categories from native/syntax-controller.ts
                    (TextMate grammars on Bun, main/syntax-*.ts) by revision, in
                    dynamic Xcode-like light/dark colours (LKM-183)
    FloatingIsland.swift / IslandLayout.swift
                    what both islands share: glass, opaque face, a header that
                    drags them (snap, no overlap, corner-relative saved place) and
                    a frame that keeps the pointer from the page
    Sheets.swift    New Project, memory, settings and provider forms; Bun controllers
                    own service operations. Forms use standalone titled, resizable
                    windows with traffic lights and an action bar only when needed.
                    Settings and project memory autosave; close/navigation waits for
                    their latest write. Swift owns welcome/status/cat surfaces
    platform.ts     direct native service imports, native event routing, WebKit proxy.
                    Services import it directly; there is no Electron alias or
                    dependency. Opening links and files goes to the platform owner
                    (src/service/PlatformOpen.swift); Keychain crypto runs in
                    `Helpers/TreziSecrets --crypto` (src/native/Secrets.swift), which
                    the service calls
    profile-path.ts   only resolves the profile aliases; the service creates them
                    (src/service/ProfilePaths.swift, `TreziService --resolve-profile`,
                    made under the profile lock before Bun starts). index.ts refuses
                    to start without the service's profile lock
    preview-transport.ts   restricted isolated WKContentWorld transport
    assets/cat/     original native animation artwork consumed by the native build
  preview/preload.ts  isolated WKWebView instrumentation: selection, comments,
                    annotations (isolated project DOM instrumentation, using
                    native/preview-transport.ts); own tsconfig (tsconfig.preview.json)
  preview/layers.ts DOM tree walk + child-index-path node resolution for the
                    Layers panel (bulk read, panel-driven select/hover, the
                    structural MutationObserver watch) — split out of preload.ts,
                    which only wires the IPC into it
  preview/measure.ts  spacing measurement geometry for the Option/Alt distance
                    overlay (select one element, hold Option, hover another):
                    gap between separated boxes, matched-edge deltas when they
                    nest/intersect. Pure — preload.ts only draws what it returns
  preview/style-provenance.ts  proves a style property's value comes from a
                    design token instead of merely equalling one: reads the
                    SPECIFIED (unresolved) declaration — inline `style=` or a
                    matched stylesheet/scoped-`<style>` rule — since
                    `getComputedStyle` always resolves `var()` away and so can
                    never tell "is" from "coincidentally equals". Threaded
                    through `styles:read` as `declaredVars`
  shared/api.ts     the IPC contract — single source of truth for cross-process types
  shared/preview-channels.ts  the raw channel NAMES (selection/style/layer messages)
                    for the one IPC surface api.ts can't type: main ⇄ the sandboxed
                    preview preload (no contextBridge there, so it's bare
                    `ipcRenderer` strings). Imported by BOTH ends
                    (src/main/preview-ipc.ts + index.ts, and src/preview/preload.ts)
                    — never re-declare one locally
  shared/token-match.ts  which design tokens may be offered for a css property
                    and which one a computed value IS. Pure + used by BOTH main
                    (re-validating a pick) and the island (chips + picker)
  shared/run-stats.ts  the chat status line's numbers: main normalizes each
                    provider's usage payload + dedupes its repeated cumulative
                    readings into `usage` event deltas, native chat state
                    accumulates them for the Swift status line
  shared/style-props.ts  the Styles panel's v1 editable CSS-property allowlist
                    (the `StyleProp` union). main/styles.ts derives its
                    `STYLE_PROPS` from it (the actual write-time boundary)
  service/        the Swift XPC service — see service-owners.md
  main/           backend services — see backend-map.md
bin/trezi.mjs     the `trezi` CLI (launch, `trezi --project <repo>`, `--update`); owns
                  the update sequence (git pull + bun install + build). install.sh boots it
scripts/build-native.mjs  bundles services and preview, compiles Swift and checks that
                  the app does not depend on Electron or the retired React renderer;
                  stamps the version (scripts/version.mjs) into the plists
                  (scripts/service-info.mjs) and bundles
scripts/native-swift.mjs  the build's Swift compiles: shared binary and module caches
                  in ~/Library/Caches/Trezi, release (-O) and test (-Onone) profiles
scripts/release.mjs  `bun run release <major|minor|patch>`: bump, CHANGELOG, commit, tag
test/             hand-rolled .mjs tests + fixtures/ + artifacts/ (PNGs, gitignored)
docs/             TASKS (next) / PROGRESS (log + rationale) / DESIGN (stamp spec)
```

## Lifecycle

- `install.sh` is the one install command (LKM-116). Piped (curl one-liner) it
  clones the `--channel` branch (main by default) to `~/.trezi` and updates it on
  re-runs; run from a checkout (`./install.sh`, `bun run setup`) it uses that checkout
  as it is (pull only with `--update`). Either way it installs missing Bun and
  command-line tools, builds, links `Trezi.app` into Applications and puts `trezi`
  (`bin/trezi`) on PATH, pointing at the last-installed checkout, offers
  `claude setup-token` and opens Trezi (not with `--no-open`). The one start path is
  `open -a Trezi` or `trezi` / `trezi .` / `trezi <path>` (a thin `open -a`);
  `trezi --update` pulls + rebuilds. The app carries its own Bun
  (`Contents/Helpers/bun`) and backend (`Contents/Resources/backend/`), so no
  installed Bun is needed at runtime. Native
  Settings uses `src/native/update-controller.ts` to guard unsaved work,
  check/pull/install/build, and restart.
- `bun run dev`/`start` (development) go through `scripts/start-native.mjs`; see
  [service-owners.md](service-owners.md) for what the Swift service owns (there is
  no Bun rollback launch since LKM-111).
- The chat runs via provider SDKs (built-in adapters in Swift-supervised provider
  helpers, v10 connections in `main`); output streams over `agent:*` IPC into
  Bun chat controllers, which send typed state to Swift.
- Trezi **owns** the dev-server lifecycle of the target repo: never run the target's
  `dev` manually; it's killed on app quit. The app awaits managed process-group
  cleanup on quit and terminal shutdown, force-stopping survivors after a one-second
  grace period. Under the Swift launch the service owns those process groups and
  drains them before releasing the profile lock, and a crashed service's groups are
  stopped by their watchdogs or the next launch's journal sweep.
- Swift edits require rebuild/restart; the user's project retains its own HMR.

## Trust boundaries and retained runtimes

- Preview messages are untrusted and are restricted by actual view identity and an
  allowlist. The preview cannot invoke agent, filesystem or application commands.
  Preserve WKContentWorld isolation. The project preview is the only WebKit view.
- Native profiles remain separate from historical Electron profiles; do not delete
  or implicitly migrate existing user data. Electron, the React application renderer
  and browser/Tailscale mode are retired. See `docs/NATIVE.md`.
- Claude and Codex share on-demand preview location/screenshot observation. The Codex
  MCP helper must preserve screenshot image content, not JSON-stringify it. These
  observe the current user view; they do not prove private worktree edits have landed.
- Provider SDKs remain in process in Bun. Source editing still uses JavaScript parsers
  (TypeScript/Babel/React Docgen/Svelte/parse5); React-related names do not imply a
  remaining application renderer. React/React DOM are development-only fixtures for
  generated project component tests. Content controls (recipe-driven content editors)
  were removed in LKM-114; a project's old `.trezi/content-controls.json` is left
  untouched and no longer read.
- Experimental Gen UI (the `project-ui` modules in `src/main/`, e.g.
  `src/main/project-ui.ts`): discovery, strict React/Svelte composition export and
  optional Jev topology selection. Helpers return source proposals only; supported
  contracts and limitations are in `docs/PROJECT_UI.md`.

## Why it's built this way (non-obvious choices)

- **Agent core = SDK in-process** (not ACP/subprocess): the product's custom tools
  (select element → edit props → annotate → PR) are wired to the renderer and need
  in-process SDK tools.
- **Preview = system `WKWebView`**: isolated instrumentation selects elements and
  talks to Bun through a view-identity-checked message allowlist.
- **Prop editing is hybrid**: simple literals splice straight into source (instant
  HMR); complex/expression values fall back to the agent. React and Svelte have
  separate engines because their ASTs differ; selection/tokens are framework-agnostic
  (they only need the `data-trezi-source` stamp — see `docs/DESIGN.md`).
