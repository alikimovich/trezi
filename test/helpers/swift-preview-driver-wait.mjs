// Shared by the real target fixture and its fast failure-path regression.
// `until` and `readState` retain the fixture's existing bounded waits and HTTP request.
export async function waitForPreviewDriver({
  until,
  readState,
  readLog,
  serving,
  exit,
  elapsed,
  emit,
  deadline
}) {
  const remaining = (limit) => Math.max(1, Math.min(limit, deadline - Date.now() - 15_000))
  let progress = 'driver URL'
  let lastState
  try {
    await until(() => readLog().includes(serving), 'driver URL', remaining(20_000))
    progress = 'driver build'
    return await until(
      async () => {
        lastState = await readState()
        if (lastState.status === 'error' || lastState.status === 'failed') {
          throw new Error(`Driver ${lastState.status}: ${lastState.message}`)
        }
        return lastState.status === 'ready' && lastState
      },
      'driver build',
      remaining(180_000)
    )
  } catch (error) {
    let finalState
    try {
      finalState = await readState()
    } catch (stateError) {
      finalState = { unavailable: String(stateError), lastState }
    }
    emit({
      reason: String(error),
      elapsed: elapsed(),
      progress,
      driverExit: exit(),
      state: finalState,
      buildLogTail: readLog().slice(-12_000)
    })
    throw error
  }
}
