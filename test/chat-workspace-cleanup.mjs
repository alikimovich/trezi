// LKM-136 chat workspace cleanup, through the Swift repository owner (run by
// test/repository-owner.mjs with its preload): the idle sweep removes clean checkouts,
// keeps parked, running and dirty ones (dirty work goes to a recovery ref, once), the
// next turn recreates a removed checkout and lands; closing a chat removes its clean
// checkout; old-name folders go only once migrated or empty; usage is measured.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  afterTurn,
  beforeTurn,
  initChatIsolation,
  isolatedCwd,
  releaseChat
} from '../src/main/chat-isolation.ts'
import {
  cleanLegacyWorkspaces,
  cleanUpWorkspacesNow,
  idlePeriod,
  initChatWorkspaces,
  legacyWorkspaceDirs,
  sweepIdleWorkspaces,
  workspaceUsage
} from '../src/main/chat-workspaces.ts'
import { removeLegacyFolder } from '../src/main/worktrees.ts'

const DAY = 24 * 60 * 60 * 1000
const base = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-workspace-cleanup-')))
const worktrees = join(base, 'profile', 'trezi', 'worktrees')
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const read = (path) => readFileSync(path, 'utf8')
const records = new Map()
const busy = new Set()
let legacy = []
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
initChatWorkspaces({
  worktreesDir: () => worktrees,
  busy: (key) => busy.has(key),
  legacyDirs: () => legacy
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
/** One landed turn: the chat writes `file`, the turn lands on the live checkout. */
async function turn(key, root, file, text) {
  await beforeTurn(key, 'edit')
  const cwd = await isolatedCwd(root, key)
  writeFileSync(join(cwd, file), text)
  await afterTurn(key, `write ${file}`, [], 'success')
  return cwd
}
const later = (days = 8) => Date.now() + days * DAY

try {
  assert.equal(idlePeriod(null), 7 * DAY, 'default idle period is 7 days')
  assert.equal(idlePeriod('14'), 14 * DAY)
  assert.equal(idlePeriod('never'), null)
  assert.equal(idlePeriod('2'), 7 * DAY, 'an unknown value falls back to the default')
  assert.deepEqual(
    legacyWorkspaceDirs(join(base, 'support', 'Trezi Native')).map((p) => p.slice(base.length)),
    [
      '/support/Praxis/praxis/worktrees',
      '/support/Praxis/dsgn/worktrees',
      '/support/dsgn/praxis/worktrees',
      '/support/dsgn/dsgn/worktrees'
    ]
  )

  const live = repo('live')
  const idle = await turn('idle', live, 'idle.txt', 'idle chat\n')
  const parked = await isolatedCwd(live, 'parked')
  const running = await turn('running', live, 'running.txt', 'running chat\n')
  const dirty = await turn('dirty', live, 'dirty.txt', 'dirty chat\n')
  assert.equal(read(join(live, 'idle.txt')), 'idle chat\n', 'turns land')
  // Park one chat: the live checkout changes the file the turn edits, mid-turn.
  await beforeTurn('parked', 'edit')
  writeFileSync(join(parked, 'a.txt'), 'chat side\n')
  writeFileSync(join(live, 'a.txt'), 'user side\n')
  await afterTurn('parked', 'conflicting', [], 'success')
  assert.ok(records.get(`chatpark-${parked.split('/').at(-1)}`), 'the conflicting turn parked')
  writeFileSync(join(live, 'a.txt'), 'one\n')
  // Uncommitted work left in a chat's checkout after its turn.
  writeFileSync(join(dirty, 'notes.txt'), 'not landed\n')
  busy.add('running')
  const refs = recovery(live).length

  // Not idle yet: nothing is touched.
  assert.deepEqual(await sweepIdleWorkspaces(7 * DAY), { removed: 0, keptDirty: 0, skipped: 4 })
  assert.ok(existsSync(idle))

  // Idle: the clean checkout goes; parked, running and dirty ones stay.
  assert.deepEqual(await sweepIdleWorkspaces(7 * DAY, later()), {
    removed: 1,
    keptDirty: 1,
    skipped: 2
  })
  assert.equal(existsSync(idle), false, 'the idle clean checkout is removed')
  assert.ok(
    !branches(live).some((b) => b.endsWith(idle.split('/').at(-1))),
    'its retired branch is gone'
  )
  assert.ok(existsSync(parked), 'a parked chat keeps its checkout')
  assert.ok(existsSync(running), 'a running chat keeps its checkout')
  assert.ok(existsSync(join(dirty, 'notes.txt')), 'a dirty checkout is kept as is')
  const added = recovery(live).slice(refs)
  assert.equal(added.length, 1, 'only the dirty checkout gets a recovery ref')
  assert.match(added[0], new RegExp(`-idle-${dirty.split('/').at(-1)}$`))
  assert.equal(
    git(live, 'show', `${added[0]}:notes.txt`),
    'not landed',
    'the dirty work is in recovery'
  )
  assert.deepEqual(await sweepIdleWorkspaces(7 * DAY, later()), {
    removed: 0,
    keptDirty: 1,
    skipped: 3
  })
  assert.equal(recovery(live).length, refs + 1, 'a second sweep adds no duplicate ref')

  // The next turn recreates the checkout from the live tree and lands.
  writeFileSync(join(live, 'live.txt'), 'edited while idle\n')
  assert.equal(await turn('idle', live, 'after.txt', 'after cleanup\n'), idle)
  assert.ok(existsSync(idle), 'the checkout is back at the same path')
  assert.equal(read(join(idle, 'live.txt')), 'edited while idle\n', 'it starts from the live tree')
  assert.equal(read(join(live, 'after.txt')), 'after cleanup\n', 'its turn lands')

  // Usage counts every checkout; "Clean up now" applies the same rules with no idle period.
  const usage = await workspaceUsage()
  assert.equal(usage.workspaces, 4)
  assert.ok(usage.bytes > 0)
  const now = await cleanUpWorkspacesNow()
  assert.equal(now.removed, 1, 'Clean up now removes the clean idle checkout')
  assert.equal(now.keptDirty, 1)
  assert.equal(existsSync(idle), false)
  assert.ok(existsSync(parked) && existsSync(running) && existsSync(dirty))
  assert.equal(now.usage.workspaces, 3)

  // A session restarted with no turn (model change, rebuild after a stop) goes through
  // isolatedCwd: it gets the checkout back before any provider starts in it.
  assert.equal(existsSync(idle), false)
  const restarted = await isolatedCwd(live, 'idle')
  assert.equal(restarted, idle, 'the same path comes back')
  assert.ok(existsSync(restarted), 'the restarted session has a checkout to run in')
  assert.equal(git(restarted, 'rev-parse', '--show-toplevel'), idle, 'it is a working checkout')
  assert.equal(
    read(join(restarted, 'after.txt')),
    'after cleanup\n',
    'it starts from the live tree'
  )
  assert.deepEqual(
    await sweepIdleWorkspaces(7 * DAY),
    { removed: 0, keptDirty: 0, skipped: 4 },
    'a restarted chat is in use, not idle'
  )
  await beforeTurn('idle', 'edit')
  assert.equal(await isolatedCwd(live, 'idle'), idle, 'an existing checkout is returned as is')

  // Closing (archiving) a chat removes its clean checkout; a reclaimed chat closes cleanly.
  busy.delete('running')
  await releaseChat('running')
  assert.equal(existsSync(running), false, 'closing a clean chat removes its checkout')
  await releaseChat('idle')
  assert.equal(existsSync(idle), false)
  await releaseChat('parked')
  assert.equal(existsSync(parked), false)
  assert.ok(
    branches(live).some((b) => b.endsWith(parked.split('/').at(-1))),
    'a parked chat keeps its branch for review'
  )

  // Old-name folders: emptied through orphan recovery, removed only when nothing else is left.
  const support = join(base, 'support')
  const migrated = join(support, 'Praxis', 'praxis', 'worktrees')
  const unknown = join(support, 'dsgn', 'dsgn', 'worktrees')
  const empty = join(support, 'dsgn', 'praxis', 'worktrees')
  for (const dir of [migrated, unknown, empty]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(support, 'Praxis', 'Cookies'), 'old app data\n')
  writeFileSync(join(empty, '.DS_Store'), '')
  const old = repo('old')
  git(
    old,
    'worktree',
    'add',
    '-q',
    '-b',
    'praxis/chat-oldclean',
    join(migrated, 'oldclean'),
    'main'
  )
  git(
    old,
    'worktree',
    'add',
    '-q',
    '-b',
    'praxis/chat-olddirty',
    join(migrated, 'olddirty'),
    'main'
  )
  writeFileSync(join(migrated, 'olddirty', 'work.txt'), 'old unlanded work\n')
  mkdirSync(join(unknown, 'stuff'))
  writeFileSync(join(unknown, 'stuff', 'keep.txt'), 'not a worktree\n')
  legacy = [migrated, unknown, empty, join(support, 'Praxis', 'dsgn', 'worktrees')]
  const before = await workspaceUsage()
  assert.ok(before.workspaces >= 3, 'usage includes old-name folders')
  const cleaned = await cleanLegacyWorkspaces()
  assert.deepEqual(cleaned.removed.sort(), [empty, migrated].sort())
  assert.deepEqual(cleaned.kept, [unknown])
  assert.equal(
    existsSync(join(support, 'Praxis', 'praxis')),
    false,
    'the emptied old-name folder is removed'
  )
  assert.ok(existsSync(join(support, 'Praxis', 'Cookies')), 'other old-app data is left alone')
  assert.equal(existsSync(join(support, 'dsgn', 'praxis')), false)
  assert.deepEqual(
    readdirSync(join(unknown, 'stuff')),
    ['keep.txt'],
    'a folder that is not a checkout stays'
  )
  const record = records.get('chatpark-olddirty')
  assert.ok(record, 'dirty old-name work is recoverable')
  assert.equal(git(old, 'show', `${record.branch}:work.txt`), 'old unlanded work')
  assert.equal((await cleanLegacyWorkspaces()).removed.length, 0, 'a second pass is a no-op')
  // The service removes only an old-name `worktrees` folder, never another empty one.
  const other = join(base, 'profile', 'other', 'worktrees')
  mkdirSync(other, { recursive: true })
  assert.equal(await removeLegacyFolder(other), false)
  assert.ok(existsSync(other), 'a folder without an old-name parent is refused')
  console.log(
    'CHAT WORKSPACE CLEANUP OK — idle removal, parked/running/dirty kept, lazy recreate, close removes, legacy folders, usage'
  )
} finally {
  rmSync(base, { recursive: true, force: true })
}
