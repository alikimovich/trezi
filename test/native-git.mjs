import assert from 'node:assert/strict'
import { NativeGitController } from '../src/native/git-controller.ts'
import { NativeSheetController } from '../src/native/sheets-runtime.ts'

const calls = [],
  logs = [],
  values = new Map()
const a = { key: 'a', root: '/a', branch: 'main', activeSessionKey: 'chat-a' },
  b = { key: 'b', root: '/b', branch: 'main', activeSessionKey: 'chat-b' }
let branch = 'main',
  connected = true,
  conflict = false,
  prConflict = false,
  release,
  paused = false
const workspace = {
  active: a,
  state: { projects: [a, b] },
  command: async ({ type, key }) => {
    if (type === 'select') workspace.active = workspace.state.projects.find((p) => p.key === key)
  },
  changed() {},
  transact: async (key, fn) => {
    const entry = workspace.state.projects.find((p) => p.key === key)
    if (!entry) throw new Error('Closed')
    await fn(entry)
  },
  refreshEnvironment: async (...args) => calls.push(['refresh', ...args])
}
const invoke = async (channel, ...args) => {
  calls.push([channel, ...args])
  if (channel === 'git:list') return { current: branch, branches: ['main', 'feature'] }
  if (channel === 'github:status')
    return { connected, gh: 'ok', login: 'user', suggestedName: 'project' }
  if (channel === 'git:checkout') {
    branch = args[1]
    return { branch, files: ['app.ts'] }
  }
  if (channel === 'publish:ship') {
    if (paused)
      await new Promise((resolve) => {
        release = resolve
      })
    return conflict
      ? {
          ok: false,
          error: 'Merge conflict',
          conflictFiles: ['app.ts'],
          recoveryRefs: ['recovery/a']
        }
      : { ok: true, branch, url: 'https://example.com/pr' }
  }
  if (channel === 'publish:pr-status')
    return {
      mergeable: prConflict ? 'CONFLICTING' : 'MERGEABLE',
      number: 6,
      baseRefName: 'main',
      headRefName: 'trezi/main',
      conflictingFiles: prConflict ? ['package.json'] : [],
      url: 'https://example.com/pr'
    }
  if (channel === 'git:remote-status')
    return {
      current: branch,
      remotes: ['origin'],
      upstream: 'origin/main',
      branches: [{ ref: 'origin/main', label: 'origin/main' }]
    }
  if (channel === 'git:remote-update')
    return { ok: true, files: ['package.json'], message: 'Updated' }
  return { ok: true, url: 'https://example.com/repo' }
}
const sheets = new NativeSheetController({ send() {} }, workspace, {}, invoke)
const git = new NativeGitController(
  sheets,
  { append: (...args) => logs.push(args) },
  { get: (key) => values.get(key), set: (key, value) => values.set(key, value) },
  () => {},
  {
    active: 'chat-b',
    get: (key) => ({ chat: key, root: key === 'chat-a' ? '/a' : '/b', ready: true }),
    submit: async (chat, text) => calls.push(['resolve-turn', chat.chat, text])
  }
)
await git.branch('a', 'feature')
assert.equal(a.branch, 'feature')
assert.equal(b.branch, 'main')
assert.deepEqual(calls.at(-1), ['refresh', 'a', ['app.ts']])
git.setMode('pr')
assert.equal(git.mode, 'pr')
paused = true
const publish = git.publish('a')
await new Promise((resolve) => setTimeout(resolve, 0))
workspace.active = b
assert.equal(git.decorate({}).publishing, false)
release()
await publish
assert.ok(calls.some((c) => c[0] === 'publish:ship' && c[1] === '/a' && c[3] === 'pr'))
assert.ok(!calls.some((c) => c[0] === 'publish:ship' && c[1] === '/b'))
paused = false
conflict = true
await git.publish('a')
assert.equal(sheets.current, null, 'A live reconcile conflict stays on the manual recovery path')
conflict = false
prConflict = true
workspace.active = b
await git.publish('a')
assert.equal(sheets.current.state.title, 'Publish has merge conflicts')
assert.ok(sheets.current.state.actions.some((action) => action.label === 'Resolve with agent'))
await sheets.action({ id: sheets.current.state.id, action: 'resolve', values: {} })
assert.equal(calls.at(-1)[1], 'chat-a', 'Resolve turn uses the published project’s chat')
assert.match(calls.at(-1)[2], /package\.json[\s\S]*origin\/main[\s\S]*git_merge_continue/)
assert.equal(workspace.active.key, 'a')
connected = false
await git.publish('a')
assert.equal(sheets.current.state.title, 'Connect to GitHub')
await sheets.action({
  id: sheets.current.state.id,
  action: 'connect',
  values: { name: 'My Repo', owner: 'user', visibility: 'private' }
})
assert.deepEqual(calls.find((c) => c[0] === 'github:connect')[2], {
  name: 'my-repo',
  owner: 'user',
  private: true
})
await git.updates('a')
await sheets.action({ id: sheets.current.state.id, action: 'pull', values: { ref: 'origin/main' } })
assert.ok(calls.some((c) => c[0] === 'git:remote-update' && c[2].expectedBranch === 'feature'))
console.log(
  'Native Git: branch scope, publish mode/concurrency, conflicts, connection and remote update passed'
)
