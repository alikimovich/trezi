// LKM-225, no desktop: a turn parked because the live tree moved is resolved once on its
// own (the Resolve button's path), logged as one `conflict` incident: recovered when the
// park clears, failed when it parks again. Off, the card waits for the user as before.
import assert from 'node:assert/strict'
import { acceptOwnerTerminal } from '../src/main/chat-turns.ts'
import { incidents } from '../src/main/self-heal/incidents.ts'
import { cardAction } from '../src/native/chat-actions.ts'
import { NativeChatController } from '../src/native/chat-controller.ts'
import { readableRecoveryReport } from '../src/native/chat-recovery-report.ts'

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))
const records = []
incidents.report = (record) => records.push(record)

// Synthetic owner IO: a provider observation is not accepted terminal proof.
{
  const emitted = []
  let settle
  const pending = new Promise((resolve) => {
    settle = resolve
  })
  const owner = { incarnation: 'inc-a', turn: 'turn-a', run: 0 }
  const accepted = acceptOwnerTerminal(pending, owner, (event) => emitted.push(event))
  assert.deepEqual(emitted, [], 'forwarding waits for the owner claim')
  settle({ claimed: true, outcome: 'failed' })
  await accepted
  assert.deepEqual(
    emitted.map((event) => event.type),
    ['owner-terminal']
  )
  await acceptOwnerTerminal(
    Promise.resolve({ claimed: false, reason: 'duplicate' }),
    owner,
    (event) => emitted.push(event)
  )
  assert.equal(emitted.length, 1, 'duplicate owner reply emits no second accepted terminal')
}

// Synthetic owner receipts; the fixture does not claim live provider or Git evidence.
const held = { id: 'held-a', incarnation: 'inc-a', generation: 1, source: 'tree-a' }
const settlement = (outcome, attemptId) => ({
  heldOperationId: held.id,
  incarnation: held.incarnation,
  outcome,
  source: held.source,
  candidate: outcome === 'merged' ? 'checked-tree-a' : null,
  evidenceIds: outcome === 'merged' ? ['synthetic-check'] : [],
  ...(attemptId ? { attemptId } : {})
})

function harness(
  autoResolve,
  {
    refuse = false,
    deferResolve = false,
    deferSend = false,
    rejectSend = false,
    cancelSend = false
  } = {}
) {
  const calls = []
  const renders = []
  let acknowledgeResolve
  const pendingResolve = deferResolve
    ? new Promise((resolve) => {
        acknowledgeResolve = resolve
      })
    : null
  let acknowledgeSend
  const pendingSend = deferSend
    ? new Promise((resolve) => {
        acknowledgeSend = resolve
      })
    : null
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
        return (
          pendingResolve ??
          (refuse
            ? { ok: false, error: 'Nothing to resolve.' }
            : {
                ok: true,
                conflicted: ['src/a.tsx'],
                prompt: 'Resolve the markers.',
                incarnation: held.incarnation
              })
        )
      if (channel === 'agent:held-operation') return held
      if (channel === 'agent:send' && rejectSend) throw new Error('Send admission refused.')
      if (channel === 'agent:send' && pendingSend) return pendingSend
      if (channel === 'agent:send' && cancelSend) {
        controller.get('a').cancellation++
        throw new Error('Message cancelled before sending.')
      }
      if (channel === 'agent:send')
        return { state: 'admitted', incarnation: held.incarnation, turn: args[4], run: 0 }
      if (channel === 'agent:turn-state') return { turn: controller.get('a').turn, running: false }
      return { ok: true }
    },
    render: (state) => renders.push(structuredClone(state)),
    effect: () => {},
    autoResolve
  })
  return {
    controller,
    calls,
    renders,
    acknowledgeResolve,
    acknowledgeSend,
    resolves: () => calls.filter((c) => c[0] === 'agent:resolve-conflict').length,
    sent: () => calls.filter((c) => c[0] === 'agent:send').map((c) => c[1]),
    emit: async (event) => {
      const actual =
        event.type === 'isolation'
          ? {
              ...event,
              ...(event.state === 'parked' && !Object.hasOwn(event, 'held') ? { held } : {}),
              ...(event.state === 'merged' && !Object.hasOwn(event, 'settlement')
                ? { settlement: settlement('merged') }
                : {})
            }
          : event
      controller.event({ projectKey: 'a', ...actual })
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

// Manual recovery actions carry the producer's exact held operation to main.
for (const [action, channel] of [
  ['resolve', 'agent:resolve-conflict'],
  ['landing-retry', 'agent:retry-landing'],
  ['discard', 'agent:discard-conflict']
]) {
  const h = harness(false)
  await h.open()
  await h.emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'] })
  await cardAction(h.controller, h.controller.get('a'), { action })
  const call = h.calls.find((item) => item[0] === channel)
  assert.equal(call?.[2], held.id, `${action} addresses the held producer operation`)
  assert.equal(typeof call?.[3], 'string', `${action} has its own attempt`)
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
  const attempt = h.controller.get('a').autoResolveAttempt
  await h.emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'] })
  assert.equal(h.controller.get('a').autoResolved, 'tried', 'duplicate park stays owned')
  await h.emit({
    type: 'isolation',
    state: 'parked',
    files: ['src/a.tsx'],
    settlement: settlement('held', attempt)
  })
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
  assert.equal(
    h.renders.at(-1)?.cards.find((card) => card.id === 'conflict')?.title,
    'Problem',
    'failed automatic recovery publishes its terminal card'
  )
}

// 4. A running turn is not interrupted: the park waits for its done.
{
  records.length = 0
  const h = harness(true, { deferResolve: true })
  await h.open()
  h.controller.get('a').isRunning = true
  await h.emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'] })
  assert.equal(h.resolves(), 0)
  h.controller.get('a').isRunning = false
  const beforeDone = h.renders.length
  await h.emit({ type: 'done' })
  assert.equal(h.resolves(), 1)
  assert.ok(h.renders.length > beforeDone, 'the done-to-Resolve boundary rendered')
  assert.deepEqual(
    h.renders.at(-1).cards.find((card) => card.id === 'conflict'),
    {
      id: 'conflict',
      title: 'Changes are still held',
      detail: 'Checking the held changes. The project still has its previous source.',
      actions: []
    },
    'deferred recovery has ordinary status without stale actions'
  )
  assert.ok(
    h.renders
      .slice(beforeDone)
      .every((state) => state.cards.every((card) => card.title !== 'Problem')),
    'no Problem flashes before deferred Resolve acknowledgement'
  )
  h.acknowledgeResolve({
    ok: true,
    conflicted: ['src/a.tsx'],
    prompt: 'Resolve the markers.',
    incarnation: held.incarnation
  })
  await tick()
  assert.deepEqual(h.sent(), ['Resolve the markers.'])
}

// An acknowledged Resolve can still fail before the follow-up turn is admitted.
// That exhausted handover must settle with its own report, not keep Checking.
{
  records.length = 0
  const h = harness(true, { rejectSend: true })
  await h.open()
  await h.emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'] })
  const chat = h.controller.get('a')
  assert.equal(chat.isRunning, false)
  assert.equal(chat.autoResolved, 'failed')
  assert.equal(h.resolves(), 1, 'the bounded recovery does not restart')
  assert.deepEqual(
    records.map((r) => r.outcome),
    ['failed']
  )
  const problem = h.renders.at(-1).cards.filter((card) => card.title === 'Problem')
  assert.equal(problem.length, 1, 'one terminal Problem replaces Checking')
  assert.ok(problem[0].actions.some((action) => action.action === 'recovery-report'))
  assert.match(readableRecoveryReport('a'), /Send admission refused/)
}

// Stop during admission is cancellation, not exhausted technical recovery.
{
  records.length = 0
  const h = harness(true, { cancelSend: true })
  await h.open()
  await h.emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'] })
  assert.equal(h.controller.get('a').autoResolved, undefined)
  assert.equal(
    h.renders.at(-1).cards.some((card) => card.title === 'Problem'),
    false
  )
  assert.deepEqual(records, [])
}

// Stop wins over a late, positive send ACK for the preallocated recovery turn.
{
  records.length = 0
  const h = harness(true, { deferSend: true })
  await h.open()
  await h.emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'] })
  const chat = h.controller.get('a')
  const turn = chat.turn
  assert.ok(turn)
  await h.controller.stop(chat)
  h.acknowledgeSend({ state: 'admitted', incarnation: held.incarnation, turn, run: 0 })
  await tick()
  assert.notEqual(chat.autoResolved, 'tried', 'Stop settles pending recovery intent')
  await h.emit({
    type: 'owner-terminal',
    outcome: 'failed',
    owner: { incarnation: held.incarnation, turn, run: 0, heldOperationId: held.id }
  })
  assert.deepEqual(records, [], 'late terminal cannot resurrect cancelled recovery')
}

// An older or uncorrelated observation cannot clear a currently failed held batch.
{
  records.length = 0
  const h = harness(true, { refuse: true })
  await h.open()
  await h.emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'] })
  const chat = h.controller.get('a')
  const operation = chat.recoveryId
  assert.equal(chat.autoResolved, 'failed')
  await h.emit({ type: 'isolation', state: 'merged', settlement: null, files: ['src/old.tsx'] })
  assert.equal(chat.recoveryId, operation)
  assert.equal(chat.isolation, 'parked')
  await h.emit({
    type: 'isolation',
    state: 'merged',
    settlement: { ...settlement('merged'), incarnation: 'old-incarnation' }
  })
  assert.equal(chat.recoveryId, operation, 'old incarnation cannot settle the batch')
}

// A newer held source supersedes the old operation; its late park cannot roll back
// the current source or incident identity.
{
  const h = harness(false)
  await h.open()
  await h.emit({ type: 'isolation', state: 'parked', held, files: ['src/a.tsx'] })
  const newer = { ...held, id: 'held-b', generation: 2, source: 'tree-b' }
  await h.emit({ type: 'isolation', state: 'parked', held: newer, files: ['src/b.tsx'] })
  await h.emit({ type: 'isolation', state: 'parked', held, files: ['src/a.tsx'] })
  assert.deepEqual(h.controller.get('a').heldOperation, newer)
  assert.deepEqual(h.controller.get('a').isolationFiles, ['src/b.tsx'])
}

// An admitted Resolve can still end with an agent error. The held attempt gets one
// terminal report; the earlier Checking state cannot outlive its owner turn.
{
  records.length = 0
  const h = harness(true)
  await h.open()
  await h.emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'] })
  const chat = h.controller.get('a')
  const turn = chat.turn
  assert.ok(turn, 'the follow-up send was admitted')
  assert.equal(chat.autoResolveTurn, turn)
  await h.emit({ type: 'error', turn, message: 'Browser check could not complete.' })
  await h.emit({
    type: 'owner-terminal',
    outcome: 'failed',
    owner: {
      incarnation: held.incarnation,
      turn,
      run: 0,
      heldOperationId: held.id,
      attemptId: chat.recoveryId
    }
  })
  assert.equal(chat.autoResolved, 'tried', 'owner terminal alone is not held-work settlement')
  await h.emit({
    type: 'isolation',
    state: 'parked',
    held,
    settlement: {
      ...settlement('held', chat.recoveryId),
      turn,
      run: 0
    }
  })
  assert.equal(chat.autoResolved, 'failed')
  assert.equal(chat.isRunning, false)
  assert.equal(h.resolves(), 1, 'automatic Resolve remains bounded')
  assert.deepEqual(
    records.map((record) => record.outcome),
    ['failed']
  )
  const conflict = h.renders.at(-1).cards.filter((card) => card.id === 'conflict')
  assert.equal(conflict.length, 1, 'one held incident card')
  assert.equal(conflict[0].title, 'Problem', 'terminal error replaces Checking')
  assert.match(conflict[0].detail, /Browser check could not complete/)
  assert.ok(conflict[0].actions.some((action) => action.action === 'recovery-report'))
  assert.match(readableRecoveryReport('a'), /Browser check could not complete/)
  const terminalOperation = chat.recoveryId
  const terminalReport = chat.recoveryReport
  await h.emit({ type: 'isolation', state: 'parked', files: ['src/a.tsx'] })
  assert.equal(chat.recoveryId, terminalOperation, 'duplicate park keeps one incident')
  assert.equal(chat.recoveryReport, terminalReport, 'duplicate park keeps its shareable report')
  await h.emit({ type: 'error', turn, message: 'Browser check could not complete.' })
  assert.deepEqual(
    records.map((record) => record.outcome),
    ['failed'],
    'one failed incident'
  )
  assert.equal(h.renders.at(-1).cards.filter((card) => card.id === 'conflict').length, 1)
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
