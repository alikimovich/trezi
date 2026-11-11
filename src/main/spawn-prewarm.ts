import { privatePageId } from './agent-browser'
import {
  agentRuntime,
  ensureAgentRuntime,
  privateRuntimeKind,
  stopAgentRuntime
} from './agent-runtime'
import { productLog } from './product-log'

/**
 * LKM-639: a background agent (an inspector Apply, a comment) lands only after a
 * `preview_verify` passed on its exact source (LOCAL-WEBKIT-3), and that check needs the
 * private dev server of its brand-new worktree. That server used to start only when the
 * agent first called the check, after its edit, so every Apply waited for a cold start
 * on its critical path. It now starts as soon as the worktree exists, in parallel with
 * the provider's startup and the model's first steps, under the same id the agent's
 * private page uses (`privatePageId`), so the page's own `ensureAgentRuntime` call finds
 * it running or shares the start in flight. Nothing about the check changes: the receipt
 * is still taken by the agent's own check, on its exact source and server generation.
 * Best-effort: a project that is not a web project, or a failed start, is left to the
 * check exactly as before. The spawn stops the server when it closes
 * (`releaseSpawnRuntime`), page or not.
 */

let enabled = true
/** Tests only: compare with the old serial start. */
export function setSpawnPrewarm(next: boolean): void {
  enabled = next
}

/** Prestarts in flight, by page id; a release while one runs cancels it. */
const pending = new Map<string, { released: boolean }>()

export async function prewarmSpawnRuntime(
  op: string,
  emitKey: string,
  worktree: string
): Promise<'started' | 'skipped' | 'failed'> {
  if (!enabled) return 'skipped'
  const id = privatePageId(emitKey, worktree)
  if (pending.has(id) || agentRuntime(id)?.root === worktree) return 'skipped'
  const token = { released: false }
  pending.set(id, token)
  const started = Date.now()
  try {
    if ((await privateRuntimeKind(worktree)) !== 'web' || token.released) return 'skipped'
    await ensureAgentRuntime(id, worktree)
    // The spawn closed while its server started: nothing may outlive it.
    if (token.released) {
      await stopAgentRuntime(id).catch(() => {})
      return 'skipped'
    }
    productLog.info('spawn', 'Background agent dev server prestarted', {
      op,
      ms: Date.now() - started
    })
    return 'started'
  } catch {
    if (token.released) return 'skipped'
    // The agent's own check starts (and reports) it again; no message here (it can name paths).
    productLog.info('spawn', 'Background agent dev server prestart failed', {
      op,
      ms: Date.now() - started
    })
    return 'failed'
  } finally {
    if (pending.get(id) === token) pending.delete(id)
  }
}

/** Stops the spawn's private server (a page closing stops it too; a second stop is a no-op). */
export function releaseSpawnRuntime(emitKey: string, worktree: string): Promise<void> {
  const id = privatePageId(emitKey, worktree)
  const token = pending.get(id)
  if (token) token.released = true
  return stopAgentRuntime(id).catch(() => {})
}
