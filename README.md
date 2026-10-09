# Trezi

An AI design & prototyping tool for your own repos. Open a project, Trezi
launches its dev server in a live preview on the right, and an AI chat on the
left edits the running app using the selected provider's native harness.

Unlike a sandbox (Figma Make, Claude Code's scratch dir), Trezi edits *your
real repository* with live hot-reload, and hands the result off as a branch +
GitHub PR.

## What it does

- **Choose how a new project starts.** New Project asks whether to use the
  React/TypeScript/Vite defaults, plan Next.js or Svelte, or discuss your own
  environment. The discussion paths initialize an empty repository and open chat
  before creating an app. After environment changes land, Trezi re-detects the
  framework, installs dependencies in the preview checkout, and restarts the web
  preview. Custom launch commands are preserved; startup errors keep chat available.

- **Live preview of your repo.** Open a folder → Trezi detects the framework
  and package manager, boots that repo's dev server, and previews it in a
  system WebKit `WKWebView`. It self-heals if the dev server dies and restarts.
  Plain HTML/CSS/JS folders (no package.json or build step) are served by a
  built-in static server with live-reload; anything Trezi can't auto-launch
  prompts for a custom command.
- **Pull updates and remote branches.** Click the current branch → **Git updates…**
  to fetch branches from GitHub or another Git remote, merge a selected remote
  branch into the current branch, or switch to a local tracking branch. Existing
  local branches are preserved. Pull conflicts restore the clean starting tree;
  successful updates refresh the preview, including changed dependencies.
- **AI chat that edits the running app.** A persistent multi-turn agent session
  streams over IPC and edits source with hot-reload. Backends are pluggable —
  Claude (via the Agent SDK), Codex, and Gemini behind one provider seam
  (Gemini is experimental, gated behind `TREZI_EXPERIMENTAL_GEMINI`). Their
  capabilities differ; see [`docs/PROVIDERS.md`](docs/PROVIDERS.md).
- **Peer chats and project memory.** Every project has a flat set of isolated,
  independently named chats, with background agents nested under the chat that
  launched them. After successful turns, Trezi conservatively learns durable
  decisions into unified project memory shared by every chat; it lives outside Git
  and remains directly editable. See [`docs/MEMORY.md`](docs/MEMORY.md).
- **Bring your own model.** Beyond the two subscription seats, Settings
  (Trezi → Settings…, Command-,) → AI Providers connects any OpenAI-compatible endpoint serving the
  `/responses` API — Vercel AI Gateway, Groq, or a custom host — so open models
  like Kimi or DeepSeek can drive a chat. Paste a key, Trezi fetches that
  endpoint's model catalog, and you tick which models to offer in the picker.
  Connections run on the Codex harness; the key is encrypted with the OS
  keychain and never leaves the main process.
- **Arrange the sidebar.** Drag project rows to reorder them. The native insertion
  line shows where they will land; Escape cancels. Order persists across restarts
  without changing the active chat or running sessions.
- **Drag to reorder in the desktop preview.** Select an element, then hold
  Command and drag it among its siblings. An insertion
  line shows the drop position for columns, rows, and grids; nesting stays fixed.
  Escape or releasing the modifier cancels. Moves write source and support undo;
  ambiguous template/data moves prepare a chat prompt.
- **Queue follow-ups.** Enter during a running turn queues the message for that
  chat, including its attachments and selected objects. Remove pending messages,
  or resume after Stop/errors. Queues last for the current app session.
- **Stay in your project.** Chat links open separately; the preview's home button
  returns to the managed project's entry page. Successful merges stay quiet,
  with Revert retained on the response. Independent text edits merge automatically;
  overlapping text gets one automatic reconciliation attempt before showing Resolve.
- **Click-to-edit.** Hold **Shift** while clicking to add or remove objects from
  a selection. Chat requests and Delete include the group; individual property
  controls target the most recent object. A **Select** mode maps a clicked element to its source
  location (via the `data-trezi-source` stamp — see
  [`docs/DESIGN.md`](docs/DESIGN.md)), then edits its **props** with typed
  controls (react-docgen for React, `svelte/compiler` for Svelte 5), applies
  the repo's **design tokens** (auto-detected from a manifest, Tailwind, or CSS
  vars), and edits text inline. Non-literal text cases run as detached background
  agents without entering the visible chat.
- **Ask to see the exact code.** Trezi can open its mini code editor in the
  relevant file and highlight the implementation, without selecting an object.
  Unsaved editor changes are preserved; available with Claude and Codex.
- **Surface controls in chat.** Ask for animation or shadow controls, or use
  `/surface-controls`. Trezi embeds native sliders, inputs, toggles, point and
  easing editors in the conversation. Controls bind to source with Undo, Reset
  and optional Replay; changes update the project through HMR. A disabled draft
  appears while Jev arranges the prepared controls; editing activates after landing.
  Later-turn revisions create a new island beside the new response, preserving
  earlier definitions. Adjusting controls preserves your place in the conversation.
  Shadow Light combines a light-source pad, distance, blur, integer layers, decay
  and rgba color with a shadow preview and CSS readout. Its input literals and
  Tailwind or inline shadow output update together through source/HMR.
- **Next.js source mapping.** Setup detects Next separately from React/Vite and
  provides development-only Turbopack/webpack adapters, with optional MDX mapping.
  It preserves config wrappers and existing component types, synchronizes helpers
  into chat worktrees, and verifies stamps after landing and preview restart.
  Next validation worktrees install their own dependencies instead of linking a
  `node_modules` directory outside Turbopack's root.
- **Inspect components in 3D (desktop).** Select an element and click the stacked
  layers icon to isolate its visual structure. Orbit, zoom, spread layers apart,
  and select a surface to edit it with the existing inspector. **Back to page**
  returns to the running screen. See [3D inspection](docs/THREE_D.md) for controls
  and first-version rendering limits.
- **Preview observation.** Claude and Codex can request the current preview route
  and a screenshot (whole view or one element). They can also inspect an element's
  box and computed styles, run read-only bounded JavaScript, read console errors,
  and resize the preview for phone/tablet/desktop checks. All of this runs in the
  WebKit preview, isolated from the page. Codex-based custom endpoints expose the
  same tools; viewing screenshots requires an image-capable model. agent-browser is
  used only for scripted multi-step interactions.

- **Controls from chat.** Ask Claude, Codex, or a custom-endpoint model to surface
  animation controls in the desktop preview. It can select the object and open
  Props, Styles, or Custom directly. Custom controls include numeric scrubbing,
  toggles, color pickers, and easing curves. Props and Styles show authored values
  by default; **Show all** exposes optional props and computed styles.
- **Review → handoff.** Pin comments/notes to elements and **Publish** a branch
  + GitHub PR. Comments and complex inline text edits can spawn parallel background
  agent sessions (each in its own git worktree).
- **Concurrent-chat isolation.** Git-root projects give each chat a private
  worktree and serialize publication through one live-checkout writer. Recovery
  branches exist only during active or parked work and are deleted after a
  successful landing; see [`docs/WORKTREES.md`](docs/WORKTREES.md).
- **iOS Simulator preview** for Expo/React Native projects (Metro detect + an
  MJPEG bridge into the preview pane).
- Tool calls run behind approve/deny cards, or an Auto mode. Edits are
  undoable (`Cmd+Z`) via an edit-history stack.

## Requirements

- **Node 22** (`.nvmrc`) and **Bun** (`bun@1.3.x`) to build. Distributed as source,
  built and run locally. The built app carries its own copy of Bun, so starting it
  needs no installed Bun. The installer installs Bun when it is missing.
- A provider subscription for the agent (e.g. Claude Pro/Max), authorized
  per-user (the installer offers `claude setup-token`) — or your own API key for a third-party endpoint, added in
  Settings. Either way it is per-user; there is no shared secret.
- **macOS 13.3+**, Xcode command-line tools with the **macOS 26 SDK** (the installer
  starts the command-line tools install when they are missing).
  Liquid Glass requires macOS 26; older releases use native fallback materials.

## Install

One command, the same for users and for development:

```bash
curl -fsSL https://raw.githubusercontent.com/alikimovich/trezi/main/install.sh | bash
```

Testers install the `candidate` branch with the same command:

```bash
curl -fsSL https://raw.githubusercontent.com/alikimovich/trezi/main/install.sh | bash -s -- --channel candidate
```

To work on Trezi itself, run it inside your clone instead (`bun run setup` does the same):

```bash
./install.sh
```

The installer installs Bun (official installer) and the Xcode command-line tools when
they are missing, clones Trezi to `~/.trezi` (override with `TREZI_HOME`), then installs,
builds, links **Trezi** into Applications and puts a `trezi` command on your `PATH`.
If the `claude` CLI is present but not authorized, it offers to run `claude setup-token`;
then it opens Trezi. Inside a clone it uses that checkout as it is: no clone, branch
switch or pull (add `--update` to pull first). The `trezi` command and Trezi.app point
to whichever checkout was installed last, and the installer says which.

Run the same command again to update and rebuild. Options: `--channel main|candidate`
(or `TREZI_CHANNEL`; default `main`, and a re-run keeps the installed channel),
`--update` and `--no-open`. Unattended installs skip every prompt.

If Claude chats say you are not logged in, run `claude auth login` in Terminal, or run
`claude setup-token` and paste the token in **Settings → AI providers → Claude…**.
Its **Check login** button shows what Trezi's Claude sees.

The installer recommends **agent-browser** for automated browser checks, including
different screen sizes, and asks whether to install its global CLI and browser.
It uses Bun, skips the offer when the CLI is
already on PATH, and defaults to **No**. Unattended installs skip the prompt.
An optional browser-install failure does not prevent Trezi installation.
To install it later: `bun install --global agent-browser && agent-browser install`.
Trezi's built-in agent instructions verify web UI with Trezi's own preview tools
(including phone/tablet/desktop checks for layout changes) and use agent-browser
only for scripted multi-step interactions. Agents
must report missing browser support or a preview that cannot yet show their edits.

Later, start Trezi from Applications or the terminal:

```bash
trezi                # open Trezi (builds it first if needed)
trezi .              # open the current folder as a project
trezi ~/code/my-app  # open that folder as a project
```

That is the one way to start Trezi: open it like any app (Finder, the Dock, Spotlight,
`open -a Trezi`), or with `trezi`, which builds a missing app and then opens it the same
way. `trezi --help` lists the options and `trezi --version` prints the installed version
as "Trezi X.Y.Z (build N, short sha)", the same text as Settings › General and About
Trezi. Changes are listed in `CHANGELOG.md`.

In the app, click **Open project…**, pick a repo with a `dev`/`start` script,
and chat on the left. Trezi **owns the dev server** — quitting or pressing Ctrl-C stops its managed
process groups, force-stopping survivors after a short grace period. Don't also run `dev`
manually for a project you open here, or you'll hit a port/lock conflict (the
error banner offers a custom-command retry for monorepos / odd setups).

## Updating

```bash
trezi --update      # git pull + bun install + rebuild
```

The native Settings update workflow checks the remote, guards unsaved work,
then pulls, installs, rebuilds and restarts. There's no signed app or auto-download — updates are
always a git pull of your checkout.

### Code signing

Every build signs Trezi.app, its XPC service, its helpers and the bundled Bun (unless it
keeps Bun's own Developer ID signature) with one identity that stays the same across
rebuilds, so macOS keeps your Keychain and privacy approvals:

1. `TREZI_SIGN_IDENTITY`, when set: an identity's name or SHA-1, or `-` for ad hoc;
2. otherwise a valid **Apple Development** identity, when you have one;
3. otherwise **Trezi Local**, a self-signed code-signing identity the first build (or
   `install.sh`) creates once in your login keychain. Only codesign may use its private
   key, and it is not added to any trust settings.

When none can be used or created, or the identity cannot sign (a locked login keychain over
SSH, a denied key-access prompt), the build signs every piece ad hoc and prints one line starting
`warning: signing Trezi ad hoc`; macOS then asks again after every rebuild. Check the
designated requirement with `codesign -d -r- out/native/Trezi.app`: with Trezi Local it
is `identifier "<bundle ID>" and certificate leaf = H"…"`, the same after every rebuild.

The master key that encrypts saved connection keys and the Claude token lives in the
Keychain item `dev.trezi.native.secrets`, read only by `Trezi.app/Contents/Helpers/TreziSecrets`.
That helper is built from one small file (`src/native/Secrets.swift`) whose binary does
not change between rebuilds, so an **Always Allow** survives them. (With a self-signed or
ad hoc signature the login keychain ties the approval to that exact binary: a change to
that file or a new Swift compiler costs one more approval. An Apple Development identity
avoids even that.) A key under the earlier name moves to the new item
once; the old item is deleted only after the new one is written.

**After updating to this version, macOS asks once more** for the Keychain (choose
**Always Allow**) and may ask again for privacy access Trezi had before. Both stay
approved after that.

Deleting the earlier item can ask once more as well; if you deny it, the old item stays
unused (`security delete-generic-password -s dev.praxis.native.secrets -a master-key`
removes it). The first Claude chat may also bring a macOS prompt about files on a network
volume: Claude Code checks one as it starts, and Trezi explains this once in that
chat. Allow it only if your project is on a network drive. Rebuild-loop results and
exact verification steps are in
[docs/PROVIDERS.md](docs/PROVIDERS.md#keychain-and-network-volume-prompts-after-stable-signing-lkm-144).

## Architecture

Trezi has a Swift/AppKit/SwiftUI interface, a separate Swift XPC service supervising
the retained Bun backend and the provider helpers, and one
WebKit view for the user's project. See [Native architecture](docs/NATIVE.md).

- **Swift** owns chat, composer, sidebar, toolbar, native dialog windows and inspectors. Settings and project memory
  save automatically; dialog windows use traffic lights instead of redundant Close buttons.
- **Bun** runs the controllers behind the native UI, source parsing and the provider
  adapters (built-in ones inside supervised helpers); it persists nothing itself. The
  Swift service writes preferences, the workspace (open projects, order,
  selection) and project memory, runs managed project servers, performs Trezi's Git
  effects, commits source edits that Bun's parsers propose, and owns chat records,
  checkpoints and turn transitions (Bun's provider sessions report typed events to it),
  and holds each provider session's grant: permission answers, Trezi tool
  authorization, Stop's deadline, resume ids and supervised provider helpers;
  see [workspace](docs/SWIFT-BACKEND-WORKSPACE.md), [memory](docs/SWIFT-BACKEND-MEMORY.md),
  [runtime](docs/SWIFT-BACKEND-RUNTIME.md), [repository](docs/SWIFT-BACKEND-REPOSITORY.md),
  [source](docs/SWIFT-BACKEND-SOURCE.md), [conversation](docs/SWIFT-BACKEND-CONVERSATION.md)
  and [providers](docs/SWIFT-BACKEND-PROVIDERS.md). Services in `src/main/` are retained
  backend code; that directory name does not imply an Electron runtime.
- **Preview** runs in `WKWebView` with an isolated selection/editing script.
- **Transport** uses authenticated, versioned XPC between the host and Swift service,
  with private pipes to Bun. Swift holds the exclusive profile lock and supervises
  Bun and its managed child lifetimes. Preview messages retain their restricted allowlist.

Claude, Codex and Gemini sessions run in provider helpers the Swift service spawns and
supervises; a connection you added in Settings runs in the backend, so its key never
leaves it. The backend and the helpers are JavaScript run by the Bun bundled into
`Trezi.app`. There is no older launch path to fall back to: without its service, Trezi
does not start. See [service](docs/SWIFT-BACKEND-SERVICE.md) and
[retirement](docs/SWIFT-BACKEND-RETIREMENT.md).

Electron and the old React application UI have been removed. Browser/Tailscale
mode (`trezi serve`) is retired; the CLI reports that explicitly. The native
profile stays separate from old Electron profiles, which are not deleted or
silently migrated. Existing provider CLI logins remain available.

## Testing

Tests are `.mjs` scripts in three tiers: `unit` (Bun backend/controller logic),
`native` (Swift/AppKit integration with a disposable profile), and `live`
(real provider edits, requiring credentials). Native tests skip on unsupported
hosts; skips remain distinct from passes. Native and live tests run serially.

`bun run test` runs unit and native checks. `bun run verify` adds live checks;
run live provider calls only when authorized. Logs and JSON summaries are written
to `test/artifacts/runs/`. Read captured PNGs to verify UI changes; offscreen
Liquid Glass captures have limitations. See [Testing](docs/TESTING.md).

## Scripts

| Command | Description |
| --- | --- |
| `bun run setup` | Run `install.sh` on this checkout (install, build, link, open) |
| `bun run dev` | Build and launch the native app |
| `bun run build` | Build `out/native/Trezi.app` (Swift, bundled Bun and backend) and the isolated preview |
| `bun run start` | Launch the existing native build from the checkout (development) |
| `bun run typecheck` | Check backend/native/shared code and preview code |
| `bun run test` | Unit and native integration checks |
| `bun run test:native` | Native integration only (native runtime + chat scroll/reveal) |
| `bun run test:native-live` | Real provider fixture edit (credentials required) |
| `bun run test:provider-live` | Claude/Codex parity, in-process vs helper (`TREZI_LIVE_PROVIDERS=1`) |
| `bun run verify` | All tiers, including real provider calls |

The `dev:native`, `build:native` and `typecheck:native` aliases remain supported.
Swift changes require rebuilding/restarting; there is no application HMR server.
WebKit rendering may differ from Chromium. Older macOS releases and iOS Simulator
still need release validation; see [current limits](docs/NATIVE.md).

### Compose UI from project components

Enable **Settings → Experimental → Gen UI** to have Claude or Codex compose React or Svelte
UI from the opened project’s components and styles using json-render. This is
experimental and off by default. The setting is saved on this device and captured
when you submit a message. Turning it off restores ordinary editing and keeps
generated source. Choose **Jev layout engine** as the UI layout method to try
Jev with your saved Vercel AI Gateway connection from Settings. See [scope and workflow](docs/PROJECT_UI.md).

### Native chat motion

The active response shows a text-only status line for thinking, writing, tool
work and user waits. Completed responses show “Worked for…” elapsed time, including
waits and landing; hover over a message or commentary block for its timestamp.
New turn timings survive history restoration; legacy durations remain absent.
Token totals stay in the footer.
New prose words softly resolve on
macOS 15+; older systems show text immediately. Reduce Motion disables the reveal
and status animation. The composer button beam runs only during active generation,
not idle drafts, approval waits, stopping or applying completed changes.

### Projects and data from earlier versions

Trezi had earlier names. Profiles, conversations, settings, environment variables,
installs and project setup files from those versions keep working; the
compatibility rules are listed in [legacy names](docs/agent-guide/legacy-names.md). When
you open a project that still uses the earlier setup file names, Trezi renames them.
It does this automatically when the Git tree is clean. When the tree has
uncommitted changes, it asks first. It never commits.
