// LKM-600: an inspector Apply is shown as Trezi's own row (the change and the element),
// never as a user bubble holding the instruction, its selector, hash or paths. The origin
// is explicit structured metadata (`AppAction`) set by the code that wrote the text; user
// text that looks the same stays a user message. The full instruction stays the turn's
// text (what the provider gets), the row's detail and its copy. Real NativeChatController
// with a recorded `invoke`; no provider or desktop.
import assert from 'node:assert/strict'
import { NativeChatController } from '../src/native/chat-controller.ts'
import { editQueued, queuedText } from '../src/native/chat-queue.ts'
import { hydrate } from '../src/native/chat-state.ts'
import { appAction, appActionRow, entryLine } from '../src/shared/app-action.ts'

const INSTRUCTION =
  'Apply this single batch of Styles preview drafts to the actual application source. Target div > button:nth-of-type(2) > span from src/Preset.tsx:82:24. Edits:\nsrc/Preset.tsx (staged against SHA-256 0123abcd): set font-weight to 400'
const ACTION = { kind: 'inspector-apply', summary: 'font-weight: 400 on <span> in Preset.tsx:82' }

const cases = []
const test = (name, run) => cases.push({ name, run })

const make = () => {
  const calls = []
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
                  record: { transcript: [], title: 'Chat' },
                  isRunning: false,
                  options: { provider: 'codex', permissionMode: 'auto' }
                }
              ]
            }
          ]
        }
      if (channel === 'agent:turn-state') return { turn: null, running: false }
      if (channel === 'providers:choices') return []
      return { ok: true }
    },
    render: () => {},
    effect: () => {}
  })
  return { controller, calls }
}
const context = {
  chat: 'a',
  root: '/fixture',
  selection: null,
  turn: {},
  setup: { needed: false, dismissed: false, status: null },
  tokens: { needed: false, dismissed: false },
  notes: [],
  spawns: []
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

test('the fallback chat turn is an app row; the user draft and chip stay put', async () => {
  const { controller, calls } = make()
  await controller.command({ type: 'context', context })
  const chat = controller.get('a')
  await controller.composer({
    chat: 'a',
    action: 'input',
    text: 'my own words',
    caret: 12,
    revision: 1
  })
  await controller.command({ type: 'submit', chat: 'a', text: INSTRUCTION, action: ACTION })
  await settle()
  const message = chat.messages.find((m) => m.role === 'user')
  assert.ok(message, 'a user-side turn exists (history is not hidden)')
  assert.equal(message.text, INSTRUCTION, 'the exact instruction is kept for copy')
  assert.equal(message.action.title, 'Apply Styles draft')
  assert.equal(message.action.line, ACTION.summary)
  assert.match(message.action.detail, /Sent by Trezi to the agent/)
  assert.ok(message.action.detail.includes(INSTRUCTION), 'diagnostics on expand')
  assert.equal(message.selection, undefined, 'no selection chip borrowed from the composer')
  assert.equal(chat.text, 'my own words', "the user's composer draft is not consumed")
  const sent = calls.find(([channel]) => channel === 'agent:send')
  assert.ok(sent, 'the worker still receives the turn')
  assert.equal(sent[1], INSTRUCTION, 'the provider gets the full guarded instruction')
  assert.deepEqual(sent[6], ACTION, 'the origin travels to the transcript explicitly')
})

test('a user message is never treated as an app row, even with the same text', async () => {
  const { controller, calls } = make()
  await controller.command({ type: 'context', context })
  await controller.command({ type: 'submit', chat: 'a', text: INSTRUCTION })
  await settle()
  const message = controller.get('a').messages.find((m) => m.role === 'user')
  assert.equal(message.action, undefined)
  assert.equal(calls.find(([channel]) => channel === 'agent:send')[6], undefined)
})

test('History restores the app row from the entry origin only', () => {
  const chat = { messages: [], streamingId: null, isRunning: false }
  hydrate(chat, [
    { role: 'user', text: INSTRUCTION, at: 1, action: ACTION },
    { role: 'assistant', text: 'Done.', at: 2 },
    { role: 'user', text: INSTRUCTION, at: 3 }
  ])
  const users = chat.messages.filter((m) => m.role === 'user')
  assert.equal(users.length, 2, 'every recorded turn stays')
  assert.equal(users[0].action.line, ACTION.summary)
  assert.equal(users[0].text, INSTRUCTION)
  assert.equal(users[1].action, undefined, 'identical user text stays a user bubble')
})

test('a queued Apply is named by its summary and cannot become the user draft', () => {
  const submission = {
    id: 'q1',
    text: INSTRUCTION,
    attachments: [],
    selection: null,
    turn: {},
    action: ACTION
  }
  assert.equal(queuedText(submission), `Apply ${ACTION.summary}`)
  const chat = { queue: [submission], text: 'mine', attachments: [], context: null }
  assert.equal(editQueued(chat, 'queued-q1'), false)
  assert.equal(chat.text, 'mine')
  assert.equal(chat.queue.length, 1)
})

test('only a known origin passes IPC; the row fences the instruction safely', () => {
  assert.equal(appAction({ kind: 'user', summary: 'x' }), undefined)
  assert.equal(appAction({ kind: 'inspector-apply', summary: '  ' }), undefined)
  assert.equal(appAction('inspector-apply'), undefined)
  assert.deepEqual(appAction({ kind: 'inspector-apply', summary: ' a\n b ', extra: 1 }), {
    kind: 'inspector-apply',
    summary: 'a b'
  })
  // History names a recorded Apply by its change; a user entry by its own text.
  assert.equal(entryLine({ text: INSTRUCTION, action: ACTION }), `Apply ${ACTION.summary}`)
  assert.equal(entryLine({ text: 'Make it blue' }), 'Make it blue')
  assert.equal(entryLine(undefined), undefined)
  const row = appActionRow(ACTION, 'has ``` inside')
  assert.match(row.detail, /````text\nhas ``` inside\n````$/)
})

let failed = 0
for (const { name, run } of cases) {
  try {
    await run()
    console.log(`PASS ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}\n  ${error.stack?.split('\n').slice(0, 4).join('\n  ')}`)
  }
}
if (failed) {
  console.log(`${failed} of ${cases.length} failed`)
  process.exit(1)
}
console.log(`${cases.length} passed`)
process.exit(0)
