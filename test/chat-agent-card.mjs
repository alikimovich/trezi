// LKM-193: a background agent's AskUserQuestion becomes a renderable question on its card
// (with the request, its file:line target and status), lights Activity and a "?" pin, and
// the card's answer settles that agent's question through the chat's answer path.
import assert from 'node:assert/strict'
import {
  agentAttention,
  agentCard,
  requestPreview,
  requestTarget
} from '../src/native/chat-agent-card.ts'
import { NativeChatController } from '../src/native/chat-controller.ts'
import { snapshot } from '../src/native/chat-snapshot.ts'
import { NativeContextController } from '../src/native/context-controller.ts'

// The preview never cuts a word: it ends on a whole word and an ellipsis.
const long = `${'Make the hero heading larger and bolder, '.repeat(5)}then recolor it`
const preview = requestPreview(long)
assert.ok(preview.endsWith('…'))
const head = preview.slice(0, -1)
assert.ok(long.startsWith(head), 'The preview is the start of the request')
assert.match(long.slice(head.length), /^[\s,.;:]/, 'The preview ends at a word boundary')
assert.ok(Array.from(preview).length <= 141)
assert.equal(requestPreview('Short request'), 'Short request')
assert.equal(requestPreview(`${'x'.repeat(200)}`).length, 141, 'Only a single huge word is cut')

const request =
  'Selected <button> at src/components/Hero.tsx:42:7 (class hero-cta).\nMake this button teal.'
assert.deepEqual(requestTarget(request), {
  label: 'src/components/Hero.tsx:42',
  source: 'src/components/Hero.tsx:42:7'
})
assert.equal(requestTarget('Make every button teal.'), undefined)

const question = {
  id: 'q-1',
  sessionKey: 'a',
  questions: [
    {
      header: 'Color',
      question: 'Which teal should the button use?',
      multiSelect: false,
      options: [
        { label: 'Brand teal', description: 'The --brand-teal token' },
        { label: 'Tailwind teal-500' }
      ]
    }
  ]
}
assert.equal(
  agentAttention({ type: 'question-request', projectKey: 'a', sessionId: 's', request: question }),
  'A background agent needs your answer in the chat.'
)
assert.equal(
  agentAttention({ type: 'question-request', projectKey: 'a', request: question }),
  null,
  "An interactive chat's question is not a background attention event"
)
assert.equal(agentAttention({ type: 'status', projectKey: 'a', sessionId: 's', text: 'x' }), null)
const running = agentCard({ id: 's', label: request, status: 'running', activity: 'Editing Hero' })
assert.equal(running.agent.statusLabel, 'Running')
assert.equal(running.detail, 'Editing Hero')
assert.equal(agentCard({ id: 's', label: 'x', status: 'queued' }).agent.statusLabel, 'Queued')

// The live path: context controller → chat snapshot → card action → answer IPC.
const calls = [],
  effects = []
const entry = { key: 'a', root: '/a', activeSessionKey: 'a' }
const invoke = async (channel, ...args) => {
  calls.push([channel, ...args])
  if (channel === 'agent:workspace-snapshot')
    return {
      projects: [
        {
          root: '/a',
          chats: [{ sessionKey: 'a', options: {}, record: { transcript: [] }, isRunning: false }]
        }
      ]
    }
  if (channel === 'setup:detect') return { canInstrument: true }
  if (channel === 'tokens:detect') return { source: 'none' }
  if (channel === 'annotations:list') return []
  if (channel === 'sessions:list') return []
  return {}
}
const workspace = {
  active: entry,
  state: { projects: [entry], history: {} },
  services: { invoke },
  changed() {},
  command: async () => {}
}
let context
const chat = new NativeChatController({
  invoke,
  render() {},
  effect: (effect) => {
    effects.push(effect)
    void context.effect(effect)
  }
})
context = new NativeContextController(workspace, chat, () => ({ projectUi: true }))
await context.activate(entry)
const view = () => snapshot(chat.get('a'), [])
const spawnEvent = (event) => chat.event({ projectKey: 'a', sessionId: 'spawn-1', ...event })
context.queued('a', 'spawn-1', request, false)
context.spawnPin('spawn-1', '/a', 'button.hero-cta')
await spawnEvent({ type: 'spawn-started', branch: 'trezi/comment' })
await spawnEvent({ type: 'question-request', request: question })
await new Promise((resolve) => setTimeout(resolve, 0))

const card = view().cards.find((c) => c.id === 'spawn-1')
assert.equal(card.title, 'Background agent needs your answer')
assert.equal(card.agent.status, 'waiting')
assert.equal(card.agent.statusLabel, 'Waiting for your answer')
assert.equal(card.agent.request, request, 'The whole request is kept for expansion')
assert.equal(card.agent.target.label, 'src/components/Hero.tsx:42')
assert.deepEqual(card.agent.question, question, 'The question renders like a chat question')
assert.equal(card.detail, undefined)
assert.deepEqual(
  card.actions.map((a) => a.action),
  ['spawn-stop'],
  'Cancel still cancels'
)
assert.ok(!JSON.stringify(card).includes('AskUserQuestion'), 'No raw tool name on the card')
assert.equal(view().questions.length, 0, 'Not duplicated as a chat question')
const pins = calls.filter((c) => c[0] === 'preview:set-annotations').at(-1)[1]
assert.deepEqual(pins.at(-1), { id: 'spawn:spawn-1', selector: 'button.hero-cta', label: '?' })

await chat.action({ chat: 'a', action: 'spawn-open-target', id: 'spawn-1' })
assert.deepEqual(effects.at(-1), { type: 'source', source: 'src/components/Hero.tsx:42:7' })

// Unanswered, the question stays; the card's answer reaches the session's answer IPC.
await chat.action({ chat: 'a', action: 'question', id: 'missing', answers: { x: 'y' } })
assert.ok(!calls.some((c) => c[0] === 'agent:respond-question'), 'Unknown ids are ignored')
assert.ok(chat.get('a').context.spawns[0].question)
const answers = { 'Which teal should the button use?': 'Brand teal' }
await chat.action({ chat: 'a', action: 'question', id: 'q-1', answers })
assert.deepEqual(calls.filter((c) => c[0] === 'agent:respond-question').at(-1), [
  'agent:respond-question',
  'q-1',
  answers
])
await new Promise((resolve) => setTimeout(resolve, 0))
const answered = view().cards.find((c) => c.id === 'spawn-1')
assert.equal(answered.agent.status, 'running')
assert.equal(answered.agent.question, undefined)
assert.ok(
  !calls
    .filter((c) => c[0] === 'preview:set-annotations')
    .at(-1)[1]
    .some((p) => p.label === '?'),
  'The "?" pin goes once the question is answered'
)
console.log(
  'Chat agent card: question view, no-cut preview, target link, status, Activity, "?" pin and answer path passed'
)
