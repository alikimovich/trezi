/** Await cleanup once, even when a terminal and its launcher both forward signals. */
export function installShutdown(cleanup: () => void | Promise<void>) {
  let stopping = false
  process.once('exit', () => {
    void cleanup()
  })
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129]
  ] as const) {
    process.on(signal, () => {
      if (stopping) return
      stopping = true
      void Promise.resolve()
        .then(cleanup)
        .then(
          () => process.exit(code),
          (error) => {
            console.error('Shutdown cleanup failed:', error)
            process.exit(1)
          }
        )
    })
  }
}
