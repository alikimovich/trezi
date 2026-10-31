// LKM-389: the sidebar title's shimmer follows a chat's real state through the real
// controllers. Approval and question waits and Stop change `chatThinking` but not the chat
// mirror, so each must still schedule a shell render carrying the right `thinking`.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { NativeChatController } from '../src/native/chat-controller.ts'
import { NativeShellController } from '../src/native/shell-controller.ts'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sent = []
const projectEntry = {
  key: 'p',
  root: '/p',
  name: 'Project',
  url: 'http://127.0.0.1:7784/',
  activeSessionKey: 'a',
  sessionKeys: ['a', 'b'],
  previewKind: 'web'
}
const workspace = {
  active: projectEntry,
  state: {
    projects: [projectEntry],
    status: { kind: 'running' },
    loadedKey: 'p',
    recents: [],
    history: {}
  },
  services: { invoke: async () => ({}) },
  changed() {}
}
const chats = new NativeChatController({
  invoke: async (channel) => (channel === 'agent:turn-state' ? { running: true, turn: 't' } : {}),
  render: () => {},
  effect: (effect) => shell.chatEffect(effect)
})
const values = new Map()
const shell = new NativeShellController(
  workspace,
  chats,
  { mode: 'merge', decorate: (state) => state },
  { get: (key) => values.get(key), set: (key, value) => values.set(key, value) },
  (state) => sent.push(state),
  () => {}
)
chats.active = 'a'

const rowOf = (key) => sent.at(-1).rows[0].children.find((row) => row.id === `chat:${key}`)
/** Runs `step`, lets the shell's scheduled render happen and returns what it sent. */
async function renders(step) {
  const before = sent.length
  await step()
  await sleep(60)
  return sent.length - before
}

for (const key of ['a', 'b']) {
  const chat = chats.get(key)
  const where = `${key === chats.active ? 'active' : 'background'} chat ${key}`
  const expect = async (name, step, thinking, running = true) => {
    const count = await renders(step)
    assert.ok(count > 0, `${where}: ${name} renders the shell`)
    assert.equal(rowOf(key).thinking, thinking, `${where}: ${name} thinking`)
    assert.equal(rowOf(key).running, running, `${where}: ${name} running`)
  }
  const event = (type, fields) => chats.event({ type, projectKey: key, ...fields })

  await expect(
    'a turn at work',
    () => {
      chat.isRunning = true
      chat.phase = 'thinking'
      chat.turn = 't'
      chats.changed(chat)
    },
    true
  )
  await expect(
    'an approval request',
    () => event('permission-request', { request: { id: 'perm', sessionKey: key } }),
    false
  )
  await expect('the approval resolved', () => event('permission-resolved', { id: 'perm' }), true)
  await expect(
    'a question request',
    () => event('question-request', { request: { id: 'ask', sessionKey: key } }),
    false
  )
  await expect('the question resolved', () => event('question-resolved', { id: 'ask' }), true)
  // Both waits at once: answering one leaves the turn waiting on the other.
  await expect(
    'two waits',
    () => {
      event('permission-request', { request: { id: 'perm', sessionKey: key } })
      event('question-request', { request: { id: 'ask', sessionKey: key } })
    },
    false
  )
  assert.equal(
    await renders(() => event('permission-resolved', { id: 'perm' })),
    0,
    `${where}: one wait left changes nothing the row shows`
  )
  assert.equal(rowOf(key).thinking, false, `${where}: one wait left is still waiting`)
  await expect('no wait left', () => event('question-resolved', { id: 'ask' }), true)
  await expect('Stop', () => chats.stop(chat), false)
  assert.equal(chat.stopping, true, `${where} is stopping`)

  // A step that changes nothing the row shows renders nothing.
  assert.equal(await renders(() => chats.changed(chat)), 0, `${where}: no news, no render`)
}

// A chat that stops being at work (the turn ends) loses the shimmer, and a closed chat does
// not carry its state to a new one with the same key.
const done = chats.get('b')
done.stopping = false
done.isRunning = false
await renders(() => chats.changed(done))
assert.equal(rowOf('b').thinking, false, 'a finished turn does not shimmer')
assert.equal(rowOf('b').running, false)
chats.close('b')
const reopened = chats.get('b')
reopened.isRunning = true
reopened.phase = 'thinking'
assert.ok(await renders(() => chats.changed(reopened)), 'a reopened chat tells the shell')
assert.equal(rowOf('b').thinking, true, 'a reopened chat at work shimmers')

// LKM-392: the steps of the `native-chat` smoke's landing. A `done` the controller alone hears
// holds the landing, the provider's own `done` keeps it, and only `landing-finished` ends it.
const lands = chats.get('a')
lands.stopping = false
lands.turn = 't'
await renders(() => chats.changed(lands))
assert.equal(rowOf('a').thinking, true, 'a turn at work before it lands')
const landingEvent = (type, fields) => chats.event({ type, projectKey: 'a', ...fields })
assert.ok(
  await renders(() => landingEvent('done', { landingPending: true })),
  'a landing tells the shell'
)
const landing = (name) => {
  assert.equal(rowOf('a').thinking, false, `${name}: no shimmer while it lands`)
  assert.equal(rowOf('a').running, true, `${name}: still Running while it lands`)
}
landing('held')
await renders(() => landingEvent('done', { landingPending: true, turn: 't' }))
landing('the provider done')
await renders(() => landingEvent('landing-finished', { turn: 't' }))
assert.equal(rowOf('a').running, false, 'the landing finishing ends the turn')

// The real landing ends by itself, so the smoke must check the landing row before it starts
// that landing, and leaves ending it to the landing.
const smokeChat = readFileSync(new URL('../src/native/smoke-chat.ts', import.meta.url), 'utf8')
const landingSteps = [
  "nativeChat.event({ type: 'done', projectKey: state.chat, landingPending: true })",
  "await runningWithoutShimmer('while it lands')",
  "send({ type: 'done', landingPending: true })"
].map((step) => smokeChat.indexOf(step))
assert.ok(
  landingSteps.every((at, index) => at >= 0 && (index === 0 || at > landingSteps[index - 1])),
  `the smoke holds the landing, checks the row, then lands: ${landingSteps}`
)
assert.ok(
  !smokeChat.includes("send({ type: 'landing-finished' })"),
  'the real landing, not the smoke, ends the turn'
)

// The app wires every chat effect to the shell through `chatEffect`.
assert.match(
  readFileSync(new URL('../src/native/index.ts', import.meta.url), 'utf8'),
  /renderChatEffect\(effect\)\n\s+shellController!\.chatEffect\(effect\)/
)

console.log('SIDEBAR-THINKING-RENDER PASS — approval, question, Stop and finish render the row')
