import type { ProjectRuntime } from '../native/runtime-service'
import type { DevServerInfo, Framework, NativeProjectInfo, RunningDevServer } from '../shared/api'
import { projectKey } from '../shared/projectKey'
import { previewServers } from './preview-evidence'
import { installProjectDependencies } from './project-dependencies'
import type { RpcHandlerRegistry } from './rpc-router'
import { nativeProjectInfo, swiftPreviewCommand, treziManifestDir } from './swift-preview'

/**
 * The dev-server routes under the Swift runtime owner (S06). Same channels and
 * results as the legacy runner in `devserver.ts`; the service runs, probes and
 * stops the servers. Bun keeps the preview-evidence mirror and runs a start's
 * dependency install through its repository write queue (the service executes it).
 */
export function registerServiceDevServer(
  router: RpcHandlerRegistry,
  runtime: ProjectRuntime,
  log: (line: string) => void,
  /** Trezi's app data, holding the Trezi-side Swift preview manifests (LKM-273). */
  userData?: () => string
): void {
  // A newer start or stop for the project discards an older start's result.
  const generations = new Map<string, number>()
  const bump = (key: string) => {
    const next = (generations.get(key) ?? 0) + 1
    generations.set(key, next)
    return next
  }
  // Projects whose running server is Trezi's Swift preview driver, not a user's dev server.
  const drivers = new Set<string>()
  runtime.onLog((_root, line) => log(line))
  runtime.onExit((root, url) => {
    const key = projectKey(root)
    if (previewServers.get(key)?.url === url) {
      previewServers.delete(key)
      drivers.delete(key)
    }
  })

  router.handle(
    'devserver:start',
    async (
      _e,
      opts: {
        root: string
        command: string
        framework?: Framework
        installDependencies?: boolean
        cleanCache?: boolean
      }
    ): Promise<RunningDevServer> => {
      const key = projectKey(opts.root)
      const generation = bump(key)
      previewServers.delete(key)
      if (opts.installDependencies) {
        await installProjectDependencies(opts.root)
        if (generations.get(key) !== generation) throw new Error('Preview start was cancelled.')
      }
      // A Swift project has no command of its own: Trezi's preview driver serves it.
      const manifestDir = userData ? treziManifestDir(opts.root, userData()) : undefined
      const driver = opts.framework === 'swift' && !opts.command.trim()
      const server = await runtime.start({
        root: opts.root,
        command: driver ? swiftPreviewCommand(undefined, undefined, manifestDir) : opts.command,
        framework: opts.framework,
        ...(opts.cleanCache ? { cleanCache: true } : {})
      })
      if (generations.get(key) === generation) {
        previewServers.set(key, server)
        if (driver) drivers.add(key)
        else drivers.delete(key)
      }
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
    drivers.delete(key)
    await runtime.stop(root)
  })
  router.handle('devserver:running', async (_e, root: string) => (await runtime.info(root)).running)
  router.handle('devserver:info', async (_e, root: string): Promise<DevServerInfo> => {
    const info = await runtime.info(root)
    return info.server ? { running: true, server: info.server } : { running: false }
  })
  // A native project's roots, manifest locations and target graph (LKM-273).
  router.handle('project:native', async (_e, root: string): Promise<NativeProjectInfo> => {
    const info = await runtime.info(root)
    const server = info.server && {
      url: info.server.url,
      driver: drivers.has(projectKey(root))
    }
    return nativeProjectInfo(root, userData?.() ?? '', server)
  })
}
