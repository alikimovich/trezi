import type { NativeView } from '../../native/platform'
import type {
  AgentEvent,
  AgentOptions,
  ImageAttachment,
  PermissionMode,
  ProviderLoginReport,
  QuestionAnswers,
  SessionRecord,
  SessionTranscriptEntry
} from '../../shared/api'

/**
 * The model-provider seam (v7). trezi's chat is backend-agnostic: `agent.ts` owns
 * the per-project `sessions` map, `activeKey`, teardown, the permission-card
 * settle loop, and every `agent:*` IPC handler — all in terms of `ProviderSession`
 * + `AgentEvent`. A `ModelProvider` plugs a specific backend (Claude Agent SDK,
 * OpenAI Codex SDK, Gemini CLI, …) behind that seam.
 *
 * Auth is per-user at runtime, by one of two paths — never a key committed in-repo.
 * A **built-in seat** signs in with the user's own subscription (Claude
 * `setup-token`, Codex "sign in with ChatGPT", Gemini "login with Google", Grok
 * `grok login`) and needs no configuration; a provider whose CLI/SDK isn't logged in
 * surfaces an `error` event the renderer maps to its login banner. A **connection**
 * (v10 — `AgentOptions.connectionId`, see `ProviderConnection` in shared/api.ts) uses
 * the user's OWN API key for an OpenAI-compatible endpoint they added, so open models
 * can drive a chat: that key is encrypted at rest with Electron `safeStorage`, lives
 * only in main (the renderer only ever learns `hasKey`), and is handed to the backend
 * per-session rather than written into any CLI's global config.
 */

/** An in-flight approve/deny prompt awaiting the user's decision. */
export interface PendingPrompt {
  toolName: string
  settle: (behavior: 'allow' | 'deny') => void
}

/**
 * An in-flight agent question (the SDK's AskUserQuestion tool) awaiting the user's
 * choice. `settle(null)` means the user dismissed it without answering.
 */
export interface PendingQuestion {
  settle: (answers: QuestionAnswers | null) => void
}

/**
 * Extra context for a `startSession` call beyond the plain single-session-per-
 * project case. Two unrelated uses share this shape:
 * - A detached comment-spawn run (v8 F1): `sessionId` is set, which stamps every
 *   event so the renderer routes it away from the main chat (its own rail row)
 *   instead of into a chat slice, and `onEvent` gives agent.ts an in-process hook
 *   for the terminal `done`/`error` without adding an IPC channel.
 * - An additional or resumed interactive chat (v9 resume/multi-chat): `sessionId`
 *   is left unset so events keep flowing into the normal chat pipeline, just
 *   tagged with `emitKey` = that session's own `sessionKey` (not the bare
 *   `projectKey`) so the renderer's `byKey` gives it its own slice. `resumeSessionId`
 *   asks the backend to resume a past SDK session instead of starting fresh
 *   (Claude-only; other backends accept and ignore it).
 */
export interface SpawnContext {
  /** Stable id for a detached comment spawn — stamped on every event so the
   *  renderer keeps it out of the active chat stream and into its own rail row.
   *  Absent for an additional/resumed interactive chat. */
  sessionId?: string
  /** The key the session's events + history record file under. For a spawn this
   *  is the PARENT project's projectKey; for an additional/resumed chat this is
   *  that chat's own sessionKey. */
  emitKey: string
  /** In-process choke point agent.ts listens on for the terminal event (spawns only). */
  onEvent?: (e: AgentEvent) => void
  /** Resume a past SDK session instead of starting fresh (v9 resume). Claude-only —
   *  other backends accept and ignore this. */
  resumeSessionId?: string
  /** A compact summary of the chat being resumed (LKM-165): if the resume fails, the new
   *  session starts from it instead of the lost one. */
  resumeSummary?: string
  /** The REAL project root when the session's cwd is a per-chat worktree
   *  (`isolatedCwd`). Tool callbacks that persist app state (e.g.
   *  chat-island persistence) must write under
   *  this root, not the worktree — a worktree write would be stranded when the
   *  worktree is merged/dropped. Absent ⇒ cwd IS the live root. */
  liveRoot?: string
  /** Durable Trezi-managed project decisions captured when this provider
   * session starts. Backends inject them into their initial instructions. */
  projectMemory?: string
  /** The provider owner's session id (S10, set by `provider-sessions.ts`): the adapter
   *  asks the owner with it before answering a permission request or running one of
   *  Trezi's tools. Absent only when an adapter is started outside that wiring. */
  grant?: string
  /** Inside a provider helper: Trezi's tools, run by Bun after the Swift owner
   *  authorized the call against the helper's grant. */
  tools?: SessionToolHost
  /** Inside a provider helper (LKM-135): cold-start progress the Swift owner bases its
   *  liveness deadlines and debug timings on. */
  onPhase?: (phase: ProviderPhase, detail?: ProviderPhaseDetail) => void
  /** Inside a Claude helper (LKM-135): the CLI an earlier helper of this app session
   *  chose, from the owner's cache. Present: no login probe runs. */
  claudeCli?: ClaudeCliChoice
}

/**
 * A helper's cold-start phases (LKM-135): `auth` the login probe finished (or the cached
 * choice was used), `cli` the provider CLI answered its initialize request, `init` the
 * CLI began the turn's session, `progress` the CLI reports work before any output.
 */
export type ProviderPhase = 'auth' | 'cli' | 'init' | 'progress'

export interface ClaudeCliChoice {
  source: 'bundled' | 'installed'
  executable?: string
}

export interface ProviderPhaseDetail {
  /** How long the phase took, in milliseconds. */
  ms?: number
  /** `auth`: the owner's cached choice was used. */
  cached?: boolean
  /** `auth` after a probe: the chosen CLI and whether it is logged in. */
  cli?: ClaudeCliChoice
  loggedIn?: boolean
}

/** Trezi tools as seen from a provider helper (see `backends/helper-host.ts`). */
export interface SessionToolHost {
  invoke(tool: string, args?: unknown): Promise<unknown>
}

/**
 * A live, multi-turn session for one open project. Providers MUST:
 * - emit exactly the `AgentEvent` contract: `delta` (assistant text), `status`
 *   (tool-use lines), `done` (exactly one per turn — clean finish AND interrupt),
 *   `error`; and SHOULD emit `permission-request`/`permission-resolved` and
 *   `commands` when the backend supports them.
 * - route ALL emission through `emit` (it tags `projectKey` and goes silent once
 *   `dispose()` is called, so a replaced/closed session can't leak into a chat).
 */
export interface ProviderSession {
  /** projectKey(root) — the map identity in agent.ts. */
  key: string
  root: string
  options: AgentOptions
  /** Enqueue a user turn (the renderer already called startAssistant()). */
  /** Send a user turn; `images` (paste/drop) go as vision blocks where supported. */
  send: (text: string, images?: ImageAttachment[]) => void
  /** In-flight approve/deny prompts, keyed by request id (settled by agent.ts). */
  pending: Map<string, PendingPrompt>
  /** In-flight agent questions (AskUserQuestion), keyed by request id. Only backends
   *  that support the tool populate it; agent.ts settles it from the renderer's answer. */
  pendingQuestions?: Map<string, PendingQuestion>
  /** Emit an event to the renderer (tagged projectKey; no-op once disposed). */
  emit: (event: AgentEvent) => void
  /** Growing history record for this session (v5-D), persisted by agent.ts on teardown. */
  record: SessionRecord
  /** Flush any in-progress assistant turn + sync filesTouched into `record`. Idempotent. */
  finalize: () => void
  /** Stop emitting (replaced/closed) — called before teardown so nothing leaks. */
  dispose: () => void
  /** Provider-specific teardown: abort the run, close any input stream/subprocess. */
  shutdown: () => void
  // Optional live controls — agent.ts optional-chains these and layers the generic
  // bookkeeping (options update, pending release) around them.
  setModel?: (model: string) => Promise<void>
  setPermissionMode?: (mode: PermissionMode) => Promise<void>
  /**
   * Stop the in-flight turn. MUST settle promptly — Stop is the user's escape
   * hatch, so a backend whose graceful cancel can block has to bound it itself
   * and escalate (agent.ts also caps the wait, but only it can clean up after).
   *
   * `hardStopped: true` means the graceful path failed and the backend killed the
   * underlying query/process, so this SESSION is now dead — agent.ts rebuilds the
   * chat rather than leaving one that looks alive but swallows every later turn.
   * A backend whose cancel is purely local (an AbortController it owns) never
   * needs it: resolving undefined reads as a clean stop.
   */
  interrupt?: () => Promise<{ hardStopped: boolean } | undefined>
  /**
   * The kill switch Stop escalates to when the provider owner's deadline passes
   * before `interrupt` answered (S10: the owner holds the deadline, see
   * `provider-sessions.ts`). It must end the turn: finalize, then emit an `error`
   * and one `done`. A backend without one is shut down instead.
   */
  forceStop?: () => void
}

export interface ModelProvider {
  /** Stable id used for dispatch ('claude' | 'codex' | …). */
  id: string
  /** Whether this backend can run a detached comment spawn (v8 F1) — it must
   *  honor the `SpawnContext` (route events through `ctx.onEvent`, emit the
   *  terminal `done`/`error`). Claude and Codex do today; others would silently
   *  leak a worktree + rail row, so agent.ts refuses to spawn on them. */
  supportsSpawn?: boolean
  /** `helper`: sessions run in a provider helper the Swift owner supervises, which
   *  already holds their grant and lifecycle (`backends/helper-session.ts`). */
  host?: 'helper'
  startSession: (
    root: string,
    options: AgentOptions,
    getWindow: () => NativeView | null,
    /** Present for a detached comment spawn (v8 F1) OR an additional/resumed
     *  interactive chat (v9 resume/multi-chat); absent for the plain default
     *  single-session-per-project case. A provider that doesn't support these can
     *  ignore it (Codex/Gemini accept it and no-op the resume). */
    ctx?: SpawnContext
  ) => Promise<ProviderSession>
  /**
   * Summarise a chat into a short name (3–6 words) describing what it's *about*,
   * from the conversation so far — so the rail can label a chat by its subject
   * rather than the opening words of the first prompt. A one-shot, tool-less
   * completion, independent of any live session. Best-effort: returns `null`
   * (and agent.ts falls back to the first-message heuristic) on any failure.
   * Optional — a backend without a cheap completion primitive omits it.
   */
  generateTitle?: (
    transcript: SessionTranscriptEntry[],
    options: AgentOptions
  ) => Promise<string | null>
  /**
   * Evaluate a completed chat against the project's current shared memory and
   * return the complete revised memory. Tool-less and best-effort: `null` means
   * no durable change or an evaluation failure. agent.ts serializes persistence.
   */
  updateProjectMemory?: (
    currentMemory: string,
    transcript: SessionTranscriptEntry[],
    options: AgentOptions
  ) => Promise<string | null>
  /**
   * "Check provider login" (LKM-119): the provider CLI's auth status, run inside a
   * provider helper (its environment and cwd are a chat's). Optional.
   */
  checkLogin?: () => Promise<Omit<ProviderLoginReport, 'provider'>>
}
