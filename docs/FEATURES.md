# What Trezi does

Trezi is an AI design and prototyping tool for your own repositories. Open a project:
Trezi runs its dev server in a live preview on the right, and an AI chat on the left
edits the running app using the selected provider's native harness. Unlike a sandbox,
Trezi edits *your real repository* with live hot-reload, and hands the result off as a
branch and GitHub PR. Install: [INSTALL.md](INSTALL.md).

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
  (Gemini is optional: off until turned on in Settings → AI Providers). Their
  capabilities differ; see [`docs/PROVIDERS.md`](PROVIDERS.md).
- **Peer chats and project memory.** Every project has a flat set of isolated,
  independently named chats, with background agents nested under the chat that
  launched them. After successful turns, Trezi conservatively learns durable
  decisions into unified project memory shared by every chat; it lives outside Git
  and remains directly editable. See [`docs/MEMORY.md`](MEMORY.md).
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
  [`docs/DESIGN.md`](DESIGN.md)), then edits its **props** with typed
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
  returns to the running screen. See [3D inspection](THREE_D.md) for controls
  and first-version rendering limits.
- **Preview observation.** Claude and Codex can request the current preview route
  and a screenshot (whole view or one element). They can also inspect an element's
  box and computed styles, run read-only bounded JavaScript, read console errors,
  and resize the preview for phone/tablet/desktop checks. All of this runs in the
  WebKit preview, isolated from the page. Codex-based custom endpoints expose the
  same tools; viewing screenshots requires an image-capable model. Vercel
  agent-browser remains required for browser verification during UI changes.

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
  successful landing; see [`docs/WORKTREES.md`](WORKTREES.md).
- **iOS Simulator preview** for Expo/React Native projects (Metro detect + an
  MJPEG bridge into the preview pane).
- Tool calls run behind approve/deny cards, or an Auto mode. Edits are
  undoable (`Cmd+Z`) via an edit-history stack.

## Compose UI from project components

Enable **Settings → Experimental → Gen UI** to have Claude or Codex compose React or Svelte
UI from the opened project’s components and styles using json-render. This is
experimental and off by default. The setting is saved on this device and captured
when you submit a message. Turning it off restores ordinary editing and keeps
generated source. Choose **Jev layout engine** as the UI layout method to try
Jev with your saved Vercel AI Gateway connection from Settings. See [scope and workflow](PROJECT_UI.md).

## Native chat motion

The active response shows a text-only status line for thinking, writing, tool
work and user waits. Completed responses show “Worked for…” elapsed time, including
waits and landing; hover over a message or commentary block for its timestamp.
New turn timings survive history restoration; legacy durations remain absent.
Token totals stay in the footer.
New prose words softly resolve on
macOS 15+; older systems show text immediately. Reduce Motion disables the reveal
and status animation. The composer button beam runs only during active generation,
not idle drafts, approval waits, stopping or applying completed changes.
