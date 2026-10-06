# Changelog

All notable user-visible changes to Trezi are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Trezi uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, a minor
release carries new features or breaking changes and a patch release only fixes.

Every change that alters user-visible behaviour adds one line under Unreleased.
`bun run release <major|minor|patch>` moves those lines into a dated version section.

## [Unreleased]

### Added
- Native macOS app: a Swift/AppKit chat and shell beside the project's live preview in system WebKit, started with `open -a Trezi` or `trezi`.
- Trezi Service: a Swift XPC service that owns the profile lock, the operation ledger, and every write to preferences, workspaces, memory, repositories, sources, conversations and providers.
- Provider helpers: Claude, Codex and Responses-API providers run in separate helper processes that the service supervises, with clearer cold-start status and sign-in handling.
- Inspector island: element controls open from chat, show authored fields by default and apply live to the source, with one Undo per gesture.
- Editor toolbar and a popped-out source editor with a file tree.
- Versioning: Settings › General and `trezi --version` show "Trezi X.Y.Z (build N, short sha)"; About Trezi shows the same; `bun run release` cuts tagged releases with this changelog.

### Fixed
- Select mode highlights the hovered element again, and pointer moves over the preview are no longer slowed by a window hit test; the editing island still keeps hover, clicks and scrolls from reaching the page beneath it (LKM-173).
- Unstamped elements now explain why source editing is unavailable, offer Connect and Ask the agent, and allow direct edits when one project CSS class rule can be identified (LKM-174).
- Shadow Light drags on the iPhone Frame Shadow island no longer flicker in the live preview while the source is written once at the end of the gesture (LKM-140).
- Stop never leaves a broken project: a stopped turn's edits are held, not applied, with one-click Revert (undoable), Keep or Ask agent to finish; a dev-server error in a file the last turn touched offers Revert last turn and Fix with agent; a paused queue says whether it will send and has Send now (LKM-151).
- Connect to Trezi works from any chat, including one with a stopped turn, and stamps React on Vite 7 and Vite 8 through a Trezi Vite plugin; Not now, a connected project and a failed setup (with its exact reason and Retry) are remembered across relaunch, and the card disappears once the preview has stamps (LKM-153).
- A chat running in its own worktree can no longer write the live project from a shell command (Claude) or from Codex and Responses connections; the agent is pointed at its worktree copy instead (LKM-156).
- A connected project whose restarted preview shows no source-mapped element for the whole grace period now offers "Source links stopped working" with Reconnect; stamps returning hide it, and Not now is remembered across relaunch (LKM-157).
- Agent turns started from the Inspector, Styles, Props, inline text edits, custom controls and Layers moves name the source relative to the project, so a chat's edits land in its own worktree instead of the live checkout (LKM-155).
- A chat whose changes were held, for example after failed Codex turns and a switch to Claude, can land again: Resolve is no longer blocked, a landing that fails shows its reason with Retry, Resolve and Discard, and the agent no longer reports edits as pending forever (LKM-165).
- Long chats no longer slow the app: typing, adding an attachment and switching preview modes no longer re-send and re-decode the whole conversation (LKM-165).
- Codex can use Trezi's own tools, such as checking whether its edits landed, without being refused (LKM-165).
- "This chat is already running" is never a dead end, and stuck turns recover: the activity row names what is running (landing, holding changes, combining), Stop works on it, a step with no progress ends on its own with a note, and a message sent meanwhile waits in the queue (LKM-165).
- A message sent while a chat needs Resolve no longer fails with "Unable to send" and a duplicate: it waits in the queue marked "Waiting for Resolve" and sends after Resolve lands; every block (a running turn, a landing, Resolve, provider sign-in) queues the message with its reason, and queued messages can be edited or removed (LKM-169).
- A failed Claude resume recovers automatically: after a restart a chat no longer shows "No conversation found"; Trezi starts a new session in the same worktree, seeded with a summary of the chat, and says so in one note (LKM-165).
- Send feedback can attach diagnostics with your consent: the last hour of logs, the chat's landing state and git status, and a short sample of the app when it is busy, with secrets removed and home paths shortened (LKM-165).
- Image and SVG attachments in a sent message no longer render as huge images that push the text down: they show as compact thumbnails in a wrapping row (transparent images on a checkerboard), name the file on hover and open a larger preview on click; composer attachments use the same compact tiles (LKM-166).
- SVG and other non-image or oversized attachments no longer fail the turn (“The pasted images are not supported or too large.”): the agent gets the original's path plus a 512 px PNG preview for an SVG, other files by path, oversized images downscaled, and a note for anything that could not be attached (LKM-166).
- The editing inspector island takes every click, scroll and hover inside its frame: the preview beneath no longer hovers or selects through it, and its controls sit on an opaque surface instead of showing the page through (LKM-162).
- Codex chats work again when the project or the chat's workspace path contains a symlink (for example an upgraded profile's `Trezi Native` folder) instead of refusing every file command (LKM-163).

### Changed
- Settings redesign: one native window with a General, AI Providers and Experimental sidebar that saves automatically.
- Renamed the app to Trezi; projects that use the earlier setup names are migrated once on open.
- Builds sign Trezi with a stable local identity when possible so Keychain “Always Allow” and privacy grants survive rebuilds; after updating, approve the Keychain once more, then not again.
- Connection keys and the subscription token are encrypted through `Contents/Helpers/TreziSecrets`; the master key lives in `dev.trezi.native.secrets`, migrated once from the earlier item name.
- Chat: the token counter only shows while a turn runs, on its own line under the status; Copy/Revert under a response appear on hover or keyboard focus, without moving the layout.
- Chat: steadier scrolling and follow behaviour, composer attachments as thumbnails, queued messages, interactive islands in the conversation and more reliable Stop and recovery.
- Chat: per-turn token counts show inline with the working status while a turn runs and under each response’s Copy/Revert row when it finishes, instead of pinned above the composer; scroll-to-latest is a centered round control just above the composer, with transcript content faded out behind it when you have scrolled up.
- Preview toolbar: the address/branch block fills the free width up to the right action groups and follows window resizes live; a long URL truncates in the middle and a branch at its end only when space is short.
- Chat: one live status line names the current step with its elapsed time (“Running bun test · 1:24”), the running turn’s token counter grows as Claude streams and sits on its own line under it until the turn ends, and “No activity for N min” appears only when the provider’s heartbeat stops; the duplicate “Still thinking…” row is gone.
- Current Claude and Codex models: the bundled Claude Agent SDK (0.3.289) and Codex SDK/CLI (0.160.1) are updated, so Opus, Sonnet and Fable run the current models (Opus 5.5, Sonnet 5.5, Fable 5.1); the chat's model picker shows the model a Claude session actually runs (e.g. "Opus 5.5", "Default · Opus 5.5"), the model list refreshes daily and right after an SDK update, and the Codex fallback list, background comments and PR descriptions use `gpt-6-sol`/`gpt-6-astra` (LKM-164).
- Activity opens by itself only for problems that need you (a failed project open, a dev server that keeps crashing), once per kind per session; startup recovery notices are gray and collapsed into one line, unread warnings show a dot in the sidebar, Window → Activity (⌘L) opens it, and Settings → General → Show Activity automatically chooses Never, For problems that need me or Always.
- Agents have full file access by default: Settings → General → Agent file access lets them read and write anywhere you can, with network access (Full access), or keeps Codex to the chat's copy of the project (Project only). Chats still work in their own copy, and a Codex turn that edits, reverts or commits in the live project says so in the chat (LKM-163).
- Sent feedback shows a short "Feedback sent — View on GitHub" toast in the window instead of a separate "Feedback sent" window; a failed post opens a standard sheet with Retry and Copy details, and confirmations and alerts (updates, preview problems, deletes, restarts) are standard macOS sheets on the main window with Return for the default button and Esc to cancel (LKM-170).

### Fixed
- Chat: the transcript no longer goes blank after sending until scrolled.
- Keychain: moving the master key from the earlier item asks for your password once instead of once per saved key, and no longer asks again when you take a while to answer.
- Chat: the first Claude chat explains once why macOS may ask about files on a network volume.
- Chat: following the conversation no longer leaves the latest message partly under the composer; past responses are compact again, without the empty counter line under Copy/Revert.
- Check login and provider helpers no longer use your home folder as the working directory, which could make macOS ask Trezi for Photos access when Claude scanned `~/Pictures`.
- Preview: dependency changes no longer break it. A chat's installs stay in its own worktree until they land; landing shows "Installing dependencies…" and reloads the preview. A dev server that crashes or stops responding shows why and restarts itself with backoff, with a Restart button.
- Applying a chat's changes: on newer Git (2.55) an unreadable patch reports the file and line (e.g. "a.txt: corrupt patch at line 7") instead of a temporary patch path, as on older Git.

### Removed
- The Electron app, the React renderer, browser and Tailscale modes, and the old in-page content controls.
