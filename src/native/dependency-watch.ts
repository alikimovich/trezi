import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const LOCKFILES = ['bun.lock', 'bun.lockb', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']
const MAX_DEPENDENCIES = 300
const POLL_MS = 2000

const stamp = async (path: string) => {
  try {
    const s = await stat(path)
    return `${s.ino}:${s.size}:${s.mtimeMs}`
  } catch {
    return '-'
  }
}

/**
 * What a dependency change alters in the live checkout: the manifest, the lockfiles
 * and the installed `package.json` of each direct dependency (a reinstall or upgrade
 * rewrites it even when the version stays). Stats only: cheap enough to poll.
 */
export async function dependencySignature(root: string): Promise<string> {
  let names: string[] = []
  try {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    names = [
      ...new Set([
        ...Object.keys(manifest?.dependencies ?? {}),
        ...Object.keys(manifest?.devDependencies ?? {})
      ])
    ]
      .filter((name) => /^(@[\w.-]+\/)?[\w.-]+$/.test(name))
      .sort()
      .slice(0, MAX_DEPENDENCIES)
  } catch {}
  const files = [
    'package.json',
    ...LOCKFILES,
    ...names.map((name) => `node_modules/${name}/package.json`)
  ]
  const stamps = await Promise.all(files.map((file) => stamp(join(root, file))))
  return files.map((file, i) => `${file}=${stamps[i]}`).join('\n')
}

/**
 * LKM-197: watches the active, running web project for dependency changes made outside
 * a landing (an install by the agent or the user in the live checkout, an upgraded
 * package). A change must hold for two polls (an install finishes first); then the
 * project restarts with clean dependency caches and the preview reloads past WebKit's.
 * Whenever the project is not running (opening, a landing's own restart) the baseline
 * is dropped and retaken, so a restart Trezi already did never triggers another.
 */
export class DependencyWatch {
  private baseline: { key: string; signature: string } | null = null
  private candidate: string | null = null
  private busy = false
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    readonly target: () => { key: string; root: string } | null,
    readonly changed: (key: string) => void,
    readonly signature: (root: string) => Promise<string> = dependencySignature
  ) {}

  start(intervalMs = POLL_MS) {
    this.timer ??= setInterval(() => void this.tick(), intervalMs)
    this.timer.unref?.()
  }
  stop() {
    clearInterval(this.timer)
    this.timer = undefined
  }

  async tick(): Promise<void> {
    if (this.busy) return
    const project = this.target()
    if (!project) {
      this.baseline = this.candidate = null
      return
    }
    this.busy = true
    try {
      const signature = await this.signature(project.root)
      if (this.target()?.key !== project.key) return
      if (this.baseline?.key !== project.key) {
        this.baseline = { key: project.key, signature }
        this.candidate = null
      } else if (signature === this.baseline.signature) {
        this.candidate = null
      } else if (signature !== this.candidate) {
        this.candidate = signature
      } else {
        this.baseline = this.candidate = null
        this.changed(project.key)
      }
    } finally {
      this.busy = false
    }
  }
}
