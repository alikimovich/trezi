import assert from 'node:assert/strict'
import { answerAsked, askUser } from '../src/main/question-tool.ts'
import { NativeChatController } from '../src/native/chat-controller.ts'

// LKM-199: a provider without a native question tool (Codex) asks through ask_user. The
// card is AskUserQuestion's; the answer is the user's next message, after the turn ended.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const notified = []
const scope = {
  emitKey: 'chat-a',
  background: false,
  notify: (channel, payload) => notified.push({ channel, payload })
}
const questions = [
  {
    question: 'Which layout?',
    header: 'Layout',
    options: [{ label: 'Grid', description: 'Two columns' }, { label: 'List' }]
  }
]

// Background agents never ask; a question with no options is refused, not shown.
assert.match(askUser({ questions }, { ...scope, background: true }).error, /default choice/)
assert.match(askUser({ questions: [{ question: 'Why?', options: [] }] }, scope).error, /options/)
assert.equal(notified.length, 0)

const asked = askUser({ questions }, scope)
assert.equal(asked.asked, true)
assert.match(asked.guidance, /End your turn now/)
assert.match(asked.guidance, /Do not choose for the user/)
assert.equal(notified.length, 1)
const { channel, payload } = notified[0]
assert.equal(channel, 'agent:event')
assert.equal(payload.type, 'question-request')
assert.equal(payload.request.sessionKey, 'chat-a')
assert.deepEqual(payload.request.questions, [
  { ...questions[0], header: 'Layout', multiSelect: false }
])

// The native chat shows the card; the answer is sent as the user's next message.
const calls = []
let answered
const controller = new NativeChatController({
  invoke: async (name, ...args) => {
    calls.push([name, ...args])
    if (name === 'agent:workspace-snapshot')
      return {
        projects: [
          {
            root: '/fixture',
            chats: [
              {
                sessionKey: 'chat-a',
                record: { id: 'r', transcript: [], title: 'Chat' },
                isRunning: false,
                options: { provider: 'codex', permissionMode: 'auto' }
              }
            ]
          }
        ]
      }
    if (name === 'providers:choices') return []
    if (name === 'agent:respond-question') {
      answered = answerAsked(args[0], args[1])
      return answered
    }
    return { ok: true }
  },
  render: () => {},
  effect: () => {}
})
await controller.command({
  type: 'context',
  context: {
    chat: 'chat-a',
    root: '/fixture',
    selection: null,
    turn: {},
    setup: { needed: false, dismissed: false, status: null },
    tokens: { needed: false, dismissed: false },
    notes: [],
    spawns: []
  }
})
const chat = controller.get('chat-a')
chat.text = 'my unsent draft'
controller.event(payload)
assert.equal(chat.questions.length, 1, 'the same question card as AskUserQuestion')
await controller.action({
  chat: 'chat-a',
  action: 'question',
  id: payload.request.id,
  answers: { 'Which layout?': 'Grid' }
})
await tick()
assert.equal(chat.questions.length, 0)
assert.equal(answered.message, 'The user answered your question(s):\n- Which layout?\n  → Grid')
const sent = calls.filter((c) => c[0] === 'agent:send')
assert.equal(sent.length, 1)
assert.equal(sent[0][1], answered.message)
assert.equal(sent[0][3], 'chat-a')
assert.equal(chat.text, 'my unsent draft', 'the composer draft is left alone')
assert.equal(chat.messages.filter((m) => m.role === 'user').at(-1).text, answered.message)

// Answered once; a dismissed question sends nothing; an AskUserQuestion id is not ours.
assert.equal(answerAsked(payload.request.id, { 'Which layout?': 'List' }), undefined)
askUser({ questions }, scope)
assert.deepEqual(answerAsked(notified.at(-1).payload.request.id, null), {})
assert.equal(answerAsked('toolu_123', null), undefined)
console.log('ask-user: OK')
