// LKM-233: home and the app-managed planning conversation, with stubbed provider IPC.
import assert from 'node:assert/strict'
import { NativeChatController } from '../src/native/chat-controller.ts'
import { HOME, START_HEADING, usableProviders } from '../src/native/chat-start.ts'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
async function until(check, label) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await tick()
  }
  throw new Error(`Timed out: ${label}`)
}
const calls = [],
  renders = [],
  effects = []
const login = { claude: false, codex: false }
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
const plan = {
  id: 'plan-one',
  projectKey: '__trezi_new_project__',
  projectRoot: '',
  transcript: [],
  planning: { options: { provider: 'codex', model: 'default' } }
}
const question = {
  id: 'question-one',
  at: Date.now(),
  images: {},
  component: {
    kind: 'options',
    title: 'Compare what?',
    options: [{ id: 'plans', title: 'Three plans', note: '' }]
  }
}
let sends = 0
const controller = new NativeChatController({
  invoke: async (channel, ...args) => {
    calls.push([channel, ...args])
    if (channel === 'providers:choices') return choices
    if (channel === 'providers:check-login') return { loggedIn: login[args[0]] }
    if (channel === 'planning:start') {
      plan.planning.settings = args[0]
      return plan
    }
    if (channel === 'planning:resume') return plan
    if (channel === 'planning:send') {
      sends++
      plan.transcript.push({
        role: 'user',
        text: args[2],
        at: Date.now(),
        planningAttachments: args[4]
      })
      plan.transcript.push({ role: 'assistant', text: 'What should it do?', at: Date.now() })
      if (sends === 1)
        plan.transcript.push({ role: 'assistant', text: '', at: Date.now(), ui: question })
      return { record: plan }
    }
    if (channel === 'agent:chat-ui-answer')
      return { record: { ...question, answer: args[2] }, message: 'Picked Three plans' }
    if (channel === 'agent:workspace-snapshot')
      return {
        projects: [
          {
            root: '/fixture',
            chats: [
              {
                sessionKey: 'project-chat',
                record: { transcript: [] },
                isRunning: false,
                options: { provider: 'codex', model: 'codex:default', permissionMode: 'auto' }
              }
            ]
          }
        ]
      }
    return { ok: true }
  },
  render: (state) => renders.push(structuredClone(state)),
  effect: (effect) => effects.push(structuredClone(effect))
})
controller.start.workspace = {
  project: () => null,
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
let revision = 0
const input = (text, chat = controller.active) =>
  controller.composer({ chat, action: 'input', text, caret: text.length, revision: ++revision })

await controller.refreshChoices()
assert.equal(controller.active, HOME)
assert.equal(last().start.centered, false)
controller.checkReadiness()
assert.equal(last().start.centered, true)
assert.equal(last().start.notice.text, 'Checking provider sign-in…')
await until(
  () => login.claude === false && controller.readiness.claude.status !== 'checking',
  'readiness'
)
assert.equal(last().start.heading, START_HEADING)
assert.equal(last().start.home, true)
assert.equal(last().start.project.title, null)
assert.deepEqual(last().start.project.recents, [{ root: '/fixture', name: 'Fixture' }])
assert.equal(last().start.ready, false)
assert.equal(usableProviders(choices, controller.readiness).length, 0)

login.codex = true
await controller.refreshReadiness()
assert.equal(last().start.ready, true)
assert.equal(last().composer.enabled, false, 'An empty prompt cannot send')
const effectsBeforePicker = effects.length
await controller.action({ chat: HOME, action: 'start-target', value: '/fixture' })
assert.equal(last().start.project.title, 'Fixture')
assert.equal(effects.length, effectsBeforePicker, 'Selecting a draft target opens nothing')
await input('Keep this draft')
await controller.action({ chat: HOME, action: 'start-target-new' })
assert.equal(last().start.project.title, null)
assert.equal(controller.get(HOME).text, 'Keep this draft')
await controller.action({ chat: HOME, action: 'start-recent', value: '/fixture' })
assert.equal(effects.at(-1).type, 'start-project', 'The bottom recent navigates directly')
assert.equal(controller.start.pending, false, 'Direct navigation never submits the draft')
assert.equal(controller.get(HOME).text, 'Keep this draft')
await controller.action({ chat: HOME, action: 'start-open' })
assert.equal(effects.at(-1).type, 'start-project', 'Standalone Open Project navigates')
assert.equal(controller.get(HOME).text, 'Keep this draft')
await input('Build a pricing page')
await controller.composer({
  chat: HOME,
  action: 'files',
  files: [{ name: 'brief.txt', path: '/tmp/brief.txt', type: 'text/plain' }]
})
await controller.composer({ chat: HOME, action: 'choice', label: 'Model', value: 'codex:other' })
await controller.composer({ chat: HOME, action: 'send' })
await until(() => sends === 1, 'one planning send')
assert.equal(controller.active, plan.id)
assert.equal(last().start.planning, true)
assert.equal(last().start.centered, false)
assert.equal(controller.get(plan.id).settings.model, 'codex:other')
assert.equal(controller.get(plan.id).messages[0].text, 'Build a pricing page')
assert.equal(controller.get(plan.id).messages[0].attachments.length, 1)
assert.equal(controller.get(HOME).text, '')
assert.equal(controller.get(HOME).attachments.length, 0)
assert.equal(
  calls.some(([channel]) => channel === 'project:create' || channel === 'project:pick-new'),
  false
)
assert.equal(
  last().cards.some((card) => card.id === 'planning'),
  true
)
await controller.composer({ chat: plan.id, action: 'send' })
assert.equal(sends, 1, 'An empty duplicate send has no effect')
await controller.action({
  chat: plan.id,
  action: 'chat-ui',
  id: question.id,
  value: JSON.stringify({ choice: 'plans' })
})
await until(() => sends === 2, 'the native quick pick is a planning turn')
assert.equal(
  calls.some(([channel]) => channel === 'agent:send'),
  false
)
await controller.action({ chat: plan.id, action: 'planning-cancel' })
assert.equal(controller.active, HOME)
assert.equal(controller.start.planningKey, null)

// An empty restored project conversation retains its ordinary docked layout.
await controller.command({
  type: 'context',
  context: {
    chat: 'project-chat',
    root: '/fixture',
    selection: null,
    turn: {},
    setup: { needed: false, dismissed: false, status: null },
    tokens: { needed: false, dismissed: false },
    notes: [],
    spawns: []
  }
})
assert.equal(last().start.centered, false)
assert.equal(last().start.home, false)

// An ordinary project chat is never held by the start gate, whatever the sign-in state:
// its send reaches the provider path (and its own sign-in card), it is not dropped.
for (const status of ['signed_out', 'checking']) {
  if (status === 'signed_out') {
    login.codex = false
    await controller.refreshReadiness()
    assert.equal(controller.readiness.codex.status, 'signed_out')
  } else controller.readiness.codex = { status: 'checking' }
  assert.equal(controller.start.enabled, true)
  const project = controller.get('project-chat')
  assert.equal(controller.start.holds(controller, project), false, `${status}: not held`)
  // The first turn keeps the stub chat running, so the second is queued, not sent.
  const handled = () =>
    calls.filter(([channel]) => channel === 'agent:send').length + project.queue.length
  const before = handled()
  await input(`Edit the hero (${status})`, 'project-chat')
  await controller.composer({ chat: 'project-chat', action: 'send' })
  await until(() => handled() === before + 1, `${status}: the project chat send is not dropped`)
  assert.equal(project.text, '', `${status}: the draft was submitted`)
}
console.log('chat-start: ok')
