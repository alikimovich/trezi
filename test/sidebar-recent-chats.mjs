// LKM-378: the selected project's recent chats nested in the native sidebar. Bun picks the
// rows (scoping, count, archive, running state, order); switching goes through the real chat
// controller, which keeps drafts, attachments and running turns per chat.
import assert from 'node:assert/strict'
import { NativeChatController } from '../src/native/chat-controller.ts'
import { NativeShellController } from '../src/native/shell-controller.ts'
import { RECENT_CHAT_LIMIT, recentChats } from '../src/native/sidebar-chats.ts'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// --- The pure pick: newest opened first, at most five, the active chat always kept --------
assert.equal(RECENT_CHAT_LIMIT, 5)
assert.deepEqual(recentChats([], null), { keys: [], more: false }, '0 chats')
assert.deepEqual(recentChats(['a'], 'a'), { keys: ['a'], more: false }, '1 chat')
const five = ['a', 'b', 'c', 'd', 'e']
assert.deepEqual(recentChats(five, 'c'), { keys: ['e', 'd', 'c', 'b', 'a'], more: false }, '5')
const seven = [...five, 'f', 'g']
assert.deepEqual(recentChats(seven, 'g'), { keys: ['g', 'f', 'e', 'd', 'c'], more: true }, '>5')
assert.deepEqual(
  recentChats(seven, 'a'),
  { keys: ['g', 'f', 'e', 'd', 'a'], more: true },
  'an older active chat takes the last slot, so the selected row is always visible'
)
assert.deepEqual(recentChats(seven, 'missing').keys, ['g', 'f', 'e', 'd', 'c'])
assert.deepEqual(recentChats(['a', 'b', 'a'], 'a'), { keys: ['b', 'a'], more: false }, 'dedup')

// --- The shell rows, from the real chat controller ----------------------------------------
const live = (key) => ({
  sessionKey: key,
  record: { transcript: [], title: `Chat ${key}` },
  isRunning: false,
  options: { provider: 'codex', permissionMode: 'auto' }
})
const calls = []
const chat = new NativeChatController({
  invoke: async (channel, ...args) => {
    calls.push([channel, ...args])
    if (channel === 'agent:workspace-snapshot')
      return { projects: [{ root: '/alpha', chats: ['a', 'b', 'c'].map(live) }] }
    if (channel === 'agent:turn-state') return { turn: {}, running: false }
    if (channel === 'providers:choices')
      return [
        {
          value: 'codex:default',
          modelId: 'default',
          provider: 'codex',
          group: 'Codex',
          label: 'Default'
        }
      ]
    if (channel === 'attachments:save') return '/tmp/sidebar-chat.png'
    return { ok: true }
  },
  render: () => {},
  effect: () => {}
})
await chat.refreshChoices()
const context = (key) => ({
  chat: key,
  root: '/alpha',
  selection: null,
  turn: {},
  setup: { needed: false, dismissed: false, status: null },
  tokens: { needed: false, dismissed: false },
  notes: [],
  spawns: []
})
const alpha = {
  key: 'alpha',
  root: '/alpha',
  name: 'Alpha',
  activeSessionKey: 'a',
  sessionKeys: []
}
const beta = { key: 'beta', root: '/beta', name: 'Beta', activeSessionKey: 'z', sessionKeys: ['z'] }
const workspace = {
  active: alpha,
  state: {
    projects: [alpha, beta],
    status: { kind: 'running' },
    loadedKey: 'alpha',
    recents: [],
    history: {},
    selection: 0
  },
  services: { invoke: async () => ({}) },
  changed() {}
}
const renders = []
const shell = new NativeShellController(
  workspace,
  chat,
  { mode: 'merge', decorate: (s) => s },
  { get: () => undefined, set: async () => {} },
  (s) => renders.push(s),
  () => {}
)
const project = (key) => {
  shell.render()
  return renders.at(-1).rows.find((row) => row.project === key)
}
const nested = (key) => project(key).recent?.map((row) => row.session)

// Counts: 0, 1, 5 and more than 5.
assert.deepEqual(nested('alpha'), [])
assert.equal(project('alpha').allChats, false)
alpha.sessionKeys = ['a']
assert.deepEqual(nested('alpha'), ['a'])
alpha.sessionKeys = ['a', 'b', 'c', 'd', 'e']
assert.deepEqual(nested('alpha'), ['e', 'd', 'c', 'b', 'a'])
assert.equal(project('alpha').allChats, false, 'exactly five: no "View all chats"')
alpha.sessionKeys.push('f')
assert.deepEqual(nested('alpha'), ['f', 'e', 'd', 'c', 'a'], 'the active chat a stays listed')
assert.equal(project('alpha').allChats, true, 'more than five: five rows and "View all chats"')
alpha.activeSessionKey = 'f'
assert.deepEqual(nested('alpha'), ['f', 'e', 'd', 'c', 'b'])
assert.equal(project('alpha').children.length, 6, 'the all-chats menu still lists every chat')
for (const row of project('alpha').recent)
  assert.deepEqual([row.kind, row.id, row.project], ['chat', `chat:${row.session}`, 'alpha'])

// Scoping: only the selected project nests chats; switching projects moves the list.
assert.equal(project('beta').recent, undefined, 'other projects stay compact')
workspace.active = beta
assert.equal(project('alpha').recent, undefined, 'the list leaves the old project')
assert.deepEqual(nested('beta'), ['z'], 'and moves to the selected one')
workspace.active = alpha

// Archive (close chat) and unarchive (resume adds a new open chat) update the list.
alpha.sessionKeys = alpha.sessionKeys.filter((key) => key !== 'f')
alpha.activeSessionKey = 'e'
assert.deepEqual(nested('alpha'), ['e', 'd', 'c', 'b', 'a'])
assert.equal(project('alpha').allChats, false)
alpha.sessionKeys.push('r')
assert.deepEqual(nested('alpha'), ['r', 'e', 'd', 'c', 'b'])
assert.equal(project('alpha').allChats, true)
alpha.sessionKeys = ['a', 'b', 'c']
alpha.activeSessionKey = 'a'

// Selection: the selected chat row is the active chat, through the workspace's one chat state.
shell.render()
assert.equal(renders.at(-1).selected, 'chat:a')
assert.ok(nested('alpha').includes('a'))

// Switching keeps drafts and attachments; a running chat keeps running and is marked.
let revision = 0
const show = async (key) => {
  alpha.activeSessionKey = key
  await chat.command({ type: 'context', context: context(key) })
  assert.equal(chat.active, key)
  assert.equal(project('alpha').recent.find((row) => row.session === key) !== undefined, true)
  assert.equal(renders.at(-1).selected, `chat:${key}`, 'the switched-to row is highlighted')
}
const type = (key, text) =>
  chat.composer({ chat: key, action: 'input', text, caret: text.length, revision: ++revision })
const emit = (key, event) => chat.event({ projectKey: key, ...event })
await show('a')
await type('a', 'Running prompt')
await chat.composer({ chat: 'a', action: 'send' })
await tick()
assert.equal(chat.get('a').isRunning, true)
const running = () =>
  Object.fromEntries(project('alpha').recent.map((row) => [row.session, row.running]))
assert.deepEqual(running(), { c: false, b: false, a: true }, 'the indicator follows the turn')
const order = nested('alpha')
emit('a', { type: 'delta', text: 'Streaming' })
emit('a', { type: 'status', text: 'Reading' })
emit('a', { type: 'delta', text: ' more' })
assert.deepEqual(nested('alpha'), order, 'order is stable while a response streams')
await show('b')
await type('b', 'Draft for b')
await chat.composer({
  chat: 'b',
  action: 'files',
  files: [{ name: 'shot.png', path: '', type: 'image/png', data: 'AA==' }]
})
await show('c')
await type('c', 'Draft for c')
for (let round = 0; round < 3; round++)
  for (const key of ['a', 'b', 'c']) {
    await show(key)
    assert.equal(chat.get('a').isRunning, true, 'the running chat keeps running across switches')
    assert.equal(chat.get('b').text, 'Draft for b')
    assert.deepEqual(
      chat.get('b').attachments.map((file) => file.name),
      ['shot.png']
    )
    assert.equal(chat.get('c').text, 'Draft for c')
  }
assert.deepEqual(nested('alpha'), order, 'switching chats does not reorder them')
assert.deepEqual(running(), { c: false, b: false, a: true })
emit('a', { type: 'done' })
await tick()
assert.equal(chat.get('a').isRunning, false)
assert.deepEqual(running(), { c: false, b: false, a: false }, 'the indicator clears when it ends')
assert.equal(calls.filter((call) => call[0] === 'agent:send').length, 1, 'switching sends nothing')

console.log(
  'Sidebar recent chats LKM-378: scoping, 0/1/5/>5 counts, archive, running state, stable order and draft-preserving switches passed'
)
