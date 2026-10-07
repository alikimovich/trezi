import type { ControlPanelManifest, ControlParam } from './api'

/** Versioned native wire format. Executable code is never part of a spec. */
export type IslandValue = string | number | boolean
export interface IslandBlock {
  id: string
  title: string
  kind: 'group' | 'point' | 'shadow'
  output?: 'css' | 'tailwind'
  params: string[]
}
/** What the code still supports (LKM-181): every binding, some, or none. */
export type IslandHealth = 'ready' | 'partially-disabled' | 'disabled'
/** The user's choice: read-only and collapsed, or out of the transcript. */
export type IslandUserState = 'disabled' | 'hidden'
export interface IslandRecord {
  version: 1
  id: string
  revision: number
  turn: number
  manifest: ControlPanelManifest
  blocks: IslandBlock[]
  engine: 'agent' | 'jev'
  fallback?: string
  status: 'waiting' | 'ready' | 'unavailable'
  initial: Record<string, IslandValue>
  /** The turn id that defined it (S12): only that turn's landing activates it. */
  origin?: string
  /** Stable short reference, e.g. `island-shadow-2` (written `#island-shadow-2`). */
  name?: string
  /** The last binding check (LKM-181); absent until the first check. */
  health?: IslandHealth
  /** One line on why the island is disabled by the code. */
  reason?: string
  /** param id → one line on why that field is disabled. */
  reasons?: Record<string, string>
  user?: IslandUserState
  /**
   * LKM-201: defined before the source had its literals. After its turn lands it activates
   * only once every binding resolves (the owner then drops the flag and keeps the landed
   * values as `initial`); until then it writes nothing.
   */
  planned?: boolean
}
/**
 * What the transcript shows. `disabled` is by the code, or by the user (`disabledBy`);
 * `hidden` is the user's. A lifecycle `unavailable` record (its turn did not land) shows
 * as disabled by the code.
 */
export type IslandStatus = 'waiting' | 'ready' | 'partially-disabled' | 'disabled' | 'hidden'
export interface IslandView {
  id: string
  /** `#island-…`, shown in the header and inserted by Copy reference. */
  name: string
  revision: number
  title: string
  blocks: IslandBlock[]
  /** `disabled`: why this field cannot be edited (shown on hover). */
  fields: (ControlParam & { value: IslandValue | null; disabled?: string })[]
  sourceRevision: string
  status: IslandStatus
  disabledBy?: 'code' | 'user'
  /** One line on why the island is disabled; never exception text. */
  reason?: string
  /** What the code supports, also while the user has it disabled or hidden. */
  health?: IslandHealth
  detail: string
  engine: string
  replay: boolean
  /** Inline note, e.g. a bound value changed outside the island and the controls were refreshed. */
  notice?: string
}
export interface IslandCommand {
  chat: string
  id: string
  revision: number
  sourceRevision: string
  gesture?: string
  /** The gesture's last frame (release, Return, a discrete change): write it now (LKM-140). */
  ended?: boolean
  operation: string
  action:
    | 'commit'
    | 'reset'
    | 'undo'
    | 'reload'
    | 'replay'
    // The island's … menu and disabled row (LKM-181); handled in Bun, never written to source.
    | 'disable'
    | 'enable'
    | 'hide'
    | 'show'
    | 'show-hidden'
    | 'reference'
    | 'recreate'
  values?: Record<string, IslandValue>
}
export const ISLAND_USER_ACTIONS = [
  'disable',
  'enable',
  'hide',
  'show',
  'show-hidden',
  'reference',
  'recreate'
] as const
/** The chat's islands as the composer's `#` picker and reference chips name them. */
export interface IslandReference {
  id: string
  name: string
  title: string
  status: IslandStatus
}

/** Why a chat cannot host islands right now (LKM-199); each has one recovery step. */
export type IslandBlockCode =
  | 'workspace_pending'
  | 'preparation_failed'
  | 'not_git'
  | 'no_session'
  | 'closed'
export const ISLAND_RECOVERY: Record<IslandBlockCode, string> = {
  workspace_pending:
    "This chat's workspace is still being prepared. Call chat_island again in a moment; define, read and show wait for it.",
  preparation_failed:
    "This chat's workspace could not be prepared. Tell the user, and ask them to start a new chat; do not retry here.",
  not_git:
    "This project's folder is not a Git repository, so the chat has no workspace. Tell the user to open a Git repository (git init) and start a new chat.",
  no_session:
    'The chat has a workspace but its islands could not be attached. Call chat_island catalog again; if it persists, tell the user to reopen the chat.',
  closed: 'This chat is closed. Tell the user; islands need an open chat.'
}
export const ISLAND_REASON: Record<IslandBlockCode, string> = {
  workspace_pending: "The chat's workspace is still being prepared.",
  preparation_failed: "The chat's workspace could not be prepared.",
  not_git: "The project's folder is not a Git repository.",
  no_session: "The chat's islands are not attached to its workspace.",
  closed: 'The chat is closed.'
}
export interface IslandBlocker {
  code: IslandBlockCode
  /** The underlying cause, when one is known (redacted by the caller). */
  detail?: string
}
/** What `chat_island` catalog reports: whether this chat can host islands now, and where. */
export interface IslandReadiness {
  ready: boolean
  chat: string
  root?: string
  recordId?: string
  /** The chat's checkout (its worktree, or the project folder when it is not a Git repo). */
  worktree?: string
  code?: IslandBlockCode
  reason?: string
  recovery?: string
}
/** The answer of `agent:chat-record`: the chat's record, or why it has none. */
export type ChatRecordLookup =
  | { ready: true; root: string; recordId: string; worktree: string }
  | ({ ready: false } & IslandBlocker)
