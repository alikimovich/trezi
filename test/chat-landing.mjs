// LKM-159: a finished turn (`afterTurn`) and a kept stopped turn (`keepStoppedTurn`)
// land through the one `landTurn` step: the same undo group, live commit, unpark, retire
// and `merged` event, and the same PR revertability. `parked` is only ever cleared by
// `clearPark`. Runs through the Swift repository and source owners
// (test/repository-owner.mjs, suites list).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  adoptSession,
  afterTurn,
  beforeTurn,
  initChatIsolation,
  isolatedCwd,
  isolationSnapshot,
  landNow,
  releaseChat,
  resolveParkedChat
} from '../src/main/chat-isolation.ts'
import { states } from '../src/main/chat-state.ts'
import { revertGroup } from '../src/main/edit-history.ts'
import { keepStoppedTurn } from '../src/main/stopped-turn.ts'

// No unpark outside `clearPark` (src/main/chat-park.ts).
const mainDir = new URL('../src/main/', import.meta.url)
const unparks = readdirSync(mainDir, { recursive: true })
  .filter((name) => name.endsWith('.ts'))
  .filter((name) => /\.parked\s*=\s*false/.test(readFileSync(new URL(name, mainDir), 'utf8')))
assert.deepEqual(unparks, ['chat-park.ts'], 'only clearPark sets parked = false')

const dir = mkdtempSync(join(tmpdir(), 'trezi-chat-landing-'))
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
  }),
  // A mocked background model (LKM-189): it describes the diff it is shown.
  describe: () => async (prompt) => {
    const value = prompt.match(/^\+export const bar = (\d)$/m)?.[1]
    return value ? `Set the bar constant to ${value}\n\n- Change bar in src/bar.ts` : null
  }
})

const FILE = 'src/bar.ts'
let n = 0
async function fixture(prUrl) {
  const key = `landing-${n++}`
  const root = join(dir, key)
  mkdirSync(join(root, 'src'), { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(root, '.gitignore'), 'node_modules\n.env\n')
  writeFileSync(join(root, FILE), 'export const bar = 0\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'initial')
  const cwd = await isolatedCwd(root, key)
  adoptSession(key, { id: key, prUrl }, root)
  await beforeTurn(key, 'edit')
  const branch = isolationSnapshot(key).branch
  events.length = 0
  return { key, root, cwd, branch, id: branch.replace(/^trezi\/chat-/, '') }
}

/** The landing both paths share, checked on the live checkout and the last event. */
function assertLanded(chat, { turn, title, content, revertable }) {
  const group = `chat:${chat.id}:${turn}`
  assert.deepEqual(events.at(-1), {
    type: 'isolation',
    state: 'merged',
    branch: chat.branch,
    files: [FILE],
    group,
    revertable,
    projectKey: chat.key
  })
  assert.equal(readFileSync(join(chat.root, FILE), 'utf8'), content)
  assert.equal(git(chat.root, 'log', '-1', '--format=%s'), title)
  assert.ok(
    git(chat.root, 'log', '-1', '--format=%b').endsWith(
      `\n\nTrezi-Turn: ${turn}\nTrezi-Chat: ${chat.branch}`
    ),
    'the trailers close the body'
  )
  assert.equal(git(chat.root, 'status', '--porcelain'), '')
  assert.deepEqual(isolationSnapshot(chat.key), { state: 'isolated', branch: chat.branch })
  assert.equal(records.has(`chatpark-${chat.id}`), false, 'this chat’s park record is dropped')
  return group
}

try {
  // A running agent can land, keep editing, and leave only the later delta to
  // the ordinary turn-end hook.
  const mid = await fixture()
  writeFileSync(join(mid.cwd, FILE), 'export const bar = 1\n')
  const first = await landNow(mid.key, 'Set bar to one')
  assert.equal(first.outcome, 'merged')
  assert.equal(first.commit, git(mid.root, 'rev-parse', 'HEAD'))
  assert.equal(readFileSync(join(mid.root, FILE), 'utf8'), 'export const bar = 1\n')
  writeFileSync(join(mid.cwd, FILE), 'export const bar = 2\n')
  await afterTurn(mid.key, 'Set bar to two', [], 'success')
  assert.equal(readFileSync(join(mid.root, FILE), 'utf8'), 'export const bar = 2\n')
  assert.notEqual(git(mid.root, 'rev-parse', 'HEAD'), first.commit)
  assert.equal(git(mid.root, 'rev-list', '--count', `${first.commit}..HEAD`), '1')
  await releaseChat(mid.key)

  const conflict = await fixture()
  writeFileSync(join(conflict.cwd, FILE), 'export const bar = 3\n')
  writeFileSync(join(conflict.root, FILE), 'export const bar = 4\n')
  const parked = await landNow(conflict.key, 'Set bar to three')
  assert.equal(parked.outcome, 'parked')
  assert.deepEqual(parked.files, [FILE])
  assert.equal(readFileSync(join(conflict.root, FILE), 'utf8'), 'export const bar = 4\n')
  const prepared = await resolveParkedChat(conflict.key)
  assert.deepEqual(prepared.conflicted, [FILE])
  writeFileSync(join(conflict.cwd, FILE), 'export const bar = 5\n')
  const resolved = await landNow(conflict.key, 'Resolve both bar edits')
  assert.equal(resolved.outcome, 'merged')
  assert.equal(readFileSync(join(conflict.root, FILE), 'utf8'), 'export const bar = 5\n')
  await releaseChat(conflict.key)

  // A finished turn lands through landTurn.
  const done = await fixture()
  writeFileSync(join(done.cwd, FILE), 'export const bar = 1\n')
  assert.equal(await afterTurn(done.key, 'Set bar to one', [], 'success'), null)
  const doneGroup = assertLanded(done, {
    turn: 1,
    title: 'Set the bar constant to 1',
    content: 'export const bar = 1\n',
    revertable: true
  })
  assert.equal((await revertGroup(done.root, doneGroup)).ok, true)
  assert.equal(
    readFileSync(join(done.root, FILE), 'utf8'),
    'export const bar = 0\n',
    'the finished turn reverts'
  )
  await releaseChat(done.key)

  // A kept stopped turn lands through the same step, leaving its park.
  const kept = await fixture()
  writeFileSync(join(kept.cwd, FILE), 'export const bar = 2\n')
  await afterTurn(kept.key, 'Set bar to two', [], 'failed')
  assert.equal(events.at(-1).state, 'parked')
  assert.equal(records.size, 1)
  const result = await keepStoppedTurn(kept.key)
  const keptGroup = assertLanded(kept, {
    turn: 2,
    title: 'Set the bar constant to 2',
    content: 'export const bar = 2\n',
    revertable: true
  })
  assert.deepEqual(result, { ok: true, files: [FILE], group: keptGroup })
  assert.equal((await revertGroup(kept.root, keptGroup)).ok, true)
  assert.equal(
    readFileSync(join(kept.root, FILE), 'utf8'),
    'export const bar = 0\n',
    'the kept turn reverts'
  )
  await releaseChat(kept.key)

  // Work merged through a PR is not revertable, on either path.
  const pr = await fixture('https://github.com/example/app/pull/1')
  writeFileSync(join(pr.cwd, FILE), 'export const bar = 3\n')
  await afterTurn(pr.key, 'Set bar to three', [], 'success')
  assertLanded(pr, {
    turn: 1,
    title: 'Set the bar constant to 3',
    content: 'export const bar = 3\n',
    revertable: false
  })
  await beforeTurn(pr.key, 'more')
  writeFileSync(join(pr.cwd, FILE), 'export const bar = 4\n')
  await afterTurn(pr.key, 'Set bar to four', [], 'failed')
  await keepStoppedTurn(pr.key)
  assertLanded(pr, {
    turn: 3,
    title: 'Set the bar constant to 4',
    content: 'export const bar = 4\n',
    revertable: false
  })
  await releaseChat(pr.key)
  // A Full-mode raw merge lands through afterTurn with its two-parent history.
  const full = await fixture()
  git(full.root, 'checkout', '-qb', 'base-updated')
  writeFileSync(join(full.root, 'base-note.txt'), 'new base content\n')
  git(full.root, 'add', 'base-note.txt')
  git(full.root, 'commit', '-qm', 'Advance the base')
  git(full.root, 'checkout', '-q', 'main')
  git(full.cwd, 'merge', '--no-ff', '--no-edit', 'base-updated')
  const rawMerge = git(full.cwd, 'rev-parse', 'HEAD')
  states.get(full.key).gitAccess = 'full'
  await afterTurn(full.key, 'Land the base update', [], 'success')
  assert.equal(readFileSync(join(full.root, 'base-note.txt'), 'utf8'), 'new base content\n')
  git(full.root, 'merge-base', '--is-ancestor', rawMerge, 'HEAD')
  assert.equal(git(full.root, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3)
  await releaseChat(full.key)
  console.log('CHAT LANDING OK — afterTurn and Keep share landTurn; only clearPark unparks')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
