import assert from 'node:assert/strict'
import { waitForPreviewDriver } from './helpers/swift-preview-driver-wait.mjs'

// A bounded version of the target fixture's predicate wait. The fake driver
// makes the failure paths observable without compiling Swift or opening a GUI.
const until = async (check, label, timeout) => {
  assert.ok(timeout > 0 && timeout <= (label === 'driver URL' ? 20_000 : 180_000))
  for (let attempt = 0; attempt < 3; attempt++) {
    const value = await check()
    if (value) return value
  }
  throw new Error(`Timed out: ${label}`)
}
const scenario = async ({
  log,
  states,
  exit = { code: null, signal: null },
  deadline = Date.now() + 300_000
}) => {
  const evidence = []
  const waits = []
  let next = 0
  const run = waitForPreviewDriver({
    until: (check, label, timeout) => {
      waits.push({ label, timeout })
      return until(check, label, timeout)
    },
    readState: async () => {
      const state = states[Math.min(next++, states.length - 1)]
      if (state instanceof Error) throw state
      return state
    },
    readLog: () => log,
    serving: 'Serving at http://127.0.0.1:1234',
    exit: () => exit,
    elapsed: () => '1.0s',
    emit: (value) => evidence.push(value),
    deadline
  })
  return { run, evidence, waits }
}

const ready = await scenario({
  log: 'Serving at http://127.0.0.1:1234\ncompiling StudioKit',
  states: [{ status: 'building' }, { status: 'ready', generation: 1 }]
})
assert.equal((await ready.run).generation, 1)
assert.deepEqual(ready.evidence, [])

const startup = await scenario({
  log: 'driver exited before serving',
  states: [new Error('connection refused')],
  exit: { code: 1, signal: null }
})
await assert.rejects(startup.run, /Timed out: driver URL/)
assert.equal(startup.evidence.length, 1)
assert.equal(startup.evidence[0].progress, 'driver URL')
assert.match(startup.evidence[0].state.unavailable, /connection refused/)
assert.match(startup.evidence[0].buildLogTail, /exited before serving/)
assert.equal(startup.evidence[0].driverExit.code, 1)

const errored = await scenario({
  log: 'Serving at http://127.0.0.1:1234\nSwift compile failed',
  states: [{ status: 'error', message: 'Compile failed', output: 'Swift compile failed' }]
})
await assert.rejects(errored.run, /Driver error: Compile failed/)
assert.equal(errored.evidence.length, 1)
assert.equal(errored.evidence[0].progress, 'driver build')
assert.equal(errored.evidence[0].state.status, 'error')
assert.match(errored.evidence[0].buildLogTail, /Swift compile failed/)

const neverReady = await scenario({
  log: 'Serving at http://127.0.0.1:1234\ncompiling StudioKit',
  states: [{ status: 'building', message: 'Compiling StudioKit' }]
})
await assert.rejects(neverReady.run, /Timed out: driver build/)
assert.equal(neverReady.evidence.length, 1)
assert.equal(neverReady.evidence[0].state.status, 'building')
assert.match(neverReady.evidence[0].buildLogTail, /compiling StudioKit/)
assert.equal(neverReady.evidence[0].progress, 'driver build')

// With only 250 ms left before the 15 s evidence/cleanup reserve, the build
// wait must use that remaining budget rather than its normal 180 s maximum.
const nearDeadline = await scenario({
  log: 'Serving at http://127.0.0.1:1234\ncompiling StudioKit',
  states: [{ status: 'building', message: 'Still compiling StudioKit' }],
  deadline: Date.now() + 15_250
})
await assert.rejects(nearDeadline.run, /Timed out: driver build/)
const buildWait = nearDeadline.waits.find((wait) => wait.label === 'driver build')
assert.ok(buildWait.timeout > 0 && buildWait.timeout <= 250)
assert.equal(nearDeadline.evidence.length, 1)
assert.equal(nearDeadline.evidence[0].state.status, 'building')
assert.match(nearDeadline.evidence[0].buildLogTail, /compiling StudioKit/)
assert.equal(nearDeadline.evidence[0].progress, 'driver build')

console.log('Swift preview driver wait: ready, startup, error, never-ready and deadline passed')
