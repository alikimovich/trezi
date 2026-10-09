import { isAbsolute, relative } from 'node:path'
import type { SourceChangeReason } from '../main/source-changes'
import { ignoredLivePath } from './live-tree-watch'

/**
 * LKM-216: what Trezi shows must match the current source without a manual reload.
 * Every change in the live checkout (a landing, Trezi's own source write, the live-tree
 * watch, the dependency watch) and every sign that the page applied one (an HMR CSS
 * update, a new document) lands here. The inventory of caches this clears and the rules
 * are in docs/CACHES.md.
 *
 * - The token memo drops at once (any project).
 * - For the active project, after a short settle: the editing island re-reads the
 *   selection's computed styles/props/tokens/controls, Layers re-reads its tree and the
 *   chat islands re-read their bound values.
 * - A stylesheet change the page has not applied within `css` ms (no HMR update; a new
 *   document is checked `css` ms after it loads, since WebKit may have served it from
 *   cache) is compared with the dev server. Stale `<link>`s are swapped for cache-busted
 *   copies; whatever is still stale after that gets one hard reload.
 */
export type FreshnessReason = SourceChangeReason | 'hmr' | 'document'

/** CSS, preprocessors and the configs that generate CSS or tokens. */
const STYLE_FILE =
  /\.(css|scss|sass|less|styl|pcss|postcss)$|(^|\/)(tailwind|postcss|unocss|panda)\.config\.[cm]?[jt]s$/

export const isStyleFile = (path: string) => STYLE_FILE.test(path)

export interface FreshnessHost {
  /** The active project and its dev server URL (null when it shows no web preview). */
  active(): { root: string; url: string | null } | null
  /** The editing island re-reads the selection (skips while its own edit settles). */
  inspector(): Promise<void>
  /** Layers re-reads its tree when it is open. */
  layers(): Promise<void>
  /** The project's chat islands re-read their bound values. */
  islands(root: string): Promise<void>
  /** Drops the project's cached token detection. */
  tokens(root: string): void
  /** The preview's loaded CSS/JS against the dev server; null when nothing could be read. */
  check(url: string): Promise<{ stale: string[]; staleStyles?: string[] } | null>
  /** Swaps the listed stylesheets for cache-busted copies; how many were replaced. */
  reloadStyles(paths: string[]): Promise<number>
  /** Reloads the preview past WebKit's caches. */
  hardReload(): void
  report(error: unknown): void
}

export interface FreshnessTiming {
  /** Coalesces a burst of changes into one re-read. */
  settle: number
  /** How long HMR may take to apply a CSS change before Trezi checks the page itself. */
  css: number
  /** Wait after a targeted stylesheet reload before checking again. */
  recheck: number
  /** An HMR or document signal counts only this long after a change. */
  window: number
  /** At most one automatic hard reload per this interval. */
  hardGap: number
}
export const FRESHNESS_TIMING: FreshnessTiming = {
  settle: 60,
  css: 500,
  recheck: 400,
  window: 5000,
  hardGap: 3000
}

export class EditorFreshness {
  readonly stats = { rereads: 0, styleChecks: 0, styleReloads: 0, hardReloads: 0 }
  /** The newest change and the newest page update after it, per the clock. */
  changedAt = Number.NEGATIVE_INFINITY
  appliedAt = Number.NEGATIVE_INFINITY
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private cssTimer: ReturnType<typeof setTimeout> | null = null
  private lastHard = Number.NEGATIVE_INFINITY
  private running: Promise<void> = Promise.resolve()
  /** The oldest stylesheet change not yet verified on the page, and a change counter. */
  private styleSince: number | null = null
  private styleChanges = 0
  /** True while Trezi swaps stale `<link>`s itself (the page reports that as a CSS update). */
  private swapping = false
  /** New documents seen in a change's window; a check that spans one has lost its page. */
  private documents = 0

  constructor(
    readonly host: FreshnessHost,
    readonly timing: FreshnessTiming = FRESHNESS_TIMING,
    readonly now: () => number = Date.now
  ) {}

  invalidate(root: string, reason: FreshnessReason, files: string[] = []) {
    if (reason !== 'hmr' && reason !== 'document') this.host.tokens(root)
    const active = this.host.active()
    if (!active || active.root !== root) return
    const now = this.now()
    if (reason === 'hmr' || reason === 'document') {
      // CSS-in-JS and navigation also touch styles; only an outstanding change matters.
      if (now - this.changedAt > this.timing.window) return
      // Trezi's own stylesheet swap is not the dev server's update.
      if (reason === 'hmr' && !this.swapping) this.appliedAt = now
      // A new document may still come from WebKit's cache: check it once it has loaded.
      if (reason === 'document') {
        this.documents++
        if (this.styleSince !== null) this.scheduleStyleCheck(root, this.styleSince)
      }
    } else {
      const paths = files.map((file) => relativePath(root, file)).filter(Boolean)
      if (reason === 'file-change' && paths.length && paths.every(ignoredLivePath)) return
      this.changedAt = now
      if (reason === 'dependency' || paths.some(isStyleFile)) {
        this.styleChanges++
        this.styleSince ??= now
        this.scheduleStyleCheck(root, this.styleSince)
      }
    }
    this.scheduleReread()
  }

  /** No re-read or style check is pending or running. */
  get idle(): boolean {
    return !this.settleTimer && !this.cssTimer && this.styleSince === null && !this.swapping
  }

  dispose() {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    if (this.cssTimer) clearTimeout(this.cssTimer)
    this.settleTimer = this.cssTimer = null
  }

  private scheduleReread() {
    this.settleTimer ??= setTimeout(() => {
      this.settleTimer = null
      void this.reread()
    }, this.timing.settle)
  }

  /** One re-read at a time; a change during one is picked up by the next. */
  reread(): Promise<void> {
    const run = async () => {
      const active = this.host.active()
      if (!active) return
      this.stats.rereads++
      const results = await Promise.allSettled([
        this.host.inspector(),
        this.host.layers(),
        this.host.islands(active.root)
      ])
      for (const result of results)
        if (result.status === 'rejected') this.host.report(result.reason)
    }
    this.running = this.running.then(run, run)
    return this.running
  }

  private scheduleStyleCheck(root: string, since: number) {
    if (this.cssTimer) clearTimeout(this.cssTimer)
    this.cssTimer = setTimeout(() => {
      this.cssTimer = null
      void this.styleCheck(root, since).catch((error) => this.host.report(error))
    }, this.timing.css)
  }

  /** The page did not apply a stylesheet change in time: compare, swap, then reload. */
  async styleCheck(root: string, since: number): Promise<void> {
    const changes = this.styleChanges
    try {
      await this.verifyStyles(root, since)
    } finally {
      // A change that arrived meanwhile keeps its own check scheduled.
      if (changes === this.styleChanges) this.styleSince = null
    }
  }

  private async verifyStyles(root: string, since: number) {
    const active = this.host.active()
    if (!active || active.root !== root || !active.url) return
    // The page's CSS signal is not proof: a document load inserts `<link>`s and tools inject
    // `<style>`s too. The comparison with the server always runs; a signal only rules out
    // the hard reload (a script an HMR update replaced is stale on purpose).
    this.stats.styleChecks++
    const documents = this.documents
    const first = await this.host.check(active.url)
    if (!first?.stale.length) return
    if (first.staleStyles?.length) {
      this.swapping = true
      try {
        if (await this.host.reloadStyles(first.staleStyles)) {
          this.stats.styleReloads++
          await new Promise((resolve) => setTimeout(resolve, this.timing.recheck))
          const again = this.host.active()?.root === root ? await this.host.check(active.url) : null
          if (again && !again.stale.length) {
            await this.reread()
            return
          }
        }
      } finally {
        this.swapping = false
      }
    }
    if (this.host.active()?.root !== root || this.appliedAt >= since) return
    // A new document replaced the one compared: its own check is already scheduled.
    if (this.documents !== documents) return
    const now = this.now()
    if (now - this.lastHard < this.timing.hardGap) return
    this.lastHard = now
    this.stats.hardReloads++
    this.host.hardReload()
  }
}

/** Root-relative with forward slashes; an absolute path outside the root stays absolute. */
export function relativePath(root: string, file: string): string {
  if (!file) return ''
  const path = isAbsolute(file) ? relative(root, file) : file
  return path.replaceAll('\\', '/').replace(/^\.\//, '')
}
