# Provider capabilities

S02 supervises the legacy Bun backend from a separate Swift XPC service. Provider
SDKs and authentication remain in Bun; the UI connection grants no provider/parser
role or preview capability. No provider call is required by the deterministic
[service lifecycle fixtures](SWIFT-BACKEND-SERVICE.md).

Since LKM-98 (S10) every provider session is opened with the Swift service's provider
owner, which fixes the session's grant (Trezi tools, roots, chat), answers its
permission requests, authorizes its Trezi tools, holds Stop's deadline and persists
resume ids; the adapters ask instead of deciding. Credentials stay in their own stores.
Provider helpers (one supervised process per session, held to its grant) are built
and verified with a fake provider; the real adapters move into them after an
authorized live run. See [providers](SWIFT-BACKEND-PROVIDERS.md).

PR publishing uses a separate read-only Codex turn with `gpt-5.6-luna` and low
reasoning effort through the built-in Codex account. It summarizes the committed
merge-base diff after reconciliation, without chat or commit messages. Titles are
bounded to 72 characters and descriptions to 120 words. The turn has a 60-second
timeout; generation or PR-update failures are surfaced for retry, without a
conversation-based fallback. This requires Codex sign-in even for Claude chats.
Large patches are capped at 100,000 characters and marked as truncated.

Trezi has one `ProviderSession` seam, not one identical capability set. A model keeps
the native tools and behavior of its harness; Trezi must gate UI and prompts by declared
capabilities instead of assuming Claude, Codex, gateways, and Gemini are interchangeable.

| Capability | Claude Agent SDK | Codex SDK | Custom gateway | Gemini (experimental) |
| --- | --- | --- | --- | --- |
| Persistent multi-turn context | Yes | Yes | Yes, through Codex | No guaranteed continuity |
| Repository instruction discovery | `CLAUDE.md` + Claude skills | Codex-native instructions + Trezi rules | Same as Codex | Limited |
| Skills menu before the first turn | Yes | Yes | Yes, through Codex | Yes |
| Provider-native coding tools | Yes | Yes | Depends on model through Codex | Limited |
| Trezi preview location/screenshots | Yes | Yes | Yes, image support depends on endpoint | No |
| On-demand native chat islands (`chat_island`) | Yes | Yes | Yes, through Codex | No |
| Open mini code editor / highlight exact source | Yes | Yes | Yes, through Codex | No |
| Trezi worktree control tools | No | Yes | Yes, through Codex | No |
| Trezi question cards | Yes | No | No | No |
| Trezi approve/deny cards | Yes | No SDK approval event | No SDK approval event | No |
| Image input | Yes | Not wired | Not wired | Not wired |
| Resume provider thread | Yes | Not wired | Not wired | No |
| Detached background agents (comments + visual edits) | Yes | Yes | Yes, through Codex | Disabled |
| Custom endpoint | No | Built-in ChatGPT seat | Yes (`/responses`) | No |

“No” often means Trezi has not built the bridge, not that the underlying model can
never support the feature. Codex and gateway sessions receive a session-scoped local MCP
server with `workspace_state` and `prepare_conflict_resolution`: the former reads the
landing coordinator rather than guessing from the private checkout, while the latter
routes the existing three-way resolver through Trezi's repository queue. It deliberately
does not expose raw Git or discard/reset operations. Interactive tuning uses
`chat_island`, scoped to the originating chat and assistant turn. The legacy
`define_controls` and `open_controls` tools are no longer registered; the socket
bridge rejects those actions. Islands validate source anchors in the agent's
checkout and become editable after the source lands in the live project.
Preview location and screenshot tools share the native capture implementation across
Claude and Codex; screenshots are returned as MCP image content. Design calculators remain Claude-only;
question cards, resume, image transport, and background-agent support are separately
declared because they have different lifecycle and security requirements.

Preview comments use the originating chat's provider: Claude subscriptions run
the `sonnet` alias (latest Sonnet), Codex subscriptions run `gpt-5.6-sol`, and
Gateway/custom connections keep the chat's exact model and connection. The choice
is captured when submitted, including queued comments, without changing the chat.
Comments inherit reasoning effort and start a fresh provider session in an isolated
worktree. Native cards expose provider status; startup failures are reported instead
of silently retrying in the main chat. Non-repositories and unsupported backends
retain the interactive fallback, pinned to the originating chat.
Committed visual edits inherit the originating chat's selected provider/model.
AI fallbacks from text, props, styles, custom controls, and layer moves start detached children immediately on Claude and Codex
(including custom endpoints). The main draft and transcript stay intact; successful
results auto-land and refresh the preview. Failed or interrupted results never
auto-land. A provider without background support or a folder without Git worktree
support preserves the instruction in the composer and explains the fallback.
The rail always shows the harness/model the child actually received.

Until capability negotiation exists in `src/shared/api.ts`, the product should avoid
promising unsupported actions in backend-agnostic copy. Open-model connections inherit
the Codex harness's strengths and gaps; changing the model id does not grant Claude's
design calculators. Preview observation is available through the shared MCP bridge,
but image understanding depends on the endpoint model. It also retains Trezi worktree-control tools
because those belong to the harness, not the selected endpoint model.

## Required browser verification

Providers with Trezi's preview tools (Claude, Codex and Codex-based endpoints)
must verify web UI in the Trezi preview (LKM-138): `preview_screenshot` (optionally
cropped to a `selector`), `preview_inspect`, `preview_evaluate`, `preview_console` and
`preview_viewport` for phone/tablet/desktop checks, restored before finishing.
agent-browser is only for scripted multi-step interactions (clicks, typing, flows),
never just to inspect, evaluate or screenshot. Each task uses its own named browser
session. Missing CLI/browser support is reported; installation requires user
permission. Providers without the preview tools keep the agent-browser rule: check
CLI availability and use it for responsive checks with screenshots. An explicit user
tool choice takes priority.

The tools run as isolated WKContentWorld scripts (`src/preview/agent-inspect.ts`,
`src/preview/agent-evaluate.ts`, `src/preview/agent-console.ts`), driven by
`src/main/preview-agent-tools.ts` and `src/native/PreviewAgent.swift`. Inspect,
evaluate and console run in a dedicated world with no message handler, so the page
cannot see them or reach Trezi through them. `preview_evaluate` is read-only by
construction, not by convention. The expression is parsed first, and loops, labels,
`with`, `debugger` and dynamic `import()` are rejected. It then runs against a
membrane over `window`/`document`: writes, deletes, `defineProperty`, navigation,
storage, cookies, network, timers and the Function constructors throw, and calls pass
only through an allowlist of read-only DOM methods. Results are JSON, clipped to
64 KB and given 2 s. A known gap: unbounded async recursion (a microtask loop) can
still keep the page busy until the time limit returns the tool. `preview_viewport`
fits a CSS width with page zoom and only works on the foreground preview.

Preview observation is on demand and shows the current user view, not necessarily
the calling chat’s private worktree. Codex screenshot tool output is separate from
composer image attachments, which remain unwired. Restart existing provider sessions
to pick up the new tool configuration and instructions.

This is prompt-level enforcement, not a runtime tool-call gate. Existing sessions
need to be recreated to receive updated rules. A preview still serving code from
before a private worktree edit cannot verify that edit; the agent must report it as
pending instead of bypassing Trezi's landing lifecycle or claiming success.

## Skills menu and Codex runtime

Trezi bundles Codex SDK/CLI 0.154.0 or newer; updating the global `codex` binary
alone does not update the runtime used by Trezi. Run `bun install` and rebuild
after pulling a dependency update.

Codex, custom endpoints, and experimental Gemini discover project and user skills
in `.agents/skills`, their native `.codex/skills` or `.gemini/skills`, and
`.claude/skills` for compatibility with Trezi-installed packs. Codex honors
`CODEX_HOME` for its user skills. Project entries shadow same-named user entries;
symlinked installs and Codex system skills are included. Menus populate before
the first turn, independently of authentication. Invoking `/name` supplies the
selected skill file path in the prompt so the harness can read its instructions.
Claude keeps its native SDK command discovery.

## Switching models within a chat

Changing a model or provider in a nonempty chat requires confirmation: replaying
its recorded conversation consumes additional input tokens on the next message.
Cancel preserves the current choice. Empty chats do not need this confirmation,
and model/provider controls are disabled while a response or switch is running.

Every picker change starts a fresh session for that chat, preserving its private
worktree and transcript. Its first user turn includes the prior user/assistant
text and tool summaries once; later turns rely on the new provider's own context.
This handoff stays out of the displayed/saved transcript and does not reuse a
previous provider's SDK session id. Past image bytes and full tool outputs are
not present in the transcript and are not replayed. Large histories may reach the
selected model's context limit; Trezi does not silently truncate the conversation.

## New-project setup conversations

New Project offers the deterministic React/Vite starter or an empty Git repository
for Next.js, Svelte, or a custom environment. Discussion choices submit a short
planning request to the selected provider. Shared Trezi rules ask for unresolved
project/environment choices before scaffolding; an explicit choice is not asked
again. Claude can use its question cards; Codex and gateways ask in ordinary chat.
The model's conversational behavior remains prompt-guided. Creating the empty
repository itself does not install packages or choose a framework.

Preview refresh is provider-independent once edits land: manifest/lockfile changes
install dependencies in the live checkout, framework config changes restart the
managed web preview, and both re-detect the current launch settings. The provider's
terminal event alone does not prove that private edits reached the live checkout.

Composer queues are managed by Trezi for every provider. They submit separate
turns in order, preserving the originating chat, file/image attachments, and
selection context. They do not depend on provider-native steering support; image
interpretation remains subject to the capability table above.

The bundled `surface-controls` skill requires `chat_island` for on-demand tuning
controls inside the conversation. Claude and Codex/custom endpoints support this
route; Gemini must explain that native registration is unavailable. Existing
literal constants can be bound directly without rewriting the project. Optional
Replay dispatches `trezi:animation-replay` with the component name as its string
detail. Source edits use island Undo/Reset and HMR; a separate inspector or project
panel is not a substitute for a requested chat island.

`open_code` opens the docked editor at a repo-relative file and an inclusive line
range. Main validates the file boundary (including symlinks) and captures the exact
source text from the agent checkout. The active project/chat reveals it only when
that text exists in the live checkout, retrying after landing. Dirty editor drafts
defer navigation until saved or discarded. Detached agents cannot navigate the
editor. The transport also works in browser mode.

`open_preview` accepts a project-root path with optional query/hash for Claude
and Codex/custom endpoints. It uses the native preview navigation
and waits for the active turn's landing and a running web preview. Requests are
scoped to the active project/chat and discarded on a switch, failed turn, or parked
landing; detached agents cannot navigate. External origins and simulator routes
are unsupported. The tool reports a request, not proof that the page loaded.
Gemini does not expose this tool.

The Codex MCP helper uses an absolute path and working directory rooted at the
Trezi installation, independent of the target checkout. Before starting a session,
Trezi checks the real helper’s tool inventory and authenticated workspace socket.
The server is required on every Codex turn/resume, so initialization failures stop
the turn instead of silently dropping inline controls and preview tools. This check
does not call a model. These session-scoped tools are not installed into separate
Codex or Claude application chats.

The SDK session pre-approves every Trezi tool (navigation, `chat_island`, preview,
UI catalog, `workspace_state` and `prepare_conflict_resolution`) via its per-tool
approval configuration, matching Claude's in-process allowlist. Sessions run with
approvals disabled, so a tool left out is refused outright: before LKM-165,
`workspace_state` was, and Codex reported "requires approval, but this session
disables approvals". `test/codex-mcp-approvals.mjs` pins the list. Other MCP tools
and shell approval policy keep their existing configuration.

Trezi's Codex sessions (chat turns and the project-memory pass) run only the MCP
servers Trezi passes. The CLI merges `--config` tables into the user's
`$CODEX_HOME/config.toml` (default `~/.codex`), so `isolatedCodexConfig` in
`src/main/backends/codex-mcp.ts` re-reads that file each turn and sends
`mcp_servers.<name>.enabled=false` for every server it declares. It only names declared
servers, because the CLI rejects the whole config ("invalid transport") for an unknown
name. Project `.codex/config.toml` files in the target repo are not changed (LKM-113).
`test/codex-mcp.mjs` proves this against the real CLI with a fixture `CODEX_HOME`.

`mcp_servers` is not the only source (LKM-126). An installed Codex plugin
(`[plugins."vercel@openai-curated"]`) starts the servers in its own `.mcp.json`, which is
where `https://mcp.vercel.com` and its rmcp `AuthRequired` came from, and the `apps`
feature starts the ChatGPT account's connectors. Neither is declared in `mcp_servers`,
so `isolatedCodexConfig` also sends `features.plugins=false` and `features.apps=false`
on every run. Both paths use it, because the helper runs the same adapter.
`test/codex-mcp.mjs` adds an installed-plugin fixture: the real CLI lists its server
without isolation and not at all with it.

Claude chats get the same isolation (LKM-138). They keep the repo's and the user's
`CLAUDE.md` files and skills (`settingSources`) and Trezi's bundled plugin. They do
not load the user's own Claude Code plugins or MCP servers. `claudeIsolationOptions`
in `src/main/backends/claude-isolation.ts` sets `strictMcpConfig: true`, so only the
servers Trezi passes start; this also skips the target repo's `.mcp.json`. It sends
`settings.enabledPlugins` with every plugin listed in the user's
`$CLAUDE_CONFIG_DIR` (default `~/.claude`) `plugins/installed_plugins.json` and
`settings.json`, and in the repo's `.claude/settings*.json`, set to `false`. Flag
settings outrank user, project and local settings. Title and project-memory queries
always use `strictMcpConfig`. **Settings → General → Allow my Claude Code plugins in
Trezi chats** (preference `trezi:claude-user-plugins:v1`, default off) lifts both
for new chats; the helper reads it each time a session opens.
`test/preview-agent-tools.mjs` checks the options with a fixture config dir, and
`test/native-settings.mjs` checks the default and persistence.

## Framework setup context

Next setup is separate from generic React/Vite setup. The agent receives the
installed Next version (or an explicit missing-version state), selected script,
bundler, router layout, and helper hashes. Helpers are synchronized into the agent
checkout before the provider receives the turn. Setup asks for config integration,
not bulk component annotations. A TypeScript checker supplements unresolved
react-docgen schemas when an individual component is inspected.

Next's development adapter wraps the final config export, preserving functions,
async exports, existing wrappers and webpack callbacks. Conflicting Turbopack
rules require deliberate composition. Optional MDX uses a development-only remark
plugin supplied as an absolute path string. Production leaves the original config
unchanged; loaders and the remark transform independently disable outside dev.
Setup waits for landing and new-document stamp observations before reporting success.

React on Vite (LKM-153) uses Trezi's own Vite plugin, `.trezi/trezi-vite.mjs`
(`src/main/setup-vite.ts`), for every Vite version and React plugin. It is
`enforce: 'pre'` and `apply: 'serve'` and runs the unchanged `trezi-source.cjs`
visitor through the project's `@babel/core` (parse and print only) before Vite's own
JSX transform. Vite 8 transforms with Oxc and `@vitejs/plugin-react` 6 has no
`babel` option, so `react({ babel })` no longer stamps; `plugin-react-swc` never
had one. The prompt names the detected Vite and React plugin versions and asks for
`trezi()` first in `plugins` plus `@babel/core` as a dev dependency. React without
Vite keeps the Babel plugin; plain HTML is stamped by the dev server's HTML path
(`src/main/html-source.ts`) and offers no setup.

The outcome is remembered per project in its workspace entry (`sourceSetup`:
`done`, `declined` for Not now, or `failed` with the reason) and survives relaunch.
The card shows only while the preview has no stamps and the user has not declined.
Stamps in the preview hide it and record `done`. A failure shows the exact reason
(Trezi's own error, the stopped or held setup turn, or the dev server's
`[trezi-source]` line when the restarted preview stays unstamped) with Retry.

## Automatic text reconciliation

Successful interactive turns use the shared landing coordinator to merge independent
text edits and, for overlapping text, send one reconciliation continuation to the
same provider session. This applies to Claude, Codex/custom endpoints, and the
experimental Gemini seam without adding provider-specific tools. The configured
permissions still apply. Stop, failure, an unavailable session, or unresolved markers
leave the work recoverable with the manual Resolve/Discard fallback. Detached agents
retain their existing landing policy.

## Project component composition

Claude and Codex expose the read-only `project_ui_catalog` and `compose_project_ui`
tools. Main enables them per chat only when a submitted message explicitly opts
in through Settings → Experimental → Gen UI. Catalog/export supports React and the
documented Svelte subset; each output tree uses one framework. Gemini receives a limitation notice.
The tools use the current worktree and return source for ordinary edits and landing;
see [PROJECT_UI.md](PROJECT_UI.md). Settings can select the current chat model or
Jev as the composition engine. With Jev, Claude/Codex prepares candidate props and
copy, and a separate Gateway evaluation selects the composition. Jev requires a
main-process Gateway credential, reusing the encrypted connection saved in Settings,
and never silently falls back to another engine. The selected Gateway connection
wins; otherwise the sole saved Gateway is used. Environment overrides and ambiguous
connection handling are documented in PROJECT_UI.md.

Claude and Codex/custom endpoints expose Jev selection in `chat_island`. Its
`auto`/`jev` modes fall back to the chat model’s validated candidates only when no
Gateway key is configured, returning the actual engine and fallback reason. The
bundled `surface-controls` skill is portable across providers; experimental Gemini
explains its missing tools. The `content_controls` tool was removed with content
controls in LKM-114.

Codex's routine skill-description context-budget advisory is omitted from chat
activity. Skill availability and provider context limits are unchanged. Other
item-level warnings remain visible with their full text, once per item per turn.

## Native chat islands

Interactive Claude and Codex/custom-endpoint sessions expose `chat_island` with
catalog, define and read actions. Definitions bind literal values in the session's
source tree and attach to its native conversation. Detached/background children
cannot create islands. The default auto engine uses saved Gateway credentials for
Jev to select/order whole prepared blocks; missing credentials use the agent's
layout with explicit fallback reporting. Runtime failures are not hidden.

Control-capable providers receive the same selection/verification guidance that
`chat_island` returns in its catalog, maintained in
`src/shared/chat-island-guidance.ts`. The bundled surface-controls skill reads
that catalog and applies it to source inspection, parameter semantics, replay and
preview/Undo checks. This is agent guidance, not automatic proof of runtime
reactivity; the host independently validates literal bindings and transactions.
The catalog remains available to existing sessions after an app update, while
new provider sessions receive the updated initial operating rules.

Native interactions call Bun source services directly and do not invoke a model.
Current values and island revisions enter the next provider turn as application
context, separately from the visible user transcript. See [CHAT-ISLANDS.md](CHAT-ISLANDS.md)
for the catalog, limits and verification status.

## Chat timing and control preparation

The shared transcript captures assistant timestamps at their first streamed chunk
and turn completion on the initiating user entry after landing/reconciliation.
Native chat shows elapsed turn time and message/commentary timestamp tooltips;
legacy records without completion metadata omit duration.

Control surfacing publishes a disabled source-validated draft before Jev finishes
selecting/ordering its blocks. Drafts are ephemeral and removed on failure or
cancellation; only completed definitions persist. Controls still activate after
successful landing. Redefining an island from an earlier turn creates a new ID
and attaches it to the current response; same-turn definitions still update in
place. Callers must use the returned ID/revision for subsequent updates.
Operating rules v23 and the surface-controls skill prioritize
existing bindings and early definition, without inventing unrequested effects or
running redundant builds when no source was changed. Required project checks still
apply to code changes. Existing provider sessions need fresh instructions to pick
up these guidance changes.

Legacy profile/worktree paths and the identities kept on purpose are listed in
[legacy names](agent-guide/legacy-names.md).

## Claude seat login (LKM-119)

**Symptom.** Claude chats answered "Not logged in · Please run /login" (as assistant
text) or stayed on "Thinking…" forever, although `claude` worked in Terminal. Typing
`/login` in the chat gave the same reply.

**Root cause (what was checked, without live calls).**

- The helper runs the SDK's bundled CLI (2.1.186 at the time), not the installed one
  (2.1.285 here). Both read the same credentials: the Keychain item
  `Claude Code-credentials` for account `$USER` (fallback `claude-code-user`), then
  `~/.claude/.credentials.json`, or `CLAUDE_CODE_OAUTH_TOKEN`. The bundled CLI read a
  login written by the installed one, so version skew was **not** reproduced.
- Both CLIs report `loggedIn: false` when `USER` is missing: the Keychain lookup is
  keyed by it. A missing `HOME` or `PATH` did not matter. The helper allowlist passed
  `USER` only when Trezi's own environment had it, so a launch without it (launchd,
  `open -a` in some setups) logs the helper out. The helper now fills
  `USER`/`LOGNAME`/`HOME` from the account record and gives `PATH` a default.
- Other causes that match the report: a login that exists only in the shell, i.e. a
  `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` exported in `.zshrc` (Trezi sees
  it only if its 5 s login-shell environment read succeeds), or a `CLAUDE_CONFIG_DIR`
  set only in the shell. Trezi does not override `CLAUDE_CONFIG_DIR`.
- `/login` cannot work under the SDK: it needs Claude's interactive terminal UI.
- The endless "Thinking…" was a helper turn with no deadline: a CLI that never sent a
  first event kept the turn open.

**What Trezi does now.**

- Settings → AI providers → Claude… stores a **subscription token** from
  `claude setup-token` (encrypted like a connection key, `<profile>/trezi/seat-tokens.json`).
  Only Claude helpers get it, as `CLAUDE_CODE_OAUTH_TOKEN`; it is never logged, never
  in `TREZI_*` variables, other helpers, replies or reports.
- Before its first query a Claude helper runs `claude auth status --json` with the
  bundled CLI. When that is logged out and an installed `claude` (PATH,
  `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`) is logged
  in, the session uses the installed one (`pathToClaudeCodeExecutable`,
  `src/main/backends/claude-login.ts`).
- A sign-in failure (and `/login` or `/logout` typed in the chat, which never reach the
  model) is an `auth` error: the chat shows a "Not logged in to Claude" card with the
  steps (`claude auth login`, or `claude setup-token` plus Settings), **Check login**
  and **Retry** (a fresh helper, then the last message again). A turn with no first
  event within 90 s ends with "Claude did not respond — check login (claude auth
  status) and retry" in the same card. A helper crash or exit is always an error.
- **Check login** (the card and Settings → AI providers → Claude…) starts a helper
  exactly like a chat's (environment, token, cwd) that reports each CLI's auth status,
  which one chats use, whether a token is set, and `USER`/`HOME`/`PATH`/cwd.

Tested deterministically by `test/provider-login.mjs` (fake helper and stand-in CLIs).

## Claude cold first turn (LKM-135)

**Symptom.** A healthy but slow first turn ended with "Claude did not respond": the
LKM-119 90 s deadline counted the whole cold path (helper spawn, two `claude auth status`
probes one after the other, a cold CLI start, the model thinking) as silence.

**What Trezi does now.**

- **Phases.** A Claude helper reports `phase` frames to the owner: `auth` (the probe, or
  the cached choice), `cli` (the CLI answered `initialize`), `init` (the turn's session
  started) and `progress` (system messages such as a request or retry before any output,
  at most one per second). The owner logs each one at debug level in the service log
  (`debug provider claude <id>: helper ready … / auth probe … / CLI started … / session
  init … / first model event … ms after send`). The token is never logged.
- **Deadlines follow the phase.** A turn sent while the CLI has not started keeps the
  90 s deadline (a hang at the process level). Once the CLI is up, the wait for the
  session init and the model's first output is 10 minutes (`replyTimeout`), renewed by
  every phase or progress report, so a helper that is alive and making progress is
  never stopped. After 20 s without output the chat's status line reads "Still starting
  Claude…" or "Still thinking…" instead of an error (a `progress` step since LKM-147, not
  a transcript row). A real hang still ends with the no-response
  card, and its message names the phase, e.g. "Stopped while starting the Claude CLI
  (no answer in 90 s)". A helper that exits before any output also names its phase.
  The init's resume-id record no longer counts as output.
- **Probes once, in parallel.** The bundled and installed CLIs are probed at the same
  time. The owner keeps the logged-in choice for the app session and passes it in each
  Claude helper's `open` frame (`cli`), so later chats skip the probes. An installed
  executable must still be executable. A sign-in failure (`auth` error), a saved token
  and **Check login** clear the cache, so the next chat probes again.
- **Pre-warm.** Opening a project or chat starts its Claude helper and CLI right away
  (the session starts with the chat), so the cold start overlaps the user's typing; the
  `cli` phase is logged before anything is sent.
- Codex and Gemini report no phases yet and keep the 90 s deadline.

Tested deterministically by `test/provider-cold-start.mjs`: the real adapter in the real
helper under the owner fixture, with stand-in CLIs and scaled deadlines (0.5 s for 90 s,
2.5 s for 10 min).

## Live turn progress (LKM-147)

- **One status line.** The chat shows one status line per running turn: the current
  step (thinking, writing, a tool's status, or the owner's "Still thinking…" step) and
  its elapsed time, e.g. "Running bun test · 1:24". The host ticks the timer itself
  every second from the step's start stamp (`ChatActivityClock.swift`), so nothing has
  to be sent to keep it moving. The duplicate "Still thinking…" transcript row is gone:
  the owner sends it as a `progress` step.
- **Heartbeat.** Every provider helper sends a bare `progress` event about every 5 s
  while a turn is open (`helper-host.ts`). It never enters the transcript and never
  counts as output. When nothing (not even a heartbeat) has arrived for a minute, the
  status line adds "No activity for N min".
- **Live tokens.** Claude chats stream partial messages. Its usage arrives only at a
  message's start and end, so the adapter adds an output estimate of one token per four
  streamed characters (text, thinking, tool input), at most every 250 ms, and the
  authoritative report adds only the rest (`stream-usage.ts`). The counter sits on its
  own line under the status line and is shown only while the turn runs. Codex sends no
  estimate; its counter moves with its usage reports.

Tested by `test/turn-progress.mjs` (estimate, heartbeat, clock), the controller test and
the progress stage of `test/helpers/native-chat-scroll.mjs`.

## Codex seat models (LKM-126)

**Symptom.** After a CLI update, every Codex seat turn that left the model to the CLI,
or picked the top model, failed with "The 'gpt-6.1-sol' model is not supported when
using Codex with a ChatGPT account." `gpt-6.1-sol` is priority 1 in `codex debug
models`, while `gpt-6-sol` and `gpt-6-astra` worked.

**Why no filter.** `codex debug models` lists every model the CLI knows about. It has
no field that says which plans or logins may run a model, so the picker cannot know in
advance.

**Fallback** (`src/main/backends/codex-model.ts`, used by `backends/codex.ts`):

- A seat turn whose run fails with that 400 before any output is retried on a fresh
  copy of the thread with the next listed model. The chat gets one status line, e.g.
  "Codex: gpt-6.1-sol isn't available with your ChatGPT login, so this chat uses
  gpt-6-sol.", and that model is kept for the chat's later turns.
- If every listed model is rejected, the turn ends with a visible error:
  "…and no other Codex model was accepted. Choose another model in the model picker."
- The rejection is remembered for the process. Main also learns it from the status
  line, which crosses the helper boundary unchanged (`provider-sessions.ts` calls
  `noteCodexFallback` in `src/main/codex-seat.ts`). After that, a new chat that asks for the rejected model or for
  Default starts on the fallback (`supportedSeatOptions`), and the picker and the
  persisted catalog leave the model out until the next `codex debug models` probe.
- Connections never fall back: their models belong to the user's endpoint.

`test/codex-model.mjs` drives the real adapter in-process and in the real helper host
under the Swift owner fixture, against a stand-in `codex` CLI that rejects
`gpt-6.1-sol`. The stand-in also asks the real CLI which MCP servers each run's
`--config` leaves on.

**Where the real CLI says it (LKM-128).** Live on CLI 0.159.1 the fallback never
started. The CLI reports the rejection as two stream `error` events whose message is
the API's JSON body (`{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The '…' model is not supported…"}}`),
then exits 1 with only "Reading prompt from stdin..." on stderr. The adapter only
retries before any output, and it counted every item as output, including the warning
items the CLI can emit before the request (e.g. the skills-budget note, which the chat
hides). With a warning item first, the old rule gives exactly the operator's result:
two JSON errors, then the exec error. Now:

- `unsupportedCodexModel` takes a message, an event or its `error` and also looks
  inside JSON text and nested `message`/`detail`/`error` fields, so a stream `error`,
  `turn.failed` or the exec error is detected. It also accepts `'`-escaped and
  typographic quotes.
- Only items the adapter shows as the model's output (`OUTPUT_ITEMS` in
  `backends/codex.ts`) count as output. Warning items and unknown item types do not.
- The stand-in reproduces the real sequence and can put the body only in
  `turn.failed` or only in the exec error, or emit a warning item first. The test
  covers each, in-process, plus a turn with an explicit model. The helper run uses the
  warning item and the real stream errors.

The root cause is inferred from the reproduction; the live CLI output was not
captured item by item. The operator's rerun of `test:provider-live` confirms it.

## Claude seat login from a Claude Code session (LKM-124)

**Symptom.** After LKM-119, on the user's Mac, Check login showed the right `USER`,
`HOME`, `PATH` and cwd, yet the bundled and the installed `claude` both said "not logged
in" inside the helper, while `claude auth status` in Terminal said logged in. The
Keychain item and `~/.claude/.credentials.json` (0600) both existed.

**Cause found and hardened against (not the reported failure's root cause).** The helper
allowlist passed every `CLAUDE_*` variable through, so a Trezi started from a shell
inside a Claude Code session handed the helper that session's variables.
`CLAUDE_CODE_SIMPLE=1` makes the CLI run in bare mode, which never reads OAuth or the
Keychain: `CLAUDE_CODE_SIMPLE=1 claude auth status` reports `loggedIn: false` in
Terminal too (the operator reproduced this). The same pass-through carried the parent
session's `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN`,
`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_EXECPATH`,
`CLAUDE_PID`, `CLAUDE_EFFORT` and others. For Codex, `CODEX_*` let a parent Codex
session's `CODEX_SANDBOX` and `CODEX_SANDBOX_NETWORK_DISABLED` through in the same way.

This is a real defect and is fixed below, but it does **not** explain the operator's
report: their Terminal has no `CLAUDE_*`/`ANTHROPIC_*` variables, so
`CLAUDE_CODE_SIMPLE` is not their failure. The reported failure is a service-context
one: processes started by the Trezi service (provider helpers, the Keychain helper)
could not use the user's login Keychain. LKM-125 ([below](#the-service-keeps-the-users-security-session-lkm-125))
fixes that in the service's plist; the live confirmation is still pending, see
[Keychain and credentials-file diagnostics](#keychain-and-credentials-file-diagnostics-lkm-124).
(From a Terminal shell, `security find-generic-password -s "Claude
Code-credentials"` found the item, exit 0; the service and `TreziSecrets` contexts are
compared in the table there, with the live cells still pending.)

**Fix.** `ProviderHelperProcess.providerVariables` (`src/service/ProviderHelper.swift`)
is an explicit list per provider, not a prefix:

- Claude: `ANTHROPIC_*`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN` (a setup-token
  exported in the shell), `CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`/`_FOUNDRY` and their
  `_SKIP_*_AUTH`, `AWS_REGION`, `AWS_PROFILE`, `CLOUD_ML_REGION`, `VERTEX_REGION_*`,
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`, the mTLS client
  certificate variables and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`.
- Codex: `OPENAI_*`, `CODEX_HOME`, `CODEX_API_KEY`, `CODEX_CA_CERTIFICATE`.
- Every helper: proxy (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `ALL_PROXY`, lower case
  too) and CA (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`) variables.

Any other `CLAUDE*`/`CODEX*` name is dropped, including `CLAUDE_CODE_SIMPLE`. Gemini is
unchanged (`GEMINI_*`, `GOOGLE_*`). The Settings token still overrides
`CLAUDE_CODE_OAUTH_TOKEN` for Claude helpers only.

**Check login** now ends with the provider variable names from Trezi's environment:
"Passed to the helper" and "Dropped (a parent session's or not a user setting)". It
shows names only, never values; the owner adds them (`variableReport`), because the
helper cannot see what it did not get. When `CLAUDE_CODE_SIMPLE` was set, the report
says so (`bare: true`).

**Tests** (`test/provider-login.mjs`, parent-session). A fixture environment carries a
parent Claude Code and Codex session's variables plus user settings. The Claude helper
gets the settings but none of the session variables. A stand-in `claude` that is
logged out in bare mode lets the chat log in. The Codex environment
(`{"cmd":"environment"}` on the fixture) drops `CODEX_SANDBOX*`. Check login lists the
names, flags bare mode and never contains a value. A stand-in logged in only through
`CLAUDE_CODE_OAUTH_TOKEN` refuses a chat until the setup-token is saved in Settings,
then works. The stand-in CLIs are now named by helper arguments
(`--claude-bundled=`, `--claude-installed=`), because the old `CLAUDE_TEST_*` variables
are dropped. No live calls.

### Keychain and credentials-file diagnostics (LKM-124)

The environment pass-through above is not the root cause of the operator's case: their
Terminal has no `CLAUDE_*`/`ANTHROPIC_*` variables, and both CLIs still report
`loggedIn: false` inside the helper while Terminal says `true`. The allowlist hardening
stays; the root cause is still open, and the question is whether a process started by the Trezi service can use the user's login
Keychain. Check login now answers it from inside the helper, with the helper's own
`HOME`, `PATH` and security session (`probeKeychain`, `probeCredentials` in
`src/main/backends/claude-login.ts`). The report shows, and `ProviderLoginReport` types:

- `Keychain: readable from this context` or `not readable from this context (security
  exit N)` (`keychainItem`, `keychainItemExit`): the exit status of
  `security find-generic-password -s "Claude Code-credentials"`, run **without** `-w`/`-g`
  and with stdout and stderr discarded. `readable` means the item was found; its secret is
  not read. "unknown" means `security` did not run.
- `security list-keychains -d user` and `security default-keychain`, one line each
  (`keychainList`, `keychainDefault`). A helper outside the GUI security session shows
  an empty or different list here.
- `Credentials file: <absolute path> exists|does not exist, readable|not readable,
  <size> bytes, mode <octal>` (`credentialsPath`, `credentialsExists`,
  `credentialsReadable`, `credentialsSize`): `<CLAUDE_CONFIG_DIR or $HOME/.claude>/.credentials.json`
  through the helper's environment, stat and access checks only, never its content.

The service refuses a report whose fields it does not know, are out of range, or
contain the seat token. Nothing secret is read, so nothing secret can reach the report,
the service log or the pipe. The text lives in `detail`, which Settings → AI providers →
Claude… shows in a copyable field.

**Reproduction, by context** (`security find-generic-password -s "Claude Code-credentials"`
and the credentials file). Who verified each cell is stated; nothing below was run by
this change on the operator Mac.

| Context | Keychain item | Credentials file | `claude auth status` | Verified by |
| --- | --- | --- | --- | --- |
| Terminal (iTerm, user session) | found, in `login.keychain-db`, account `panda` | exists, 0600, 463 bytes | `loggedIn: true` | operator, live (LKM-124 evidence) |
| Service / provider helper (child of the XPC service) | **pending**: read "Keychain:", the keychain lists and "Credentials file:" from Check login | **pending**: same report | `loggedIn: false` for the bundled and the installed CLI | `claude auth status`: operator, live. Keychain and file lines: not yet run |
| `Contents/Helpers/TreziSecrets` (`TreziSecrets --crypto`, run by the service) | Save token in Settings fails with "macOS Keychain encryption unavailable; unlock the keychain and retry." | not applicable | not applicable | operator, live. The `OSStatus` was not captured |
| Agent shell used for this change (a sandboxed background session, not one of the three contexts) | `find-generic-password` (metadata only) exit 0 | not looked at | not run | this change, live |

To complete the two pending cells on the operator Mac (no model call): open Trezi, then
Settings → AI providers → Claude… → **Check login**, and copy the report into the
issue. Compare it with, in Terminal:
`security find-generic-password -s "Claude Code-credentials" >/dev/null; echo $?`,
`security list-keychains -d user`, `security default-keychain` and
`stat -f '%N %z bytes mode %Lp' ~/.claude/.credentials.json`. Interpretation: exit 0 in
Terminal and non-zero (or an empty/different keychain list) in the helper means the
service's process tree lost the user's security session, which LKM-125 fixes with
`JoinExistingSession` (below): after that fix the helper's line should read exit 0 too,
and a non-zero one means the fix did not take effect. A readable file with
`loggedIn: false` would point at the CLI instead. Whether the fix works on the operator
Mac is not verified by this change.

**Tests.** `test/provider-login.mjs` (keychain): a fake `security` (exit 0 and exit 44)
on the helper PATH prints the secret on stdout and stderr; fixture HOMEs with a 0600
`.credentials.json`, without one, and with an unreadable one. It asserts the readable and
not-readable lines, the exit code, both keychain lines, the file's path, existence,
readability, size and mode, that only `find-generic-password -s`, `list-keychains -d user`
and `default-keychain` are called (no `-w`/`-g`), and that neither the keychain secret nor
the file's content appears in the report, the service log or the pipe.

Since LKM-127 every other part of that test also gets a stand-in `security`
(`--claude-security=`), so no result depends on the machine's keychains. Its
`real-keychain` part runs `/usr/bin/security` from the test and through Check login and
requires the same list, default and item-lookup result. When the session has no user
keychain (`list-keychains` or `default-keychain` fails, as on a headless runner) that part
prints `PROVIDER-LOGIN real-keychain SKIP` with both exit codes instead of passing. The
test never creates a keychain or changes the search list.

## The service keeps the user's security session (LKM-125)

**Symptom.** Save token (Settings → AI Providers → Claude…) and adding or updating a
connection key failed with "macOS Keychain encryption unavailable; unlock the keychain
and retry", a chat on a saved connection said its key "could not be read", and a Claude
helper reported `loggedIn: false` while `claude auth status` in Terminal said `true`.

**Root cause.** The XPC service's `Info.plist` had no `XPCService.JoinExistingSession`,
so launchd started the service in a **new security session**, one without the user's
login keychain. Every process it starts inherits that session: Bun, the
`Contents/Helpers/TreziSecrets` helper (`TreziSecrets --crypto`; connection keys, the
subscription token) and the provider helpers with the Claude CLI (its login is the Keychain item
`Claude Code-credentials`). That held for `bun run dev` and `open -a` alike, since both
reach the service through XPC. Only the `~/.claude/.credentials.json` fallback or an
exported `CLAUDE_CODE_OAUTH_TOKEN` worked there.

**Fix.** `scripts/service-info.mjs` writes the service plist with
`JoinExistingSession` set, so the service runs in its caller's (the host's) session and
its children reach the same keychains. A plain `claude auth login` in Terminal is then
seen by chats, with no token.

**Check login** (the chat card and Settings → AI Providers → Claude…) now also reports,
from inside the helper, the exit codes of `security list-keychains` and
`security default-keychain` (`keychain` in the report, and a "Keychain in this helper"
line in its detail). A non-zero code means the helper has no user keychain. The service
accepts only those two integer fields there. The LKM-124 diagnostics above run the same
two commands (the list with `-d user`) and also show their one-line output
(`keychainList`, `keychainDefault`); security's error output is never shown.

**Proof.** `test/service-session.mjs` (unit) parses the plist the build writes and checks
the session probe (`src/native/SecuritySession.swift`, the host's `securitySession`
command and `TreziHost --session`: session id, graphic-access bit, the two exit codes).
The native settings group's `security-session` step (`src/native/smoke-session.ts`) runs
`TreziHost --session` from Bun under the real service and requires the same report as
the host's (`security-session.json`). `test/provider-login.mjs` covers the Check login
fields with stand-in `security` commands. No test writes to the user's keychain.

## Stable app identity and no surprise permission prompts (LKM-137)

**Symptom.** After every rebuild macOS asked again for the Keychain item that holds the
master key, and once a "Trezi would like to access your Photos" prompt appeared with a
helper's cwd `/Users/<user>`.

**Keychain and privacy grants.** The build signed everything ad hoc, so every rebuild was
a new app to macOS. It now signs with one stable identity (`scripts/signing.mjs`; README
"Code signing"). In the login keychain an item made by a binary without an Apple team ID
is tied to that binary's code hash, which even a stable self-signed identity changes on
every rebuild. So the Keychain work moved out of TreziHost into its own small executable,
`Contents/Helpers/TreziSecrets` (`src/native/Secrets.swift`, built byte-identical each
time), which the service runs as `TreziSecrets --crypto encrypt|decrypt`. Its item is
`dev.trezi.native.secrets`, created with an access list that trusts the helper; the
earlier item is migrated once (read, write the new one, delete the old only after that
write). Users approve the Keychain once more after this change, then not again.

**Photos.** Settings → AI providers → Claude… → **Check login** sent no project root, so
`providers:check-login` used `homedir()` and the service started the provider helper,
and `claude auth status` inside it, with cwd `$HOME`. The Claude CLI looks through its
working directory, and under `$HOME` that reaches `~/Pictures/Photos Library.photoslibrary`,
which is what makes macOS ask for Photos. The 24 hours of TCC log on hand had no Trezi
request, so this is identified from the code path and the reported cwd, not a captured
event. Now:

- `providers:check-login` without a project uses the temporary folder;
- `ProviderHelperProcess.workingDirectory` (`src/service/ProviderHelper.swift`) never
  starts a helper in a home folder (`HOME`, the helper's `HOME`, the account's), `/` or
  another ancestor of one, or in a folder that is gone: it uses a private (0700)
  `trezi-helper` folder under the temporary folder instead. A project or worktree is kept;
- the host's login-shell environment probe (`HostLaunch.run`) and `npx skills add -g`
  (`WorkflowTools.skills`) run in the temporary folder, not `$HOME`.

The chat sessions already ran in the chat's worktree, and Trezi uses only NSOpenPanel and
NSSavePanel for files; nothing in Trezi calls a Photos API.

**Tests.** `test/signing-identity.mjs` (identity choice, override, every ad hoc fallback
with exactly one warning line, an identity that cannot sign falling back to ad hoc for
every piece with that one warning, the stable designated requirement, a real ad hoc sign,
and a real "Trezi Local" in a temporary keychain that signs two builds with the same
`codesign -d -r-` requirement); `test/keychain-migration.mjs` (the real
helper against a temporary keychain: migrate once with no data loss, later runs, a fresh
profile, an invalid old key); `test/provider-login.mjs` `helper-cwd` (Check login with a
home, `/`, an ancestor of a home or a missing folder never runs in it). The keychain
parts need a session that can create a keychain and say SKIP elsewhere.

## Keychain and network-volume prompts after stable signing (LKM-144)

**Rebuild loop (`test/keychain-rebuild.mjs`, `bun run test:keychain-rebuild`).** This
checks whether an **Always Allow** for `TreziSecrets` survives a rebuild when the signer
is self-signed and has no Team ID:

- *deterministic* (runs everywhere): two builds of `src/native/Secrets.swift` from
  different folders, with the build's own swiftc flags, are byte-identical, and the
  signed helpers have the same CDHash. On the worker Mac (Xcode 26 SDK, arm64) that was
  `7afd5eab581e61ab99e6cb659ad31c8dd4120032` ad hoc.
- *rebuild-read*: on a temporary keychain made with a password, the item one build
  creates is read by the rebuild (another folder) twice with UI disabled. A build from
  changed source is refused (exit 1, where a real run would ask). This is the loop
  build → read → rebuild → read, with no prompt possible.

The test uses only no-UI calls: `TreziSecrets --keychain`, and `security`
create/unlock/delete-keychain with a password. It never touches the login keychain, the
search list or the default keychain. It does not sign with "Trezi Local", because
codesign finds an identity only through the search list. Where no keychain can be created
(the worker sandbox refuses `create-keychain`) that part prints SKIP. Every `security` call
is bounded at 30 s, so a hung security agent cannot stall the suite.

A manual probe on a temporary keychain (LKM-144) found two access lists:

- for an item `TreziSecrets` creates when signed with "Trezi Local", the decrypt entry
  trusts the designated requirement (`identifier "dev.trezi.secrets" and certificate
  leaf = H"…"`), so rebuilt and even changed builds read it;
- signed ad hoc, the entry names `cdhash H"…"`. That is the per-rebuild prompt before
  LKM-137.

A temporary keychain shows no partition list. The login keychain is where LKM-137 saw a
`cdhash:` partition, so the operator steps below confirm the real result there. The
helper's bytes, and so its CDHash, do not change between builds, so that partition still
matches after a rebuild. Only a change to `Secrets.swift`, the Swift compiler or the SDK
costs one more approval.

**Repeated prompts while migrating.** The service ran `TreziSecrets` on a concurrent
queue with a 30 s timeout. A first read of the old item (owned by the old ad hoc
TreziHost) asks for the login password. Each parallel call (several connections, the
seat token) showed its own dialog, and a helper killed while the user was still typing
threw the answer away. `ProviderData.crypto` now runs the helper one call at a time with
a 180 s timeout, so one approval serves the calls queued behind it (`test/provider-data.mjs`
`keychain-serial`). `Secrets.swift` is unchanged, so this costs no extra approval.

**Migration from `dev.praxis.native.secrets`.** It is idempotent: once
`dev.trezi.native.secrets` exists the old item is never read again. A helper whose write
collides with another's uses the key the other wrote. `test/keychain-migration.mjs`
covers migrate, repeated runs, a reappearing old item, a fresh profile and an invalid
key. One narrow window remains when two helpers really run at once. A helper that finds
neither item, because the other moved it in between, fails that one decrypt, with no data
loss. The service no longer runs helpers at once, and fixing the window in
`Secrets.swift` would cost every user an approval, so it is left.
The old item belongs to the old TreziHost, so deleting it is a change to that item's
owner. macOS may ask once more for that ("TreziSecrets wants to delete…", Allow). If it
is denied, the old item stays, unused, and can be removed by hand.

**Expected prompts after updating.**

1. Once: TreziSecrets wants to use `dev.praxis.native.secrets` (enter the login
   password, then **Always Allow**).
2. Possibly once: deleting that old item (**Allow**).
3. Never again for rebuilds, unless `Secrets.swift` or the Swift toolchain changes.

**Operator verification (login keychain; the worker sandbox cannot reach it).**

1. `bun run build`, then `codesign -dvvv out/native/Trezi.app/Contents/Helpers/TreziSecrets 2>&1 | grep -E 'CDHash|Authority|Identifier'`.
   Note the CDHash; `Authority=Trezi Local` (or Apple Development).
2. Open Trezi and send a Claude message, or save a key in Settings → AI providers.
   Expect the prompts above, then choose **Always Allow**.
3. `security find-generic-password -s dev.praxis.native.secrets -a master-key; echo $?`
   (attributes only, no prompt). Expected: `security: SecKeychainSearchCopyNext: The
   specified item could not be found in the keychain.` and `44`, meaning the migration
   finished. If it still exists, `security delete-generic-password -s dev.praxis.native.secrets -a master-key`
   removes it (this one may ask).
4. `security dump-keychain -a ~/Library/Keychains/login.keychain-db | grep -A40 '"dev.trezi.native.secrets"'`.
   Expected: an `authorizations (…): decrypt` entry whose `requirement:` is
   `identifier "dev.trezi.secrets" and certificate leaf = H"…"` (or `cdhash H"…"`), and
   any `partition_id` (`cdhash:` / `teamid:`). Record both in the issue.
5. Rebuild from another checkout or after `rm -rf out/native`, run step 1 again (same
   CDHash), quit and reopen Trezi, then send a message: no Keychain prompt.
6. `printf x | out/native/Trezi.app/Contents/Helpers/TreziSecrets --crypto encrypt --keychain ~/Library/Keychains/login.keychain-db >/dev/null; echo $?`
   prints `0` with no dialog (`--keychain` disables UI; 1 would mean another approval
   is needed).

**Network volumes.** The reported request is `kTCCServiceSystemPolicyNetworkVolumes`
with responsible TreziHost, accessing `…/claude-agent-sdk-darwin-arm64/claude` and
requesting `com.apple.sandboxd`. `sandboxd` is how macOS files every file-protection TCC
request, so it does not mean the Bash sandbox made the access. The accessing process is
the Claude CLI itself. Claude's sandbox settings (`sandbox` in settings, which Trezi
takes from the user's `~/.claude/settings.json`) confine only the commands Claude runs
under Seatbelt, not the CLI process. Trezi cannot set them so that the CLI stops
touching a network volume. The likely trigger is the CLI resolving paths at start
(`/home` is the autofs `auto_home` map on a default Mac, and any mounted share under
`/Volumes`). A `denyRead` rule for those paths would make the CLI stat them itself.
Turning the sandbox off is not an option. So Trezi keeps the sandbox and explains the
prompt instead: the first Claude turn of a profile shows one status line
(`src/native/network-volume-note.ts`, preference `trezi:network-volume-note:v1`). It
says to allow only when the project is on a network drive. macOS remembers either
answer for the app's stable signature (LKM-137), so the prompt itself is also one-time.
Codex, Gemini and connection chats do not run the Claude CLI and never show the note
(`test/network-volume-note.mjs`).

**Bundle ID.** `dev.praxis.native` stays. A rename would reset every TCC grant
(including this one), the WebKit data store and the app's designated requirement, so
users would see every prompt again. It is recorded as a kept OS identity in
`docs/agent-guide/legacy-names.md`. The one "Failed to match existing code requirement"
line in the TCC log after LKM-137 is the old ad hoc grant being replaced once.

## Trezi tools from provider helpers (LKM-131)

Since LKM-111 the Claude and Codex adapters run in a provider helper, a separate process
that holds none of main's (Bun's) services. The adapters called their Trezi tools in
place, so in a helper `chat_island` answered "Native chat islands are not available",
the preview observers found no preview, Gen UI read as off, and `open_preview` and
`open_code` went to a window that did not exist.

**Routing.** The helper host gives each session `ctx.tools.invoke` (`SessionToolHost`).
`sessionTool` in `src/main/session-tools.ts` sends every tool that needs main through
it as a helper `tool` frame. The Swift owner checks the frame against the session's
grant (`ProviderPolicy.authorize` in `src/service/ProviderPolicy.swift`: a granted name,
arguments up to 256 KB, and no `open_code` or `chat_island` for background runs). A
refused call goes back to the helper as `tool-error` and never reaches Bun. An authorized
call is relayed to Bun. `src/native/provider-service.ts` runs it with the helper
session's scope (`runTreziTool` from `src/main/backends/helper-session.ts`: live root,
chat key, background, window). The owner then validates the result and returns it. The
helper gains no capability: it only asks, and what it gets back is data. Outside a
helper (`ctx.tools` absent) the same functions run in place behind `authorizedTool`.
`runTreziTool` answers any name that is not one of its own with an error. Tool answers
(`tool-result`, `tool-error`) settle outside the helper's ordered frame queue, because
Codex checks its bridge (`workspace_state`) while its helper is still opening.

**Audit.** Gemini exposes no Trezi tools.

| Tool | Claude (`trezi` in-process MCP) | Codex (Trezi MCP bridge) | Needs main for |
| --- | --- | --- | --- |
| `chat_island` | routed | routed | the chat-island service on the Swift editing owner |
| `preview_location`, `preview_screenshot` | routed | routed | the preview registry (URL, capture) |
| `preview_inspect`, `preview_evaluate`, `preview_console`, `preview_viewport` | routed | routed | the preview's isolated agent world and page zoom |
| `open_preview`, `open_code` | routed | routed | the window that navigates the preview or reveals code |
| `project_ui_catalog`, `compose_project_ui` | routed | routed | the chat's Experimental Gen UI state |
| `workspace_state`, `prepare_conflict_resolution` | — | routed | chat-isolation state (worktree, parked batch) |
| `install_skills` | routed | — | the workflow owner |
| `spring_to_css`, `check_contrast`, `fluid_clamp`, `color_scale`, `layered_shadow`, `line_height`, `list_recommended_skills` | in the helper | — | nothing (pure) |

**Proof.** `test/provider-helper-tools.mjs` (unit) runs the real helper entry under the
Swift owner fixture. It uses stand-in `claude` and `codex` CLIs (no model, no network),
and each calls every Trezi tool its session lists. The test fails when a listed tool is
neither pure nor routed, or when a routed tool answers with a missing-service error. It
checks main's real answers: an island that renders and whose commit and undo round-trip
through the source, the preview URL and capture, navigation, Gen UI and the install.
It also checks that a background session's `chat_island` and `open_code` are refused
by the owner before main. The Codex half needs a Unix-socket listen, which some
sandboxes forbid.
