import { randomUUID } from 'node:crypto'
import { createChatWorktree } from './chat-worktrees'
import { isRepoRoot } from './git'
import { productLog } from './product-log'
import { enqueueRepoWrite } from './repo-write-queue'
import { dependencyInstall } from './worktree-dependencies'
import { removeWorktree, retireWorktreeBranch, type Worktree } from './worktrees'

/**
 * LKM-182: one prewarmed chat worktree per open project, so "New chat" rarely waits for
 * `git worktree add` and the dependency clone. It is created in the background after the
 * project opens and after each new chat takes it, exactly as a chat's own worktree is
 * (detached, branch retired), and synced from the live tree when taken
 * (`chat-isolation.ts`). Closing the project removes it like any clean chat checkout.
 * A spare left behind by a quit is an ordinary clean orphan for the next launch's
 * `pruneOrphans`.
 */

interface Spare {
  id: string
  /** The checkout once created; null while it is being created or when it failed. */
  wt: Worktree | null
  /** Settles with the checkout, or null for a non-repository root or a failure. */
  ready: Promise<Worktree | null>
}

const spares = new Map<string, Spare>()

/** Start creating `liveRoot`'s spare unless it has one. Never throws. */
export function prewarmSpare(liveRoot: string, worktreesDir: string): void {
  if (spares.has(liveRoot)) return
  const id = randomUUID().slice(0, 8)
  const started = Date.now()
  const spare: Spare = { id, wt: null, ready: Promise.resolve(null) }
  spare.ready = (async () => {
    if (!(await isRepoRoot(liveRoot))) return null
    const wt = await enqueueRepoWrite(liveRoot, async () => {
      const created = await createChatWorktree(liveRoot, id, worktreesDir)
      await retireWorktreeBranch(created)
      return created
    })
    spare.wt = wt
    productLog.info('worktree', 'Spare chat worktree ready', { id, ms: Date.now() - started })
    return wt
  })().catch((error) => {
    productLog.warn('worktree', 'Spare chat worktree failed', {
      id,
      error: error instanceof Error ? error.message : String(error)
    })
    return null
  })
  spares.set(liveRoot, spare)
  // Nothing to keep for a folder that is not a repository root, or after a failure.
  void spare.ready.then((wt) => {
    if (!wt && spares.get(liveRoot) === spare) spares.delete(liveRoot)
  })
}

/** Hand `liveRoot`'s spare (ready or still being created) to a new chat. The caller
 *  awaits it; null there means the chat creates its own checkout. */
export function takeSpare(liveRoot: string): Promise<Worktree | null> | null {
  const spare = spares.get(liveRoot)
  if (!spare) return null
  spares.delete(liveRoot)
  productLog.info('worktree', 'Spare chat worktree taken', { id: spare.id, ready: !!spare.wt })
  return spare.ready
}

/** Remove `liveRoot`'s unused spare (project close). Waits for one still being created
 *  and for its background install. Never throws. */
export async function releaseSpare(liveRoot: string): Promise<void> {
  const spare = spares.get(liveRoot)
  if (!spare) return
  spares.delete(liveRoot)
  const wt = await spare.ready
  if (!wt) return
  await dependencyInstall(wt.path)
  // A spare is never edited: its HEAD is its fork point, so nothing needs a recovery ref.
  await enqueueRepoWrite(liveRoot, () => removeWorktree(liveRoot, wt, { intent: 'abandon' })).catch(
    () => {}
  )
  productLog.info('worktree', 'Spare chat worktree removed', { id: wt.id })
}

/** Ids of every spare (ready or being created): orphan recovery must skip them. */
export function spareWorktreeIds(): string[] {
  return [...spares.values()].map((spare) => spare.id)
}

/** Test seam: `liveRoot`'s spare once settled, or null when it has none. */
export function spareReady(liveRoot: string): Promise<Worktree | null> {
  return spares.get(liveRoot)?.ready ?? Promise.resolve(null)
}

/** Forget every spare on quit; the checkouts stay for the next launch's recovery. */
export function dropSpares(): void {
  spares.clear()
}
