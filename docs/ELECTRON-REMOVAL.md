# Electron retirement and unused-code review

Trezi now ships one application runtime: Swift/AppKit/SwiftUI with Bun services
and an isolated system WebKit project preview. This is a runtime retirement, not
a Swift rewrite of the backend. `src/main/` remains the backend directory.

## Removed

- Electron's main entrypoint, both application preload/renderer trees, its Vite
  configuration, postinstall bundle rebranding, and React UI generation script.
- Browser/Tailscale mode: its server, preview gateway/bridge, browser command
  scope guards, CLI remote configuration, and old React browser UI. `trezi serve`
  returns a clear retirement message instead of launching a broken runtime.
- The old `window.api` interface/global declaration, floating web-panel message
  handlers, renderer-only preferences/layout bridges and source-reveal helper.
- Application-only React state, CodeMirror/editor/tree UI, Markdown display,
  Tailwind/shadcn/Radix/Lucide components and their tests.
- Electron/Playwright application and provider integration tests. Their absence
  is not evidence that every old feature has native parity. Native integration
  and a separate real-provider test remain; release gaps remain in TASKS/NATIVE.
- Electron-only terminal-stream guards, renderer HMR port exclusion and
  `ELECTRON_RUN_AS_NODE` MCP configuration.
- 32 direct package declarations, including Electron, electron-vite, Playwright,
  Vite, CodeMirror, Zustand, Tailwind and their application UI dependencies.

## Preserved or moved

- Original cat artwork moved to `src/native/assets/cat`; the native build still
  consumes its exact frames and durations.
- Agent/provider sessions, Git/worktrees, managed servers, source parsing and
  mutation, diagnostics, media, content recipes and Simulator backend remain.
  Services import `src/native/platform.ts` directly, with native types rather
  than Electron aliases/types. Preview instrumentation imports its WebKit
  transport directly and still has a restricted message boundary.
- Backend/controller unit tests remain. Tests formerly importing renderer
  re-exports now import the shared helpers. The MCP bridge test now launches its
  actual stdio helper under Bun instead of Electron's Node mode.
- Native workspace persistence tests remain; the retired React restoration test
  was removed while native workspace/controller integration covers restoration.
- Provider credentials and historical Electron profiles were not modified.
  Native continues to use its existing profile path.
- `dev`, `build`, `start`, CLI launch/update and installation now target native.
  Existing `*:native` aliases remain. The app needs macOS 13.3+ and the macOS 26
  SDK to build; source builds still need Bun and development dependencies.

## Dependencies that look removable but are still used

| Dependency | Why it remains |
| --- | --- |
| TypeScript, Babel parser, React Docgen, Svelte compiler, parse5 | Parse and edit the user's project; independent of the application UI |
| json-render core/codegen, Zod | Validate and generate project compositions/control schemas |
| Claude/Codex SDKs | Provider sessions; not tied to Electron |
| APCA/colorparsley | Design tools used by agent and inspectors |
| esbuild | Explicit development dependency for native service/preview bundling and boundary tests; previously obtained through other tooling |
| React / React DOM | Direct development-only dependencies to render generated project components in tests |
| MCP SDK | No direct import remains, so the root declaration was removed; the Claude SDK still declares it as a peer dependency |
| electron-to-chromium | Transitive browser-version data for Babel's toolchain; not an Electron executable/runtime |

The root manifest changed from 38 runtime / 11 development declarations to
13 runtime / 5 development declarations. TypeScript moved to runtime because the
source-editing backend imports it, while React/React DOM moved to development.

## Follow-up cleanup

Removed the unused thinking-orb Swift vendor code, standalone native prototype,
renderer freeze-frame handlers/state, privileged media-scheme registration shim,
and uncalled props token-edit endpoint/adapters. Active native screenshots, media
serving and style/token editing remain. The content-controls vendor now contains
only recipe/API code and supporting types, without web UI or Motion dependencies.

Experimental Gemini remains opt-in and reachable. Unused shared helpers are retained
for separate review; tests alone do not establish application usage. Historical
PROGRESS entries and migration documentation remain historical records.

## Checks

`test/native-boundary.mjs` bundles the native backend without aliasing Electron,
rejects retired application-runtime imports and undeclared external dependencies,
and checks that WebKit instrumentation is self-contained. The native build also
rejects renderer/runtime imports. Unit and native integration results are recorded
in PROGRESS. Native background integration skips real pointer/animation timing;
real provider calls and broad OS/Simulator release validation remain separate.
