import { statSync } from 'node:fs'

const MAX_WATCHED = 200
const INTERVAL = 400

function stamp(file: string): string {
  try {
    const stats = statSync(file)
    return `${stats.mtimeMs}:${stats.size}`
  } catch {
    return 'missing'
  }
}

/** Poll bundle inputs against a synchronous initial snapshot. Bun's watchFile can take its
 * first stat after an immediate edit and silently adopt that edit as its baseline. fs.watch
 * also stops reporting a path once its watcher has been closed, so keep explicit polling. */
export class StatesWatch {
  private timer: ReturnType<typeof setInterval> | undefined

  watch(files: string[], changed: (file: string) => void) {
    this.close()
    const watched = files.slice(0, MAX_WATCHED).map((file) => ({ file, stamp: stamp(file) }))
    if (!watched.length) return
    const timer = setInterval(() => {
      for (const input of watched) {
        if (this.timer !== timer) return
        const next = stamp(input.file)
        if (next === input.stamp) continue
        input.stamp = next
        changed(input.file)
      }
    }, INTERVAL)
    this.timer = timer
    timer.unref()
  }

  close() {
    clearInterval(this.timer)
    this.timer = undefined
  }
}
