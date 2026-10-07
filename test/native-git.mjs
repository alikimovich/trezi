import assert from 'node:assert/strict'
import { NativeGitController } from '../src/native/git-controller.ts'
import { NativeSheetController } from '../src/native/sheets-runtime.ts'

const calls = [],
  logs = [],
  values = new Map()
const a = { key: 'a', root: '/a', branch: 'main' },
  b = { key: 'b', root: '/b', branch: 'main' }
let branch = 'main',
  connected = true,
  conflict = false,
  release,
  paused = false
const workspace = {
  active: a,
  state: { projects: [a, b] },
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
    active: 'a',
    get: (key) => ({ chat: key }),
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
assert.equal(sheets.current.state.title, 'Publish has merge conflicts')
assert.ok(sheets.current.state.actions.some((action) => action.label === 'Resolve with agent'))
await sheets.action({ id: sheets.current.state.id, action: 'resolve', values: {} })
assert.match(calls.at(-1)[2], /app\.ts[\s\S]*recovery\/a[\s\S]*git_merge_continue/)
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
