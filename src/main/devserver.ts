import type { NativeView } from '../native/platform'
import type { ProjectRuntime } from '../native/runtime-service'
import { outputLogger } from './devserver-log'
import { registerServiceDevServer } from './devserver-service'
import { editingOwner } from './editing-owner'
import { productLog } from './product-log'
import type { RpcHandlerRegistry } from './rpc-router'

/**
 * Project detection and dev-server routes. The service owns project runtimes (S06):
 * the routes are served by `devserver-service.ts` against the Swift RuntimeOwner, the
 * only runner since LKM-111 removed the Bun one. Only detection's sidecar migration
 * stays here.
 */
export function registerDevServerIpc(
  getWindow: () => NativeView | null,
  router: RpcHandlerRegistry,
  runtime: ProjectRuntime
): void {
  router.handle('project:detect', async (_e, root: string) => {
    // Move legacy sidecar data (annotations/tokens) into `.trezi/` before
    // anything reads the sidecar. No-op except right after the 2026-07 rename.
    for (const legacy of await editingOwner().migrateSidecar(root))
      console.warn(
        `Trezi metadata collision: keeping the existing file; legacy copy retained at ${legacy}`
      )
    // One-time rename of the setup helpers, imports and stamps (LKM-132). A clean tree
    // migrates here; a dirty one waits for the user (`project:migrate-names`).
    const names = await editingOwner().migrateNames(root, false)
    if (names.migrated)
      for (const kept of names.kept)
        console.warn(`Trezi setup helper differed from the current one; kept at ${kept}`)
    return runtime.detect(root)
  })
  router.handle('project:legacy-names', (_e, root: string) => editingOwner().legacyNames(root))
  router.handle('project:migrate-names', (_e, root: string) =>
    editingOwner().migrateNames(root, true)
  )
  // The window can outlive its webContents (display sleep / GPU loss), so guard
  // isDestroyed() or `.send()` throws for a late log line.
  const output = outputLogger()
  registerServiceDevServer(router, runtime, (line) => {
    // A target can print source excerpts, prompts or secrets in build errors. Only
    // persist a fixed category and length; the Activity view still gets the line.
    const fields = output(line)
    if (fields) productLog.info('output', 'Dev server output', { ...fields }, 'devserver')
    const wc = getWindow()?.webContents
    if (wc && !wc.isDestroyed()) wc.send('devserver:log', line)
  })
  // A ready server that ended by itself: the preview restarts it (LKM-146).
  runtime.onExit((root, url, reason) => {
    productLog.warn('lifecycle', 'Dev server exited', { root }, 'devserver')
    const wc = getWindow()?.webContents
    if (wc && !wc.isDestroyed()) wc.send('devserver:exit', { root, url, reason })
  })
}
