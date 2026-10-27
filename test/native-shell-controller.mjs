import assert from 'node:assert/strict'
import { NativeShellController } from '../src/native/shell-controller.ts'

const calls = [],
  renders = [],
  projections = [],
  values = new Map()
const active = {
  key: 'a',
  root: '/a',
  name: 'Project',
  url: 'http://127.0.0.1:7784/',
  activeSessionKey: 'a',
  sessionKeys: ['a'],
  previewKind: 'web'
}
const workspace = {
  active,
  state: {
    projects: [active],
    status: { kind: 'running' },
    loadedKey: 'a',
    recents: [],
    history: { a: [{ id: 'old', title: 'Older chat', transcript: [] }] }
  },
  services: {
    invoke: async (channel, ...args) => {
      calls.push([channel, ...args])
      return channel === 'project:icon' ? { dataUrl: 'icon' } : {}
    }
  },
  changed() {}
}
const chat = {
  chats: new Map([
    ['a', { title: 'Working chat', messages: [], isRunning: true, unreadAnswer: true }]
  ])
}
const shell = new NativeShellController(
  workspace,
  chat,
  { mode: 'merge', decorate: (s) => s },
  { get: (key) => values.get(key), set: (key, value) => values.set(key, value) },
  (s) => renders.push(s),
  (p) => projections.push(p)
)
shell.render()
assert.equal(renders.at(-1).rows[0].children[0].title, 'Working chat')
assert.deepEqual(
  [renders.at(-1).rows[0].children[0].running, renders.at(-1).rows[0].children[0].unread],
  [true, true],
  'Running and unread reach the native menu independently; the menu gives running precedence'
)
assert.equal(renders.at(-1).rows[0].children[1].title, 'Older chat')
assert.equal(renders.at(-1).chatReady, true)
// The initial open hides chat until the selected project is loaded.
workspace.state.loadedKey = null
workspace.state.status = { kind: 'busy', label: 'Opening Project…' }
shell.render()
assert.equal(renders.at(-1).chatReady, false)
assert.equal(renders.at(-1).previewReady, false, 'preview can be unavailable during project work')
assert.equal(renders.at(-1).project, 'a', 'Code still has an active source project')
workspace.state.loadedKey = 'a'
// Later in-project navigation/reload may be busy without hiding chat.
shell.render()
assert.equal(renders.at(-1).chatReady, true)
// An error reports truthfully and closes the gate until recovery.
workspace.state.status = { kind: 'error', message: 'The dev server exited' }
shell.render()
assert.equal(renders.at(-1).chatReady, false)
workspace.state.status = { kind: 'running' }
shell.render()
assert.equal(renders.at(-1).chatReady, true)
await shell.action({ action: 'device' })
assert.equal(active.viewport, 'mobile')
await shell.action({ action: 'expand' })
assert.equal(projections.at(-1).chatHidden, true)
assert.equal(values.get('trezi:chat-hidden'), '1')
assert.equal(chat.chatHidden, true, 'The chat controller learns the column is hidden')
await shell.action({ action: 'address', value: '/about' })
assert.deepEqual(calls.at(-1), ['preview:load', 'http://127.0.0.1:7784/about'])
await assert.rejects(
  shell.action({ action: 'address', value: 'https://example.com/' }),
  /stay within/
)
let selectOffs = 0
shell.selectOff = () => {
  selectOffs++
  assert.equal(shell.selecting, false, 'The selection is dropped after the mode flips off')
  assert.notDeepEqual(calls.at(-1), ['preview:set-select-mode', false], 'before the page disarms')
}
await shell.action({ action: 'select-object' })
assert.equal(shell.selecting, true)
assert.equal(selectOffs, 0, 'Turning the select tool on keeps the selection')
// LKM-344: turning the select tool off drops the page selection, island and chip.
await shell.action({ action: 'select-object' })
assert.equal(shell.selecting, false)
assert.equal(selectOffs, 1, 'Turning the select tool off drops the selection')
assert.deepEqual(calls.at(-1), ['preview:set-select-mode', false])
await shell.action({ action: 'select-object' })
assert.equal(shell.selecting, true)
shell.location = 'http://127.0.0.1:7784/new'
shell.render()
assert.equal(renders.at(-1).previewURL, shell.location)
shell.location = 'https://example.com/'
shell.render()
assert.equal(renders.at(-1).previewURL, active.url)

// LKM-372: favicon loads in flight while projects switch, reorder, close and open. Each
// row's icon comes from its own root's result; a late result never lands on another row.
{
  const pending = new Map()
  const requested = []
  const project = (key) => ({
    key,
    root: `/${key}`,
    name: key.toUpperCase(),
    url: null,
    activeSessionKey: key,
    sessionKeys: [],
    previewKind: 'web'
  })
  const [a, b, c] = ['a', 'b', 'c'].map(project)
  const iconWorkspace = {
    active: a,
    state: {
      projects: [a, b],
      status: { kind: 'running' },
      loadedKey: 'a',
      recents: [],
      history: {}
    },
    services: {
      invoke: (channel, root) => {
        assert.equal(channel, 'project:icon')
        requested.push(root)
        return new Promise((resolve, reject) => pending.set(root, { resolve, reject }))
      }
    },
    changed() {}
  }
  const states = []
  const iconShell = new NativeShellController(
    iconWorkspace,
    { chats: new Map() },
    { mode: 'merge', decorate: (s) => s },
    { get: () => undefined, set() {} },
    (s) => states.push(s),
    () => {}
  )
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40))
  const icons = () => Object.fromEntries(states.at(-1).rows.map((r) => [r.project, r.icon]))
  iconShell.render()
  assert.deepEqual(icons(), { a: undefined, b: undefined }, 'Rows keep the folder while loads run')
  // Switch to B and reorder while both loads are in flight, then B's answer lands first.
  iconWorkspace.active = b
  iconWorkspace.state.projects = [b, a]
  iconShell.render()
  pending.get('/b').resolve({ path: 'favicon.svg', dataUrl: 'data:image/svg+xml;base64,Qg==' })
  await settle()
  assert.deepEqual(icons(), { b: 'data:image/svg+xml;base64,Qg==', a: undefined })
  // A third project opens and A closes while A's load is still running.
  iconWorkspace.state.projects = [b, c]
  iconWorkspace.active = c
  iconShell.render()
  pending.get('/a').resolve({ path: 'favicon.png', dataUrl: 'data:image/png;base64,QQ==' })
  await settle()
  assert.deepEqual(
    icons(),
    { b: 'data:image/svg+xml;base64,Qg==', c: undefined },
    "A's late answer lands on no row"
  )
  // A failed lookup leaves C on the folder; reopening A shows A's own icon on A's row only.
  pending.get('/c').reject(new Error('unreadable'))
  iconWorkspace.state.projects = [c, a, b]
  await settle()
  iconShell.render()
  assert.deepEqual(icons(), {
    c: undefined,
    a: 'data:image/png;base64,QQ==',
    b: 'data:image/svg+xml;base64,Qg=='
  })
  assert.deepEqual(requested, ['/a', '/b', '/c'], 'One lookup per project root, never a second')
}
console.log(
  'Native shell: project/history state, viewport, expand persistence, scoped navigation and per-row favicon loads passed'
)
