import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { turnMessage } from './chat-commit'
import { clearPark, gitOut, upsertParkRecord } from './chat-park'
import { type ChatState, emitIsolation, onChain, states } from './chat-state'
import { completeTurn } from './chat-worktrees'
import { productLog } from './product-log'
import { retireWorktreeBranch } from './worktrees'

/**
 * LKM-196: a chat never stays parked with nothing held. A park is a claim that the
 * chat's cumulative batch (`baseSha..HEAD` in its worktree) is not in the project. It
 * goes stale when the same content reaches the live tree another way (the user or a
 * command applied it there, a landing wrote the files and then failed), and nothing
 * re-checked it until the user pressed Retry or Resolve: the chat looked blocked, and
 * the agent saw "parked" with nothing to prepare. Checked on every turn start, on chat
 * open and before the agent's workspace tools answer:
 *  - nothing pending against live → the park is cleared (the work is in the project);
 *  - a pending diff the chat lost track of → the batch is rebuilt (committed, files and
 *    park record restored) so Resolve, Retry and Discard work on it again.
 */
export type ParkReconcile = 'none' | 'kept' | 'cleared' | 'rebuilt'

const execFileP = promisify(execFile)
const blobAt = (cwd: string, spec: string): Promise<Buffer | null> =>
  execFileP('git', ['show', spec], {
    cwd,
    encoding: 'buffer',
    timeout: 15000,
    maxBuffer: 64 * 1024 * 1024
  }).then(
    ({ stdout }) => stdout as Buffer,
    () => null
  )

/** Every file of the held batch, and the ones whose content the live tree lacks. */
export async function heldBatch(st: ChatState): Promise<{ files: string[]; pending: string[] }> {
  const files = (
    await gitOut(st.wt.path, [
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      `${st.wt.baseSha}..HEAD`
    ])
  )
    .split('\0')
    .filter(Boolean)
  const pending: string[] = []
  for (const rel of files) {
    const chat = await blobAt(st.wt.path, `HEAD:${rel}`)
    const live = await readFile(join(st.liveRoot, rel)).catch(() => null)
    if (chat === null ? live !== null : live === null || !chat.equals(live)) pending.push(rel)
  }
  return { files, pending }
}

const dirty = async (path: string): Promise<boolean> =>
  !!(await gitOut(path, ['status', '--porcelain', '--untracked-files=all'])).trim()

/**
 * Reconcile one chat's park. Call on the chat's chain, inside the repository lease.
 * `fold` commits the worktree's uncommitted changes into the batch first; only when
 * no turn runs (they are the running turn's own work otherwise). Never throws.
 */
export async function reconcileParkOnChain(
  sessionKey: string,
  st: ChatState,
  where: 'turn-start' | 'chat-open' | 'agent-tool',
  fold: boolean
): Promise<ParkReconcile> {
  // A staged Resolve, a reverted stop and a reclaimed checkout have their own way out.
  if (!st.parked || st.reverted || st.resolvingFiles || st.reclaimed) return 'none'
  try {
    // An agent's own merge in progress (LKM-188) is finished by its turn, not here.
    if (
      (
        await gitOut(st.wt.path, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => '')
      ).trim()
    )
      return 'kept'
    let folded = false
    if (fold && (await dirty(st.wt.path))) {
      const described = await turnMessage(sessionKey, st, ++st.turnNo)
      const outcome = await completeTurn(st.liveRoot, st.wt, described.text, {
        land: false,
        keepHistory: st.gitAccess === 'full'
      })
      folded = outcome.outcome === 'parked'
    }
    const { files, pending } = await heldBatch(st)
    if (!pending.length && !(fold && (await dirty(st.wt.path)))) {
      const head = (await gitOut(st.wt.path, ['rev-parse', 'HEAD'])).trim()
      const reason = st.landingError ? 'failed' : st.interrupted ? 'interrupted' : 'conflict'
      clearPark(st)
      st.wt.baseSha = head
      // A running turn keeps its branch; its own landing retires it.
      if (where !== 'agent-tool') await retireWorktreeBranch(st.wt).catch(() => {})
      st.lastLanding = {
        outcome: files.length ? 'merged' : 'unchanged',
        files,
        at: Date.now()
      }
      productLog.info('parking', 'Stale park cleared: nothing left to land', {
        worktree: st.wt.id,
        where,
        reason,
        files: files.length
      })
      emitIsolation(sessionKey, 'isolated', st.wt.branch)
      return 'cleared'
    }
    const lost = folded || !st.parkedFiles.length || files.some((f) => !st.parkedFiles.includes(f))
    if (!lost) {
      // The sidebar's record is non-critical history; restore it quietly if it went.
      if (!st.parkRecordId) upsertParkRecord(st, st.parkedFiles)
      return 'kept'
    }
    st.parkedFiles = files
    upsertParkRecord(st, files)
    productLog.info('parking', 'Park batch rebuilt', {
      worktree: st.wt.id,
      where,
      files: files.length,
      pending: pending.length
    })
    emitIsolation(
      sessionKey,
      'parked',
      st.wt.branch,
      files,
      undefined,
      undefined,
      st.landingError ? 'failed' : st.interrupted ? 'interrupted' : undefined,
      st.landingError
    )
    return 'rebuilt'
  } catch (error) {
    productLog.warn('parking', 'Park reconcile failed', {
      worktree: st.wt.id,
      where,
      error: error instanceof Error ? error.message : String(error)
    })
    return 'kept'
  }
}

/** `reconcileParkOnChain` queued behind the chat's in-flight work. */
export async function reconcilePark(
  sessionKey: string,
  where: 'chat-open' | 'agent-tool'
): Promise<ParkReconcile> {
  const st = states.get(sessionKey)
  if (!st?.parked) return 'none'
  return onChain(st, () => reconcileParkOnChain(sessionKey, st, where, where === 'chat-open'))
}

/**
 * Chat open (`agent:workspace-snapshot`): reconcile every idle parked chat, waiting at
 * most `boundMs` so a long landing never holds the snapshot. `busy` excludes chats
 * whose turn or landing is running.
 */
export async function reconcileIdleParks(
  busy: (sessionKey: string) => boolean,
  boundMs = 2000
): Promise<void> {
  const work = [...states.entries()]
    .filter(([key, st]) => st.parked && !busy(key))
    .map(([key]) => reconcilePark(key, 'chat-open'))
  if (!work.length) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.all(work),
    new Promise((resolve) => {
      timer = setTimeout(resolve, boundMs)
    })
  ])
  clearTimeout(timer)
}
