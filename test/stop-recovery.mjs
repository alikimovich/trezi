// LKM-151: Stop never leaves a broken project. A turn stopped between two dependent
// edits holds its work on the chat branch (the live checkout keeps its exact bytes);
// the post-Stop card reverts it (undoably), keeps it (with a working Revert) or lets
// the agent finish it. Runs through the Swift repository and source owners
// (test/repository-owner.mjs, suites list).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  afterTurn,
  beforeTurn,
  initChatIsolation,
  isolatedCwd,
  isolationSnapshot,
  releaseChat
} from '../src/main/chat-isolation.ts'
import { revertGroup } from '../src/main/edit-history.ts'
import { keepStoppedTurn, revertStoppedTurn, undoStoppedRevert } from '../src/main/stopped-turn.ts'

const dir = mkdtempSync(join(tmpdir(), 'trezi-stop-recovery-'))
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

// CRLF, a BOM-less UTF-8 accent and no final newline: "byte-exact" must mean bytes.
const ORIGINAL = Buffer.from(
  'export function Bar() {\r\n  return <div className="é">\r\n    <span>hi</span>\r\n  </div>\r\n}',
  'utf8'
)
// The first of two dependent edits: a fragment opened, its closing edit never made.
const HALF = Buffer.from(
  'export function Bar() {\r\n  return <>\r\n  <div className="é">\r\n    <span>hi</span>\r\n  </div>\r\n}',
  'utf8'
)
const DONE = Buffer.from(
  'export function Bar() {\r\n  return <>\r\n  <div className="é">\r\n    <span>hi</span>\r\n  </div>\r\n  </>\r\n}',
  'utf8'
)
const FILE = 'src/bar.tsx'

let n = 0
async function fixture() {
  const key = `stop-${n++}`
  const root = join(dir, key)
  mkdirSync(join(root, 'src'), { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(root, '.gitignore'), 'node_modules\n.env\n')
  writeFileSync(join(root, FILE), ORIGINAL)
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'initial')
  const cwd = await isolatedCwd(root, key)
  await beforeTurn(key, 'edit')
  events.length = 0
  return {
    key,
    root,
    cwd,
    live: () => readFileSync(join(root, FILE)),
    copy: () => readFileSync(join(cwd, FILE))
  }
}
const last = () => events.at(-1)

try {
  // Stop mid-edit: the half-made edit is held, never landed; the live file is untouched.
  const stop = await fixture()
  writeFileSync(join(stop.cwd, FILE), HALF)
  assert.equal(await afterTurn(stop.key, 'Wrap the bar in a fragment', [], 'failed'), null)
  assert.ok(stop.live().equals(ORIGINAL), 'a stopped turn never writes the live checkout')
  assert.equal(git(stop.root, 'status', '--porcelain'), '')
  assert.deepEqual(isolationSnapshot(stop.key), {
    state: 'parked',
    branch: isolationSnapshot(stop.key).branch,
    reason: 'interrupted'
  })
  assert.equal(last().state, 'parked')
  assert.equal(last().reason, 'interrupted')
  assert.deepEqual(last().files, [FILE])

  // Revert is byte-exact (the live file never changed) and undoable until the next turn.
  assert.deepEqual(revertStoppedTurn(stop.key), { ok: true, files: [FILE] })
  assert.equal(last().state, 'isolated')
  assert.equal(last().reason, 'reverted')
  assert.equal(isolationSnapshot(stop.key).state, 'isolated')
  assert.ok(stop.live().equals(ORIGINAL))
  assert.equal(revertStoppedTurn(stop.key).ok, false, 'a reverted turn is not reverted twice')
  assert.deepEqual(undoStoppedRevert(stop.key), { ok: true, files: [FILE] })
  assert.equal(last().reason, 'interrupted')
  assert.equal(isolationSnapshot(stop.key).reason, 'interrupted')
  assert.ok(stop.copy().equals(HALF), 'undo restores the held work')
  assert.equal(undoStoppedRevert(stop.key).ok, false)
  // Revert again: the next turn start discards the held work for good.
  assert.equal(revertStoppedTurn(stop.key).ok, true)
  await beforeTurn(stop.key, 'something else')
  assert.ok(stop.copy().equals(ORIGINAL), 'the next turn starts from the live bytes')
  assert.ok(stop.live().equals(ORIGINAL))
  assert.equal(isolationSnapshot(stop.key).state, 'isolated')
  assert.equal(undoStoppedRevert(stop.key).ok, false, 'a settled revert cannot be undone')
  await releaseChat(stop.key)

  // Keep changes: the partial work lands like a turn, and its Revert restores the bytes.
  const keep = await fixture()
  writeFileSync(join(keep.cwd, FILE), HALF)
  await afterTurn(keep.key, 'Wrap the bar in a fragment', [], 'failed')
  assert.ok(keep.live().equals(ORIGINAL))
  const kept = await keepStoppedTurn(keep.key)
  assert.equal(kept.ok, true)
  assert.deepEqual(kept.files, [FILE])
  assert.match(kept.group, /^chat:[^:]+:\d+$/)
  assert.ok(keep.live().equals(HALF), 'Keep lands the partial work')
  assert.equal(last().state, 'merged')
  assert.equal(last().group, kept.group)
  assert.equal(isolationSnapshot(keep.key).state, 'isolated')
  // LKM-189: the kept work is described by its change (here the fallback), not a fixed title.
  assert.equal(git(keep.root, 'log', '-1', '--format=%s'), 'Update bar.tsx')
  const reverted = await revertGroup(keep.root, kept.group)
  assert.equal(reverted.ok, true)
  assert.ok(keep.live().equals(ORIGINAL), 'the kept turn reverts byte for byte')
  assert.equal((await keepStoppedTurn(keep.key)).ok, false, 'nothing is held after Keep')
  await releaseChat(keep.key)

  // Ask agent to finish: the next turn continues on the held work; its success lands it all.
  const finish = await fixture()
  writeFileSync(join(finish.cwd, FILE), HALF)
  await afterTurn(finish.key, 'Wrap the bar in a fragment', [], 'failed')
  await beforeTurn(finish.key, 'Finish it')
  assert.ok(finish.copy().equals(HALF), 'a held turn is not reset by the next turn start')
  writeFileSync(join(finish.cwd, FILE), DONE)
  await afterTurn(finish.key, 'Finish it', [], 'success')
  assert.ok(finish.live().equals(DONE))
  assert.equal(last().state, 'merged')
  assert.equal(last().reason, undefined)
  assert.equal(isolationSnapshot(finish.key).state, 'isolated')
  await releaseChat(finish.key)

  // A drift park stays a conflict when a later turn on top of it is stopped.
  const drift = await fixture()
  writeFileSync(join(drift.cwd, FILE), HALF)
  writeFileSync(join(drift.root, FILE), DONE)
  await afterTurn(drift.key, 'edit', [], 'success')
  assert.equal(last().state, 'parked')
  assert.equal(last().reason, undefined)
  writeFileSync(join(drift.cwd, 'src/more.ts'), 'export {}\n')
  await afterTurn(drift.key, 'more', [], 'failed')
  assert.equal(last().reason, undefined, 'a conflict is not offered as a stopped turn')
  assert.equal(revertStoppedTurn(drift.key).ok, false)
  assert.equal((await keepStoppedTurn(drift.key)).ok, false)
  await releaseChat(drift.key)

  // Releasing a chat with a reverted stopped turn keeps nothing on a branch.
  const release = await fixture()
  writeFileSync(join(release.cwd, FILE), HALF)
  await afterTurn(release.key, 'edit', [], 'failed')
  revertStoppedTurn(release.key)
  await releaseChat(release.key)
  assert.ok(release.live().equals(ORIGINAL))
  assert.equal(records.size, 1, 'only the drift chat keeps a park record')
  console.log(
    'STOP RECOVERY OK — stopped turns hold, revert byte-exact (undoable), keep and finish'
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}
