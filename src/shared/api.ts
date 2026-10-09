/**
 * Types shared by backend services, native controllers and preview instrumentation.
 * This module is neutral (no runtime or node imports) so every tsconfig can include it
 * without dragging in process-specific code.
 */

import type { ChatUiRecord } from './chat-ui'
import type { DependencyIssue } from './dependency-issue'

export type { DependencyIssue } from './dependency-issue'
export type { GithubConnectOptions, GithubConnectResult, GithubStatus } from './github'

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm'
export type Framework =
  | 'vite'
  | 'next'
  | 'cra'
  | 'sveltekit'
  | 'expo'
  | 'react-native'
  // A plain static site (vanilla HTML/CSS/JS, no package.json or build step) —
  // served by trezi's own built-in static file server, not a spawned dev command.
  | 'static'
  | 'unknown'

/**
 * What the right pane previews: a web dev server in the native WebContentsView
 * ('web'), or a booted iOS Simulator streamed through the local sim bridge
 * ('simulator'). Threads through detection so the renderer drives the right
 * lifecycle (devServer.* vs simulator.*) while everything downstream of the URL
 * — bounds, load, retry — stays identical.
 */
export type PreviewKind = 'web' | 'simulator'

/**
 * AI-assisted diagnosis of an open/launch failure. trezi *proposes* a fix (never
 * auto-runs): repo-scoped steps it can apply, host-scoped steps (sudo / global /
 * downloads) the user runs. Cached per-machine by `signature` so a repeat error
 * recalls the plan instead of re-diagnosing.
 */
export interface DiagStep {
  text: string
  /** Optional exact shell command (shown with a copy button). */
  command?: string
  /** 'repo' = trezi can apply it; 'host' = machine-level, the user must run it. */
  scope: 'repo' | 'host'
}
export interface Diagnosis {
  /** Stable cache key derived from the error. */
  signature: string
  summary: string
  detail?: string
  steps: DiagStep[]
  /** True when recalled from the per-machine cache rather than freshly diagnosed. */
  seenBefore: boolean
  /** Last recorded outcome for this signature on this machine. */
  status?: 'proposed' | 'applied' | 'dismissed'
}

/** Result of ensuring/switching the opened project's `trezi/*` working branch. */
export interface BranchResult {
  /** Files changed between branch tips; omitted when the comparison is unavailable. */
  files?: string[]
  isRepo: boolean
  /** The branch now checked out (null if not a git repo or the switch failed). */
  branch: string | null
  /** True if this call created the branch. */
  created: boolean
  /** Set when a switch failed (e.g. conflicting uncommitted changes). */
  error?: string
}

export interface GitRemoteStatus {
  localBranches: string[]
  current: string | null
  remotes: string[]
  upstream: string | null
  branches: { ref: string; remote: string; branch: string; label: string }[]
}
export interface GitRemoteAction {
  action: 'pull' | 'checkout'
  ref: string
  expectedBranch: string
}
export interface GitRemoteResult {
  ok: boolean
  branch: string | null
  files: string[]
  changed: boolean
  message: string
}

export interface DetectedProject {
  /** Empty project: open chat without attempting to launch a server. */
  setupRequired?: boolean
  root: string
  name: string
  framework: Framework
  packageManager: PackageManager
  scriptName: string
  /** Full command we'll run, e.g. "bun run dev". User may override this. */
  devCommand: string
  /** Web dev server vs iOS Simulator (React Native / Expo → 'simulator'). */
  previewKind: PreviewKind
}

/**
 * A project's own favicon, resolved from its source tree (see
 * `src/main/project-icon.ts`). The rail leads each project with this instead of
 * the generic folder glyph, so a wall of open projects is scannable by icon.
 */
export interface ProjectIcon {
  /** Project-relative path the icon came from — shown in the rail row's title
   *  so it's obvious WHICH file the rail is showing. */
  path: string
  /** `data:` URL, ready for an `<img src>`. Capped at 512 KB by main. */
  dataUrl: string
}

export interface ProjectCreateOptions {
  template: 'react' | 'empty'
}

/** Result of `project:create` (create the chosen starter, git init,
 *  install deps). `warning` = created, but a non-fatal step failed and the
 *  user must be told now (today: `git init` / the first commit — see
 *  scaffold.ts); it can be set alongside `ok: true`. */
export interface ProjectCreateResult {
  ok: boolean
  root?: string
  error?: string
  warning?: string
}

export interface RunningDevServer {
  url: string
  pid: number
  /** True when we attached to a server the user was already running (we don't own it). */
  attached?: boolean
}

/** Result of `devserver:info` — lets a reattaching renderer recover an already-
 *  running project's URL instead of blindly respawning on a fresh port. */
export interface DevServerInfo {
  running: boolean
  server?: RunningDevServer
}

/**
 * A booted simulator served through the local sim bridge. `url` is that bridge's
 * HTTP URL (an MJPEG device page) so `preview.load(url)` is unchanged at the call
 * site — the simulator preview is "just another local URL".
 */
export interface RunningSimulator {
  url: string
  /** PID of the Metro/Expo dev-server process group (for teardown). */
  pid: number
  /** The booted device's UDID. */
  udid: string
  /** The launched app's bundle id (so subsequent runs relaunch without rebuilding). */
  bundleId: string
  previewKind: 'simulator'
}

/** One bootable iOS simulator device. */
export interface SimDevice {
  udid: string
  name: string
  runtime: string
}

/** A tapped simulator element, resolved to its RN source when the testID
 *  stamp is present. `source` is null when the project isn't set up for
 *  select (no stamp found) — not every pick resolves. */
export interface SimElementPick {
  source: string | null
  tag: string
}

/**
 * Result of probing the host for iOS-Simulator capability — all read-only. The
 * renderer surfaces `reason` (a human message) when `ok` is false, instead of
 * crashing on a non-macOS host or one without Xcode.
 */
export interface SimPreflight {
  ok: boolean
  reason?: string
  isMac: boolean
  hasXcode: boolean
  /** `idb` present (enables Phase-2 interaction); mirroring works without it. */
  hasIdb: boolean
  runtimes: string[]
  devices: SimDevice[]
}

/**
 * The agent's permission posture, mirroring the SDK's `PermissionMode`:
 * - `auto` — **trezi's default**: a model classifier approves/denies each tool
 *   call; only the ones it flags as risky fall through to trezi's canUseTool
 *   (approve/deny card). No prompts for routine work, but genuinely dangerous
 *   ops still surface.
 * - `default` — ask (cards) for every tool the SDK gates.
 * - `acceptEdits` — auto-accept file edits, still ask for the rest (e.g. Bash).
 * - `bypassPermissions` — skip all checks (and trezi's canUseTool guards); unused.
 */
export type PermissionMode = 'auto' | 'default' | 'acceptEdits' | 'bypassPermissions'

/** One selectable choice in an agent question (the SDK's AskUserQuestion tool). */
export interface QuestionOption {
  /** Short display text (1-5 words). */
  label: string
  /** Why this option / what it implies — shown under the label. */
  description?: string
}

/** One question the agent posed to the user via the AskUserQuestion tool. */
export interface QuestionSpec {
  /** Very short chip label (≤12 chars), e.g. "Approach". */
  header: string
  /** The full question sentence. */
  question: string
  options: QuestionOption[]
  /** Allow picking more than one option (else single-choice). */
  multiSelect: boolean
}

/**
 * A pending agent question surfaced to the user as an interactive multiple-choice
 * card (distinct from a tool approve/deny). The user's picks flow back to the
 * agent as the tool result. `id` correlates the answer to the awaiting SDK call.
 */
export interface QuestionRequest {
  id: string
  questions: QuestionSpec[]
  /** The chat session this question belongs to — same value as the emitting
   *  `AgentEvent.projectKey` (the project's own key for its first chat, or
   *  `${projectKey}#…` for an additional/resumed chat). Lets the renderer keep
   *  a backgrounded chat's cards out of whichever chat is on screen, instead of
   *  a single un-keyed global list. */
  sessionKey: string
}

/**
 * The user's answer to a QuestionRequest: question text → chosen answer string
 * (multi-select answers comma-joined; free text for "Other"). `null` (sent by the
 * renderer) means the user dismissed the question without answering.
 */
export type QuestionAnswers = Record<string, string>

/** A pending tool-permission prompt surfaced to the user as an approve/deny card. */
export interface PermissionRequest {
  /** Correlates the renderer's decision back to the awaiting SDK callback. */
  id: string
  toolName: string
  /** Full prompt sentence from the SDK when available (else built from tool + input). */
  title: string
  /** Short noun phrase, e.g. "Edit file" — good for compact labels. */
  displayName?: string
  /** A single-line summary of the most relevant input (path / command / pattern). */
  detail?: string
  /** The chat session this request belongs to — see `QuestionRequest.sessionKey`. */
  sessionKey: string
}

/**
 * One entry in the composer's "/" menu. `source: 'project'` marks a skill
 * discovered in the opened repo (`.claude/skills/<name>/SKILL.md`) — these rank
 * first and carry the SKILL.md frontmatter `description`; everything else the
 * backend advertises (built-ins, user-level skills) is `'other'`.
 */
export interface SlashCommandItem {
  name: string
  description?: string
  source: 'project' | 'other'
}

/** Why a detached background agent was launched. The worktree/session machinery is
 * shared, but the renderer uses the origin to choose the right completion UX. */
export type BackgroundSpawnOrigin = 'comment' | 'text-edit'

/** Why a turn failed, when the chat shows a card for it (LKM-119). */
export type ProviderErrorCode = 'auth' | 'no-response'

/**
 * "Check provider login" (LKM-119): the provider's auth status as its helper sees it
 * (same environment allowlist, PATH and cwd as a chat). Names only, never a secret.
 */
export interface ProviderLoginReport {
  provider: string
  loggedIn: boolean | null
  /** The CLI the chats use: `bundled` (the SDK's) or `installed` (e.g. ~/.local/bin/claude). */
  source?: 'bundled' | 'installed'
  executable?: string
  authMethod?: string
  /** A subscription token from Settings is in the helper's environment. */
  token?: boolean
  /** Exit codes of `security list-keychains` / `security default-keychain` run in the
   *  helper (null: could not run). Non-zero: the helper has no user keychain (LKM-125). */
  keychain?: { listKeychains: number | null; defaultKeychain: number | null }
  /** Claude, from inside the helper (LKM-124): `security find-generic-password -s "Claude Code-credentials"` (no `-w`, output discarded) found the item; null: `security` did not run. */
  keychainItem?: boolean | null
  keychainItemExit?: number | null
  /** `security list-keychains -d user` and `security default-keychain`, on one line each. */
  keychainList?: string
  keychainDefault?: string
  /** `<config dir>/.credentials.json` through the helper's HOME: absolute path and metadata, never content. */
  credentialsPath?: string
  credentialsExists?: boolean
  credentialsReadable?: boolean
  credentialsSize?: number | null
  /** The provider's variables in Trezi's environment, by name (never values): passed to the helper, or dropped as a parent session's (LKM-124). */
  inherited?: string[]
  dropped?: string[]
  /** CLAUDE_CODE_SIMPLE (bare mode, which never reads the login) was set and dropped. */
  bare?: boolean
  /** One line per probe, human-readable. */
  detail: string
}

export type AgentEvent = (
  | { type: 'delta'; text: string }
  | { type: 'status'; text: string }
  | { type: 'commands'; commands: SlashCommandItem[] }
  /** The model the session resolved its choice to, from the SDK's init message
   *  (`claude-opus-5-5` for the `opus` alias, LKM-164). Not turn output. */
  | { type: 'model'; model: string }
  | { type: 'permission-request'; request: PermissionRequest }
  /** A pending request was resolved without the user (abort/session change) — dismiss its card. */
  | { type: 'permission-resolved'; id: string }
  /** The agent asked the user a multiple-choice question (AskUserQuestion tool). */
  | { type: 'question-request'; request: QuestionRequest }
  /** A pending question was resolved (answered elsewhere / abort / session change) — dismiss its card. */
  | { type: 'question-resolved'; id: string }
  /** LKM-208: an answer component shown or updated in the streaming message (`chat_ui`). */
  | { type: 'chat-ui'; ui: ChatUiRecord }
  /** Tokens the backend just reported, as a DELTA to add to the chat's running
   *  totals (main dedupes the providers' repeated cumulative readings — see
   *  `shared/run-stats.ts`). Drives the status line's ↑/↓ counters. `cached` is
   *  the share of `input` served from the prompt cache, not an extra amount. */
  | { type: 'usage'; input: number; output: number; cached: number }
  /** The turn is alive (LKM-147): the provider helper's heartbeat about every 5 s
   *  while a turn is open, or the owner's "Still thinking…" (`step`). It names the
   *  current step at most; it never enters the transcript and never counts as the
   *  turn's first output. */
  | { type: 'progress'; step?: string }
  | { type: 'done'; landingPending?: boolean }
  /** `code` (LKM-119): `auth` — the provider is not signed in (a login card, not
   *  assistant text); `no-response` — the turn produced nothing within the owner's
   *  first-event deadline and was ended; since LKM-135 its message names the
   *  cold-start phase it stopped in (CLI start, session init, first model reply). */
  | { type: 'error'; message: string; code?: ProviderErrorCode }
  /** An auto-generated name for this chat, summarising what the conversation is
   *  about (not its opening words). Emitted once per chat after the first turn
   *  completes; the renderer stores it on the chat slice and the rail shows it. */
  | { type: 'title'; title: string }
  /** A queued background spawn started running — flip its rail row from
   *  queued → running and attach its branch. */
  | { type: 'spawn-started'; branch: string; origin?: BackgroundSpawnOrigin }
  /** A detached background spawn finished — drop its working rail row. `branch`
   *  is null when it auto-applied onto the working tree, else the durable review
   *  branch. Comments can use `summary` + `files` for a parent-chat notification;
   *  automatic edit origins deliberately remain out of the transcript. `label` is
   *  the comment's own text, one line (LKM-178): the collapsed result row names it. */
  | {
      type: 'spawn-finished'
      outcome?: 'applied' | 'review' | 'failed' | 'cancelled' | 'no-change'
      branch: string | null
      origin?: BackgroundSpawnOrigin
      summary?: string
      files?: string[]
      label?: string
    }
  /** Main starts one bounded reconciliation turn in the originating chat. */
  | { type: 'reconciliation-started' }
  | { type: 'landing-finished' }
  /** LKM-194: at turn start, why the chat's dependencies are not installed (conflict
   *  markers, a failed install), or null once nothing stands in the way. The turn
   *  starts either way; the chat shows a card. */
  | { type: 'dependencies'; issue: DependencyIssue | null }
  /** LKM-215: at most once per turn, what changed in the live checkout during a Full
   *  access Codex turn that Trezi itself did not do (`live-change-watch.ts`). `spawn`
   *  marks a spawned comment agent's own report, a row of its own beside the turn's. */
  | { type: 'live-change'; line: string; detail: string; agent: boolean; spawn?: boolean }
  /** Per-chat worktree isolation status (v9). A chat's turn merged back onto the live
   *  checkout ('merged'), a private worktree was forked for the chat ('isolated'), or a
   *  turn parked on its branch after mid-turn drift ('parked'). Routed by `projectKey` =
   *  the chat's emitKey, like every other interactive-chat event. */
  | {
      type: 'isolation'
      state: 'isolated' | 'merged' | 'parked'
      branch?: string
      files?: string[]
      /** On 'merged': the edit-history group id (`chat:<wtId>:<turnNo>`) that reverts
       *  this turn's file changes — the renderer tags the merged assistant message with
       *  it to render a per-turn Revert button. */
      group?: string
      /** On 'merged': whether this turn is safely revertable (false once the chat's
       *  work has been pushed & merged via a PR) — the renderer hides Revert if false. */
      revertable?: boolean
      /** LKM-151: 'interrupted' on a park held from a stopped/failed turn (live never
       *  had it); 'reverted' on the 'isolated' that follows the user reverting it.
       *  LKM-165: 'failed' on a park held because landing itself failed (`error`). */
      reason?: 'interrupted' | 'reverted' | 'failed'
      /** On a 'failed' park: why the landing failed, for the chat's Retry card. */
      error?: string
    }
) & {
  /** Which project's session emitted this — set by main so the renderer routes it
   * to the right chat (active project shows live; others accumulate in the rail). */
  projectKey?: string
  /** Set for a detached background spawn's events — the renderer keeps these
   *  out of the main chat stream and routes them to the spawn's own rail row. */
  sessionId?: string
  /** The user turn an interactive chat's event belongs to (S11). A terminal event
   *  for another turn than the one a chat is running is late and must be ignored. */
  turn?: string
  /** A `done` no unfinished send accounts for (a late event): it completes nothing. */
  stale?: boolean
}

/** Per-session options the user can set from the chat toolbar. */
/**
 * An image pasted or dropped into the composer, sent to the agent as a vision
 * content block. `data` is raw base64 (no `data:` prefix); `mediaType` is the
 * MIME type (e.g. "image/png").
 */
export interface ImageAttachment {
  mediaType: string
  data: string
}

export interface AgentTurnOptions {
  /** Opt-in static React composition; captured when the message is submitted. */
  projectUi?: boolean
  projectUiEngine?: 'agent' | 'jev'
}

export interface AgentOptions {
  /** Model alias ('fable' | 'opus' | 'sonnet' | 'haiku') or undefined for the account default. */
  model?: string
  /** Reasoning effort ('low' | 'medium' | 'high') or undefined for the model default. */
  effort?: string
  /** Permission posture; defaults to 'default' (ask). */
  permissionMode?: PermissionMode
  /**
   * Which HARNESS runs the agent loop (v7): 'claude' (default) | 'codex'.
   * Undefined → Claude. The two built-in harnesses authenticate with the user's own
   * subscription (Claude setup-token / Codex sign-in-with-ChatGPT). A key is never
   * committed in-repo — but see `connectionId`: a user MAY store their own API key
   * for a third-party endpoint, encrypted at rest and only in main.
   */
  provider?: string
  /**
   * Run this turn against a user-added endpoint (v10) instead of the harness's own
   * account — see `ProviderConnection`. Harness and endpoint are orthogonal: the
   * Codex harness supplies the agent loop while the connection supplies the URL,
   * key and model. Undefined ⇒ the harness's own subscription, exactly as pre-v10.
   */
  connectionId?: string
  /**
   * Claude only (LKM-138): load the user's own Claude Code plugins and MCP servers.
   * Set by main from Settings when a helper session opens; absent ⇒ isolated.
   */
  claudeUserPlugins?: boolean
  /**
   * Settings → "Agent file access" (LKM-163): 'full' lets the agent read and write
   * anywhere the user can (Codex `danger-full-access`); 'project' keeps Codex to the
   * chat worktree. Set by main when a helper session opens; absent ⇒ 'full'.
   */
  agentFileAccess?: 'full' | 'project'
  /** Settings → Agent Git access; absent is Managed. */
  agentGitAccess?: 'managed' | 'full'
}

/** Trezi-managed durable context for one project, stored outside the repo. */
export interface ProjectMemory {
  content: string
  updatedAt: number
}

/**
 * A user-added model endpoint (v10). Trezi's two built-in seats — Claude (Agent
 * SDK) and Codex (`@openai/codex-sdk`) — log in with the user's own subscription and
 * need no configuration. A *connection* is the third path: an OpenAI-compatible
 * endpoint the user points Trezi at (Vercel AI Gateway, Groq, or any custom host)
 * so open models like Kimi or DeepSeek can drive a chat.
 *
 * Harness and endpoint are ORTHOGONAL. The Codex harness runs the loop; the
 * connection only says where requests go. `@openai/codex-sdk` accepts `baseUrl` +
 * `apiKey` per `Codex` instance, so a connection never writes to (or reads from)
 * the user's own `~/.codex/config.toml`.
 *
 * Connections are GLOBAL, not per-project — a key belongs to the user, not a repo.
 * The API key is deliberately NOT a field here: it is encrypted at rest with
 * Electron `safeStorage` and never crosses to the renderer, which only learns
 * `hasKey`. That way a compromised renderer dependency cannot exfiltrate keys.
 */
export interface ProviderConnection {
  /** Stable generated id — what `AgentOptions.connectionId` references. */
  id: string
  /** User-facing name shown as the picker's group heading ("AI Gateway"). */
  label: string
  /** Which preset created it; drives defaults and the dialog's badge. */
  preset: 'gateway' | 'custom'
  /** Endpoint root, e.g. `https://ai-gateway.vercel.sh/v1`. */
  baseUrl: string
  /**
   * Which OpenAI wire format Trezi speaks to this host. Only `'responses'` (the
   * newer `/responses` endpoint) is possible: the `codex` CLI bundled with
   * `@openai/codex-sdk` REJECTS `wire_api = "chat"` at config load ("no longer
   * supported"), so a host that offers only the older `/chat/completions` route
   * cannot back a connection at all — verified against the vendored binary, not
   * inferred. Kept as a field rather than hardcoded so the disk format survives
   * the CLI ever restoring chat support; widen the union if it does.
   */
  wireApi: 'responses'
  /** The models the user ticked from the catalog — these populate the chat picker. */
  models: string[]
  /** Whether a key is stored. The key itself never leaves main. */
  hasKey: boolean
}

/** A connection draft from the settings dialog. `id` absent ⇒ create a new one. */
export interface ProviderConnectionInput {
  id?: string
  label: string
  preset: 'gateway' | 'custom'
  baseUrl: string
  wireApi: 'responses'
  models: string[]
  /** Plaintext key on its way to `safeStorage`. Omit to keep the stored one. */
  apiKey?: string
}

/** Params for a catalog probe — an unsaved draft, or a saved connection by id. */
export interface ModelCatalogInput {
  baseUrl: string
  /** Plaintext key to probe with. Omit to reuse the key stored for `id`. */
  apiKey?: string
  /** Saved connection whose stored key to use when `apiKey` is omitted. */
  id?: string
}

/**
 * Result of probing `{baseUrl}/models`. This one call both validates the credential
 * and returns the catalog, so the dialog's "Connect" button does the whole job.
 */
export interface ModelCatalogResult {
  ok: boolean
  /** Model ids the endpoint advertises, sorted. Empty when `ok` is false. */
  models: string[]
  /** Human-readable failure ("401 Unauthorized"), for display in the dialog. */
  error?: string
  /** The host has no `/models` route — the dialog falls back to free-text entry
   *  rather than leaving the user stuck. */
  unsupported?: boolean
}

/**
 * One selectable entry in the chat's model picker (v10). The picker is MODEL-first:
 * the user picks a model and Trezi derives which harness runs it and which endpoint
 * it points at, because people think in models rather than harnesses. Built in main
 * so the renderer never hardcodes a model list again.
 */
export interface ModelChoice {
  /** Stable value for the picker + `AgentOptions` round-trip. */
  value: string
  /** Display name ("Opus", "Kimi K3"). */
  label: string
  /** Which harness runs it. */
  provider: 'claude' | 'codex'
  /** Set when this model comes from a user connection (absent for built-in seats). */
  connectionId?: string
  /** The model id handed to the backend, when it differs from `value`. */
  modelId?: string
  /** Group heading in the picker ("Claude", "Codex", or a connection's label). */
  group: string
}

/** One line of a recorded agent session's transcript (v5-D history). */
export interface SessionTranscriptEntry {
  /** Turn completion, including landing; stored on the initiating user entry. */
  completedAt?: number
  role: 'user' | 'assistant' | 'status'
  text: string
  at: number
  /** LKM-208: a status entry's answer component (`chat_ui`), with the user's answer. */
  ui?: ChatUiRecord
}

/**
 * A persisted agent session ("previous agent") — captured in main as the agent
 * works and written to disk when the session ends (close / switch-away suspend /
 * quit), so it's reopenable for review or resume after restart. `endedAt` is null
 * while the session is still live.
 */
export interface SessionRecord {
  id: string
  projectKey: string
  projectRoot: string
  projectName: string
  startedAt: number
  endedAt: number | null
  /** The trezi/* branch it worked on, if the renderer tagged it. */
  branch?: string
  /** The PR it produced, if published. */
  prUrl?: string
  /** Repo-relative (or absolute) paths the agent edited this session. */
  filesTouched: string[]
  transcript: SessionTranscriptEntry[]
  /**
   * An auto-generated name summarising what this chat is about (LLM-derived from
   * the conversation once its first turn finishes), so the rail shows a meaningful
   * label instead of the opening words. Absent until generated (or on a backend
   * without title support) — the rail then falls back to the first user message.
   */
  title?: string
  /** A detached comment spawn (v8 F1), vs the interactive project chat. */
  kind?: 'comment'
  /**
   * The project's last-active chat, persisted on quit/close so a relaunch can
   * continue it in place. It is omitted from History while current. `main` is a
   * read-only compatibility value for records written before chats became peers.
   */
  slot?: 'current' | 'main'
  /**
   * The Claude Agent SDK's own resumable session id (v9 resume), captured off
   * the `system`/init message. Only the Claude backend sets this (Codex/Gemini
   * have no equivalent primitive wired up) — its presence is what the "Resume"
   * affordance gates on, since it doubles as a Claude-backend marker.
   */
  sdkSessionId?: string
  /** The resolved directory `sdkSessionId` was started in; a resume uses it (LKM-165). */
  sdkCwd?: string
}

/** What `agent:open-project` hands back so the renderer can paint the current chat. */
export interface OpenProjectResult {
  transcript: SessionTranscriptEntry[]
  title?: string
}

/**
 * One live (still-open, in-memory) agent chat, as seen from main — used to
 * reattach the renderer after a reload without tearing down the session. The
 * full in-progress `SessionRecord` (transcript included) travels here so the
 * renderer can repaint the chat without a round trip to disk (a live session
 * is only persisted on teardown, so `sessions:list`/`sessions:get` can't see it).
 */
export interface LiveChatSnapshot {
  sessionKey: string
  record: SessionRecord
  /** A turn is currently in flight for this session (best-effort — see
   *  `agent:workspace-snapshot`'s implementation for how it's derived). */
  isRunning: boolean
  /** The turn in flight (S11: from the conversation owner), so a reattached chat
   *  accepts that turn's terminal events and no other. */
  turn?: string | null
  /** Per-chat worktree isolation status (v9), for the renderer to rehydrate the chat's
   *  isolation chip after a reload. Absent for a non-isolated chat (treated as 'live'). */
  isolation?: {
    state: 'live' | 'isolated' | 'parked'
    branch?: string
    reason?: 'interrupted' | 'failed'
    error?: string
  }
  /** The options this session is ACTUALLY running with (main's live copy — the
   *  authority). The renderer reconciles its per-chat pickers against these on
   *  reattach so a reload can't leave the toolbar showing a posture the session
   *  never had. */
  options: AgentOptions
}

/** One live project (an open workspace-rail entry) and its live chat(s). */
export interface LiveProjectSnapshot {
  projectKey: string
  /** Absolute project root, recovered from the session record. */
  root: string
  chats: LiveChatSnapshot[]
  /** Which of `chats` was last active for this project, if any. */
  activeSessionKey: string | null
}

/** Everything still live in main when the renderer asks — the reattach source
 *  of truth after a hard reload (render-process-gone, hard refresh). */
export interface WorkspaceSnapshot {
  projects: LiveProjectSnapshot[]
  /** The project root of the globally active sessionKey, if any. */
  activeRoot: string | null
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
  /** Corner radius for the native view (card inset in desktop viewport, iPhone
   *  screen in mobile); 0/omitted = square. */
  radius?: number
}

/**
 * An element the user picked in the live preview (v2 select mode). `source` is
 * the repo's opt-in `data-trezi-source` stamp ("path/File.tsx:line") when present
 * — that's what lets the agent edit the exact component (see DESIGN.md).
 */
export interface SelectedElement {
  /** Explicit Shift-click group; the outer element remains the inspector target. */
  selectionGroup?: SelectedElement[]
  tag: string
  id: string | null
  /** Authored display classes only; compiler-generated style-scope markers are
   * omitted before this crosses into titles, chat context, or style panels. */
  classes: string[]
  selector: string
  source: string | null
  /**
   * The nearest COMPONENT-instance call site (v8 F3a) — `data-trezi-component-source`,
   * which the stamp plugin forwards so the authored `<Component …/>` (not the
   * innermost host) wins. Lets the inspector edit per-instance props. Null when the
   * element isn't inside a stamped component instance (or on a non-React backend).
   */
  componentSource: string | null
  text: string | null
  rect: Bounds
  styles: Record<string, string>
  /** The element's `LayerNode.path` when it was picked, so Layers can select its row
   *  (LKM-179). Absent on picks that don't come from the page's DOM. */
  layerPath?: number[] | null
}

/**
 * One row in the Layers panel's DOM tree. `path` is a child-index path from
 * `document.body` (`[0,2,1]`) — recomputed fresh on every read, never a
 * durable id: `data-trezi-source` stamps aren't unique (a `.map()` puts the
 * same stamp on every rendered item) and a CSS selector is too lossy, so this
 * is the only workable handle. Every action that resolves a path back to a
 * live element re-validates the `{tag, source}` fingerprint first.
 */
export interface LayerNode {
  path: number[]
  parentPath: number[] | null
  depth: number
  tag: string
  id: string | null
  /** LABEL material, not the live class list: capped at 5 and stripped of
   *  compiler style-scope markers (`s-…`/`svelte-…`/`sc-…`) — see
   *  `isScopeClass` in `src/preview/layers.ts`. */
  classes: string[]
  source: string | null
  componentSource: string | null
  text: string | null
  childCount: number
  /** This stamp appears more than once in the snapshot — a client-side UX
   *  hint only (grey out dragging), never the correctness boundary. */
  dupStamp: boolean
}

export interface LayersSnapshot {
  nodes: LayerNode[]
  truncated: boolean
  totalSeen: number
}

/** Identifies a layer node across the renderer↔preload boundary for select/hover. */
export interface LayerFingerprint {
  tag: string
  source: string | null
}

/**
 * A Layers-panel or native-preview drag-to-reorder request. Both sides are
 * identified by their `data-trezi-source` stamp — main never needs the DOM path, only the
 * renderer does (to resolve rows back to elements). `sessionId` is a UUID
 * minted client-side once per drag gesture: it becomes the `commitEdit`
 * coalesce key, and deliberately never coalesces with anything else — a move
 * shifts every later line in the file, invalidating subsequent stamps until
 * the next HMR restamp, so reusing a stamp-based key would misbehave across
 * repeated drags.
 */
export interface MoveNodeRequest {
  dragged: { source: string }
  target: { source: string }
  position: 'before' | 'after' | 'inside'
  sessionId: string
}

export interface MoveNodeResult {
  applied: boolean
  needsAgent?: boolean
  agentPrompt?: string
  error?: string
}

/** Figma-style inline overlay modes: comment-to-agent (C) or annotation (Y). */
export type CommentMode = 'comment' | 'annotate' | null

/** A comment/annotation submitted from the preview's inline composer. */
export interface PreviewComment {
  kind: 'comment' | 'annotate'
  el: SelectedElement
  text: string
}

/** Previewable media the editor shows instead of opening as text. */
export interface SourceMedia {
  kind: 'image' | 'video' | 'audio'
  /** MIME type, derived from the extension. */
  mediaType: string
  /**
   * `trezi-media://` URL the renderer can point an <img>/<video>/<audio> at.
   * Opaque and per-file: main streams it from disk (range requests included), so
   * a big video never has to cross IPC as base64.
   */
  url: string
}

/** Request to reveal exact source in the active chat’s mini editor. */
export interface CodeRevealRequest {
  root: string
  key: string
  source: string
  startLine: number
  endLine: number
  /** Exact source lines, so landing or intervening edits cannot highlight unrelated code. */
  code: string
  requestId: string
}

/**
 * A stamped element's source file, read for the inspector's inline code peek —
 * the whole file (so surrounding context is visible) plus the stamp line and,
 * when the JSX parse resolves it, the element's full line span for highlighting.
 *
 * A file that isn't text carries `media` (previewable) or `binary` (not) instead,
 * with an empty `code`: decoding a PNG as utf8 and pouring it into the editor is
 * the bug this avoids.
 */
export interface SourceView {
  /** Repo-relative file path (from the stamp). */
  file: string
  /** The full file content — empty for `media` / `binary` files. */
  code: string
  /** 1-based line the stamp points at. */
  line: number
  /** 1-based inclusive line span of the stamped element (open → close tag). */
  elementStart?: number
  elementEnd?: number
  /** Set when the file is an image/video/audio: show it, don't edit it. */
  media?: SourceMedia
  /** Set when the file is binary but not previewable media (font, archive, …). */
  binary?: boolean
  /** Size on disk, for the preview's footer. Present with `media` / `binary`. */
  bytes?: number
  /** SHA-256 of the text as read: the baseline a save (or a restored draft) must still match. */
  hash?: string
}

/** Result of a whole-file save from the v9 code drawer. */
export interface SourceWriteResult {
  ok: boolean
  /** The file drifted on disk since the drawer loaded it — refused to clobber. */
  conflict?: boolean
  /** Human-readable failure (unresolved path, write error). */
  error?: string
  /** On success: the SHA-256 of the saved text (the drawer's next baseline). */
  hash?: string
}

/**
 * Result of a create / rename / delete from the editor's file-tree sidebar.
 * `path` is the repo-relative POSIX path the op landed on (the new path for a
 * rename), so the renderer can re-select it once the tree reloads.
 */
export interface FileOpResult {
  ok: boolean
  path?: string
  /** Human-readable failure (bad path, name taken, fs error). */
  error?: string
}

export type PropKind = 'string' | 'number' | 'boolean' | 'enum' | 'other'

/** One editable prop/attribute of a selected element. */
export interface PropField {
  name: string
  kind: PropKind
  /** Allowed values for `kind: 'enum'`. */
  options?: string[]
  /** Current literal value at the usage site, if set and literal. */
  value?: string | number | boolean
  /** Currently set with a non-literal expression — editing it routes to the agent. */
  expression?: boolean
  /** From react-docgen, when a schema was resolved. */
  description?: string
  required?: boolean
  /** This prop isn't currently on the element (offered from the schema to add). */
  fromSchema?: boolean
  /** The declared default is an expression; never evaluate it for the inspector. */
  defaultExpression?: boolean
  /** The component's declared literal default, when one was resolved.
   *  Drives the "reset to default" affordance — resetting removes the attribute
   *  so the value falls back to this. (v8 F2) */
  default?: string | number | boolean
}

/** Result of inspecting a selected element's editable props. */
export interface PropInspection {
  component: string
  /** The `path:line` we edit at (from the element's data-trezi-source). */
  source: string
  fields: PropField[]
  /**
   * True when a real prop schema resolved (react-docgen). This is the gate: only
   * schema-backed components get the prop panel; otherwise it's prompt-only.
   */
  hasSchema: boolean
  /** Why the schema is limited (e.g. no react-docgen match), if applicable. */
  note?: string
}

/** Agent request to select an object and open its desktop inspector. */
export interface ControlsOpenRequest {
  presentation?: 'animation'
  root: string
  source?: string
  file?: string
  tab: 'props' | 'styles' | 'custom'
  requestId: string
}

/** What the floating prop-panel island renders from (main renderer → island). */
export interface PanelState {
  openRequest?: ControlsOpenRequest
  root: string
  element: SelectedElement
  inspection: PropInspection | null
  inspecting: boolean
  /**
   * Tallest the CARD may grow (px) — derived from the preview area by the main
   * renderer. The island must not size itself from its own viewport (the view's
   * height follows the card's reported height; 100vh would be circular).
   */
  maxHeight: number
  /** AI-surfaced control panels matching the selection (Custom Controls, v10) —
   *  fetched by the main renderer via `controls:get`; null while unfetched. */
  controls: ResolvedControlPanel[] | null
  /**
   * Can trezi instrument this project for visual editing (a supported UI
   * framework was detected)? Tailors the Styles tab's read-only guidance when
   * the picked element has no source stamp. Null while unprobed.
   */
  canInstrument: boolean | null
  /**
   * The project's detected design tokens, so the Styles tab can name the
   * current value ("--color-text", not "#6c6c6c") and offer a picker. Null
   * while undetected / between projects.
   */
  tokens: TokenSet | null
}

/** A user action inside the island, relayed back to the main renderer. */
export type PanelAction =
  | { kind: 'cancel-selection' }
  | { kind: 'close' }
  | { kind: 'seed'; text: string }
  | { kind: 'apply-edit'; root: string; text: string }
  | { kind: 'setup' }
  | { kind: 'owner' }
  | { kind: 'inspection'; inspection: PropInspection }
  /** Ask the AI to surface a control panel for the selection (Custom Controls,
   *  v10) — App builds the trigger prompt and auto-sends it as a real turn. */
  | { kind: 'controls'; hint?: string; panelId?: string }
  /** Add an animation to the selection, then surface its tunable parameters. */
  | { kind: 'animation-controls'; hint?: string }

export interface PropEdit {
  source: string
  name: string
  kind: PropKind
  value: string | number | boolean
}

export interface PropEditResult {
  applied: boolean
  /** When not applied directly: the change needs the agent (complex / non-literal). */
  needsAgent?: boolean
  /** A ready-to-send prompt describing the change, when `needsAgent`. */
  agentPrompt?: string
  error?: string
}

/**
 * A style change from the island's Styles tab (v10). `prop` is a css longhand
 * from the fixed v1 allowlist (e.g. 'padding-top', 'border-radius',
 * 'transition-duration'); `value` is its css text (e.g. '13px', '150ms',
 * 'cubic-bezier(.17,.67,.83,.67)'). `classes` is the element's live class list,
 * which drives the Tailwind-first commit strategy (rewrite a utility class when
 * one matches, else splice an inline style, else route to the agent).
 */
export interface StyleEdit {
  /** The element's `data-trezi-source` stamp ("path/File.tsx:line"). */
  source: string
  /** The css property (longhand) being edited. */
  prop: string
  /** The new css value, as css text. */
  value: string
  /** The element's current class list (Tailwind class-rewrite candidates). */
  classes: string[]
  /**
   * Optional undo-batch id: a multi-prop gesture (the linked padding/margin
   * scrubber commits four longhands) sends one shared group so a single Cmd+Z
   * reverts the whole gesture — the per-prop coalesce keys differ, so
   * edit-history's group batching is the only thing that can join them.
   */
  group?: string
  /**
   * Set when the user picked a DESIGN TOKEN rather than a raw value: write a
   * reference (`var(--color-text)`, or a Tailwind token class) instead of
   * `value`. `value` still carries the token's resolved css text, so the live
   * preview, the post-commit reconcile and Replay all keep working against
   * something concrete — only the text written into source differs.
   *
   * Only the name + group cross the boundary: main re-detects the project's
   * tokens and re-validates the pick (name exists, value shape fits the
   * property), so the island's claim is never trusted. An unresolvable token is
   * dropped silently and the edit lands as a plain value edit — the value is
   * still right, only the reference is unavailable.
   */
  token?: { name: string; group: string }
  /**
   * The property's AUTHORED css text before this edit (`1.5rem`), when the
   * panel read one (`StyleReadResult.specified`). Prompt-context only — never
   * spliced: it lets the S3 agent prompt tell the agent to keep the project's
   * unit/idiom instead of pasting the scrub's px value into a rem-authored
   * declaration.
   */
  authored?: string
}

/** A `styles:read` reply: fresh computed values plus proof of token usage. */
export interface StyleReadResult {
  values: Record<string, string>
  /**
   * Per editable longhand: the exact `--name` its SPECIFIED (unresolved)
   * declaration references — inline `style=`, or a matched stylesheet /
   * scoped-`<style>` rule (see `preview/style-provenance.ts`) — or null when
   * it's a literal. `values`' computed style always fully resolves `var()`,
   * so this is the only signal that tells "this value IS that token" apart
   * from "happens to equal it".
   */
  declaredVars: Record<string, string | null>
  /**
   * Per editable longhand: the AUTHORED css text of that same specified
   * declaration, when one was found — `1.5rem`, where `values` can only ever
   * say `24px` (computed style serializes lengths as used px). What lets the
   * panel read back the project's own units instead of the browser's.
   */
  specified: Record<string, string>
}

/** Result of applying a StyleEdit (mirrors PropEditResult's shape). */
export interface StyleEditResult {
  applied: boolean
  /** How the edit landed: a Tailwind class rewrite or an inline-style splice. */
  strategy?: 'tailwind' | 'inline' | 'class-rule'
  /** True when a token REFERENCE was written (rather than the resolved value). */
  wroteToken?: boolean
  /** When not applied directly: the change needs the agent (dynamic class / expression style). */
  needsAgent?: boolean
  /** A ready-to-send prompt describing the change, when `needsAgent`. */
  agentPrompt?: string
  error?: string
}

/** Which control primitive the island renders for a custom-control param. */
export type ControlKind = 'number' | 'color' | 'select' | 'toggle' | 'text' | 'bezier'

/**
 * How a custom-control param writes back to the repo. The manifest is untrusted
 * agent output — main validates every strategy's target before any write.
 * - `prop`    — a component prop edit, applied at the live selection's
 *               `componentSource ?? source` through the props engine.
 * - `style`   — a css property, routed through the Styles engine (StyleEdit).
 * - `literal` — a source literal located by `anchor`: a unique substring that
 *               ends immediately before the literal in the manifest's `file`.
 *               Must occur exactly once (checked at save AND at every apply);
 *               main lexes + renders the replacement literal itself — supplied
 *               strings are never spliced raw.
 */
export type ControlApply =
  | { strategy: 'prop'; propName: string }
  | { strategy: 'style'; styleProp: string }
  | { strategy: 'literal'; anchor: string }

/** One parameter in an AI-surfaced control panel. Static metadata only — the
 *  current value is re-derived from the source of truth on every read (no
 *  values are stored, so manifests can't drift). */
export interface ControlParam {
  /** Stable id, unique within its panel (`^[a-z0-9][a-z0-9-]{0,40}$`). */
  id: string
  /** Human label rendered next to the control (≤80 chars, rendered as text). */
  label: string
  kind: ControlKind
  /** Display unit for 'number' params, e.g. 'px' | 'ms'. */
  unit?: string
  /** Clamp range for 'number' params (main clamps on apply, not just in UI). */
  min?: number
  max?: number
  /** Scrub increment for 'number' params. */
  step?: number
  /** Allowed values for `kind: 'select'`. */
  options?: string[]
  /** How the param writes back to source. */
  apply: ControlApply
}

/**
 * An AI-surfaced control panel for one component (Custom Controls, v10) —
 * generated by the agent's `define_controls` tool, validated by main, and
 * persisted in the repo's `.trezi/control-panels.json` sidecar. Upserted by
 * `file` + `component` (regenerating replaces, never duplicates).
 */
export interface ControlPanelManifest {
  /** Animation panels are owned by the project, not the current selection. */
  presentation?: 'animation'
  /** Project listens for trezi:animation-replay with its component name as detail. */
  replay?: boolean
  id: string
  /** Repo-relative source file the panel's params live in. */
  file: string
  /** The component name the panel targets (matches PropInspection.component). */
  component: string
  /** Panel heading shown in the island's Custom tab. */
  title: string
  params: ControlParam[]
  createdAt: string
}

/**
 * A ControlParam with its value freshly resolved from the source of truth
 * (`literal` → lexed from the live file; `prop` → props:inspect; `style` →
 * the element's computed styles). `valid: false` (with `reason`) marks a param
 * whose target no longer resolves — rendered disabled with a Regenerate offer.
 */
export interface ResolvedControlParam extends ControlParam {
  /** The current value, or null when it couldn't be resolved. */
  value: string | number | boolean | null
  /** False when the anchor/prop/style target no longer resolves. */
  valid: boolean
  /** Why the param is invalid (e.g. "anchor not found"), when `valid` is false. */
  reason?: string
}

/** A manifest plus its params resolved against the live tree — what the island renders. */
export interface ResolvedControlPanel {
  manifest: ControlPanelManifest
  params: ResolvedControlParam[]
}

/** Result of an undo/redo over the trezi source-edit history (v8 F3b). */
export interface UndoResult {
  ok: boolean
  /** The file reverted/re-applied. */
  file?: string
  /** The history stack was empty. */
  empty?: boolean
  /** The file changed on disk since the edit — refused to clobber. */
  conflict?: boolean
}

/** A reviewer note pinned to an element, stored in the repo's .trezi sidecar. */
export interface Annotation {
  id: string
  /** The element's data-trezi-source, if any. */
  source: string | null
  selector: string
  tag: string
  /** The reviewer's note. */
  text: string
  createdAt: string
}

/** What the renderer supplies to create an annotation (id/createdAt assigned in main). */
export interface AnnotationInput {
  source: string | null
  selector: string
  tag: string
  text: string
}

export interface PublishResult {
  ok: boolean
  /** The created PR URL on success. */
  url?: string
  /** The work branch publish kept the live checkout on (publish.ship). */
  branch?: string
  error?: string
  /** Published, but the work branch could not take in the merged base (LKM-185). */
  notice?: string
  /** Per-file merge conflicts left for explicit resolution; never auto-resolved. */
  conflictFiles?: string[]
  /** Local refs preserving the pre-reconciliation tips. */
  recoveryRefs?: string[]
  /** LKM-194: both tips bumped package.json `version` differently. */
  versionConflict?: { local: string; remote: string }
  /** The publish step that failed (`publish-progress.ts`), when one had started (LKM-187). */
  step?: string
  /** The user cancelled the run before the pull request was created. */
  cancelled?: boolean
}

/**
 * In-app feedback (LKM-27) posted as a GitHub issue on Trezi's OWN repo (the
 * app's git checkout, `app.getAppPath()`), not the opened target project. The
 * screenshot + conversation are opt-in attachments — the renderer only sends
 * them when the corresponding toggle is on, so a bare report carries neither.
 */
export interface FeedbackInput {
  /** The user's typed feedback. */
  body: string
  /** A `data:image/…;base64,…` app screenshot, present only when opted in. */
  screenshot?: string | null
  /** The rendered chat transcript, present only when opted in. */
  conversation?: string | null
  /** Attach redacted logs, landing state and git status (LKM-165), only when opted in. */
  diagnostics?: boolean
  /** The chat the sheet was opened over, for its landing state and worktree status. */
  chat?: { key: string; root?: string } | null
}

export interface FeedbackResult {
  ok: boolean
  /** The created issue URL on success. */
  url?: string
  error?: string
}

/** Result of scaffolding source-stamping into an unprepared project. */
export type Frontend = 'next' | 'react' | 'react-native' | 'svelte' | 'vue' | 'solid' | 'unknown'
/** How trezi instruments source mapping for the detected framework. */
export type SetupStrategy =
  | 'next-loader'
  | 'vite-plugin'
  | 'babel-plugin'
  | 'babel-plugin-rn'
  | 'svelte-preprocess'
  | 'inspector'
  | 'none'

/**
 * Read-only setup probe — can trezi instrument this project for visual editing?
 * Runs the deps-based framework detection WITHOUT writing anything, so the
 * renderer can decide up front whether to even offer setup (never dead-end a
 * static/vanilla project on "Set it up") and how to word the Styles tab's
 * read-only guidance.
 */
export interface SetupProbe {
  /** The detected UI framework (deps-based), or 'unknown' when unrecognized. */
  framework: Frontend
  /** True when trezi can add source-mapping for this framework (i.e. framework !== 'unknown'). */
  canInstrument: boolean
}

export interface NextSetupInfo {
  version?: string
  declaredVersion?: string
  command: string
  bundler: 'turbopack' | 'webpack' | 'unknown'
  router: 'app' | 'pages' | 'mixed' | 'unknown'
}

/** A React project built by Vite (LKM-153): Vite 8 transforms with Oxc and
 *  `@vitejs/plugin-react` 6 has no Babel option, so stamping uses Trezi's own plugin. */
export interface ViteSetupInfo {
  version?: string
  declaredVersion?: string
  major?: number
  /** The React plugin the project uses, with its installed (else declared) version. */
  reactPlugin?: string
  reactPluginVersion?: string
}

/** What the project remembers about Connect to Trezi (LKM-153), kept in its workspace entry. */
export interface SourceSetupState {
  /** `unstamped` (LKM-157): was `done`, but a restarted preview stayed without stamps. */
  state: 'done' | 'declined' | 'failed' | 'unstamped'
  /** The exact failure, shown with a retry. */
  reason?: string
  at: number
}

export interface SetupResult {
  next?: NextSetupInfo
  vite?: ViteSetupInfo
  helpers?: Array<{ path: string; sha256: string }>
  /** The chat worktree Trezi copied the helpers into before the setup turn. */
  checkout?: string

  ok: boolean
  /** The detected UI framework (NOT the build tool) — drives everything. */
  framework?: Frontend
  /** The instrumentation approach chosen for that framework. */
  strategy?: SetupStrategy
  /** Svelte major version (4 or 5), so the prop-typing idiom is right. */
  svelteMajor?: number
  /** Repo-relative files trezi wrote (under `.trezi/`). */
  files?: string[]
  /** False if the helper already existed (idempotent). */
  written?: boolean
  error?: string
}

export type TokenSource = 'manifest' | 'tailwind' | 'css' | 'none'

export interface Token {
  name: string
  value: string
}

export interface TokenGroup {
  name: string
  tokens: Token[]
}

/** Design tokens detected in the opened repo (one source wins per project). */
export interface TokenSet {
  source: TokenSource
  /** Human label for where they came from, e.g. ".trezi/tokens.json". */
  origin?: string
  groups: TokenGroup[]
}

/** Result of scaffolding a starter `.trezi/tokens.json` manifest. */
export interface TokenScaffoldResult {
  ok: boolean
  /** False if a manifest already existed (idempotent — nothing written). */
  written: boolean
  /** The token set after scaffolding (now sourced from the manifest). */
  set?: TokenSet
  error?: string
}

/** One entry in the File → Open Recent menu (pushed from the renderer's store). */
export interface RecentMenuEntry {
  root: string
  name: string
}

/** Visible preview's exploded scene. The document and session are opaque identities. */
export interface ThreeDState {
  session: string
  revision: number
  title: string
  layers: { id: number; label: string; depth: number }[]
  selected: number | null
  hasSource: boolean
  separation: number
  limited: boolean
  simplified: boolean
  invalid: boolean
}

export type ThreeDAction =
  | { session: string; revision: number; action: 'close' | 'code' | 'front' | 'reset' }
  | { session: string; revision: number; action: 'separation' | 'layer'; value: number }

/**
 * Self-update status pushed from main (`update:status`). Trezi is distributed
 * as a git checkout; the updater compares HEAD to the tracked remote.
 * - `idle`      — up to date, or not a git checkout / offline / no upstream.
 * - `available` — `behind` commits behind the remote; `subject` is the newest.
 * - `updating`  — an in-app "Update & Restart" is running; `progress` is the
 *                 latest output line.
 * - `error`     — a check or apply failed; `error` is the message.
 */
export interface UpdateStatus {
  status: 'idle' | 'available' | 'updating' | 'error'
  behind: number
  subject?: string
  progress?: string
  error?: string
}
