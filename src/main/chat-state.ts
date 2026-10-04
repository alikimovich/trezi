import { dirname } from 'node:path'
import type { NativeView } from '../native/platform'
import type { AgentEvent, SessionRecord } from '../shared/api'
import { createChatWorktree } from './chat-worktrees'
import { enqueueRepoWrite } from './repo-write-queue'
import type { SessionStore } from './sessions-store'
import { retireWorktreeBranch, type Worktree } from './worktrees'

/**
 * The in-memory state behind per-chat isolation (`chat-isolation.ts`), shared with
 * its park records (`chat-park.ts`), landing (`chat-landing.ts`), parked-chat
 * actions (`parked-chat.ts`) and helper sync (`chat-helpers.ts`). Internal: other
 * modules use those modules' functions, never `ChatState` itself.
 */

/** In-memory state for one isolated chat, keyed by its `sessionKey` (= emitKey). */
export interface ChatState {
  wt: Worktree
  liveRoot: string
  /** A turn's merge refused (mid-turn drift): work stays on the branch for review. */
  parked: boolean
  /** The persisted park `SessionRecord` id while parked, else null. */
  parkRecordId: string | null
  /** Files in the cumulative batch that Trezi could not safely land. */
  parkedFiles: string[]
  /** Marker-bearing files after `stageResolve`; retained so preparing twice is
   *  idempotent instead of erasing the only recovery diff on the second call. */
  resolvingFiles: string[] | null
  /** The park came from a stopped/failed turn, not live drift (LKM-151). */
  interrupted: boolean
  /** The user reverted the stopped turn: the live tree never had it, and the held work
   *  is discarded at the next turn start (or release) unless they undo first. */
  reverted: boolean
  turnNo: number
  /** Per-chat serialization chain (sync + merge queue). */
  chain: Promise<unknown>
  /** The live session's history record (adopted right after startSession). Held by
   *  reference so a later `agent:tag-session` prUrl mutation is seen live — a chat
   *  whose work was pushed & merged (prUrl set) marks its turns non-revertable. */
  record?: SessionRecord
  /** When the chat last started or finished a turn (idle cleanup, LKM-136). */
  lastUsed: number
  /** Idle cleanup removed the checkout; the next turn recreates it at the same path. */
  reclaimed: boolean
}

interface Deps {
  worktreesDir: () => string
  store: () => SessionStore
  getWindow: () => NativeView | null
}

let deps: Deps | null = null
export const states = new Map<string, ChatState>()

/** Wire the module's Electron/store/window seam. Called once at IPC registration. */
export function initChatIsolation(d: Deps): void {
  deps = d
  states.clear()
}

/** The injected seam, or null before `initChatIsolation`. */
export function chatDeps(): Deps | null {
  return deps
}

/** Emit an isolation event on the same webContents path other agent:* events use,
 *  tagged with the chat's `sessionKey` (= emitKey) so the renderer routes it to the
 *  right chat. Sent via the window (not `session.emit`) so a final merge after the
 *  session is disposed still reaches the renderer. */
export function emitIsolation(
  sessionKey: string,
  state: 'isolated' | 'merged' | 'parked',
  branch?: string,
  files?: string[],
  group?: string,
  revertable?: boolean,
  reason?: 'interrupted' | 'reverted'
): void {
  // Guard a destroyed webContents: this fires from async turn lifecycle hooks,
  // which can land after the renderer process is killed (OS display sleep).
  const wc = deps?.getWindow()?.webContents
  if (wc && !wc.isDestroyed())
    wc.send('agent:event', {
      type: 'isolation',
      state,
      ...(branch ? { branch } : {}),
      ...(files && files.length ? { files } : {}),
      ...(group ? { group } : {}),
      ...(revertable !== undefined ? { revertable } : {}),
      ...(reason ? { reason } : {}),
      projectKey: sessionKey
    } satisfies AgentEvent)
}

/** Run `operation` after the chat's in-flight work, inside the repository lease. The
 *  chain moves on past a failure; the caller still sees it. */
export function onChain<T>(st: ChatState, operation: () => Promise<T>): Promise<T> {
  const task = st.chain.then(() => enqueueRepoWrite(st.liveRoot, operation))
  st.chain = task.catch(() => {})
  return task
}

/** Recreate a checkout idle cleanup removed, at the same path and id. Call inside the
 *  repository lease (`enqueueRepoWrite`) on the chat's chain; a no-op otherwise. */
export async function recreateWorkspace(st: ChatState): Promise<void> {
  if (!st.reclaimed) return
  const created = await createChatWorktree(st.liveRoot, st.wt.id, dirname(st.wt.path))
  await retireWorktreeBranch(created)
  st.wt = created
  st.reclaimed = false
}
