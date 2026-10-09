// LKM-221: quitting while agents work. The alert text, Cancel, Wait and Quit, Quit Anyway
// with its bounded landing/publish safe point, and "Don't ask again".
import assert from 'node:assert/strict'
import {
  QUIT_TITLE,
  QuitGuard,
  quitDetail,
  stoppingNote,
  waitingNote
} from '../src/native/quit-guard.ts'

assert.equal(
  quitDetail([
    { kind: 'chat', project: 'lkmv.ch' },
    { kind: 'chat', project: 'lkmv.ch' },
    { kind: 'background', project: 'swiftly-demos' },
    { kind: 'publish', project: 'lkmv.ch' }
  ]),
  '2 chats in lkmv.ch and 1 background agent in swiftly-demos are still running. A publish is in progress.\n\nQuit Anyway stops the agents and keeps their work in each chat’s copy. A landing or publish finishes first.'
)
assert.equal(
  quitDetail([{ kind: 'chat', project: 'site' }]),
  '1 chat in site is still running.\n\nQuit Anyway stops the agents and keeps their work in each chat’s copy.'
)
assert.match(quitDetail([{ kind: 'dreamer' }]), /^The Dreamer is still running\./)
assert.match(
  quitDetail([
    { kind: 'landing', project: 'a' },
    { kind: 'landing', project: 'b' }
  ]),
  /^2 landings are in progress\./
)
assert.equal(
  waitingNote([
    { kind: 'chat', project: 'site' },
    { kind: 'landing', project: 'site' }
  ]),
  'Waiting for 1 chat in site and a landing to finish. Trezi quits when the work ends.'
)
assert.equal(stoppingNote([{ kind: 'chat', project: 'site' }]), 'Stopping agents…')
assert.equal(
  stoppingNote([{ kind: 'landing' }, { kind: 'publish' }]),
  'Finishing a landing and a publish before quitting…'
)

/** A guard over scripted work with a virtual clock: `drive` fires timers in order. */
function harness({ work = [], dontAsk = false, stop } = {}) {
  const state = { work: [...work], sent: [], dontAsk, saved: false, clock: 0, stops: 0, ticks: [] }
  const timers = []
  const guard = new QuitGuard({
    work: () => state.work,
    stop: async () => {
      state.stops++
      await stop?.(state)
    },
    dontAsk: () => state.dontAsk,
    setDontAsk: async () => {
      state.saved = true
    },
    send: (command, payload) => state.sent.push([command, payload]),
    wait: (ms) => new Promise((resolve) => timers.push({ at: state.clock + ms, resolve })),
    now: () => state.clock,
    pollMs: 250,
    safePointMs: 15_000
  })
  const commands = () => state.sent.map(([command]) => command)
  /** Runs `action` and fires timers until the guard proceeds or goes idle with none due. */
  async function drive(action) {
    let done = false
    void Promise.resolve(action()).then(() => {
      done = true
    })
    for (let i = 0; i < 1000; i++) {
      for (let k = 0; k < 20; k++) await Promise.resolve()
      if (done && guard.phase === 'idle') break
      timers.sort((a, b) => a.at - b.at)
      const timer = timers.shift()
      if (!timer) break
      state.clock = Math.max(state.clock, timer.at)
      for (const tick of state.ticks) tick(state)
      timer.resolve()
    }
  }
  return { guard, state, commands, drive }
}

// Nothing running: the quit goes ahead at once, no alert.
{
  const { guard, commands } = harness()
  guard.request()
  assert.deepEqual(commands(), ['quitProceed'])
  assert.equal(guard.phase, 'idle')
}

// A running turn asks; a second request joins it; Cancel leaves the work running.
{
  const { guard, state, commands } = harness({ work: [{ kind: 'chat', project: 'site' }] })
  guard.request()
  guard.request()
  assert.deepEqual(state.sent, [['quitAsk', { title: QUIT_TITLE, detail: quitDetail(state.work) }]])
  await guard.answer('cancel')
  assert.equal(guard.phase, 'idle')
  assert.equal(state.stops, 0, 'Cancel never stops agents')
  assert.deepEqual(commands(), ['quitAsk'])
  // A fresh quit asks again.
  guard.request()
  assert.deepEqual(commands(), ['quitAsk', 'quitAsk'])
}

// Wait and Quit: a cancellable note, then the quit once the turn ends; never stops it.
{
  const { guard, state, commands, drive } = harness({ work: [{ kind: 'chat', project: 'site' }] })
  state.ticks.push((s) => {
    if (s.clock >= 1000) s.work = []
  })
  guard.request()
  await drive(() => guard.answer('wait'))
  assert.equal(state.stops, 0)
  assert.deepEqual(commands(), ['quitAsk', 'quitNote', 'quitProceed'], 'the note is sent once')
  assert.deepEqual(state.sent[1][1], {
    text: waitingNote([{ kind: 'chat', project: 'site' }]),
    cancellable: true
  })
  assert.equal(state.saved, false)
}

// Wait and Quit can be cancelled from its note; the turn keeps running.
{
  const { guard, state, commands, drive } = harness({ work: [{ kind: 'chat', project: 'site' }] })
  state.ticks.push((s) => {
    if (s.clock === 500) guard.cancel()
  })
  guard.request()
  await drive(() => guard.answer('wait'))
  assert.equal(guard.phase, 'idle')
  assert.ok(!commands().includes('quitProceed'))
}

// Quit Anyway stops the agents, waits for them to settle and quits; "Don't ask again" saved.
{
  const { guard, state, commands, drive } = harness({
    work: [
      { kind: 'chat', project: 'site' },
      { kind: 'background', project: 'site' }
    ],
    stop: (s) => {
      s.work = []
    }
  })
  guard.request()
  await drive(() => guard.answer('stop', true))
  assert.equal(state.stops, 1)
  assert.equal(state.saved, true)
  assert.deepEqual(commands(), ['quitAsk', 'quitNote', 'quitProceed'])
  assert.deepEqual(state.sent[1][1], { text: 'Stopping agents…', cancellable: false })
}

// Quit Anyway with a landing: the landing is not stopped; the quit waits for it; Cancel is ignored.
{
  const { guard, state, commands, drive } = harness({
    work: [
      { kind: 'chat', project: 'site' },
      { kind: 'landing', project: 'site' }
    ],
    stop: (s) => {
      s.work = s.work.filter((w) => w.kind === 'landing')
    }
  })
  state.ticks.push((s) => {
    if (s.clock === 750) guard.cancel()
    if (s.clock >= 2000) s.work = []
  })
  guard.request()
  await drive(() => guard.answer('stop'))
  assert.ok(state.clock >= 2000, 'quit only after the landing finished')
  assert.equal(commands().at(-1), 'quitProceed')
  assert.ok(
    state.sent.some(
      ([c, p]) =>
        c === 'quitNote' && p.text === 'Finishing a landing before quitting…' && !p.cancellable
    )
  )
}

// The safe-point wait is bounded: a stuck publish still lets the quit go ahead.
{
  const { guard, state, commands, drive } = harness({
    work: [{ kind: 'publish', project: 'site' }]
  })
  guard.request()
  await drive(() => guard.answer('stop'))
  assert.ok(state.clock >= 15_000 && state.clock < 16_000)
  assert.equal(commands().at(-1), 'quitProceed')
}

// A stop that never settles is bounded too.
{
  const { guard, state, commands, drive } = harness({
    work: [{ kind: 'chat', project: 'site' }],
    stop: () => new Promise(() => {})
  })
  guard.request()
  await drive(() => guard.answer('stop'))
  assert.ok(state.clock >= 15_000 && state.clock < 16_000)
  assert.equal(commands().at(-1), 'quitProceed')
}

// "Don't ask again": no alert, but the landing safe point still holds; the Dreamer is not waited for.
{
  const { guard, state, commands, drive } = harness({
    dontAsk: true,
    work: [{ kind: 'landing', project: 'site' }, { kind: 'dreamer' }]
  })
  state.ticks.push((s) => {
    if (s.clock >= 1000) s.work = [{ kind: 'dreamer' }]
  })
  await drive(() => guard.request())
  assert.ok(!commands().includes('quitAsk'))
  assert.equal(state.stops, 1)
  assert.ok(state.clock >= 1000 && state.clock < 15_000)
  assert.equal(commands().at(-1), 'quitProceed')
}

// An answer arriving after the alert closed (or a bogus choice) does nothing.
{
  const { guard, state } = harness({ work: [{ kind: 'chat', project: 'site' }] })
  await guard.answer('stop')
  assert.equal(state.stops, 0)
  guard.request()
  await guard.answer('later')
  assert.equal(guard.phase, 'idle')
  assert.equal(state.stops, 0)
}

console.log('quit-guard: ok')
