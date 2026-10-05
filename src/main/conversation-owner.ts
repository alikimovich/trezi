import type {
  AgentOptions,
  PermissionMode,
  SessionRecord,
  SessionTranscriptEntry
} from '../shared/api'

/**
 * The conversation owner seam (S11). Under the Swift launch the service's
 * conversation coordinator owns what a chat is between provider events: session
 * records and History (the only writer of `sessions/*.json`), a checkpoint of every
 * live chat (so a crash mid-turn keeps the transcript), the turn state machine and its
 * completion policy, titles, model handoff, pending approvals and spawn admission.
 * Bun's provider sessions are adapters: agent.ts reports typed events to the owner and
 * performs the effects its answers call for (landing goes through the repository
 * coordinator). It is the only owner since LKM-111 removed the in-process twin: with
 * no service, chats do not start and History is not written.
 */

export type TurnOutcome = 'success' | 'failed'
export type Persist = 'current' | 'history' | 'none'
export type ApprovalKind = 'permission' | 'question'
export type TurnPhase = 'idle' | 'preparing' | 'running' | 'landing'

/** A terminal event's fate. At most one per run of a turn is claimed. */
export type TerminalClaim =
  | { claimed: true; outcome: TurnOutcome; title: boolean; memory: boolean }
  | { claimed: false; reason: 'stale' | 'duplicate' }

export interface OwnedChat {
  chat: string
  project: string
  root: string
  active: boolean
  phase: TurnPhase
  turn: string | null
  run: number
  record: SessionRecord
  options: AgentOptions
}

/** A chat a crash cut off, and what the next Swift launch did with its record. */
export interface ConversationRecovery {
  chat: string
  id: string
  project: string
  interrupted: boolean
  outcome: 'restored' | 'kept' | 'damaged'
  copy?: string
}

export interface Released {
  id: string
  kind: ApprovalKind
}

export class ConversationError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export interface ConversationOwner {
  /** Which owner this is, for diagnostics and tests. */
  readonly kind: 'swift'
  // Session records (History and each project's current chat).
  save(record: SessionRecord, current?: boolean): Promise<void>
  remove(id: string): Promise<void>
  rename(id: string, title: string): Promise<{ ok: boolean; title?: string; error?: string }>
  // Live chats.
  open(
    chat: string,
    project: string,
    record: SessionRecord,
    options: AgentOptions,
    active: boolean
  ): Promise<void>
  activate(chat: string): Promise<void>
  checkpoint(chat: string, record: SessionRecord): Promise<boolean>
  close(
    chat: string,
    persist: Persist,
    record: SessionRecord
  ): Promise<{ saved: boolean; release: Released[] }>
  configure(chat: string, options: AgentOptions): Promise<void>
  /** A new provider session for the chat. `model` waits for the turn (busy otherwise). */
  handoff(
    chat: string,
    options: AgentOptions,
    record: SessionRecord,
    reason: 'model' | 'restart'
  ): Promise<void>
  // Turns.
  begin(chat: string, turn: string): Promise<void>
  /** The user entry reached the provider; `handoff` asks for the recorded history once. */
  send(chat: string, turn: string, entry: SessionTranscriptEntry): Promise<{ handoff: boolean }>
  abort(chat: string, turn: string): Promise<boolean>
  cancel(chat: string): Promise<{ phase: TurnPhase; turn: string | null }>
  terminal(
    chat: string,
    turn: string,
    run: number,
    kind: 'done' | 'error',
    record: SessionRecord
  ): Promise<TerminalClaim>
  continueTurn(chat: string, turn: string, run: number): Promise<boolean>
  landed(chat: string, turn: string, at: number): Promise<{ landed: boolean; completedAt?: number }>
  /** `user` renames always win; a `generated` title only names an untitled chat ('' ends titling). */
  title(
    chat: string,
    title: string,
    source: 'user' | 'generated'
  ): Promise<{ ok: boolean; title?: string; error?: string }>
  // Approvals (permission cards and agent questions).
  register(chat: string, id: string, kind: ApprovalKind, tool: string): Promise<void>
  /** The chat holding this approval, or null when it is unknown or already settled. */
  resolve(id: string, kind: ApprovalKind): Promise<string | null>
  mode(chat: string, mode: PermissionMode): Promise<string[]>
  release(chat: string): Promise<Released[]>
  // Background spawns: admitted now, or queued FIFO behind the project's cap.
  spawn(id: string, project: string): Promise<boolean>
  spawnDone(id: string): Promise<string[]>
  spawnCancel(id: string): Promise<boolean>
  snapshot(): Promise<{ chats: OwnedChat[]; spawns: { running: string[]; queued: string[] } }>
  status(): Promise<{ recovered: ConversationRecovery[] }>
}

let owner: ConversationOwner | null = null

/** Installed once by the native entry point when the Swift service is supervising Bun. */
export function setConversationOwner(next: ConversationOwner | null): void {
  owner = next
}

/** The Swift owner, when installed (sessions-store routes its writes through it). */
export function swiftConversationOwner(): ConversationOwner | null {
  return owner
}
