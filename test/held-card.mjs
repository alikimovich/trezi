// LKM-590: the held-changes card shows one clear next step from structured state. While
// Trezi owns the hold it shows progress and nothing to press; a failed landing offers Try
// applying again; a staged overlap (the backend's `conflicts`) offers Fix conflicts; a moved
// project offers Combine with project edits; the report, the other recovery and Discard sit
// in More, and Discard asks first. Each visible action maps to its existing owner, once.
import assert from 'node:assert/strict'
import { emitIsolation, initChatIsolation, states } from '../src/main/chat-state.ts'
import { NativeChatController } from '../src/native/chat-controller.ts'
import { snapshot } from '../src/native/chat-snapshot.ts'
import { newChat, reduce } from '../src/native/chat-state.ts'

const held = (chat) => snapshot(chat, []).cards.find((card) => card.id === 'conflict')
const row = (card) => card.actions.map((a) => [a.action, a.label, a.role])
const menu = (card) => (card.menu ?? []).map((a) => a.action)
const files = ['src/page.tsx']

// The main side: a park staged with overlapping edits names them; any other park does not.
const announced = []
initChatIsolation({
  getWindow: () => ({
    webContents: { isDestroyed: () => false, send: (_, event) => announced.push(event) }
  })
})
states.set('k', { resolvingFiles: ['src/page.tsx'] })
emitIsolation('k', 'parked', 'trezi/chat-k', files)
emitIsolation('k', 'merged', 'trezi/chat-k', files)
states.set('k', { resolvingFiles: null })
emitIsolation('k', 'parked', 'trezi/chat-k', files)
assert.deepEqual(
  announced.map((event) => event.conflicts),
  [['src/page.tsx'], undefined, undefined]
)
states.clear()

// Moved project (no reason known beyond that): Combine, with Retry and Discard in More.
{
  const chat = newChat('moved')
  reduce(chat, { type: 'isolation', state: 'parked', files })
  const card = held(chat)
  assert.equal(card.title, 'This turn’s changes didn’t land')
  assert.match(card.detail, /^The project changed under them/)
  assert.deepEqual(row(card), [['resolve', 'Combine with project edits', 'primary']])
  assert.match(card.hint, /^Combine with project edits merges them with the newer edits/)
  assert.deepEqual(menu(card), ['landing-retry', 'discard-ask'])
  // The turn-end Problem with no reason of its own: honest, the report in More.
  chat.recoveryProblem = 'Problem: The changes are still held after the checks and reconciliation.'
  chat.recoveryReport = '/tmp/report.json'
  const problem = held(chat)
  assert.equal(problem.title, 'Problem')
  assert.equal(problem.detail, chat.recoveryProblem)
  assert.equal(problem.fullDetail, 'src/page.tsx')
  assert.deepEqual(row(problem), [['resolve', 'Combine with project edits', 'primary']])
  assert.deepEqual(menu(problem), ['recovery-report', 'landing-retry', 'discard-ask'])
}

// Failed landing (retryable): Try applying again; Combine stays reachable in More.
{
  const chat = newChat('failed')
  reduce(chat, {
    type: 'isolation',
    state: 'parked',
    files,
    reason: 'failed',
    error: 'The repository owner refused the write.'
  })
  const card = held(chat)
  assert.equal(card.title, 'Changes couldn’t be applied')
  assert.match(card.detail, /couldn’t apply them to the project: The repository owner refused/)
  assert.deepEqual(row(card), [['landing-retry', 'Try applying again', 'primary']])
  assert.match(card.hint, /checks the held changes again and applies them/)
  assert.deepEqual(menu(card), ['resolve', 'discard-ask'])
  // A request that ended still held with no reason of its own says so with the known one.
  chat.recoveryProblem = 'The changes are still held.'
  assert.equal(
    held(chat).detail,
    'The changes are still held. Trezi couldn’t apply them to the project: The repository owner refused the write.'
  )
}

// Real conflict (structured, from the park event): Fix conflicts; Retry would only re-park.
{
  const chat = newChat('conflict')
  reduce(chat, { type: 'isolation', state: 'parked', files, conflicts: files })
  const card = held(chat)
  assert.equal(card.title, 'Changes overlap with project edits')
  assert.deepEqual(row(card), [['resolve', 'Fix conflicts', 'primary']])
  assert.match(card.hint, /asks the agent to combine both versions/)
  assert.deepEqual(menu(card), ['discard-ask'])
  // A landing that failed over staged overlaps: fixing them comes first; Retry stays in More.
  reduce(chat, {
    type: 'isolation',
    state: 'parked',
    files,
    conflicts: files,
    reason: 'failed',
    error: 'boom'
  })
  assert.deepEqual(row(held(chat)), [['resolve', 'Fix conflicts', 'primary']])
  assert.match(held(chat).detail, /last attempt to apply them failed: boom/)
  assert.deepEqual(menu(held(chat)), ['landing-retry', 'discard-ask'])
  // A send in flight offers nothing it would refuse.
  chat.sending = true
  assert.deepEqual(held(chat).actions, [])
  chat.sending = false
  // A later park without staged overlaps is no longer called a conflict.
  reduce(chat, { type: 'isolation', state: 'parked', files })
  assert.equal(row(held(chat))[0][1], 'Combine with project edits')
}

// Working: progress only, never a disabled cluster or Discard; the working title says what.
{
  const chat = newChat('working')
  reduce(chat, { type: 'isolation', state: 'parked', files, reason: 'failed', error: 'x' })
  for (const [recovery, title] of [
    ['retry', 'Trying to apply again…'],
    ['resolve', 'Combining with project edits…'],
    ['discard', 'Discarding held changes…']
  ]) {
    chat.recovery = recovery
    const card = held(chat)
    assert.equal(card.title, title)
    assert.equal(card.busy, true)
    assert.match(card.detail, /Nothing is needed from you yet/)
    assert.deepEqual(card.actions, [])
    assert.equal(card.menu, undefined)
  }
  chat.recovery = undefined
  chat.landingError = undefined
  Object.assign(chat, { isRunning: true, operation: 'resolving', phase: 'applying' })
  assert.equal(held(chat).title, 'Fixing conflicts…')
  assert.equal(held(chat).busy, false, 'the agent turn shows its own activity')
  // A turn that does not own the hold (stopping) still offers nothing until it ends.
  Object.assign(chat, { stopping: true, landingError: 'x' })
  const blocked = held(chat)
  assert.deepEqual(blocked.actions, [])
  assert.deepEqual(menu(blocked), [])
  assert.equal(blocked.hint, 'Recovery returns when the current turn finishes.')
}

// Failed recovery after a timeout: the Problem, its report, and nothing else until it ends.
{
  const chat = newChat('timeout')
  reduce(chat, { type: 'isolation', state: 'parked', files })
  Object.assign(chat, {
    recovery: 'retry',
    recoveryTimedOut: true,
    recoveryProblem: 'Problem: The recovery request did not answer within two minutes.',
    recoveryReport: '/tmp/report.json'
  })
  const card = held(chat)
  assert.equal(card.title, 'Problem')
  assert.deepEqual(card.actions, [])
  assert.deepEqual(menu(card), ['recovery-report'])
  assert.match(card.hint, /earlier request is still finishing/)
}

// Settled: the merge clears the card.
{
  const chat = newChat('settled')
  reduce(chat, { type: 'isolation', state: 'parked', files })
  reduce(chat, { type: 'isolation', state: 'merged', files })
  assert.equal(held(chat), undefined)
}

// Discard asks first, through the real controller, and reaches its owner exactly once.
{
  const calls = []
  const renders = []
  const controller = new NativeChatController({
    invoke: async (channel, ...args) => {
      calls.push([channel, ...args])
      if (channel === 'agent:workspace-snapshot')
        return {
          projects: [
            {
              root: '/fixture',
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
      if (channel === 'providers:choices') return []
      return { ok: true }
    },
    render: (state) => renders.push(structuredClone(state)),
    effect: () => {}
  })
  await controller.command({
    type: 'context',
    context: {
      chat: 'a',
      root: '/fixture',
      selection: null,
      turn: {},
      setup: { needed: false, dismissed: false, status: null },
      tokens: { needed: false, dismissed: false },
      notes: [],
      spawns: []
    }
  })
  const card = () => renders.at(-1).cards.find((c) => c.id === 'conflict')
  const discards = () => calls.filter((call) => call[0] === 'agent:discard-conflict').length
  controller.event({ projectKey: 'a', type: 'isolation', state: 'parked', files, conflicts: files })
  await controller.action({ chat: 'a', action: 'discard-ask', id: 'conflict' })
  assert.equal(card().title, 'Discard held changes?')
  assert.match(
    card().detail,
    /deletes this chat’s held changes\.\nThe project keeps its current files\. This can’t be undone\./
  )
  assert.deepEqual(row(card()), [
    ['discard-cancel', 'Keep changes', undefined],
    ['discard', 'Discard changes', 'destructive']
  ])
  assert.equal(discards(), 0, 'asking deletes nothing')
  await controller.action({ chat: 'a', action: 'discard-cancel', id: 'conflict' })
  assert.equal(card().title, 'Changes overlap with project edits')
  assert.equal(discards(), 0)
  // A new hold replaces the question: the user confirms what they see.
  await controller.action({ chat: 'a', action: 'discard-ask', id: 'conflict' })
  controller.event({ projectKey: 'a', type: 'isolation', state: 'parked', files })
  assert.notEqual(card().title, 'Discard held changes?')
  // A click still on its way from the old confirm card deletes nothing.
  await controller.action({ chat: 'a', action: 'discard', id: 'conflict' })
  assert.equal(discards(), 0, 'an unconfirmed Discard never reaches the owner')
  // A recovery request also ends the question; afterwards the card is not a confirm.
  await controller.action({ chat: 'a', action: 'discard-ask', id: 'conflict' })
  await controller.action({ chat: 'a', action: 'landing-retry', id: 'conflict' })
  assert.notEqual(card().title, 'Discard held changes?')
  await controller.action({ chat: 'a', action: 'discard', id: 'conflict' })
  assert.equal(discards(), 0)
  // An older Problem does not survive a park the backend reports as a real overlap.
  controller.event({
    projectKey: 'a',
    type: 'isolation',
    state: 'parked',
    files,
    reason: 'failed',
    error: 'old'
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(card().title, 'Problem')
  controller.event({ projectKey: 'a', type: 'isolation', state: 'parked', files, conflicts: files })
  assert.equal(card().title, 'Changes overlap with project edits')
  assert.deepEqual(
    row(card()).map((r) => r[1]),
    ['Fix conflicts']
  )
  await controller.action({ chat: 'a', action: 'discard-ask', id: 'conflict' })
  await controller.action({ chat: 'a', action: 'discard', id: 'conflict' })
  assert.equal(discards(), 1, 'one confirmed Discard, one request')
}

// LKM-597: a failed landing that a newer turn carries is an intermediate step, not a Problem.
// The real controller path: the failed park writes the Problem and its report; the user's
// next message (a new turn id) continues on the held work, and that turn's landing checks it.
{
  const controller = new NativeChatController({
    invoke: async (channel) => {
      if (channel === 'agent:workspace-snapshot')
        return {
          projects: [
            {
              root: '/fixture',
              chats: [
                {
                  sessionKey: 'b',
                  record: { transcript: [] },
                  isRunning: false,
                  options: { provider: 'claude' }
                }
              ]
            }
          ]
        }
      if (channel === 'providers:choices') return []
      return { ok: true }
    },
    render: () => {},
    effect: () => {}
  })
  await controller.command({
    type: 'context',
    context: {
      chat: 'b',
      root: '/fixture',
      selection: null,
      turn: {},
      setup: { needed: false, dismissed: false, status: null },
      tokens: { needed: false, dismissed: false },
      notes: [],
      spawns: []
    }
  })
  const chat = controller.get('b')
  const card = () => held(chat)
  const failed = (turn, error) =>
    controller.event({
      projectKey: 'b',
      type: 'isolation',
      state: 'parked',
      files,
      reason: 'failed',
      error,
      turn
    })
  const gate = 'the check "webkit /portfolio" did not pass on this exact source (checks-failed).'
  // Turn t1 ends held: while it is still landing it is its own outcome (no newer owner).
  Object.assign(chat, { turn: 't1', isRunning: true, phase: 'applying', operation: 'landing' })
  failed('t1', gate)
  chat.recoveryReport = '/tmp/report.json'
  Object.assign(chat, { isRunning: false, phase: 'thinking', operation: undefined })
  assert.equal(card().title, 'Problem', 't1’s own unresolved outcome stays honest')
  assert.deepEqual(row(card()), [['landing-retry', 'Try applying again', 'primary']])
  // The user answers (a new turn): it continues on the held work, so it owns the hold.
  Object.assign(chat, { turn: 't2', isRunning: true, phase: 'working' })
  const working = card()
  assert.equal(working.title, 'Working on held changes…')
  assert.match(working.detail, /checks them again when it finishes\. Nothing is needed/)
  assert.deepEqual(working.actions, [], 'no Retry/Resolve/Discard while the turn owns it')
  assert.equal(working.hint, undefined)
  assert.deepEqual(menu(working), ['recovery-report'], 'the earlier failure’s report is kept')
  assert.equal(chat.recoveryProblem, `Problem: ${gate}`, 'diagnostic history is not erased')
  // Its landing: still progress.
  Object.assign(chat, { phase: 'applying', operation: 'landing' })
  assert.equal(card().title, 'Checking changes…')
  // A late park from t1 cannot restore the obsolete Problem over t2's work.
  failed('t1', 'stale')
  assert.equal(chat.landingError, gate)
  assert.equal(card().title, 'Checking changes…')
  // A stopping turn no longer carries it: the failure is shown again, with nothing to press yet.
  chat.stopping = true
  assert.equal(card().title, 'Problem')
  assert.deepEqual(card().actions, [])
  chat.stopping = false
  // Terminal: t2's own landing also fails. The new reason, the one next action.
  failed('t2', 'the check "webkit /" did not pass on this exact source (checks-failed).')
  Object.assign(chat, { isRunning: false, phase: 'thinking', operation: undefined })
  assert.equal(card().title, 'Problem')
  assert.match(card().detail, /check "webkit \/" did not pass/)
  assert.deepEqual(row(card()), [['landing-retry', 'Try applying again', 'primary']])
  // t3 recovers: the merge clears the Problem and its report; a late t2 park cannot revive it.
  Object.assign(chat, { turn: 't3', isRunning: true, phase: 'working' })
  assert.equal(card().title, 'Working on held changes…')
  controller.event({ projectKey: 'b', type: 'isolation', state: 'merged', files, turn: 't3' })
  assert.equal(card(), undefined)
  assert.equal(chat.recoveryProblem, undefined)
  failed('t2', 'late')
  assert.equal(card(), undefined, 'a late older park does not restore an obsolete Problem')
  // A product decision is never presented as progress, even while a turn runs.
  controller.event({
    projectKey: 'b',
    type: 'isolation',
    state: 'parked',
    files,
    decision: 'Keep the old heading?',
    turn: 't3'
  })
  const decision = snapshot(chat, []).cards.find((c) => c.id === 'conflict')
  assert.equal(decision.title, 'Decision needed')
  // Hydration cannot tell whether a running turn is the failed one: never assumed newer.
  const fresh = newChat('hydrated')
  reduce(fresh, { type: 'isolation', state: 'parked', files, reason: 'failed', error: 'x' })
  Object.assign(fresh, { failedTurn: 'live', turn: 'live', isRunning: true, phase: 'working' })
  assert.equal(held(fresh).title, 'Changes couldn’t be applied')
}

console.log('HELD-CARD PASS')
