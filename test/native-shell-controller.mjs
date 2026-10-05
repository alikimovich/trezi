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
const chat = { chats: new Map([['a', { title: 'Working chat', messages: [], isRunning: true }]]) }
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
assert.equal(renders.at(-1).rows[0].children[1].title, 'Older chat')
await shell.action({ action: 'device' })
assert.equal(active.viewport, 'mobile')
await shell.action({ action: 'expand' })
assert.equal(projections.at(-1).chatHidden, true)
assert.equal(values.get('trezi:chat-hidden'), '1')
await shell.action({ action: 'address', value: '/about' })
assert.deepEqual(calls.at(-1), ['preview:load', 'http://127.0.0.1:7784/about'])
await assert.rejects(
  shell.action({ action: 'address', value: 'https://example.com/' }),
  /stay within/
)
await shell.action({ action: 'select-object' })
assert.equal(shell.selecting, true)
shell.location = 'http://127.0.0.1:7784/new'
shell.render()
assert.equal(renders.at(-1).previewURL, shell.location)
shell.location = 'https://example.com/'
shell.render()
assert.equal(renders.at(-1).previewURL, active.url)
console.log(
  'Native shell: project/history state, viewport, expand persistence and scoped navigation passed'
)
