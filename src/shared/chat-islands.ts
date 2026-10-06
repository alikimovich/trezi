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
