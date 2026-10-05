// LKM-165: a chat whose Codex turns failed, then switched to Claude, still lands; a
// drift park lets the Resolve turn run (it was refused, so the chat never landed);
// a landing that throws holds the work with a reason and lands on Retry, and the
// agent's workspace state never reads "pending". Runs through the Swift repository
// and source owners (test/repository-owner.mjs, suites list).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  adoptSession,
  afterTurn,
  agentWorkspaceState,
  beforeTurn,
  initChatIsolation,
  isolatedCwd,
  isolationSnapshot,
  releaseChat,
  resolveParkedChat,
  retryLanding,
  sendRefusal
} from '../src/main/chat-isolation.ts'

const dir = mkdtempSync(join(tmpdir(), 'trezi-landing-recovery-'))
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const events = []
const records = new Map()
initChatIsolation({
  worktreesDir: () => join(dir, 'worktrees'),
  store: () => ({
    get: (id) => records.get(id),
    save: (record) => records.set(record.id, record),
    remove: (id) => records.delete(id)
  }),
  getWindow: () => ({
    webContents: { isDestroyed: () => false, send: (_, event) => events.push(event) }
  })
})

const FILE = 'src/bar.ts'
const OTHER = 'src/baz.ts'
const read = (root, file = FILE) => readFileSync(join(root, file), 'utf8')
let n = 0
async function fixture() {
  const key = `recovery-${n++}`
  const root = join(dir, key)
  mkdirSync(join(root, 'src'), { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(root, '.gitignore'), 'node_modules\n.env\n')
  writeFileSync(join(root, FILE), 'export const bar = 0\n')
  writeFileSync(join(root, OTHER), 'export const baz = 0\n')
  writeFileSync(join(root, 'README.md'), '# app\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'initial')
  const cwd = await isolatedCwd(root, key)
  adoptSession(key, { id: key }, root)
  await beforeTurn(key, 'edit')
  events.length = 0
  return { key, root, cwd, branch: isolationSnapshot(key).branch }
}

try {
  // Failed Codex turns hold their work; after a switch to Claude the next turn lands it all.
  const sw = await fixture()
  writeFileSync(join(sw.cwd, FILE), 'export const bar = 1\n')
  await afterTurn(sw.key, 'Codex turn one', [], 'failed')
  assert.equal(isolationSnapshot(sw.key).reason, 'interrupted')
  assert.equal(sendRefusal(sw.key), null, 'a failed turn’s hold never blocks the next send')
  await beforeTurn(sw.key, 'again')
  writeFileSync(join(sw.cwd, OTHER), 'export const baz = 1\n')
  await afterTurn(sw.key, 'Codex turn two', [], 'failed')
  assert.equal(read(sw.root), 'export const bar = 0\n', 'held work is not live yet')
  writeFileSync(join(sw.root, 'README.md'), '# app, edited by the user\n')
  // The provider switch restarts the session on the same chat key and worktree.
  assert.equal(await isolatedCwd(sw.root, sw.key), sw.cwd)
  await beforeTurn(sw.key, 'claude')
  writeFileSync(join(sw.cwd, FILE), 'export const bar = 2\n')
  await afterTurn(sw.key, 'Claude turn', [], 'success')
  assert.equal(events.at(-1).state, 'merged')
  assert.deepEqual(events.at(-1).files.toSorted(), [FILE, OTHER])
  assert.equal(read(sw.root), 'export const bar = 2\n')
  assert.equal(read(sw.root, OTHER), 'export const baz = 1\n')
  assert.equal(read(sw.root, 'README.md'), '# app, edited by the user\n')
  assert.deepEqual(isolationSnapshot(sw.key), { state: 'isolated', branch: sw.branch })
  const settled = agentWorkspaceState(sw.key)
  assert.equal(settled.state, 'isolated')
  assert.equal(settled.lastLanding.outcome, 'merged')
  assert.match(settled.guidance, /Never describe earlier changes as pending/)
  await releaseChat(sw.key)

  // The stuck chat: a failed Codex turn's hold goes stale under a live edit, so the
  // next successful turn parks as a conflict. Resolve's turn must be allowed and land.
  const stuck = await fixture()
  writeFileSync(join(stuck.cwd, FILE), 'export const bar = 1\n')
  await afterTurn(stuck.key, 'Codex turn', [], 'failed')
  writeFileSync(join(stuck.root, FILE), 'export const bar = 9\n')
  await beforeTurn(stuck.key, 'claude')
  writeFileSync(join(stuck.cwd, FILE), 'export const bar = 2\n')
  await afterTurn(stuck.key, 'Claude turn', [], 'success')
  assert.equal(events.at(-1).state, 'parked')
  assert.equal(events.at(-1).reason, undefined, 'a drift park is a conflict, not a hold')
  assert.ok(sendRefusal(stuck.key), 'an unresolved conflict refuses queued sends')
  assert.equal(agentWorkspaceState(stuck.key).state, 'parked')
  const prep = await resolveParkedChat(stuck.key)
  assert.deepEqual(prep, { ok: true, conflicted: [FILE] })
  assert.equal(sendRefusal(stuck.key), null, 'the Resolve turn itself is allowed')
  assert.equal(agentWorkspaceState(stuck.key).state, 'resolving')
  await beforeTurn(stuck.key, 'resolve')
  writeFileSync(join(stuck.cwd, FILE), 'export const bar = 29\n')
  await afterTurn(stuck.key, 'Resolve conflicts', [], 'success')
  assert.equal(events.at(-1).state, 'merged')
  assert.equal(read(stuck.root), 'export const bar = 29\n')
  assert.deepEqual(isolationSnapshot(stuck.key), { state: 'isolated', branch: stuck.branch })
  assert.equal(records.size, 0, 'the park record is dropped')
  await releaseChat(stuck.key)

  // A stale drift park the user has since cleared up lands on Retry.
  const stale = await fixture()
  writeFileSync(join(stale.root, FILE), 'export const bar = 9\n')
  writeFileSync(join(stale.cwd, FILE), 'export const bar = 1\n')
  await afterTurn(stale.key, 'Set bar', [], 'success')
  assert.equal(isolationSnapshot(stale.key).state, 'parked')
  writeFileSync(join(stale.root, FILE), 'export const bar = 0\n')
  assert.deepEqual(await retryLanding(stale.key), { ok: true, state: 'isolated' })
  assert.equal(events.at(-1).state, 'merged')
  assert.equal(read(stale.root), 'export const bar = 1\n')
  await releaseChat(stale.key)

  // A landing that throws is held as a failed park with its reason, then Retry lands it.
  const failed = await fixture()
  const lock = join(git(failed.cwd, 'rev-parse', '--absolute-git-dir'), 'index.lock')
  writeFileSync(lock, '')
  writeFileSync(join(failed.cwd, FILE), 'export const bar = 5\n')
  assert.equal(await afterTurn(failed.key, 'Set bar to five', [], 'success'), null)
  const held = events.at(-1)
  assert.equal(held.state, 'parked')
  assert.equal(held.reason, 'failed')
  assert.ok(held.error, 'the failure carries its reason')
  assert.deepEqual(held.files, [FILE])
  assert.equal(isolationSnapshot(failed.key).reason, 'failed')
  assert.equal(sendRefusal(failed.key), null)
  const state = agentWorkspaceState(failed.key)
  assert.equal(state.state, 'failed')
  assert.equal(state.lastLanding.outcome, 'failed')
  assert.match(state.guidance, /Do not say the changes are pending/)
  assert.equal(read(failed.root), 'export const bar = 0\n')
  rmSync(lock)
  const retried = await retryLanding(failed.key)
  assert.deepEqual(retried, { ok: true, state: 'isolated' })
  assert.equal(events.at(-1).state, 'merged')
  assert.equal(read(failed.root), 'export const bar = 5\n')
  assert.equal(agentWorkspaceState(failed.key).state, 'isolated')
  await releaseChat(failed.key)
  console.log(
    'CHAT LANDING RECOVERY OK — provider switch after failed turns, Resolve turn, stale park Retry, failed landing Retry'
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}
