import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PackageManager } from '../shared/api'
import { enqueueRepoWrite } from './repo-write-queue'

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  )

export async function projectPackageManager(root: string): Promise<PackageManager> {
  // Respect an explicit packageManager even while a migration leaves an old lockfile.
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const manager = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : ''
    if (['bun', 'pnpm', 'yarn', 'npm'].includes(manager)) return manager as PackageManager
  } catch {
    /* detection reports malformed manifests */
  }
  if ((await exists(join(root, 'bun.lock'))) || (await exists(join(root, 'bun.lockb'))))
    return 'bun'
  if (await exists(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (await exists(join(root, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

let serviceInstaller: ((root: string) => Promise<unknown>) | null = null

/** The service runs and supervises installs (S06); set by the native entry point.
 * LKM-111 removed the in-process install that ran without one. */
export function setDependencyInstaller(
  installer: ((root: string) => Promise<unknown>) | null
): void {
  serviceInstaller = installer
}

/** Install in the live checkout (worktree-local node_modules are never landed by Git),
 * in the repository's lane. The service logs its own progress and output. */
export async function installProjectDependencies(root: string): Promise<void> {
  if (!serviceInstaller)
    throw new Error('Trezi’s service is not running, so project dependencies cannot be installed.')
  const install = serviceInstaller
  return enqueueRepoWrite(root, async () => {
    await install(root)
  })
}
