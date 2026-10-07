import type { ControlPanelManifest } from '../shared/api'
import type {
  IslandBlock,
  IslandHealth,
  IslandRecord,
  IslandUserState,
  IslandValue
} from '../shared/chat-islands'

/**
 * The editing owner seam (S12). Under the Swift launch the service's editing
 * coordinator decides the editing workflows between the preview, the inspectors and
 * the chat:
 * - chat islands: the only writer of their history files (`<userData>/chat-islands`),
 *   pending activation bound to the turn that defined them, command admission, the
 *   revision chain of a queued batch and each island's Undo group;
 * - the project sidecars (`.trezi/control-panels.json` and since S15
 *   `annotations.json` and `tokens.json`), committed only if the file still holds the
 *   bytes Bun read, in the repository lane;
 * - the project's other `.trezi/` files (S15): the pre-rename sidecar migration, the
 *   setup helpers a chat worktree carries and the worktree's own `node_modules` (a
 *   clone of the live one, LKM-146) with its dependency marker, run in the same lane
 *   (`EditingProject.swift`; Bun still runs an install between the two dependency
 *   calls when no clone fits);
 * - deferred preview navigation (`open_preview`), released when its turn lands.
 * Bun keeps the JS helpers (manifest validation, Jev composition, literal
 * resolution and splicing, source proposals), the isolated WebKit instrumentation and
 * the inspector views. It is the only owner since LKM-111 removed the in-process twin:
 * with no service, these workflows refuse.
 */

export interface IslandAdmission {
  /** Names this composition in `islandCommit`/`islandAbort`. */
  token: string
  id: string
  revision: number
  turn: number
  /** The definition replaces the island of the same turn (same id). */
  replacing: boolean
}

export interface IslandCommandAdmission {
  ticket: string
  /** The source revision the command must be computed against (the batch's own writes). */
  expected: string
  /** Undo: the source-owner group to revert. */
  group?: string
  /** Reset: the island's initial values. */
  initial?: Record<string, IslandValue>
}

export type SidecarName = 'control-panels.json' | 'annotations.json' | 'tokens.json'
export const SIDECAR_NAMES: readonly SidecarName[] = [
  'control-panels.json',
  'annotations.json',
  'tokens.json'
]
export type SidecarCommit = { ok: true; hash: string } | { ok: false; conflict: true }
export type NavigationEvent = 'landed' | 'failed' | 'begin' | 'close'
/** `files`: project-relative paths with a legacy reference; `helpers`: legacy helper files. */
export interface LegacyNamesPlan {
  legacy: boolean
  clean: boolean
  files: string[]
  helpers: string[]
}
/** `dirty` with `migrated: false`: refused, nothing changed. `kept`: differing legacy copies. */
export type LegacyNamesResult =
  | { migrated: false; dirty: boolean }
  | { migrated: true; dirty: boolean; files: string[]; kept: string[] }

export class EditingError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export interface EditingOwner {
  readonly kind: 'swift'
  // Chat islands
  islandsOpen(chat: string, root: string, record: string): Promise<IslandRecord[]>
  islandsClose(chat: string): Promise<void>
  islands(chat: string): Promise<IslandRecord[]>
  /** `origin` is the turn id Bun attributes the tool call to (the owner checks it). */
  islandDefine(
    chat: string,
    turn: number,
    origin: string | null,
    id?: string,
    revision?: number
  ): Promise<IslandAdmission>
  islandCommit(
    chat: string,
    token: string,
    definition: { manifest: ControlPanelManifest; blocks: IslandBlock[] },
    engine: 'agent' | 'jev',
    initial: Record<string, IslandValue>,
    fallback?: string,
    /** The island's stable short name (`island-shadow-2`), kept across revisions. */
    name?: string
  ): Promise<IslandRecord[]>
  islandAbort(chat: string, token: string): Promise<void>
  /** LKM-181: the user's Disable/Hide (`null`: Enable/Show), saved with the record. */
  islandMark(chat: string, id: string, user: IslandUserState | null): Promise<IslandRecord[]>
  /** LKM-181: what Bun's binding check found, saved with the record when it changed. */
  islandHealth(
    chat: string,
    id: string,
    revision: number,
    health: IslandHealth,
    reason?: string,
    reasons?: Record<string, string>
  ): Promise<IslandRecord[]>
  /** LKM-181: the agent's `show {id}`, attaching a ready island to the current turn. */
  islandShow(chat: string, id: string, turn: number, origin: string | null): Promise<IslandRecord[]>
  /** A turn's terminal (`turn` null: whatever the chat is doing). `records` null: chat not open. */
  islandSettle(
    chat: string,
    turn: string | null,
    successful: boolean
  ): Promise<{ records: IslandRecord[] | null; cancelled: boolean }>
  islandCommand(
    chat: string,
    id: string,
    revision: number,
    action: 'commit' | 'reset' | 'undo' | 'reload',
    sourceRevision: string
  ): Promise<IslandCommandAdmission>
  islandFinish(
    chat: string,
    ticket: string,
    outcome: { ok: boolean; group?: string; revision?: string },
    last: boolean
  ): Promise<void>
  // Deferred preview navigation
  /** Answers whether it may open now (false: it waits for its turn to land). `now`: the
   *  chat has nothing unlanded, so it opens at once instead of after the turn (LKM-196). */
  navigate(
    chat: string,
    root: string,
    path: string,
    turn: string | null,
    now?: boolean
  ): Promise<boolean>
  navigation(chat: string, kind: NavigationEvent, turn: string | null): Promise<boolean>
  navigationTake(chat: string): Promise<{ root: string; path: string } | null>
  navigationState(): Promise<
    Array<{ chat: string; root: string; path: string; turn: string | null; awaiting: boolean }>
  >
  /** Hash-bound project sidecar commit; `expectedHash` null means the file must not exist. */
  sidecar(
    root: string,
    name: SidecarName,
    expectedHash: string | null,
    content: string
  ): Promise<SidecarCommit>
  // Project files in `.trezi/` (S15), each in the project's repository lane
  /** Moves legacy sidecar metadata into `.trezi/`; answers the legacy copies a differing file won over. */
  migrateSidecar(root: string): Promise<string[]>
  /** Legacy names the project still uses (`EditingLegacyNames`) and whether its tree is clean. */
  legacyNames(root: string): Promise<LegacyNamesPlan>
  /** Rewrites them to Trezi names; a dirty tree changes only when `confirmed`. Never commits. */
  migrateNames(root: string, confirmed: boolean): Promise<LegacyNamesResult>
  /** Copies the live project's setup helpers into a worktree (verified, hashes recorded). */
  syncSetupHelpers(liveRoot: string, worktree: string): Promise<void>
  /** Gives a checkout its own `node_modules` (removes a link to the live one, clones the live
   *  folder when the manifests match); answers whether it still needs its own install. */
  dependencyState(liveRoot: string, checkout: string): Promise<boolean>
  /** Records the manifests the checkout's install ran against. */
  markDependencies(liveRoot: string, checkout: string): Promise<void>
}

let owner: EditingOwner | null = null

/** Installed once by the native entry point when the Swift service is supervising Bun. */
export function setEditingOwner(next: EditingOwner | null): void {
  owner = next
}

/** The Swift owner, when installed. */
export function swiftEditingOwner(): EditingOwner | null {
  return owner
}

/** The Swift owner; with no service there is none (no islands or sidecar writes). */
export function editingOwner(): EditingOwner {
  if (!owner)
    throw new EditingError(
      'unavailable',
      'Trezi’s service is not running, so this project cannot be edited.'
    )
  return owner
}
