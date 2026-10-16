import { type Stats, unwatchFile, watchFile } from 'node:fs'

const MAX_WATCHED = 200
const INTERVAL = 400

/** Watches the files a states bundle was built from. Polled, not `fs.watch`: Bun never again
 * reports a path whose `fs.watch` was closed once, so a component shown a second time would
 * stop updating. */
export class StatesWatch {
  private watched: [string, (now: Stats, before: Stats) => void][] = []

  watch(files: string[], changed: (file: string) => void) {
    this.close()
    for (const file of files.slice(0, MAX_WATCHED)) {
      const listener = (now: Stats, before: Stats) => {
        if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) changed(file)
      }
      watchFile(file, { interval: INTERVAL, persistent: false }, listener)
      this.watched.push([file, listener])
    }
  }

  close() {
    for (const [file, listener] of this.watched) unwatchFile(file, listener)
    this.watched = []
  }
}
