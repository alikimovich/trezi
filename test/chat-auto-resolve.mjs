// LKM-225, no desktop: a turn parked because the live tree moved is resolved once on its
// own (the Resolve button's path), logged as one `conflict` incident: recovered when the
// park clears, failed when it parks again. Off, the card waits for the user as before.
import assert from 'node:assert/strict'
import { incidents } from '../src/main/self-heal/incidents.ts'
import { NativeChatController } from '../src/native/chat-controller.ts'

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))
const records = []
incidents.report = (record) => records.push(record)

function harness(autoResolve, { refuse = false } = {}) {
  const calls = []
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
    render: () => {},
    effect: () => {},
    autoResolve
  })
  return {
    controller,
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
  assert.equal(records.length, 0, 'nothing logged while the resolution turn runs')
  await h.emit({ type: 'done' })
  await h.emit({ type: 'isolation', state: 'merged', files: ['src/a.tsx'], group: 'g1' })
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
}

// 3. A Resolve that cannot start is a failed incident too.
{
  records.length = 0
  const h = harness(true, { refuse: true })
  await h.open()
  await h.emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'] })
  assert.equal(h.resolves(), 1)
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
}

console.log('chat-auto-resolve: OK')
process.exit(0)
