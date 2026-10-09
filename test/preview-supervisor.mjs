import assert from 'node:assert/strict'
import {
  NativePreviewSupervisor,
  RESTART_DELAYS,
  STABLE_AFTER
} from '../src/native/preview-supervisor.ts'

// LKM-146: a ready dev server that exits or stops answering is restarted with backoff;
// the preview shows the reason and Restart meanwhile, and gives up after the last delay.
const URL = 'http://127.0.0.1:7784'
const running = { kind: 'running', name: 'app', url: URL }
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function harness({ outcomes = [] } = {}) {
  let now = 0,
    sequence = 0
  const timers = new Map(),
    commands = [],
    renders = []
  const clock = {
    now: () => now,
    set: (run, ms) => {
      const id = ++sequence
      timers.set(id, { run, at: now + ms, ms })
      return id
    },
    clear: (id) => {
      timers.delete(id)
    }
  }
  const workspace = {
    state: {
      activeKey: '/app',
      status: { ...running },
      projects: [],
      revision: 0,
      history: {},
      recents: []
    },
    changed() {
      renders.push(structuredClone(this.state.status))
    },
    async command(command) {
      commands.push(command)
      this.state.status = { kind: 'busy', label: 'Opening app…' }
      await tick()
      const outcome = outcomes.shift() ?? 'running'
      this.state.status =
        outcome === 'running' ? { ...running } : { kind: 'error', message: outcome }
    }
  }
  const supervisor = new NativePreviewSupervisor(workspace, clock)
  /** Runs the one pending timer, advancing the clock to it. */
  const fire = async () => {
    assert.equal(timers.size, 1, 'one restart is pending')
    const [id, timer] = [...timers][0]
    timers.delete(id)
    now = timer.at
    timer.run()
    await tick()
    await tick()
    return timer.ms
  }
  return {
    workspace,
    supervisor,
    timers,
    commands,
    renders,
    fire,
    advance: (ms) => {
      now += ms
    }
  }
}

{
  // An exit of the active project's ready server: reason, Restart, then a restart that works.
  const h = harness()
  h.supervisor.exited({ root: '/app', url: URL, reason: 'The dev server exited (code 1).\nboom' })
  assert.equal(h.workspace.state.status.kind, 'error')
  assert.equal(h.workspace.state.status.restart, true, 'the preview offers Restart')
  assert.match(
    h.workspace.state.status.message,
    /^The dev server exited \(code 1\)\.\nboom\n\nRestarting in 1 s…$/
  )
  assert.deepEqual(h.renders.at(-1), h.workspace.state.status, 'the status is rendered')
  assert.equal(await h.fire(), RESTART_DELAYS[0])
  assert.deepEqual(h.commands, [{ type: 'restart', key: '/app' }])
  assert.equal(h.workspace.state.status.kind, 'running')
  assert.equal(h.timers.size, 0)
  console.log(
    'Preview supervisor: an exit shows the reason and Restart, then restarts the server passed'
  )
}

{
  // Restarts that keep failing back off, then give up and leave Restart to the user.
  const h = harness({
    outcomes: Array(RESTART_DELAYS.length).fill('Dev server exited (code 1) before printing a URL.')
  })
  h.supervisor.exited({ root: '/app/', url: URL, reason: 'The dev server stopped responding.' })
  assert.match(h.workspace.state.status.message, /^The dev server stopped responding\./)
  const delays = []
  for (let i = 0; i < RESTART_DELAYS.length; i++) delays.push(await h.fire())
  assert.deepEqual(delays, RESTART_DELAYS, 'each failed restart waits longer')
  assert.equal(h.commands.length, RESTART_DELAYS.length)
  assert.equal(h.timers.size, 0, 'no further automatic restart')
  assert.equal(h.workspace.state.status.restart, true)
  assert.match(
    h.workspace.state.status.message,
    /^Dev server exited \(code 1\) before printing a URL\.\n\nTrezi restarted it 5 times without success\. Use Restart to try again\.$/
  )
  console.log(
    'Preview supervisor: failing restarts back off (1, 2, 4, 8, 16 s) and then leave Restart to the user passed'
  )
}

{
  // Crashing again soon after a restart continues the backoff; a stable server starts it over.
  const h = harness()
  h.supervisor.exited({ root: '/app', url: URL, reason: 'crash' })
  await h.fire()
  h.supervisor.exited({ root: '/app', url: URL, reason: 'crash' })
  assert.equal(await h.fire(), RESTART_DELAYS[1], 'an unstable server waits longer')
  h.advance(STABLE_AFTER)
  h.supervisor.exited({ root: '/app', url: URL, reason: 'crash' })
  assert.equal(await h.fire(), RESTART_DELAYS[0], 'a server that stayed up starts the backoff over')
  console.log(
    'Preview supervisor: quick repeat crashes keep backing off; a stable server resets it passed'
  )
}

{
  // Exits that are not the active, running preview are ignored.
  const h = harness()
  h.supervisor.exited({ root: '/other', url: URL, reason: 'x' })
  h.supervisor.exited({ root: '/app', url: 'http://127.0.0.1:9999', reason: 'x' })
  h.workspace.state.status = { kind: 'busy', label: 'Opening app…' }
  h.supervisor.exited({ root: '/app', url: URL, reason: 'x' })
  assert.equal(h.timers.size, 0)
  assert.equal(h.renders.length, 0)
  console.log(
    'Preview supervisor: other projects, stale URLs and a preview already restarting are ignored passed'
  )
}

{
  // The user's Restart cancels the pending attempt; so does anyone else changing the status.
  const h = harness()
  h.supervisor.exited({ root: '/app', url: URL, reason: 'crash' })
  h.supervisor.reset()
  assert.equal(h.timers.size, 0, 'Restart cancels the pending attempt')
  h.workspace.state.status = { ...running }
  h.supervisor.exited({ root: '/app', url: URL, reason: 'crash' })
  h.workspace.state.status = { kind: 'busy', label: 'Installing dependencies…' }
  await h.fire()
  assert.deepEqual(h.commands, [], 'a status someone else set is left alone')
  h.workspace.state.status = { ...running }
  h.supervisor.exited({ root: '/app', url: URL, reason: 'crash' })
  h.workspace.state.activeKey = '/other'
  await h.fire()
  assert.deepEqual(h.commands, [], 'another project became active')
  console.log(
    'Preview supervisor: a manual Restart or another status change cancels the automatic restart passed'
  )
}
