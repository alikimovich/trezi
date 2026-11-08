// LKM-225, no desktop: a turn parked because the live tree moved is resolved once on its
// own (the Resolve button's path), logged as one `conflict` incident: recovered when the
// park clears, failed when it parks again. Off, the card waits for the user as before.
// LKM-509 acceptance contract: active check/retry/resolve owns a parked failure and
// presents status; matching recovery clears it. A user decision remains visible,
// an unowned failure keeps one report and action, and Stop cannot revive the card.
import assert from 'node:assert/strict'
import { incidents } from '../src/main/self-heal/incidents.ts'
import { NativeChatController } from '../src/native/chat-controller.ts'
import { snapshot } from '../src/native/chat-snapshot.ts'

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))
const records = []
incidents.report = (record) => records.push(record)

function harness(autoResolve, { refuse = false } = {}) {
  const calls = []
  const frames = []
  const controller = new NativeChatController({
    invoke: async (channel, ...args) => {
      calls.push([channel, ...args])
      if (channel === 'agent:workspace-snapshot')
        return {
          projects: [
            {
              root: '/Users/me/app',
              chats: [
                {
                  sessionKey: 'a',
                  record: { transcript: [] },
                  isRunning: false,
                  options: { provider: 'claude' }
                }
              ]
            }
          ]
        }
      if (channel === 'agent:resolve-conflict')
        return refuse
          ? { ok: false, error: 'Nothing to resolve.' }
          : { ok: true, conflicted: ['src/a.tsx'], prompt: 'Resolve the markers.' }
      return { ok: true }
    },
    render: () => frames.push(snapshot(controller.get('a'), [])),
    effect: () => {},
    autoResolve
  })
  return {
    controller,
    frames,
    resolves: () => calls.filter((c) => c[0] === 'agent:resolve-conflict').length,
    sent: () => calls.filter((c) => c[0] === 'agent:send').map((c) => c[1]),
    emit: async (event) => {
      controller.event({ projectKey: 'a', ...event })
      await tick()
    },
    open: () =>
      controller.command({
        type: 'context',
        context: {
          chat: 'a',
          root: '/Users/me/app',
          selection: null,
          turn: {},
          setup: { needed: false, dismissed: false, status: null },
          tokens: { needed: false, dismissed: false },
          notes: [],
          spawns: []
        }
      })
  }
}

// 1. Parked, resolve turn runs, the park clears: one recovered incident.
{
  records.length = 0
  const h = harness(true)
  await h.open()
  await h.emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'] })
  assert.equal(h.resolves(), 1, 'Resolve started by itself')
  assert.deepEqual(h.sent(), ['Resolve the markers.'])
  assert.ok(
    h.frames.some((frame) =>
      frame.cards.some((card) => card.title === 'Combining with project edits…')
    )
  )
  assert.ok(h.frames.every((frame) => frame.cards.every((card) => card.title !== 'Problem')))
  assert.equal(records.length, 0, 'nothing logged while the resolution turn runs')
  await h.emit({ type: 'done' })
  await h.emit({ type: 'isolation', state: 'merged', files: ['src/a.tsx'], group: 'g1' })
  assert.equal(
    h.frames.at(-1).cards.some((card) => card.id === 'conflict'),
    false
  )
  assert.deepEqual(records, [
    { chat: 'a', code: 'conflict', recovery: 'resolve', outcome: 'recovered', attempts: 1 }
  ])
  assert.equal(h.controller.get('a').autoResolved, undefined)
  assert.equal(h.resolves(), 1)
}

// 2. The resolution parks again: one failed incident, no second automatic Resolve; the
//    card is left to the user.
{
  records.length = 0
  const h = harness(true)
  await h.open()
  await h.emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'] })
  await h.emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'] })
  await h.emit({ type: 'done' })
  await h.emit({ type: 'done' })
  assert.equal(h.resolves(), 1, 'tried once only')
  assert.deepEqual(
    records.map((r) => r.outcome),
    ['failed'],
    'one failed incident'
  )
  assert.equal(h.controller.get('a').isolation, 'parked')
  assert.equal(h.frames.at(-1).cards.find((card) => card.id === 'conflict')?.title, 'Problem')
}

// 3. A Resolve that cannot start is a failed incident too.
{
  records.length = 0
  const h = harness(true, { refuse: true })
  await h.open()
  await h.emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'] })
  assert.equal(h.resolves(), 1)
  assert.equal(h.frames.at(-1).cards.find((card) => card.id === 'conflict')?.title, 'Problem')
  assert.deepEqual(
    records.map((r) => r.outcome),
    ['failed']
  )
}

// 4. A running turn is not interrupted: the park waits for its done.
{
  records.length = 0
  const h = harness(true)
  await h.open()
  h.controller.get('a').isRunning = true
  await h.emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'] })
  assert.equal(h.resolves(), 0)
  const ownedPark = h.frames.at(-1).cards.find((card) => card.id === 'conflict')
  assert.equal(ownedPark?.title, 'Working on held changes…')
  assert.equal(
    ownedPark?.detail,
    'Trezi is working on the held changes. Nothing is needed from you yet.'
  )
  h.controller.get('a').isRunning = false
  await h.emit({ type: 'done' })
  assert.equal(h.resolves(), 1)
}

// 5. Off (the default, and the smoke suite): the card waits for the user.
{
  records.length = 0
  const h = harness(false)
  await h.open()
  await h.emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'] })
  await h.emit({ type: 'done' })
  assert.equal(h.resolves(), 0)
  assert.equal(records.length, 0)
  assert.equal(h.frames.at(-1).cards.find((card) => card.id === 'conflict')?.title, 'Problem')
}

// A decision is a user request, even when the turn has not finished.
{
  const h = harness(true)
  await h.open()
  h.controller.get('a').isRunning = true
  await h.emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'], decision: 'Keep ours?' })
  assert.equal(
    h.frames.at(-1).cards.find((card) => card.id === 'conflict')?.title,
    'Decision needed'
  )
}

// A failed check is terminal; automatic conflict resolution cannot turn it into
// an unrequested recovery operation or hide its actual reason.
{
  const h = harness(true)
  await h.open()
  await h.emit({
    type: 'isolation',
    state: 'parked',
    files: ['src/a.tsx'],
    reason: 'failed',
    error: 'The stopped work did not pass its check.'
  })
  assert.equal(h.resolves(), 0)
  assert.equal(h.frames.at(-1).cards.find((card) => card.id === 'conflict')?.title, 'Problem')
}

// Keep owns its IPC until the owner result settles. A conflict callback during
// that request cannot spend the chat's single automatic Resolve attempt.
{
  const h = harness(true)
  await h.open()
  h.controller.get('a').keepingStopped = true
  h.controller.event(
    { projectKey: 'a', type: 'isolation', state: 'parked', files: ['src/a.tsx'] },
    true
  )
  await tick()
  assert.equal(h.resolves(), 0)
  assert.equal(h.controller.get('a').autoResolved, undefined)
  h.controller.get('a').keepingStopped = false
  await h.emit({ type: 'done' })
  assert.equal(h.resolves(), 1)
}

console.log('chat-auto-resolve: OK')
process.exit(0)
