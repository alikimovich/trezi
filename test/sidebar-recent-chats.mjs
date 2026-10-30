// LKM-378: the selected project's chats nested in the native sidebar. Bun picks the rows
// (scoping, every open chat, closed chats with their age, archive, running state, order); switching goes through the real chat
// controller, which keeps drafts, attachments and running turns per chat.
import assert from 'node:assert/strict'
import { NativeChatController } from '../src/native/chat-controller.ts'
import { NativeShellController } from '../src/native/shell-controller.ts'
import { recentChats, shortAgo } from '../src/native/sidebar-chats.ts'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// --- The pure pick: every open chat, newest opened first ----------------------------------
assert.deepEqual(recentChats([]), [], '0 chats')
assert.deepEqual(recentChats(['a']), ['a'], '1 chat')
const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
assert.deepEqual(
  recentChats(seven),
  ['g', 'f', 'e', 'd', 'c', 'b', 'a'],
  'no cap: archiving keeps it short'
)
assert.deepEqual(recentChats(['a', 'b', 'a']), ['b', 'a'], 'dedup')

// --- A closed chat's age, as the Electron rail showed it -----------------------------------
const now = Date.UTC(2026, 9, 29)
const ago = (seconds) => shortAgo(now - seconds * 1000, now)
assert.deepEqual(
  [
    ago(-5),
    ago(30),
    ago(5 * 60),
    ago(3 * 3600),
    ago(2 * 86400),
    ago(120 * 86400),
    ago(400 * 86400)
  ],
  ['now', 'now', '5m', '3h', '2d', '4mo', '1y']
)

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

// Counts: 0, 1, 5 and more than 5: every open chat is listed.
assert.deepEqual(nested('alpha'), [])
alpha.sessionKeys = ['a']
assert.deepEqual(nested('alpha'), ['a'])
alpha.sessionKeys = ['a', 'b', 'c', 'd', 'e']
assert.deepEqual(nested('alpha'), ['e', 'd', 'c', 'b', 'a'])
alpha.sessionKeys.push('f')
assert.deepEqual(nested('alpha'), ['f', 'e', 'd', 'c', 'b', 'a'], 'more than five: all listed')
alpha.activeSessionKey = 'f'
assert.equal(project('alpha').children.length, 6, 'children list every open chat')
for (const row of project('alpha').recent)
  assert.deepEqual([row.kind, row.id, row.project], ['chat', `chat:${row.session}`, 'alpha'])

// Scoping: only the selected project nests chats; switching projects moves the list.
assert.equal(project('beta').recent, undefined, 'other projects stay compact')
workspace.active = beta
assert.equal(project('alpha').recent, undefined, 'the list leaves the old project')
assert.deepEqual(nested('beta'), ['z'], 'and moves to the selected one')
workspace.active = alpha

// Archive (close chat) and unarchive (resume adds a new open chat) update the list. A closed
// chat is a history child of the project row: Swift nests those under its History section.
alpha.sessionKeys = alpha.sessionKeys.filter((key) => key !== 'f')
alpha.activeSessionKey = 'e'
workspace.state.history.alpha = [
  { id: 'old', title: 'Old chat', startedAt: Date.now() - 3 * 86400 * 1000, transcript: [] }
]
assert.deepEqual(nested('alpha'), ['e', 'd', 'c', 'b', 'a'])
const past = project('alpha').children.filter((row) => row.kind === 'history')
assert.deepEqual(
  past.map((row) => [row.id, row.title, row.detail]),
  [['history:old', 'Old chat', '3d']],
  'a closed chat carries its age for the History row'
)
alpha.sessionKeys.push('r')
assert.deepEqual(nested('alpha'), ['r', 'e', 'd', 'c', 'b', 'a'])
workspace.state.history = {}
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
  'Sidebar chats: scoping, every open chat, history age, archive, running state, stable order and draft-preserving switches passed'
)
