import type {
  AgentEvent,
  AgentOptions,
  ImageAttachment,
  PermissionMode,
  QuestionAnswers,
  SessionRecord
} from '../shared/api'
import type { PermissionVerdict } from './provider-policy'

/**
 * The provider owner seam (S10). Under the Swift launch the service's provider owner
 * holds every provider session's grant and lifecycle: which Trezi tools it may run,
 * how its permission requests are answered, when Stop gives up on a graceful cancel
 * and kills it, and the provider thread id a restored chat resumes (persisted, so a
 * crash does not lose it). It also supervises provider HELPERS — separate processes
 * with a scrubbed environment and only their stdio — and enforces their grant on
 * every frame they send (`ProviderHelper.swift`).
 *
 * The built-in adapters (Claude, Codex, Gemini) run in helpers by default since LKM-111
 * (`backends/helper-session.ts`); a v10 connection's Codex session stays in Bun and asks
 * this owner through `provider-sessions.ts`. LKM-111 also removed the in-process twin:
 * with no Swift owner installed nothing can start a provider session.
 */

export type ProviderPhase = 'idle' | 'running' | 'cancelling' | 'stopped'

/** What the adapter tells the owner when a session opens. The owner derives the rest. */
export interface ProviderGrant {
  /** Unique per provider session (never reused). */
  session: string
  /** The chat's key (its emitKey): events and approvals belong to it. */
  chat: string
  provider: string
  /** The session's working directory (a chat worktree or the live root). */
  root: string
  liveRoot: string
  /** A detached comment spawn. */
  background: boolean
}

export interface OwnedProviderSession {
  session: string
  chat: string
  provider: string
  host: 'bun' | 'helper'
  phase: ProviderPhase
  background: boolean
  tools: string[]
  resume: string | null
}

/** A session the service was running when it stopped without closing it. */
export interface ProviderRecovery {
  session: string
  chat: string
  provider: string
  record: string | null
  resume: string | null
  /** A turn was in flight. */
  interrupted: boolean
}

/** A helper broke its grant: the frame was refused and the helper stopped. */
export interface ProviderViolation {
  session: string
  reason: string
}

/**
 * What a helper's provider added to its session record since the last delta:
 * assistant and tool-status entries, the files it edited, its resumable thread id.
 * Bun's record keeps everything else (user entries, title, branch).
 */
export interface RecordDelta {
  entries: SessionRecord['transcript']
  filesTouched?: string[]
  sdkSessionId?: string
}

/** The Bun side of a helper-hosted session: what the owner relays. */
export interface HelperHandlers {
  /** A validated event, already tagged with the grant's chat (and spawn id). */
  event(event: AgentEvent): void
  /** New record content, sent before the event that followed it. */
  record(delta: RecordDelta): void
  /** An authorized Trezi tool call; the result goes back to the helper. */
  tool(tool: string, args: unknown): Promise<unknown>
  /** The helper is gone (exited, killed, closed). */
  exit(reason: string): void
}

export interface HelperStart {
  options: AgentOptions
  context: {
    emitKey: string
    sessionId?: string
    resumeSessionId?: string
    resumeSummary?: string
    liveRoot?: string
    projectMemory?: string
  }
}

export class ProviderError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export interface ProviderOwner {
  readonly kind: 'swift'
  /** Registers an in-process (Bun) adapter's session; answers its granted Trezi tools. */
  open(grant: ProviderGrant): Promise<{ tools: string[] }>
  /** Starts a helper-hosted session: the owner spawns and supervises the helper. */
  openHelper(
    grant: ProviderGrant,
    start: HelperStart,
    handlers: HelperHandlers
  ): Promise<{ tools: string[] }>
  permission(session: string, tool: string, input: unknown): Promise<PermissionVerdict>
  /** Rejects with `unauthorized` (forbidden scope) or `invalidRequest` (too large). */
  authorize(session: string, tool: string, args: unknown): Promise<void>
  /** A user turn reached the in-process adapter. */
  turn(session: string): Promise<void>
  /** A user turn for a helper-hosted session (images keep their bytes and type). */
  send(session: string, text: string, images?: ImageAttachment[]): Promise<void>
  /** Stop was pressed: resolves once the graceful stop settled (`escalate: false`) or
   *  the owner's deadline passed (`escalate: true`: kill it; a helper is already killed). */
  cancel(session: string): Promise<{ escalate: boolean }>
  /** The in-process adapter's graceful stop answered. */
  settled(session: string): Promise<void>
  terminal(session: string, kind: 'done' | 'error'): Promise<void>
  /** The provider's resumable thread id for a session record (persisted by the Swift owner). */
  resume(session: string, id: string, record: string): Promise<void>
  /** The resume id last reported for a session record, if the owner kept one. */
  recover(record: string): Promise<{ provider: string; resume: string } | null>
  /** The user's answer to a helper-hosted session's approval or question. */
  answer(
    session: string,
    id: string,
    kind: 'permission' | 'question',
    value: 'allow' | 'deny' | QuestionAnswers | null
  ): Promise<void>
  configure(session: string, change: { model?: string; mode?: PermissionMode }): Promise<void>
  close(session: string): Promise<void>
  snapshot(): Promise<{ sessions: OwnedProviderSession[] }>
  status(): Promise<{ recovered: ProviderRecovery[]; violations: ProviderViolation[] }>
}

let owner: ProviderOwner | null = null

/** Installed once by the native entry point when the Swift service is supervising Bun. */
export function setProviderOwner(next: ProviderOwner | null): void {
  owner = next
}

/** The Swift owner; with none installed (Bun outside the service) no session can start. */
export function providerOwner(): ProviderOwner {
  if (!owner)
    throw new ProviderError(
      'unavailable',
      'Trezi’s service is not running, so provider sessions cannot start.'
    )
  return owner
}
