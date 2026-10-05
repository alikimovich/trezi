import type { ProjectRuntime } from '../native/runtime-service'
import type { DevServerInfo, Framework, RunningDevServer } from '../shared/api'
import { projectKey } from '../shared/projectKey'
import { previewServers } from './preview-evidence'
import { installProjectDependencies } from './project-dependencies'
import type { RpcHandlerRegistry } from './rpc-router'

/**
 * The dev-server routes under the Swift runtime owner (S06). Same channels and
 * results as the legacy runner in `devserver.ts`; the service runs, probes and
 * stops the servers. Bun keeps the preview-evidence mirror and runs a start's
 * dependency install through its repository write queue (the service executes it).
 */
export function registerServiceDevServer(
  router: RpcHandlerRegistry,
  runtime: ProjectRuntime,
  log: (line: string) => void
): void {
  // A newer start or stop for the project discards an older start's result.
  const generations = new Map<string, number>()
  const bump = (key: string) => {
    const next = (generations.get(key) ?? 0) + 1
    generations.set(key, next)
    return next
  }
  runtime.onLog((_root, line) => log(line))
  runtime.onExit((root, url) => {
    const key = projectKey(root)
    if (previewServers.get(key)?.url === url) previewServers.delete(key)
  })

  router.handle(
    'devserver:start',
    async (
      _e,
      opts: { root: string; command: string; framework?: Framework; installDependencies?: boolean }
    ): Promise<RunningDevServer> => {
      const key = projectKey(opts.root)
      const generation = bump(key)
      previewServers.delete(key)
      if (opts.installDependencies) {
        await installProjectDependencies(opts.root)
        if (generations.get(key) !== generation) throw new Error('Preview start was cancelled.')
      }
      const server = await runtime.start({
        root: opts.root,
        command: opts.command,
        framework: opts.framework
      })
      if (generations.get(key) === generation) previewServers.set(key, server)
      return server
    }
  )
  // Landed manifest changes: the workspace controller stops the server, installs here
  // (the preview says so), then starts it (LKM-146).
  router.handle('devserver:install', async (_e, root: string) => {
    bump(projectKey(root))
    await installProjectDependencies(root)
  })
  router.handle('devserver:stop', async (_e, root: string) => {
    const key = projectKey(root)
    bump(key)
    previewServers.delete(key)
    await runtime.stop(root)
  })
  router.handle('devserver:running', async (_e, root: string) => (await runtime.info(root)).running)
  router.handle('devserver:info', async (_e, root: string): Promise<DevServerInfo> => {
    const info = await runtime.info(root)
    return info.server ? { running: true, server: info.server } : { running: false }
  })
}
