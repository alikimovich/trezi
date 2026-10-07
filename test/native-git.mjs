import assert from 'node:assert/strict'
import { NativeGitController } from '../src/native/git-controller.ts'
import { NativeSheetController } from '../src/native/sheets-runtime.ts'

const calls = [],
  logs = [],
  sent = [],
  opened = [],
  values = new Map()
let progress = null
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
  if (channel === 'publish:progress') return progress
  if (channel === 'publish:cancel') return true
  return { ok: true, url: 'https://example.com/repo' }
}
const sheets = new NativeSheetController(
  { send: (type, payload) => sent.push([type, payload]) },
  workspace,
  {},
  invoke
)
const git = new NativeGitController(
  sheets,
  { append: (...args) => logs.push(args) },
  { get: (key) => values.get(key), set: (key, value) => values.set(key, value) },
  () => {},
  (url) => opened.push(url)
)
git.pollInterval = 5
const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const lastToast = () => sent.findLast(([type]) => type === 'toastState')?.[1].state
await git.branch('a', 'feature')
assert.equal(a.branch, 'feature')
assert.equal(b.branch, 'main')
assert.deepEqual(calls.at(-1), ['refresh', 'a', ['app.ts']])
git.setMode('pr')
assert.equal(git.mode, 'pr')
paused = true
const publish = git.publish('a')
// LKM-187: progress shows synchronously on click, before any reply.
assert.deepEqual(
  (({ publishing, publishLabel, publishCancellable }) => ({
    publishing,
    publishLabel,
    publishCancellable
  }))(git.decorate({})),
  { publishing: true, publishLabel: 'Creating PR…', publishCancellable: true }
)
await new Promise((resolve) => setTimeout(resolve, 0))
progress = { id: 'w1', state: 'running', step: 'push', since: Date.now() - 5000 }
await tick()
assert.equal(git.decorate({}).publishLabel, 'Pushing… 5s')
// The indicator stays with its project: another project's toolbar is idle.
workspace.active = b
assert.equal(git.decorate({}).publishing, false)
assert.equal(git.decorate({}).publishLabel, 'Create PR')
workspace.active = a
await git.cancel('a')
assert.ok(calls.some((c) => c[0] === 'publish:cancel' && c[1] === '/a'))
assert.equal(git.decorate({}).publishLabel, 'Cancelling…')
assert.equal(git.decorate({}).publishCancellable, false)
progress = null
release()
await publish
assert.ok(calls.some((c) => c[0] === 'publish:ship' && c[1] === '/a' && c[3] === 'pr'))
assert.ok(!calls.some((c) => c[0] === 'publish:ship' && c[1] === '/b'))
assert.equal(git.decorate({}).publishing, false)
// The run finished before the cancel took: its success still shows.
assert.equal(lastToast().message, 'Pull request opened')
paused = false
await git.publish('a')
assert.equal(lastToast().action, 'View on GitHub')
await sheets.toastAction({ id: lastToast().id })
assert.deepEqual(opened, ['https://example.com/pr'])
conflict = true
await git.publish('a')
assert.match(logs.at(-1)[0], /recovery\/a/)
assert.equal(sheets.current.state.title, 'Couldn’t create the pull request')
assert.match(sheets.current.state.detail, /app\.ts/)
assert.deepEqual(
  sheets.current.state.actions.map((action) => action.id),
  ['copy', 'cancel', 'retry']
)
const ships = calls.filter((c) => c[0] === 'publish:ship').length
await sheets.action({ id: sheets.current.state.id, action: 'retry', values: {} })
await tick()
assert.equal(calls.filter((c) => c[0] === 'publish:ship').length, ships + 1, 'Retry publishes')
assert.equal(sheets.current.state.title, 'Couldn’t create the pull request')
sheets.close()
conflict = false
// A publish this process didn't start (Trezi reloaded): adopted, then its result shows.
progress = { id: 'w2', state: 'running', step: 'merge' }
await git.refresh('/a')
assert.equal(git.decorate({}).publishLabel, 'Merging…')
assert.equal(git.decorate({}).publishCancellable, false)
progress = {
  id: 'w2',
  state: 'done',
  result: { ok: true, url: 'https://github.com/o/r/pull/7' }
}
await tick()
await tick()
assert.equal(git.decorate({}).publishing, false)
assert.equal(lastToast().message, 'Pull request #7 opened')
progress = null
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
