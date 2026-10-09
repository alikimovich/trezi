// LKM-196: a chat never stays parked with nothing to land. A park whose work already
// reached the live tree is cleared (on turn start, chat open and the agent's workspace
// tools); a pending diff whose batch went missing is rebuilt so Resolve and Retry work;
// workspace_state never reports parked without a batch. Runs through the Swift
// repository and source owners (test/repository-owner.mjs, suites list).
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
  reconcileIdleParks,
  reconcilePark,
  releaseChat,
  resolveParkedChat,
  retryLanding,
  sendRefusal
} from '../src/main/chat-isolation.ts'
import { states } from '../src/main/chat-state.ts'
import { runTreziTool } from '../src/main/session-tools.ts'
import { turnTimings } from '../src/main/turn-timing.ts'

const dir = mkdtempSync(join(tmpdir(), 'trezi-ghost-park-'))
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
  const key = `ghost-${n++}`
  const root = join(dir, key)
  mkdirSync(join(root, 'src'), { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(root, '.gitignore'), 'node_modules\n.env\n')
  writeFileSync(join(root, FILE), 'export const bar = 0\n')
  writeFileSync(join(root, OTHER), 'export const baz = 0\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'initial')
  const cwd = await isolatedCwd(root, key)
  adoptSession(key, { id: key }, root)
  await beforeTurn(key, 'edit')
  events.length = 0
  return { key, root, cwd, branch: isolationSnapshot(key).branch }
}
/** A drift park: live changed FILE under the chat, so the chat's turn is refused. */
async function driftPark() {
  const f = await fixture()
  writeFileSync(join(f.root, FILE), 'export const bar = 9\n')
  writeFileSync(join(f.cwd, FILE), 'export const bar = 1\n')
  await afterTurn(f.key, 'Set bar', [], 'success')
  assert.equal(isolationSnapshot(f.key).state, 'parked')
  assert.ok(sendRefusal(f.key), 'the conflict refuses sends')
  return f
}
const scope = (f) => ({
  root: f.cwd,
  liveRoot: f.root,
  emitKey: f.key,
  background: false,
  notify: () => {}
})
const assertCleared = (f) => {
  assert.equal(events.at(-1).state, 'isolated')
  assert.deepEqual(isolationSnapshot(f.key), { state: 'isolated', branch: f.branch })
  assert.equal(sendRefusal(f.key), null)
  const state = agentWorkspaceState(f.key)
  assert.equal(state.state, 'isolated')
  assert.equal(state.lastLanding.outcome, 'merged')
  assert.deepEqual(state.lastLanding.files, [FILE])
  assert.equal(records.size, 0, 'the park record is dropped')
}

try {
  // No diff, turn start: the user applied the chat's change live themselves. The next
  // send is not refused and lands normally.
  const turn = await driftPark()
  writeFileSync(join(turn.root, FILE), 'export const bar = 1\n')
  await beforeTurn(turn.key, 'next')
  assertCleared(turn)
  writeFileSync(join(turn.cwd, OTHER), 'export const baz = 2\n')
  await afterTurn(turn.key, 'Set baz', [], 'success')
  assert.equal(events.at(-1).state, 'merged')
  assert.equal(read(turn.root, OTHER), 'export const baz = 2\n')
  await releaseChat(turn.key)

  // No diff, chat open: the same reconcile runs for every idle parked chat.
  const open = await driftPark()
  writeFileSync(join(open.root, FILE), 'export const bar = 1\n')
  await reconcileIdleParks(() => false)
  assertCleared(open)
  assert.equal(await reconcilePark(open.key, 'chat-open'), 'none', 'settled once')
  await releaseChat(open.key)

  // No diff, agent tool: workspace_state answers one consistent status, never parked.
  const tool = await driftPark()
  writeFileSync(join(tool.root, FILE), 'export const bar = 1\n')
  turnTimings.received(tool.key, 'turn-timed')
  const reported = await runTreziTool('workspace_state', {}, scope(tool))
  assert.equal(reported.state, 'isolated')
  assert.equal(reported.lastLanding.outcome, 'merged')
  // LKM-200: the agent reads its turn's timing, this very call included (still running).
  assert.equal(reported.timing.current.turn, 'turn-timed')
  assert.deepEqual(
    reported.timing.current.tools.map((call) => [call.tool, call.ms]),
    [['workspace_state', null]]
  )
  turnTimings.completed(tool.key, 'turn-timed')
  assertCleared(tool)
  await releaseChat(tool.key)

  // A failed landing whose files were written live before it threw holds nothing:
  // it is cleared, not left on Retry with an empty batch.
  const failed = await fixture()
  const st = states.get(failed.key)
  st.parked = true
  st.landingError = 'git blew up after writing the files'
  assert.equal(agentWorkspaceState(failed.key).state, 'failed')
  const prep = await runTreziTool('prepare_conflict_resolution', {}, scope(failed))
  assert.equal(prep.ok, false)
  assert.equal(prep.state, 'isolated')
  assert.match(prep.guidance, /no parked Trezi batch/)
  assert.equal(events.at(-1).state, 'isolated')
  await releaseChat(failed.key)

  // A pending diff the chat lost track of: parked files and record gone, plus an
  // uncommitted edit in the worktree. Chat open rebuilds the batch, and Resolve works.
  const lost = await driftPark()
  const lst = states.get(lost.key)
  lst.parkedFiles = []
  records.clear()
  lst.parkRecordId = null
  writeFileSync(join(lost.cwd, OTHER), 'export const baz = 3\n')
  assert.equal(await reconcilePark(lost.key, 'chat-open'), 'rebuilt')
  assert.equal(events.at(-1).state, 'parked')
  assert.deepEqual(events.at(-1).files.toSorted(), [FILE, OTHER])
  assert.deepEqual(lst.parkedFiles.toSorted(), [FILE, OTHER])
  assert.equal(records.size, 1, 'the park record is restored')
  const parked = await runTreziTool('workspace_state', {}, scope(lost))
  assert.equal(parked.state, 'parked')
  assert.deepEqual(parked.files.toSorted(), [FILE, OTHER], 'parked always names its batch')
  assert.equal(git(lost.cwd, 'status', '--porcelain'), '', 'the edit is in the batch')
  assert.deepEqual(await resolveParkedChat(lost.key), { ok: true, conflicted: [FILE] })
  await beforeTurn(lost.key, 'resolve')
  writeFileSync(join(lost.cwd, FILE), 'export const bar = 19\n')
  await afterTurn(lost.key, 'Resolve conflicts', [], 'success')
  assert.equal(events.at(-1).state, 'merged')
  assert.equal(read(lost.root), 'export const bar = 19\n')
  assert.equal(read(lost.root, OTHER), 'export const baz = 3\n')
  await releaseChat(lost.key)

  // Parked with no batch at all but uncommitted work: the batch is built, Retry lands it.
  const bare = await fixture()
  const bst = states.get(bare.key)
  bst.parked = true
  bst.landingError = 'The landing failed.'
  writeFileSync(join(bare.cwd, OTHER), 'export const baz = 4\n')
  assert.equal(await reconcilePark(bare.key, 'chat-open'), 'rebuilt')
  assert.equal(events.at(-1).state, 'parked')
  assert.equal(events.at(-1).reason, 'failed')
  assert.deepEqual(events.at(-1).files, [OTHER])
  assert.deepEqual(await retryLanding(bare.key), { ok: true, state: 'isolated' })
  assert.equal(read(bare.root, OTHER), 'export const baz = 4\n')
  await releaseChat(bare.key)

  // A real conflict is kept as it is.
  const real = await driftPark()
  const before = events.length
  assert.equal(await reconcilePark(real.key, 'chat-open'), 'kept')
  assert.equal(events.length, before, 'a real park emits nothing')
  assert.equal(isolationSnapshot(real.key).state, 'parked')
  await releaseChat(real.key)

  console.log(
    'CHAT GHOST PARK OK — stale park cleared on turn start, chat open and workspace tools; lost batch rebuilt and resolvable'
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}
