import { type FSWatcher, watch } from 'node:fs'

/** Generated output, dependencies and Trezi's sidecars: never the user's source. */
const IGNORED =
  /(^|\/)(\.git|node_modules|\.next|\.nuxt|\.vite|\.svelte-kit|\.turbo|\.cache|\.parcel-cache|\.vercel|\.output|dist|build|out|coverage|\.trezi)(\/|$)/
const BATCH_MS = 50

/** Whether a root-relative path is one the editor's caches never read. */
export const ignoredLivePath = (path: string) => IGNORED.test(path.replaceAll('\\', '/'))

/**
 * LKM-216: watches the active project's live checkout (FSEvents through `fs.watch`), so
 * an edit made outside Trezi's own writers (the user's editor, an agent's `land_now`,
 * a formatter) invalidates the editor's caches too. Changed paths arrive root-relative
 * in batches; generated and dependency folders are filtered out (the dependency watch
 * owns those). A watch that cannot start leaves only Trezi's own change signals.
 */
export class LiveTreeWatch {
  private watcher: FSWatcher | null = null
  private root = ''
  private batch = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly changed: (root: string, files: string[]) => void,
    readonly open: (
      root: string,
      listener: (event: string, file: string | Buffer | null) => void
    ) => FSWatcher = (root, listener) => watch(root, { recursive: true }, listener)
  ) {}

  get watching() {
    return this.root
  }

  /** Follows the active project; an empty root stops watching. */
  target(root: string) {
    if (root === this.root) return
    this.stop()
    if (!root) return
    try {
      const watcher = this.open(root, (_event, file) => this.saw(root, file))
      watcher.on('error', () => {
        if (this.watcher === watcher) this.stop()
      })
      watcher.unref?.()
      this.watcher = watcher
      this.root = root
    } catch {
      this.root = ''
    }
  }

  stop() {
    this.watcher?.close()
    this.watcher = null
    this.root = ''
    this.batch.clear()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private saw(root: string, file: string | Buffer | null) {
    if (root !== this.root) return
    const path = file ? String(file) : ''
    if (path && ignoredLivePath(path)) return
    this.batch.add(path)
    this.timer ??= setTimeout(() => {
      this.timer = null
      const files = [...this.batch].filter(Boolean)
      this.batch.clear()
      if (root === this.root) this.changed(root, files)
    }, BATCH_MS)
  }
}
