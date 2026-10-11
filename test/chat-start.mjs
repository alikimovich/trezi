// LKM-232 centered start composer, on the real native chat controller with fixture
// services (no provider, no network, no keychain): readiness comes from a scripted
// `providers:check-login`, sends are recorded, never delivered.
// - off until the app opts in; zero providers shows LKM-231's sign-in actions under the
//   centered composer; Claude alone or Codex alone unlocks it;
// - the no-project draft: an empty send stays put, a real one waits for a project
//   (Open/New/Cancel), its model pick is kept locally (no session restart);
// - the project's new chat receives the draft, attachments and model, and sends it
//   exactly once; the chat then leaves the centered layout;
// - a chat with history is never centered; a draft carried into one starts a new chat;
// - losing the selected provider keeps the draft and offers sign-in or the other one;
// - an auth error on a turn marks that seat signed out;
// - the new-project sheet's planning text goes ahead of the carried draft.
import assert from 'node:assert/strict'
import { NativeChatController } from '../src/native/chat-controller.ts'
import { HOME, START_HEADING, usableProviders } from '../src/native/chat-start.ts'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
async function until(check, label) {
  for (let i = 0; i < 400; i++) {
    if (check()) return
    await tick()
  }
  throw new Error(`Timed out: ${label}`)
}
const calls = [],
  renders = [],
  effects = []
const login = { claude: false, codex: false }
const transcripts = {}
const live = (chat) => ({
  sessionKey: chat,
  record: { transcript: transcripts[chat] ?? [], title: 'New chat' },
  isRunning: false,
  options: { provider: 'codex', model: 'codex:default', permissionMode: 'auto' }
})
const keys = ['p1', 'p2', 'p3', 'p4']
const context = (chat, root = '/fixture') => ({
  chat,
  root,
  selection: null,
  turn: {},
  setup: { needed: false, dismissed: false, status: null },
  tokens: { needed: false, dismissed: false },
  notes: [],
  spawns: []
})
const choices = [
  {
    value: 'claude:sonnet',
    modelId: 'sonnet',
    provider: 'claude',
    group: 'Claude',
    label: 'Sonnet'
  },
  {
    value: 'codex:default',
    modelId: 'default',
    provider: 'codex',
    group: 'Codex',
    label: 'Default'
  },
  { value: 'codex:other', modelId: 'other', provider: 'codex', group: 'Codex', label: 'Other' }
]
const controller = new NativeChatController({
  invoke: async (channel, ...args) => {
    calls.push([channel, ...args])
    if (channel === 'agent:workspace-snapshot')
      return { projects: [{ root: '/fixture', chats: keys.map(live) }] }
    if (channel === 'providers:choices') return choices
    if (channel === 'providers:check-login') return { loggedIn: login[args[0]] }
    return { ok: true }
  },
  render: (state) => renders.push(structuredClone(state)),
  effect: (effect) => effects.push(structuredClone(effect))
})
let project = null
controller.start.workspace = {
  project: () => project,
  recents: () => [{ root: '/fixture', name: 'Fixture' }],
  busy: () => '',
  preferred: () => ({
    provider: 'codex',
    model: 'codex:default',
    modelId: 'default',
    permissionMode: 'auto'
  })
}
const last = () => renders.at(-1)
const sends = () => calls.filter((c) => c[0] === 'agent:send')
let rev = 0
const input = (text, chat = controller.active) =>
  controller.composer({ chat, action: 'input', text, caret: text.length, revision: ++rev })
const send = (chat = controller.active) => controller.composer({ chat, action: 'send' })
const act = (action, value) =>
  controller.action({ chat: controller.active, action, ...(value ? { value } : {}) })
const settled = () =>
  until(
    () =>
      controller.readiness.claude.status !== 'checking' &&
      controller.readiness.codex.status !== 'checking',
    'readiness'
  )

await controller.refreshChoices()
// Off until the app (or a smoke check) opts in: the smoke suite keeps its layout.
assert.equal(controller.active, HOME)
assert.equal(last().start.centered, false, 'Start layout is off until enabled')

// Zero providers: centered, with LKM-231's sign-in actions under the composer.
controller.checkReadiness()
assert.equal(last().start.centered, true, 'The no-project chat centers at once')
assert.equal(last().start.notice.text, 'Checking provider sign-in…')
await settled()
let start = last().start
assert.equal(start.heading, START_HEADING)
assert.equal(start.home, true)
assert.equal(start.project.title, null)
assert.deepEqual(start.project.recents, [{ root: '/fixture', name: 'Fixture' }])
assert.equal(start.notice.text, 'Sign in to either provider to start chatting.')
const signIns = start.notice.actions.map((a) => a.action)
assert.ok(
  signIns.includes('sign-in-claude') && signIns.includes('sign-in-codex'),
  JSON.stringify(signIns)
)
assert.equal(usableProviders(choices, controller.readiness).length, 0)
assert.equal(start.ready, false)
await input('Not yet')
assert.equal(last().composer.enabled, false, 'No provider: Send is disabled, typing is not')
await send()
assert.equal(controller.start.pending, false, 'No provider: the draft stays a draft')
assert.equal(controller.get(HOME).text, 'Not yet')
await input('')

// Either seat alone unlocks it (the draft takes that seat); a saved connection would too.
for (const seat of ['claude', 'codex']) {
  login.claude = seat === 'claude'
  login.codex = seat === 'codex'
  await controller.refreshReadiness()
  assert.deepEqual(
    usableProviders(choices, controller.readiness).map((p) => p.key),
    [seat]
  )
  assert.equal(last().start.centered, true)
  assert.equal(last().start.ready, true, `${seat} alone unlocks the composer`)
  assert.equal(last().start.notice, undefined)
  assert.equal(controller.get(HOME).settings.provider, seat)
}
assert.deepEqual(
  usableProviders(
    [
      ...choices,
      {
        value: 'conn:x:m',
        modelId: 'm',
        provider: 'claude',
        connectionId: 'x',
        group: 'Gateway',
        label: 'M'
      }
    ],
    { claude: { status: 'signed_out' }, codex: { status: 'signed_out' } }
  ).map((p) => p.key),
  ['conn:x'],
  'A custom connection is usable without a seat'
)
login.claude = true
await controller.refreshReadiness()
assert.equal(controller.get(HOME).settings.provider, 'codex', 'The preferred seat once it is ready')

// The no-project draft: empty send stays centered, a real one waits for a project.
await send()
assert.equal(controller.start.pending, false, 'An empty send does nothing')
await input('Make a landing page')
await controller.composer({
  chat: HOME,
  action: 'files',
  files: [{ name: 'brief.txt', path: '/tmp/brief.txt', type: 'text/plain' }]
})
await controller.composer({ chat: HOME, action: 'choice', label: 'Model', value: 'codex:other' })
assert.equal(controller.get(HOME).settings.model, 'codex:other')
assert.equal(calls.filter((c) => c[0] === 'agent:restart-chat').length, 0, 'No session to restart')
await send()
assert.equal(controller.start.pending, true)
assert.equal(sends().length, 0, 'Nothing is sent without a project')
assert.equal(last().start.centered, true)
assert.deepEqual(
  last().start.notice.actions.map((a) => a.action),
  ['start-open', 'start-new', 'start-cancel']
)
await act('start-cancel')
assert.equal(controller.start.pending, false, 'Cancel forgets the send')
assert.equal(controller.get(HOME).text, 'Make a landing page', 'Cancel keeps the draft')
await send()
await act('start-open')
assert.deepEqual(effects.at(-1), { type: 'start-project' })
assert.equal(controller.start.carry, HOME)

// The project opens with its new chat: the draft, attachment and model arrive; one send.
project = 'Fixture'
await controller.command({ type: 'context', context: context('p1') })
await until(() => sends().length === 1, 'the carried send')
await tick()
assert.equal(sends().length, 1, 'The first prompt is sent exactly once')
const restart = calls.find((c) => c[0] === 'agent:restart-chat')
assert.equal(restart?.[2], 'p1', 'The picked model is applied to the new chat')
assert.equal(controller.get('p1').settings.model, 'codex:other')
const p1 = controller.get('p1')
assert.deepEqual(
  p1.messages.filter((m) => m.role === 'user').map((m) => m.text),
  ['Make a landing page']
)
assert.equal(
  p1.messages.find((m) => m.role === 'user').attachments?.length ??
    sends()[0]
      .flat()
      .filter((a) => a?.name === 'brief.txt').length,
  1
)
assert.equal(controller.get(HOME).text, '', 'The no-project draft is moved, not copied')
assert.equal(controller.get(HOME).attachments.length, 0)
assert.equal(controller.start.pending, false)
assert.equal(last().chat, 'p1')
assert.equal(last().start.centered, false, 'The chat docks left once its message is sent')
await controller.command({ type: 'context', context: context('p1') })
await tick()
assert.equal(sends().length, 1, 'Re-selecting the chat sends nothing again')

// An auth error on a turn: that seat is signed out for the start screen.
controller.event({ projectKey: 'p1', type: 'error', code: 'auth', message: 'Not logged in' })
assert.equal(controller.readiness.codex.status, 'signed_out')
login.codex = true
await controller.refreshReadiness()

// A new, empty chat in the project centers; the project is named in its menu.
await controller.command({ type: 'context', context: context('p2') })
assert.equal(last().start.centered, true)
assert.equal(last().start.home, false)
assert.equal(last().start.project.title, 'Fixture')

// Losing the selected provider keeps the draft and offers sign-in or the other seat.
await input('Keep me')
login.codex = false
login.claude = true
await controller.refreshReadiness()
start = last().start
assert.equal(start.centered, true, 'Another provider can still answer')
assert.equal(start.notice.text, 'Codex is not signed in. Your draft is kept.')
assert.deepEqual(
  start.notice.actions.map((a) => [a.action, a.value]),
  [
    ['sign-in-codex', undefined],
    ['start-provider', 'claude']
  ]
)
assert.equal(start.ready, false)
await send()
assert.equal(sends().length, 1, 'A lost provider never sends the draft')
assert.equal(controller.get('p2').text, 'Keep me')
await act('start-provider', 'claude')
assert.equal(controller.get('p2').settings.provider, 'claude')
assert.equal(controller.get('p2').text, 'Keep me')
assert.equal(last().start.notice, undefined)
// Losing every provider: the project's new chat shows LKM-231's card in the left layout.
login.claude = false
await controller.refreshReadiness()
assert.equal(last().start.centered, false)
assert.ok(
  last().cards.some((c) => c.id === 'provider-start'),
  'The in-chat provider card shows'
)
login.claude = true
login.codex = true
await controller.refreshReadiness()

// A chat with history is never centered; a draft carried into it starts a new chat.
controller.start.carry = 'p2'
await controller.command({ type: 'context', context: context('p1') })
assert.equal(last().start.centered, false)
await until(() => effects.at(-1)?.type === 'start-chat', 'a new chat for the carried draft')
assert.deepEqual(effects.at(-1), { type: 'start-chat', root: '/fixture' })
await controller.command({ type: 'context', context: context('p3') })
assert.equal(controller.get('p3').text, 'Keep me', 'The draft follows into the new chat')
assert.equal(controller.get('p1').text, '', 'The conversation keeps no copy')
assert.equal(sends().length, 1, 'A carried draft without a send is not sent')

// New project: the sheet's planning text goes ahead of the carried draft, sent once.
controller.start.carry = 'p3'
controller.start.prefix = { text: 'Let’s plan a new Svelte project.', send: true }
await controller.command({ type: 'context', context: context('p4') })
await until(() => sends().length === 2, 'the planning send')
assert.deepEqual(
  controller
    .get('p4')
    .messages.filter((m) => m.role === 'user')
    .map((m) => m.text),
  ['Let’s plan a new Svelte project.\n\nKeep me']
)
await tick()
assert.equal(sends().length, 2)
console.log('chat-start: ok')
