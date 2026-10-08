import assert from 'node:assert/strict'
import { z } from 'zod'
import { chatUiCatalog, chatUiShape } from '../bin/chat-ui-schema.mjs'
import {
  answerChatUi,
  chatUiContext,
  chatUiProblems,
  chatUiTool,
  setChatUiHost
} from '../src/main/chat-ui.ts'
import { registerPreviewSource } from '../src/main/preview-state.ts'
import { treziRules } from '../src/main/rules.ts'
import { NativeChatController } from '../src/native/chat-controller.ts'
import { hydrate, newChat } from '../src/native/chat-state.ts'

// LKM-208: native answer components (options, form) — schema, tool, answer round trip.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const CHAT = 'chat-ui-a'
const notified = []
const scope = {
  emitKey: CHAT,
  background: false,
  notify: (channel, payload) => notified.push({ channel, payload })
}
const transcript = []
setChatUiHost({
  persist: (chat, record) => {
    assert.equal(chat, CHAT)
    const entry = transcript.find((e) => e.ui?.id === record.id)
    if (entry) entry.ui = record
    else
      transcript.push({
        role: 'status',
        text: `Showed ${record.component.kind}`,
        at: 1,
        ui: record
      })
  },
  find: (_chat, id) => transcript.find((e) => e.ui?.id === id)?.ui
})
// A preview whose thumbnails name what they captured.
const thumbnails = []
registerPreviewSource({
  getUrl: () => 'http://localhost:5199/variants?v=b#top',
  capture: async () => null,
  agent: {
    evaluate: async (code) =>
      code.includes('prepareCapture')
        ? code.includes('#missing')
          ? { error: 'No element matches #missing.' }
          : {
              crop: { x: 1, y: 2, width: 30, height: 40 },
              scrolled: false,
              restore: { x: 0, y: 0 }
            }
        : true,
    captureRect: async () => null,
    setViewport: async () => ({ width: null, zoom: 1 }),
    thumbnail: async (rect, width) => {
      thumbnails.push({ rect, width })
      return Buffer.from(`jpeg ${rect ? 'element' : 'page'}`).toString('base64')
    }
  }
})

const options = {
  kind: 'options',
  title: 'Hero directions',
  options: [
    { id: 'a', title: 'Centered', note: 'A centered headline over the photo.', capture: true },
    {
      id: 'b',
      title: 'Split hero',
      note: 'Copy left, image right.',
      tags: ['bold'],
      capture: { selector: '.hero' }
    },
    { id: 'c', title: 'Minimal', note: 'Type only.' }
  ]
}
const form = {
  kind: 'form',
  title: 'Card details',
  fields: [
    {
      id: 'density',
      type: 'choice',
      label: 'Density',
      options: [
        { value: 'compact', label: 'Compact' },
        { value: 'airy', label: 'Airy' }
      ]
    },
    { id: 'radius', type: 'number', label: 'Radius', unit: 'px', min: 0, max: 32 },
    { id: 'gap', type: 'slider', label: 'Gap', min: 4, max: 48, step: 4, default: 16 },
    {
      id: 'accent',
      type: 'color',
      label: 'Accent',
      suggestions: [{ name: '--brand', value: '#0a84ff' }]
    },
    { id: 'shadow', type: 'toggle', label: 'Shadow' },
    { id: 'notes', type: 'text', label: 'Notes', required: false, multiline: true }
  ]
}

// --- a bad payload is rejected with every problem, and nothing is shown -------------------
const bad = await chatUiTool(
  {
    action: 'show',
    component: {
      kind: 'options',
      title: 'Too few',
      options: [{ id: 'A b', title: 'One', note: 'Only one.', extra: 1 }]
    }
  },
  scope
)
assert.equal(bad.code, 'invalid_component')
assert.match(bad.error, /nothing was shown/)
assert.ok(
  bad.problems.some((p) => p.startsWith('options:')),
  bad.problems.join(' | ')
)
assert.ok(
  bad.problems.some((p) => /options\.0\.id: use 1–32 lowercase/.test(p)),
  'bad option id'
)
assert.ok(
  bad.problems.some((p) => /extra/.test(p)),
  'unknown keys are rejected'
)
assert.deepEqual(
  chatUiProblems({
    kind: 'form',
    title: 'Broken',
    fields: [
      { id: 'x', type: 'slider', label: 'X', min: 10, max: 2 },
      {
        id: 'x',
        type: 'choice',
        label: 'Y',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' }
        ],
        default: 'z'
      },
      { id: 'n', type: 'number', label: 'N', min: 0, max: 5, default: 9 }
    ]
  }),
  [
    'fields.1.id: duplicate id "x"',
    'fields.0.min: min must be below max',
    'fields.1.default: default must be one of the option values',
    'fields.2.default: default is outside min…max'
  ]
)
assert.ok(chatUiProblems({ kind: 'chart' }).length, 'an unknown kind is rejected')
assert.equal(notified.length, 0, 'nothing reached the chat')
assert.equal(transcript.length, 0)
assert.match(
  (await chatUiTool({ action: 'show', component: form }, { ...scope, background: true })).error,
  /Background edits/
)

// --- the catalog, and the tool's schema is listable over MCP -----------------------------
const catalog = await chatUiTool({ action: 'catalog' }, scope)
assert.deepEqual(
  catalog.components.map((c) => c.kind),
  ['options', 'form']
)
assert.equal(catalog.limits.options.max, 4)
const listed = z.toJSONSchema(z.object(chatUiShape))
assert.ok(listed.properties.component, 'the component schema converts to JSON Schema')

// --- show: the component appears at once (skeletons), then each capture fills in ---------
const shown = await chatUiTool({ action: 'show', component: options }, scope)
assert.equal(shown.shown, true)
assert.match(shown.guidance, /end your turn now/)
assert.deepEqual(shown.images, ['a', 'b'])
const events = notified.map((n) => n.payload)
assert.ok(events.every((e) => e.type === 'chat-ui' && e.projectKey === CHAT))
assert.equal(events.length, 3, 'shown, then one event per captured option')
assert.deepEqual(Object.keys(events[0].ui.images), [], 'first frame: every image is a skeleton')
assert.deepEqual(Object.keys(events[1].ui.images), ['a'])
assert.equal(events[2].ui.images.b.route, '/variants?v=b#top')
assert.equal(
  events[2].ui.images.b.src,
  `data:image/jpeg;base64,${Buffer.from('jpeg element').toString('base64')}`
)
assert.deepEqual(thumbnails, [
  { rect: null, width: 360 },
  { rect: { x: 1, y: 2, width: 30, height: 40 }, width: 360 }
])
assert.ok(!('capture' in events[0].ui.component.options[0]), 'capture requests are not content')
assert.equal(transcript.length, 1, 'the conversation owns the component')

// --- update: a failed capture is reported per option; replacing keeps kept images -------
const id = shown.id
assert.match(
  (await chatUiTool({ action: 'update', id: 'ui-nope', option: 'a' }, scope)).error,
  /No chat_ui component/
)
assert.match(
  (await chatUiTool({ action: 'update', id, option: 'z' }, scope)).error,
  /no option "z"/
)
const missing = await chatUiTool(
  { action: 'update', id, option: 'c', capture: { selector: '#missing' } },
  scope
)
assert.match(missing.error, /No element matches #missing/)
assert.match(notified.at(-1).payload.ui.missing.c, /No element matches/)
const replaced = await chatUiTool(
  {
    action: 'update',
    id,
    component: {
      ...options,
      options: [options.options[1], { id: 'd', title: 'Stacked', note: 'Image above copy.' }]
    }
  },
  scope
)
assert.deepEqual(
  replaced.images.sort(),
  ['b'],
  'b kept its image (and was captured again); a is gone'
)
assert.match(
  (await chatUiTool({ action: 'update', id, component: form }, scope)).error,
  /is options; show a new one/
)

// --- answers are checked against the component -----------------------------------------
assert.match(answerChatUi(CHAT, id, { choice: 'z' }).error, /no option "z"/)
assert.match(answerChatUi(CHAT, id, { choice: null }).error, /Say what to change/)
const shownForm = await chatUiTool({ action: 'show', component: form }, scope)
const formId = shownForm.id
const invalidForm = answerChatUi(CHAT, formId, {
  values: { radius: 40, shadow: 'yes', density: 'huge', extra: 1 }
}).error
for (const problem of [
  /There is no field extra/,
  /Density: pick one listed option/,
  /Radius: at most 32/,
  /Gap is required/,
  /Accent is required/,
  /Shadow: must be on or off/
])
  assert.match(invalidForm, problem)

// --- the native chat: mid-turn component, pick → structured turn → summary next turn ----
const calls = []
const prompts = []
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
                sessionKey: CHAT,
                record: { id: 'r', transcript: [], title: 'Chat' },
                isRunning: false,
                options: { provider: 'codex', permissionMode: 'auto' }
              }
            ]
          }
        ]
      }
    if (name === 'providers:choices') return []
    if (name === 'agent:chat-ui-answer') return answerChatUi(args[0], args[1], args[2])
    // The mocked provider receives what agent.ts sends: the context, then the user's text.
    if (name === 'agent:send') prompts.push(chatUiContext(args[2]) + args[0])
    return { ok: true }
  },
  render: () => {},
  effect: () => {}
})
await controller.command({
  type: 'context',
  context: {
    chat: CHAT,
    root: '/fixture',
    selection: null,
    turn: {},
    setup: { needed: false, dismissed: false, status: null },
    tokens: { needed: false, dismissed: false },
    notes: [],
    spawns: []
  }
})
const chat = controller.get(CHAT)
controller.event({ type: 'delta', text: 'Here are three directions.', projectKey: CHAT })
controller.event(events[0])
const streaming = chat.messages.find((m) => m.id === chat.streamingId)
assert.deepEqual(
  streaming.segments.map((s) => s.kind),
  ['text', 'ui'],
  'the component sits where it was shown, mid-turn'
)
controller.event(events[2])
assert.equal(streaming.segments.length, 2, 'an update replaces the segment in place')
assert.deepEqual(Object.keys(streaming.segments[1].ui.images).sort(), ['a', 'b'])

await controller.action({
  chat: CHAT,
  action: 'chat-ui',
  id,
  value: JSON.stringify({ choice: 'b', comment: 'Tighter gap' })
})
await tick()
const sent = calls.filter((c) => c[0] === 'agent:send')
assert.equal(sent.length, 1)
assert.equal(sent[0][1], 'Picked option A: Split hero. Tighter gap')
assert.equal(chat.messages.filter((m) => m.role === 'user').at(-1).text, sent[0][1])
assert.equal(streaming.segments[1].ui.answer.choice, 'b', 'the chat shows the pick')
assert.match(
  prompts[0],
  /^Answer components in this chat \(chat_ui\):\n- "Hero directions" \(chat_ui options ui-[0-9a-f]+\): User picked option A: Split hero \(id "b"\) and commented: "Tighter gap"\. Apply this variant\./
)
assert.equal(transcript[0].ui.answer.comment, 'Tighter gap', 'the answer is saved with the message')
assert.match(answerChatUi(CHAT, id, { choice: 'd' }).error, /already answered/)
assert.match(
  (await chatUiTool({ action: 'update', id, option: 'b' }, scope)).error,
  /already answered/
)

// A form submit: one structured user turn; the next turn summarizes its values once.
controller.event({ type: 'done', projectKey: CHAT })
await tick()
await controller.action({
  chat: CHAT,
  action: 'chat-ui',
  id: formId,
  value: JSON.stringify({
    values: { density: 'airy', radius: 12, gap: 24, accent: '#0a84ff', shadow: true }
  })
})
await tick()
const formTurn = calls.filter((c) => c[0] === 'agent:send').at(-1)[1]
assert.equal(
  formTurn,
  'Card details\n- Density: airy\n- Radius: 12 px\n- Gap: 24\n- Accent: #0a84ff\n- Shadow: on'
)
assert.match(
  prompts.at(-1),
  /the user submitted \{"density":"airy","radius":12,"gap":24,"accent":"#0a84ff","shadow":true\}/
)
assert.doesNotMatch(prompts.at(-1), /Hero directions/, 'an answer is summarized once')
assert.equal(chatUiContext(CHAT), '')

// A bad answer from the UI is an error on the chat, never a turn.
const before = calls.filter((c) => c[0] === 'agent:send').length
await controller.action({ chat: CHAT, action: 'chat-ui', id: formId, value: '{"values":{}}' })
assert.match(chat.error, /already answered/)
assert.equal(calls.filter((c) => c[0] === 'agent:send').length, before)

// --- a resumed chat rebuilds the components from its transcript --------------------------
const resumed = newChat(CHAT)
hydrate(resumed, [
  { role: 'user', text: 'Explore heroes', at: 1 },
  { role: 'assistant', text: 'Options:', at: 2 },
  ...transcript
])
assert.deepEqual(
  resumed.messages.map((m) => m.segments.map((s) => s.kind)),
  [['text'], ['text', 'ui', 'ui']]
)
assert.equal(resumed.messages[1].segments[1].ui.answer.choice, 'b')

// --- the rules are generated from the catalog -------------------------------------------
const rules = treziRules({ controlTools: true })
for (const entry of chatUiCatalog) {
  assert.ok(rules.includes(`- ${entry.kind} (${entry.title}). Use when: ${entry.when}`), entry.kind)
  assert.ok(rules.includes(entry.limits), `${entry.kind} limits`)
}
console.log('chat-ui: OK')
