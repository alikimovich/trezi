// LKM-182 prewarmed spare chat worktrees, through the Swift repository owner (run by
// test/repository-owner.mjs with its preload): a project's spare is created in the
// background, skipped by orphan recovery, taken by the next chat and synced from the
// live tree on take (uncommitted work included), and removed unused on project close
// without a recovery ref. A folder that is not a repository root gets none.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initChatIsolation,
  isolatedCwd,
  liveChatWorktreeIds,
  releaseChat
} from '../src/main/chat-isolation.ts'
import { prewarmSpare, releaseSpare, spareReady, takeSpare } from '../src/main/chat-spare.ts'
import { setDependencyInstaller } from '../src/main/project-dependencies.ts'
import { dependenciesInstalling } from '../src/main/worktree-dependencies.ts'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-chat-spare-')))
const worktrees = join(base, 'profile', 'worktrees')
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const records = new Map()
initChatIsolation({
  worktreesDir: () => worktrees,
  store: () => ({
    get: (id) => records.get(id),
    save: (record) => records.set(record.id, record),
    remove: (id) => records.delete(id),
    list: () => [...records.values()]
  }),
  getWindow: () => null
})

function repo(name) {
  const path = join(base, name)
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'main')
  git(path, 'config', 'user.name', 'User')
  git(path, 'config', 'user.email', 'user@local')
  git(path, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(path, '.gitignore'), 'node_modules\n.env\n')
  writeFileSync(join(path, 'a.txt'), 'one\n')
  git(path, 'add', '-A')
  git(path, 'commit', '-q', '-m', 'init')
  return path
}
const recovery = (root) =>
  git(root, 'for-each-ref', '--format=%(refname)', 'refs/trezi/recovery/')
    .split('\n')
    .filter(Boolean)
const branches = (root) =>
  git(root, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean)

// Prewarm: a detached checkout of the live tree, listed as live for orphan recovery.
const live = repo('live')
prewarmSpare(live, worktrees)
prewarmSpare(live, worktrees) // one spare per project
const spare = await spareReady(live)
assert.ok(spare && existsSync(spare.path), 'the spare checkout exists')
assert.ok(liveChatWorktreeIds().includes(spare.id), 'orphan recovery skips the spare')
assert.deepEqual(branches(live), ['main'], 'the spare carries no branch')
assert.equal(readFileSync(join(spare.path, 'a.txt'), 'utf8'), 'one\n')

// Take: the next chat runs in the spare, brought up to the live tree first.
writeFileSync(join(live, 'a.txt'), 'edited live\n')
writeFileSync(join(live, 'new.txt'), 'untracked\n')
const cwd = await isolatedCwd(live, 'chat-a')
assert.equal(cwd, spare.path, 'the new chat took the spare')
assert.equal(readFileSync(join(cwd, 'a.txt'), 'utf8'), 'edited live\n', 'synced on take')
assert.equal(readFileSync(join(cwd, 'new.txt'), 'utf8'), 'untracked\n')
assert.equal(await spareReady(live), null, 'a taken spare is gone from the project')
assert.equal(takeSpare(live), null)
// Without a spare the chat creates its own checkout as before.
const own = await isolatedCwd(live, 'chat-b')
assert.notEqual(own, spare.path)
assert.ok(existsSync(own))
await releaseChat('chat-a')
await releaseChat('chat-b')
assert.ok(!existsSync(cwd) && !existsSync(own), 'released chats remove their checkouts')

// Close: an unused spare is removed with no recovery ref (it holds no work).
const before = recovery(live).length
prewarmSpare(live, worktrees)
const unused = await spareReady(live)
assert.ok(unused && existsSync(unused.path))
await releaseSpare(live)
assert.ok(!existsSync(unused.path), 'project close removes the unused spare')
assert.equal(recovery(live).length, before, 'no recovery ref for an untouched spare')
assert.ok(!liveChatWorktreeIds().includes(unused.id))
assert.ok(!git(live, 'worktree', 'list', '--porcelain').includes(unused.path))
// Closing while the spare is still being created waits for it, then removes it.
prewarmSpare(live, worktrees)
const inFlight = spareReady(live)
await releaseSpare(live)
const late = await inFlight
assert.ok(late && !existsSync(late.path), 'a spare still being created is removed too')

// Not a repository root: no spare.
const plain = join(base, 'plain')
mkdirSync(plain, { recursive: true })
prewarmSpare(plain, worktrees)
assert.equal(await spareReady(plain), null)
assert.equal(takeSpare(plain), null)

// Closing a chat whose background install is still running waits for the install, then
// removes the checkout: nothing keeps writing into a deleted folder or recreates it.
const deps = repo('deps')
writeFileSync(join(deps, 'package.json'), '{"name":"deps","dependencies":{"x":"1.0.0"}}\n')
git(deps, 'add', '-A')
git(deps, 'commit', '-q', '-m', 'manifest')
mkdirSync(join(deps, 'node_modules', 'x'), { recursive: true })
writeFileSync(join(deps, 'node_modules', 'x', 'index.js'), 'live\n')
// A spare cloned from the live dependencies, then the manifests change: the take needs an install.
prewarmSpare(deps, worktrees)
const depSpare = await spareReady(deps)
assert.ok(
  depSpare && existsSync(join(depSpare.path, 'node_modules', 'x')),
  'the spare cloned node_modules'
)
writeFileSync(join(deps, 'package.json'), '{"name":"deps","dependencies":{"x":"2.0.0"}}\n')
let openGate
const gate = new Promise((resolve) => {
  openGate = resolve
})
const installs = []
setDependencyInstaller(async (path) => {
  installs.push(path)
  await gate
  mkdirSync(join(path, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(path, 'node_modules', 'x', 'index.js'), 'installed\n')
})
try {
  const depCwd = await isolatedCwd(deps, 'chat-deps')
  assert.equal(depCwd, depSpare.path)
  assert.ok(dependenciesInstalling(depCwd), 'the new chat installs in the background')
  assert.deepEqual(installs, [depCwd])
  let released = false
  const closing = releaseChat('chat-deps').then(() => {
    released = true
  })
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.ok(!released && existsSync(depCwd), 'the checkout stays while the install runs')
  openGate()
  await closing
  assert.ok(!dependenciesInstalling(depCwd))
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.ok(!existsSync(depCwd), 'the checkout is removed once the install settled')
  assert.ok(!git(deps, 'worktree', 'list', '--porcelain').includes(depCwd))
} finally {
  openGate()
  setDependencyInstaller(null)
}

console.log('chat-spare: ok')
