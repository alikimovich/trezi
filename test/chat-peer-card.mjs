// LKM-406: what the chat and rail show of `peer-state` and a held decision. The events
// come from the real lifecycle in test/peer-feedback.mjs; this pins their rendering.
import assert from 'node:assert/strict'
import { emitIsolation, initChatIsolation, states } from '../src/main/chat-state.ts'
import { agentWorkspaceState } from '../src/main/chat-status.ts'
import { showParkedChat } from '../src/main/parked-chat.ts'
import { agentCard } from '../src/native/chat-agent-card.ts'
import { decisionCard, peerCard, peerLine } from '../src/native/chat-peer-card.ts'
import { snapshot } from '../src/native/chat-snapshot.ts'
import { newChat, reduce } from '../src/native/chat-state.ts'

const line = (kind, extra = {}) => ({
  kind,
  peer: 'peer-1',
  origin: 'chat',
  goal: 'Update the hero',
  ...extra
})
const known = line('overlap', { certainty: 'known', files: ['src/Hero.tsx'] })
const possible = line('overlap', { certainty: 'uncertain', files: ['src/Hero.tsx'] })
const unknown = line('overlap', { certainty: 'uncertain', files: [] })
const SAFE = /\b(safe|no conflict|compatible|clear to|won.t conflict|independent)\b/i

for (const uncertain of [possible, unknown]) {
  const text = peerLine(uncertain)
  assert.match(text, /may/, 'an uncertain overlap reads as uncertain')
  assert.match(text, /Not confirmed either way/)
  assert.doesNotMatch(text, SAFE)
  assert.equal(peerCard([uncertain]).title, 'Possible overlap')
}
assert.doesNotMatch(peerLine(known), /may|Not confirmed/, 'a known overlap is stated')
assert.match(peerLine(known), /is also changing src\/Hero\.tsx/)
assert.equal(peerCard([known]).title, 'Overlaps with other work')
assert.equal(peerLine(line('overlap', { certainty: 'known', files: [] })).includes('same'), true)

assert.equal(peerCard([line('waiting', { seconds: 60 })]).title, 'Waiting for other work')
assert.match(peerLine(line('waiting', { seconds: 60 })), /another chat .*up to 60 seconds/)
assert.equal(peerCard([line('reconciling', { self: true })]).title, 'Combining with other work')
assert.equal(peerLine(line('reconciling', { self: true })).includes('Update the hero'), false)
assert.match(peerLine(line('reconciling')), /^Another chat .* is combining/)
assert.equal(peerCard([]), null)
assert.equal(peerCard(undefined), null)

// A chat: one card, replaced in place and gone on the empty event; no transcript row.
const chat = newChat('chat-1')
const choices = []
const cards = () => snapshot(chat, choices).cards
const peerCards = () => cards().filter((card) => card.id === 'peer-work')
const messages = chat.messages.length
reduce(chat, { type: 'peer-state', lines: [possible] })
assert.equal(peerCards().length, 1)
assert.equal(peerCards()[0].title, 'Possible overlap')
assert.deepEqual(peerCards()[0].actions, [])
reduce(chat, { type: 'peer-state', lines: [known, possible] })
assert.equal(peerCards().length, 1, 'a change replaces the card')
assert.equal(peerCards()[0].title, 'Overlaps with other work')
assert.equal(peerCards()[0].detail.split('\n').length, 2)
reduce(chat, { type: 'peer-state', lines: [line('waiting', { seconds: 30 }), known] })
assert.equal(peerCards()[0].title, 'Waiting for other work')
chat.isRunning = true
assert.equal(snapshot(chat, choices).activity.label, 'Waiting for other work…')
assert.equal(snapshot(chat, choices).activity.kind, 'waiting')
assert.equal(snapshot(chat, choices).composer.thinking, false, 'waiting is not the model at work')
chat.stopping = true
assert.equal(snapshot(chat, choices).activity.kind, 'stopping', 'a Stop outranks the wait')
chat.stopping = false
chat.isRunning = false
reduce(chat, { type: 'peer-state', lines: [] })
assert.equal(peerCards().length, 0, 'the card clears when the peers are gone')
assert.equal(chat.messages.length, messages, 'peer state never enters the transcript')

// The decision: the question, where the work is, and only the way on that works.
const question = 'Should the site be dark or light?'
reduce(chat, {
  type: 'isolation',
  state: 'parked',
  branch: 'trezi/chat-1',
  files: ['page.txt'],
  reason: 'failed',
  error: `Decision needed: ${question}`,
  decision: question
})
const [held] = cards().filter((card) => card.id === 'conflict')
assert.equal(held.title, 'Decision needed')
assert.equal(cards().filter((card) => card.id === 'conflict').length, 1)
assert.equal(
  cards().filter((card) => card.id === 'error').length,
  0,
  'one question surface, no duplicate error'
)
assert.deepEqual(held.detail.split('\n').slice(0, 2), [
  question,
  'Nothing landed. This chat’s work is kept on trezi/chat-1.'
])
assert.ok(held.detail.endsWith('page.txt'))
assert.deepEqual(
  held.actions.map((action) => action.action),
  ['discard'],
  'Retry and Resolve would pick a side, and both refuse'
)
assert.equal(decisionCard({ ...chat, isRunning: true }, chat.decision).actions[0].disabled, true)
assert.equal(
  snapshot(
    Object.assign(chat, { queue: [{ id: 'q', text: 'x', attachments: [] }], paused: true }),
    choices
  ).composer.queueNote,
  'Waiting — answer the decision or discard the held changes to send these'
)
chat.queue = []
// A held landing without a decision keeps its usual card and every way out.
reduce(chat, {
  type: 'isolation',
  state: 'parked',
  files: ['page.txt'],
  reason: 'failed',
  error: 'x'
})
assert.equal(chat.decision, undefined)
assert.deepEqual(
  cards()
    .find((card) => card.id === 'conflict')
    .actions.map((action) => action.label),
  ['Discard', 'Retry', 'Resolve']
)
reduce(chat, {
  type: 'isolation',
  state: 'parked',
  branch: 'trezi/chat-1',
  decision: question,
  reason: 'failed',
  error: 'x'
})
reduce(chat, { type: 'isolation', state: 'merged', files: ['page.txt'] })
assert.equal(chat.decision, undefined, 'the answered decision clears')
assert.equal(
  cards().some((card) => card.id === 'conflict'),
  false
)

// The main side: a hold always reaches the chat. Only the one re-show that ends the same
// reconciliation is skipped, and a held decision asked again must pause the queue again.
const announced = []
initChatIsolation({
  getWindow: () => ({
    webContents: { isDestroyed: () => false, send: (_, event) => announced.push(event) }
  })
})
const hold = (extra = {}) => ({
  parked: true,
  wt: { branch: 'trezi/chat-1' },
  parkedFiles: ['page.txt'],
  landingError: `Decision needed: ${question}`,
  decision: question,
  ...extra
})
const park = (ask) =>
  emitIsolation('chat-1', 'parked', 'trezi/chat-1', ['page.txt'], null, null, 'failed', 'x', ask)
park(question)
park(question)
assert.equal(announced.length, 2, 'emitting never drops a hold: the same question asked again')
announced.length = 0
// The end of a reconciliation re-shows the park once; the hold just announced it.
states.set('chat-1', hold({ decisionShown: true }))
assert.match(agentWorkspaceState('chat-1').guidance, /shown the one question on the decision card/)
assert.doesNotMatch(agentWorkspaceState('chat-1').guidance, /Ask the user/)
showParkedChat('chat-1')
assert.equal(announced.length, 0, 'the repeat right after a hold is skipped')
assert.equal(states.get('chat-1').decisionShown, false, 'and only that one')
showParkedChat('chat-1')
assert.equal(announced.length, 1, 'a later restore shows the decision again')
assert.equal(announced[0].decision, question)
announced.length = 0
states.set('chat-1', hold({ decision: undefined, decisionShown: true }))
showParkedChat('chat-1')
assert.equal(announced.length, 1, 'a park with no decision is never skipped')
states.clear()
// The chat: the answer unpaused it and the user queued a message. The re-hold with the same
// question must pause it again, the message stays unsent, and the note says why.
{
  const asked = newChat('chat-2')
  const again = {
    type: 'isolation',
    state: 'parked',
    branch: 'trezi/chat-2',
    files: ['page.txt'],
    reason: 'failed',
    error: `Decision needed: ${question}`,
    decision: question
  }
  reduce(asked, again)
  assert.equal(asked.paused, true)
  asked.paused = false
  asked.queue = [{ id: 'q', text: 'one more thing', attachments: [] }]
  reduce(asked, again)
  assert.equal(asked.paused, true, 'a decision asked again pauses the queue again')
  assert.equal(asked.queue.length, 1, 'the queued message is not sent onto held work')
  assert.equal(
    snapshot(asked, []).composer.queueNote,
    'Waiting — answer the decision or discard the held changes to send these'
  )
}

// The rail: the same words on the comment's card, under what it is doing now.
const spawn = { id: 's', label: 'Update the hero', status: 'running', activity: 'Reading' }
assert.equal(agentCard(spawn).detail, 'Reading')
assert.equal(agentCard({ ...spawn, peerWork: [] }).detail, 'Reading')
assert.deepEqual(agentCard({ ...spawn, peerWork: [possible] }).detail.split('\n'), [
  peerLine(possible),
  'Reading'
])
assert.equal(
  agentCard({ ...spawn, peerWork: [possible], question: { id: 'q', questions: [] } }).detail,
  undefined,
  'a pending question replaces it'
)

console.log('Chat peer card: overlap, wait, reconciliation and decision render as stated')
