import { DependencyConflictError, manifestMarkers } from './conflict-markers'
import { editingOwner } from './editing-owner'
import { productLog } from './product-log'
import { installProjectDependencies } from './project-dependencies'

/** Installs still running in a checkout (LKM-182), by checkout path. */
const installing = new Map<string, Promise<void>>()

/** Whether a background install is still running in this checkout. */
export function dependenciesInstalling(checkout: string): boolean {
  return installing.has(checkout)
}

/** The checkout's background install, if one is running (settles, never rejects). */
export function dependencyInstall(checkout: string): Promise<void> | undefined {
  return installing.get(checkout)
}

/** Every checkout gets its own node_modules (LKM-146): a shared link let an agent's
 * install or remove rewrite the live dependencies under the running dev server before
 * anything landed, and Next/Turbopack cannot follow such a link outside its root. The
 * editing owner removes a link, clones the live folder copy-on-write when the manifests
 * match and keeps the marker (`.trezi/dependencies.sha256`). Otherwise (another volume,
 * changed manifests) the checkout installs from its own manifests and lockfile through
 * the service installer. Never broadens a framework's root.
 *
 * `background` (LKM-182, the new-chat path): the clone still happens here, but an
 * install that is needed starts and is not awaited, so a chat can show and its turn can
 * start while it runs. While one runs in a checkout, later calls leave it alone.
 *
 * A manifest or lockfile with unresolved conflict markers is never installed: the call
 * rejects with `DependencyConflictError` instead, in either mode (LKM-194). */
export async function provisionDependencies(
  liveRoot: string,
  checkout: string,
  install = installProjectDependencies,
  opts: { background?: boolean } = {}
): Promise<void> {
  // The owner would clone over the folder the install is writing.
  const running = installing.get(checkout)
  if (running) {
    if (!opts.background) await running
    return
  }
  const owner = editingOwner()
  // Empty/uninstalled projects are provisioned by their ordinary setup turn.
  if (!(await owner.dependencyState(liveRoot, checkout))) return
  // LKM-194: a manifest with conflict markers cannot parse; installing only fails.
  const marked = await manifestMarkers(checkout)
  if (marked.length) throw new DependencyConflictError(marked)
  const job = (async () => {
    await install(checkout)
    await owner.markDependencies(liveRoot, checkout)
  })()
  if (!opts.background) return job
  const started = Date.now()
  productLog.info('worktree', 'Dependencies installing in the background', { checkout })
  const settled = job.then(
    () =>
      productLog.info('worktree', 'Background dependency install finished', {
        checkout,
        ms: Date.now() - started
      }),
    (error) =>
      productLog.warn('worktree', 'Background dependency install failed', {
        checkout,
        ms: Date.now() - started,
        error: error instanceof Error ? error.message : String(error)
      })
  )
  installing.set(checkout, settled)
  void settled.finally(() => {
    if (installing.get(checkout) === settled) installing.delete(checkout)
  })
}
