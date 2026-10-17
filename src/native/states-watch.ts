import { statSync } from 'node:fs'

const MAX_WATCHED = 200
const INTERVAL = 400

const stamp = (file: string) => {
  try {
    const stat = statSync(file)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return ''
  }
}

/** Watches the files a states bundle was built from. Polled with our own baseline, not
 * `fs.watch` (Bun never again reports a path whose `fs.watch` was closed once, so a component
 * shown a second time would stop updating) and not `fs.watchFile` (Bun takes its baseline on
 * the first tick, so an edit made right after `watch` can be missed). */
export class StatesWatch {
  private timer: ReturnType<typeof setInterval> | undefined

  watch(files: string[], changed: (file: string) => void) {
    this.close()
    const known = new Map(files.slice(0, MAX_WATCHED).map((file) => [file, stamp(file)]))
    const timer = setInterval(() => {
      for (const [file, before] of known) {
        const now = stamp(file)
        if (now === before) continue
        known.set(file, now)
        changed(file)
        // The callback may watch a new set of files; this poll is then over.
        if (this.timer !== timer) return
      }
    }, INTERVAL)
    timer.unref()
    this.timer = timer
  }

  close() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}
