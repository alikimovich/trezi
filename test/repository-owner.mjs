// S07 repository coordinator: the real Swift RepositoryOwner (compiled into a fixture
// process) driven through Bun's real client and the unchanged TS entry points.
// - suites: the Git suites (git, worktrees, chat-worktrees, resolve-conflicts,
//   live-commit, recovery, reconciliation, Next setup) run with the Swift owner installed;
// - malformed-patch: a patch Git cannot read errors with its path and reason, logged in full;
// - lanes: FIFO per common directory (live checkout and worktrees share one), leases,
//   re-entrancy, unrelated repositories concurrent, competing chats landing;
// - external: a foreign index lock, an external commit and the user's staged work;
// - intent: removal/discard/landing refused without their explicit intent, and never
//   aimed at the main checkout, a folder outside the profile or a path-like name;
// - crash: SIGKILL inside a landing, a reconciliation reset and a removal leaves the
//   work reachable from journaled recovery refs, reported (not replayed) next launch;
// - relaunch: a new owner continues on the worktrees; journal and refs are kept; a
//   damaged journal is refused untouched; drain refuses queued work.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  completeTurn,
  createChatWorktree,
  discardParked,
  stageResolve,
  syncFromLive
} from '../src/main/chat-worktrees.ts'
import { setEditingOwner } from '../src/main/editing-owner.ts'
import { commitLiveTurn } from '../src/main/live-commit.ts'
import { enqueueRepoWrite } from '../src/main/repo-write-queue.ts'
import { setRepositoryOwner } from '../src/main/repository-owner.ts'
import { pruneOrphans, removeWorktree, retireWorktreeBranch } from '../src/main/worktrees.ts'
import { compileEditingFixture, startEditingFixture } from './helpers/editing-fixture.mjs'
import { compileRepositoryFixture, startRepositoryFixture } from './helpers/repository-fixture.mjs'
import { useRunnerEnv } from './helpers/runner-env.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi repository-owner-')))
const fixtures = new Set()
let repos = 0

const g = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const read = (path) => readFileSync(path, 'utf8')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function repo(files = { 'a.txt': 'one\n', 'b.txt': 'two\n' }) {
  const path = join(scratch, `repo-${++repos}`)
  mkdirSync(path, { recursive: true })
  g(path, 'init', '-q', '-b', 'main')
  g(path, 'config', 'user.name', 'User')
  g(path, 'config', 'user.email', 'user@local')
  g(path, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(path, '.gitignore'), 'node_modules\n.env\n')
  for (const [name, content] of Object.entries(files)) writeFileSync(join(path, name), content)
  g(path, 'add', '-A')
  g(path, 'commit', '-q', '-m', 'init')
  return path
}
const profile = (name) => {
  const path = join(scratch, name)
  mkdirSync(path, { recursive: true })
  return path
}
const recovery = (repoRoot) =>
  g(repoRoot, 'for-each-ref', '--format=%(refname)', 'refs/trezi/recovery/')
    .split('\n')
    .filter(Boolean)

let binary
async function fixture(profilePath, env = {}) {
  const started = await startRepositoryFixture(binary, profilePath, env)
  fixtures.add(started)
  return started
}
async function stop(started) {
  await started.stop()
  fixtures.delete(started)
}
async function install(started, options) {
  const owner = started.owner(options)
  setRepositoryOwner(owner)
  return owner
}

async function section(name, run) {
  await run()
  console.log(`REPOSITORY-OWNER ${name} PASS`)
}

/** A chat worktree with its branch attached, as at the start of a turn. */
async function chat(live, dir, id) {
  const wt = await createChatWorktree(live, id, dir)
  await syncFromLive(live, wt)
  return wt
}

try {
  binary = compileRepositoryFixture()
  const suiteFixture = compileEditingFixture()
  // After the cached compiles: from here on Git, the fixtures and the suites see the CI runner's conditions.
  // biome-ignore lint/correctness/useHookAtTopLevel: not a React hook, it sets the process env
  useRunnerEnv(scratch)
  // Creating a chat worktree copies the setup helpers through the editing owner: one
  // editing process serves every section (the repository owner under test is swapped).
  const editing = await startEditingFixture(suiteFixture, profile('editing'), {
    REPOSITORY_WORKTREES_ROOT: scratch
  })
  fixtures.add(editing)
  setEditingOwner(editing.owners().editing)

  await section('suites', async () => {
    // The Git suites' own assertions, through the Swift owner. (setup-next installs the
    // Swift owners itself: test/helpers/with-service-owners.mjs.)
    // Chat worktrees also need the editing owner, so these run on the editing fixture.
    const suites = [
      'chat-worktrees',
      'resolve-conflicts',
      'worktrees',
      'live-commit',
      'git',
      'chat-recovery',
      'auto-reconciliation',
      'chat-workspace-cleanup',
      'chat-spare',
      'stop-recovery',
      'chat-landing',
      'chat-landing-recovery',
      'chat-ghost-park',
      'setup-worktree'
    ]
    const results = await Promise.all(
      suites.map(
        (suite) =>
          new Promise((resolve) => {
            const child = spawn(
              'bun',
              ['--preload', './test/helpers/repository-owner-preload.mjs', `test/${suite}.mjs`],
              {
                cwd: root,
                env: {
                  ...process.env,
                  REPOSITORY_FIXTURE: suiteFixture,
                  REPOSITORY_PROFILE: profile(`parity-${suite}`)
                },
                stdio: ['ignore', 'pipe', 'pipe']
              }
            )
            let output = ''
            child.stdout.on('data', (data) => {
              output += data
            })
            child.stderr.on('data', (data) => {
              output += data
            })
            const timer = setTimeout(() => child.kill('SIGKILL'), 100_000)
            child.on('exit', (code, signal) => {
              clearTimeout(timer)
              resolve({ suite, code, signal, output })
            })
          })
      )
    )
    // Every failed suite's output, not only the first: CI shows just this log's tail.
    const failed = results.filter(({ code }) => code !== 0)
    assert.deepEqual(
      failed.map(({ suite }) => suite),
      [],
      failed
        .map(
          ({ suite, code, signal, output }) =>
            `--- ${suite} against the Swift owner exited ${code ?? signal}:\n${output.slice(-3000)}`
        )
        .join('\n')
    )
    for (const { suite, output } of results)
      assert.ok(
        Number(/REPOSITORY-PARITY frames=(\d+)/.exec(output)?.[1] ?? 0) > 0,
        `${suite} sent no repository frames`
      )
  })

  await section('lanes', async () => {
    const owned = await fixture(profile('lanes'))
    await install(owned)
    const live = repo(),
      other = repo()
    const dir = join(scratch, 'lanes', 'trezi', 'worktrees')
    const wt = await chat(live, dir, 'lane1')
    const log = []
    const at = (label) => log.push([label, Date.now()])
    const when = (label) => log.find(([name]) => name === label)[1]

    // Acquiring is a service round trip: queue B and C only once A holds the lane.
    let granted
    const leased = new Promise((resolve) => {
      granted = resolve
    })
    const a = enqueueRepoWrite(live, async () => {
      at('A start')
      granted()
      await sleep(300)
      at('A end')
    })
    await leased
    // A worktree root resolves to the same common directory: same lane, after A.
    const b = enqueueRepoWrite(wt.path, async () => {
      at('B start')
    })
    // A Swift effect outside any lease queues in the lane too.
    writeFileSync(join(live, 'c.txt'), 'c\n')
    const c = commitLiveTurn(live, ['c.txt'], { title: 'lane commit' }).then((result) => {
      at('C done')
      return result
    })
    // An unrelated repository is not serialized behind them.
    const d = enqueueRepoWrite(other, async () => {
      at('D start')
    })
    await Promise.all([a, b, c, d])
    assert.ok(when('B start') >= when('A end'), 'a worktree waits for the live checkout lane')
    assert.ok(when('C done') >= when('A end'), 'an effect waits for the lease')
    assert.ok(when('D start') < when('A end'), 'another repository runs concurrently')
    assert.equal((await c).committed, true)

    // Re-entrant: a nested lease on the same repository and effects inside a lease.
    const inner = await Promise.race([
      enqueueRepoWrite(live, () =>
        enqueueRepoWrite(wt.path, async () => {
          writeFileSync(join(live, 'd.txt'), 'd\n')
          return (await commitLiveTurn(live, ['d.txt'], { title: 'inside the lease' })).committed
        })
      ),
      sleep(10_000).then(() => 'deadlock')
    ])
    assert.equal(inner, true)

    // Competing chats land in one order, both committed, nothing lost.
    const one = await chat(live, dir, 'lane2'),
      two = await chat(live, dir, 'lane3')
    writeFileSync(join(one.path, 'one.txt'), 'from chat one\n')
    writeFileSync(join(two.path, 'two.txt'), 'from chat two\n')
    const land = (wtree, title) =>
      enqueueRepoWrite(live, async () => {
        const outcome = await completeTurn(live, wtree, title)
        assert.equal(outcome.outcome, 'merged', title)
        return commitLiveTurn(live, outcome.files, { title })
      })
    const [first, second] = await Promise.all([
      land(one, 'chat one turn'),
      land(two, 'chat two turn')
    ])
    assert.ok(first.committed && second.committed)
    assert.equal(read(join(live, 'one.txt')), 'from chat one\n')
    assert.equal(read(join(live, 'two.txt')), 'from chat two\n')
    const subjects = g(live, 'log', '--format=%s', '-4')
    assert.match(subjects, /chat one turn/)
    assert.match(subjects, /chat two turn/)
    assert.equal(g(live, 'status', '--porcelain', '--', 'one.txt', 'two.txt'), '')
    setRepositoryOwner(null)
    await stop(owned)
  })

  await section('external', async () => {
    const owned = await fixture(profile('external'))
    await install(owned)
    const live = repo({ 'a.txt': 'one\n', 'b.txt': 'two\n', 'c.txt': 'three\n' })
    const dir = join(scratch, 'external', 'trezi', 'worktrees')
    // The user's own staged work stays staged and out of Trezi's commit.
    writeFileSync(join(live, 'c.txt'), 'staged by the user\n')
    g(live, 'add', 'c.txt')
    const wt = await chat(live, dir, 'ext1')
    writeFileSync(join(wt.path, 'a.txt'), 'one, by the chat\n')
    let outcome = await completeTurn(live, wt, 'turn under a lock')
    assert.equal(outcome.outcome, 'merged')
    wt.baseSha = outcome.newBase
    // A foreign Git process holds the index: the commit is refused, the files stay.
    writeFileSync(join(live, '.git', 'index.lock'), '')
    const locked = await commitLiveTurn(live, outcome.files, { title: 'locked' })
    assert.equal(locked.committed, false)
    assert.equal(read(join(live, 'a.txt')), 'one, by the chat\n')
    rmSync(join(live, '.git', 'index.lock'))
    const unlocked = await commitLiveTurn(live, outcome.files, { title: 'after the lock' })
    assert.equal(unlocked.committed, true)
    assert.equal(g(live, 'show', '--name-only', '--format=', 'HEAD'), 'a.txt')
    assert.equal(g(live, 'diff', '--cached', '--name-only'), 'c.txt')
    // An external commit moves HEAD between turns; the next turn builds on it.
    await retireWorktreeBranch(wt)
    writeFileSync(join(live, 'b.txt'), 'two, committed outside Trezi\n')
    g(live, 'commit', '-q', '-m', 'outside', '--', 'b.txt')
    const outside = g(live, 'rev-parse', 'HEAD')
    assert.equal((await syncFromLive(live, wt)).synced, true)
    assert.equal(read(join(wt.path, 'b.txt')), 'two, committed outside Trezi\n')
    writeFileSync(join(wt.path, 'e.txt'), 'new\n')
    outcome = await completeTurn(live, wt, 'after the outside commit')
    assert.equal(outcome.outcome, 'merged')
    assert.equal(
      (await commitLiveTurn(live, outcome.files, { title: 'after the outside commit' })).committed,
      true
    )
    assert.equal(g(live, 'rev-parse', 'HEAD^'), outside)
    assert.equal(g(live, 'diff', '--cached', '--name-only'), 'c.txt')
    setRepositoryOwner(null)
    await stop(owned)
  })

  await section('intent', async () => {
    const home = profile('intent')
    const owned = await fixture(home)
    await install(owned)
    const live = repo()
    const dir = join(home, 'trezi', 'worktrees')
    const wt = await chat(live, dir, 'int1')
    writeFileSync(join(wt.path, 'a.txt'), 'unlanded chat work\n')
    const head = g(live, 'rev-parse', 'HEAD')
    const worktree = {
      id: wt.id,
      repoRoot: live,
      path: wt.path,
      branch: wt.branch,
      baseSha: wt.baseSha
    }
    const refused = async (method, body, code, extra) => {
      const result = await owned.frame(method, body, extra)
      assert.equal(result.kind, 'failed', `${method} ${JSON.stringify(body)}`)
      assert.equal(result.payload.code, code, `${method}: ${result.payload.message}`)
    }
    await refused('discardParked', { root: live, worktree }, 'invalidRequest')
    await refused('discardParked', { root: live, worktree, intent: 'land' }, 'invalidRequest')
    await refused(
      'removeWorktree',
      { root: live, worktree, keepBranch: false, intent: 'delete' },
      'invalidRequest'
    )
    await refused('removeWorktree', { root: live, worktree, keepBranch: false }, 'invalidRequest')
    await refused('completeTurn', { root: live, worktree, message: 'x' }, 'invalidRequest')
    await refused(
      'deleteBranch',
      { root: live, branch: 'main', intent: 'discard' },
      'invalidRequest'
    )
    await refused('switchBranch', { root: live, branch: 'main' }, 'invalidRequest')
    await refused(
      'commitLive',
      { root: live, files: ['a.txt'], title: 't', extra: 1 },
      'invalidRequest'
    )
    await refused('commitLive', { root: live, files: ['a.txt'], title: 't' }, 'invalidRequest', {
      expectedRevision: { epoch: 'e', counter: '1' }
    })
    await refused('commitLive', { root: live, files: ['a.txt'], title: 't' }, 'unauthorized', {
      scope: { project: 'x' }
    })
    // Never the user's main checkout, never a checkout outside the profile.
    writeFileSync(join(live, 'b.txt'), 'the user is editing\n')
    await refused(
      'discardParked',
      { root: live, worktree: { ...worktree, path: live }, intent: 'discard' },
      'unauthorized'
    )
    await refused(
      'syncWorktree',
      { root: live, worktree: { ...worktree, path: live } },
      'unauthorized'
    )
    const foreign = join(scratch, 'foreign-worktree')
    g(live, 'worktree', 'add', '-q', '-b', 'trezi/foreign', foreign)
    writeFileSync(join(foreign, 'a.txt'), "the user's own worktree\n")
    await refused(
      'discardParked',
      {
        root: live,
        worktree: { ...worktree, path: foreign, branch: 'trezi/foreign' },
        intent: 'discard'
      },
      'unauthorized'
    )
    assert.equal(read(join(foreign, 'a.txt')), "the user's own worktree\n")
    assert.equal(read(join(live, 'b.txt')), 'the user is editing\n')
    assert.equal(read(join(wt.path, 'a.txt')), 'unlanded chat work\n')
    assert.equal(g(live, 'rev-parse', 'HEAD'), head)
    // A name that is not a local branch is never handed to `git checkout` as a path.
    const checkout = await owned.frame('checkout', { root: live, branch: 'b.txt' })
    assert.equal(checkout.kind, 'succeeded')
    assert.match(checkout.payload.error, /not a local branch/)
    assert.equal(read(join(live, 'b.txt')), 'the user is editing\n')
    // With intent: discard is still recoverable, and removing dirty work keeps it.
    await discardParked(wt)
    assert.equal(read(join(wt.path, 'a.txt')), 'one\n')
    const discarded = recovery(live).find((ref) => ref.includes('-discardParked-'))
    assert.ok(discarded, 'discard keeps a recovery ref')
    assert.equal(g(live, 'show', `${discarded}:a.txt`), 'unlanded chat work')
    writeFileSync(join(wt.path, 'new.txt'), 'dirty at removal\n')
    await removeWorktree(live, wt, { keepBranch: false, intent: 'abandon' })
    assert.equal(existsSync(wt.path), false)
    const removed = recovery(live).find((ref) => ref.includes('-removeWorktree-'))
    assert.ok(removed, 'removal of dirty work keeps a recovery ref')
    assert.equal(g(live, 'show', `${removed}:new.txt`), 'dirty at removal')
    const status = await owned.frame('status', {})
    assert.deepEqual(status.payload.active, [])
    assert.deepEqual(status.payload.interrupted, [])
    setRepositoryOwner(null)
    await stop(owned)
  })

  await section('crash', async () => {
    const home = profile('crash')
    const dir = join(home, 'trezi', 'worktrees')
    const live = repo()
    const crashed = async (point, act) => {
      const owned = await fixture(home, { REPOSITORY_FAULT: point })
      await install(owned, { timeout: 1500 })
      const pending = act().then(
        () => 'answered',
        (error) => error
      )
      const status = await owned.exited
      fixtures.delete(owned)
      assert.equal(status.signal, 'SIGKILL', `${point}: ${owned.stderr}`)
      await pending
      setRepositoryOwner(null)
    }
    const restart = async () => {
      const owned = await fixture(home)
      await install(owned)
      return owned
    }
    const interrupted = async (owned, kind) => {
      const entry = (await owned.frame('status', {})).payload.interrupted.find(
        (item) => item.kind === kind
      )
      assert.ok(entry, `${kind} is reported as interrupted`)
      return entry
    }

    // A landing killed after its first file write.
    let owned = await restart()
    const wt = await chat(live, dir, 'crash1')
    setRepositoryOwner(null)
    await stop(owned)
    writeFileSync(join(wt.path, 'a.txt'), 'one, landed\n')
    writeFileSync(join(wt.path, 'b.txt'), 'two, landed\n')
    await crashed('land.write', () => completeTurn(live, wt, 'crashing turn'))
    assert.equal(read(join(live, 'a.txt')), 'one, landed\n', 'the first write happened')
    assert.equal(read(join(live, 'b.txt')), 'two\n', 'the second did not')
    owned = await restart()
    const landing = await interrupted(owned, 'completeTurn')
    const target = landing.refs.find((ref) => ref.endsWith('-target'))
    assert.ok(target && recovery(live).includes(target), 'the target commit is kept')
    assert.equal(g(live, 'show', `${target}:b.txt`), 'two, landed')
    assert.equal(read(join(live, 'a.txt')), 'one, landed\n', 'nothing is reset on restart')
    assert.ok(existsSync(wt.path), 'the worktree is kept')
    assert.equal(g(live, 'rev-parse', `refs/heads/${wt.branch}`), g(live, 'rev-parse', target))
    assert.equal(
      (await owned.frame('acknowledge', { operationID: landing.operationID })).kind,
      'failed',
      'acknowledge needs its intent'
    )
    assert.equal(
      (
        await owned.frame('acknowledge', {
          operationID: landing.operationID,
          intent: 'acknowledge'
        })
      ).kind,
      'succeeded'
    )
    assert.equal(
      (await owned.frame('status', {})).payload.interrupted.some(
        (item) => item.operationID === landing.operationID
      ),
      false
    )
    assert.ok(recovery(live).includes(target), 'acknowledging keeps the ref')
    setRepositoryOwner(null)
    await stop(owned)

    // A reconciliation killed right after it reset the worktree onto the live tree.
    const parkedLive = repo()
    owned = await restart()
    const parked = await chat(parkedLive, dir, 'crash2')
    writeFileSync(join(parked.path, 'a.txt'), "one, the chat's version\n")
    writeFileSync(join(parkedLive, 'a.txt'), "one, the user's version\n")
    assert.equal((await completeTurn(parkedLive, parked, 'parked turn')).outcome, 'parked')
    const parkedTip = g(parked.path, 'rev-parse', 'HEAD')
    setRepositoryOwner(null)
    await stop(owned)
    await crashed('resolve.reset', () => stageResolve(parkedLive, parked))
    owned = await restart()
    const resolve = await interrupted(owned, 'stageResolve')
    const parkedRef = resolve.refs.find((ref) => ref.endsWith('-parked'))
    assert.equal(g(parkedLive, 'rev-parse', parkedRef), parkedTip)
    assert.equal(g(parkedLive, 'show', `${parkedRef}:a.txt`), "one, the chat's version")
    assert.equal(read(join(parkedLive, 'a.txt')), "one, the user's version\n")
    setRepositoryOwner(null)
    await stop(owned)

    // A removal killed after preserving dirty work, before the checkout went.
    const removal = await (async () => {
      const o = await restart()
      const w = await chat(live, dir, 'crash3')
      setRepositoryOwner(null)
      await stop(o)
      return w
    })()
    writeFileSync(join(removal.path, 'x.txt'), 'dirty when removed\n')
    await crashed('remove.preserved', () =>
      removeWorktree(live, removal, { keepBranch: false, intent: 'abandon' })
    )
    owned = await restart()
    const removed = await interrupted(owned, 'removeWorktree')
    assert.equal(g(live, 'show', `${removed.refs[0]}:x.txt`), 'dirty when removed')
    assert.ok(existsSync(join(removal.path, 'x.txt')), 'the checkout is still there')
    setRepositoryOwner(null)
    await stop(owned)
  })

  await section('orphans', async () => {
    const home = profile('orphans')
    const dir = join(home, 'trezi', 'worktrees')
    const live = repo()
    let owned = await fixture(home)
    await install(owned)
    // Two orphans: a plain dirty chat, and a PARKED chat (its tip is the cumulative squash).
    const plain = await chat(live, dir, 'orph1')
    const parked = await chat(live, dir, 'orph2')
    writeFileSync(join(parked.path, 'a.txt'), "one, the parked chat's version\n")
    writeFileSync(join(live, 'a.txt'), "one, the user's version\n")
    assert.equal((await completeTurn(live, parked, 'parked turn')).outcome, 'parked')
    const parkedTip = g(parked.path, 'rev-parse', 'HEAD')
    writeFileSync(join(plain.path, 'x.txt'), 'plain dirty work\n')
    writeFileSync(join(parked.path, 'y.txt'), 'parked dirty work\n')
    setRepositoryOwner(null)
    await stop(owned)

    // The recovery commit cannot be made (signing is required and cannot run here).
    g(live, 'config', 'commit.gpgsign', 'true')
    g(live, 'config', 'gpg.program', '/usr/bin/false')
    owned = await fixture(home)
    await install(owned)
    const reclaimed = await pruneOrphans(live, dir, new Set(), (id) => id === parked.id)
    assert.deepEqual(reclaimed.map((item) => item.id).sort(), [parked.id, plain.id].sort())
    // Nothing was force-removed: the dirty files are still on disk (in place or moved aside).
    const found = (id, file) => {
      const names = execFileSync('ls', ['-A', dir], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
      return names
        .filter((name) => name === id || name.startsWith(`.recovered-${id}-`))
        .map((name) => join(dir, name, file))
        .find(existsSync)
    }
    assert.equal(read(found(plain.id, 'x.txt')), 'plain dirty work\n')
    assert.equal(read(found(parked.id, 'y.txt')), 'parked dirty work\n')
    // The parked branch was put back exactly as it was: no fold survived the failed commit.
    assert.equal(g(live, 'rev-parse', `refs/heads/${parked.branch}`), parkedTip)
    // Both dirty states are at their own recovery refs (distinct names within one sweep).
    const refs = recovery(live)
    const dirtyRefs = refs.filter((ref) => ref.endsWith('-orphan-dirty'))
    assert.equal(dirtyRefs.length, 2)
    assert.equal(new Set(refs).size, refs.length)
    const contents = dirtyRefs.map((ref) => g(live, 'ls-tree', '-r', '--name-only', ref)).join('\n')
    assert.match(contents, /x\.txt/)
    assert.match(contents, /y\.txt/)
    assert.ok(
      refs.some((ref) => ref.endsWith('-orphan-head') && g(live, 'rev-parse', ref) === parkedTip),
      'the parked tip has its own ref'
    )
    assert.equal((await owned.frame('status', {})).payload.active.length, 0)
    setRepositoryOwner(null)
    await stop(owned)

    // With a working commit the same sweep recovers the work on the branch and removes the checkout.
    g(live, 'config', '--unset', 'commit.gpgsign')
    g(live, 'config', '--unset', 'gpg.program')
    const again = repo()
    owned = await fixture(home)
    await install(owned)
    const third = await chat(again, join(home, 'trezi', 'worktrees-b'), 'orph3')
    writeFileSync(join(third.path, 'z.txt'), 'committed by recovery\n')
    setRepositoryOwner(null)
    await stop(owned)
    owned = await fixture(home)
    await install(owned)
    const done = await pruneOrphans(
      again,
      join(home, 'trezi', 'worktrees-b'),
      new Set(),
      () => false
    )
    assert.equal(done[0].dirty, true)
    assert.equal(existsSync(third.path), false)
    assert.equal(g(again, 'show', `refs/heads/${third.branch}:z.txt`), 'committed by recovery')
    setRepositoryOwner(null)
    await stop(owned)
  })

  await section('relaunch', async () => {
    const home = profile('relaunch')
    const dir = join(home, 'trezi', 'worktrees')
    const live = repo()
    let owned = await fixture(home)
    await install(owned)
    const wt = await chat(live, dir, 'roll1')
    writeFileSync(join(wt.path, 'a.txt'), 'swift turn\n')
    const outcome = await completeTurn(live, wt, 'swift turn')
    assert.equal(outcome.outcome, 'merged')
    wt.baseSha = outcome.newBase
    await commitLiveTurn(live, outcome.files, { title: 'swift turn' })
    await retireWorktreeBranch(wt)
    // A sync over dirty work keeps it at a recovery ref before the reset.
    writeFileSync(join(wt.path, 'b.txt'), 'dirty, reset by a sync\n')
    writeFileSync(join(live, 'c.txt'), 'live drift\n')
    assert.equal((await syncFromLive(live, wt)).synced, true)
    const refs = recovery(live)
    assert.equal(refs.length, 1)
    assert.equal(g(live, 'show', `${refs[0]}:b.txt`), 'dirty, reset by a sync')
    setRepositoryOwner(null)
    await stop(owned)
    // A relaunched owner continues on the worktree: nothing was interrupted, every ref is kept.
    owned = await fixture(home)
    await install(owned)
    assert.deepEqual((await owned.frame('status', {})).payload.interrupted, [])
    writeFileSync(join(wt.path, 'b.txt'), 'relaunched turn\n')
    const next = await completeTurn(live, wt, 'relaunched turn')
    assert.equal(next.outcome, 'merged')
    assert.equal(read(join(live, 'b.txt')), 'relaunched turn\n')
    assert.deepEqual(recovery(live), refs)
    setRepositoryOwner(null)
    await stop(owned)

    // A damaged journal is refused and left exactly as found; leases still work.
    const damagedHome = profile('damaged')
    mkdirSync(join(damagedHome, 'service', 'repository'), { recursive: true })
    const damagedJournal = join(damagedHome, 'service', 'repository', 'journal.json')
    writeFileSync(damagedJournal, '{not json')
    owned = await fixture(damagedHome)
    assert.match((await owned.frame('status', {})).payload.journal, /damaged/)
    writeFileSync(join(live, 'z.txt'), 'z\n')
    const blocked = await owned.frame('commitLive', {
      root: live,
      files: ['z.txt'],
      title: 'blocked'
    })
    assert.equal(blocked.payload.code, 'recoveryRequired')
    assert.equal(g(live, 'status', '--porcelain', '--', 'z.txt'), '?? z.txt')
    const lease = await owned.frame('acquire', { root: live })
    assert.equal(lease.kind, 'succeeded')
    assert.equal((await owned.frame('release', { lease: lease.payload.lease })).kind, 'succeeded')
    assert.equal(read(damagedJournal), '{not json')
    await stop(owned)
  })

  // LKM-130: a patch Git cannot read is still an error (conflicts are not, see the
  // resolve-conflicts suite). The message names the file and Git's reason instead of
  // the command line; Git's full output goes to the service log. LKM-150: asserted
  // as parsed fields, whatever the local Git's wording (test/git-messages.mjs pins those).
  await section('malformed-patch', async () => {
    const owned = await fixture(profile('malformed'))
    const live = repo()
    const patch =
      'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n-one\n+ONE\n'
    const applied = await owned.cmd({ cmd: 'apply', root: live, patch })
    assert.equal(applied.ok, false, JSON.stringify(applied))
    assert.equal(applied.conflict, false, JSON.stringify(applied))
    assert.equal(applied.problems.length, 1, JSON.stringify(applied))
    const [problem] = applied.problems
    assert.equal(problem.reason, 'corrupt patch', JSON.stringify(applied))
    assert.equal(problem.file, 'a.txt', JSON.stringify(applied))
    assert.ok(Number.isInteger(problem.line) && problem.line > 0, JSON.stringify(applied))
    assert.equal(applied.message, `a.txt: corrupt patch at line ${problem.line}`)
    assert.ok(
      owned.stderr.includes('git apply --3way refused a patch') &&
        owned.stderr.includes('Command failed: git apply --3way'),
      `service log: ${owned.stderr}`
    )
    assert.ok(
      /error: corrupt patch at /.test(owned.stderr),
      "the service log has Git's full error output"
    )
    assert.equal(read(join(live, 'a.txt')), 'one\n')
    await stop(owned)
  })

  await section('drain', async () => {
    const owned = await fixture(profile('drain'))
    const live = repo()
    const head = g(live, 'rev-parse', 'HEAD')
    const lease = await owned.frame('acquire', { root: live })
    writeFileSync(join(live, 'q.txt'), 'queued\n')
    const queued = owned.frame('commitLive', {
      root: live,
      files: ['q.txt'],
      title: 'queued behind a lease'
    })
    await sleep(100)
    assert.equal((await owned.cmd({ cmd: 'close', timeout: 5 })).closed, true)
    assert.equal((await queued).payload.code, 'unavailable')
    assert.equal(
      (await owned.frame('commitLive', { root: live, files: ['q.txt'], title: 'late' })).payload
        .code,
      'unavailable'
    )
    assert.equal(
      (await owned.frame('release', { lease: lease.payload.lease })).payload.code,
      'unavailable'
    )
    assert.equal(g(live, 'rev-parse', 'HEAD'), head)
    await stop(owned)
  })

  console.log('REPOSITORY-OWNER OK')
} finally {
  setRepositoryOwner(null)
  for (const started of fixtures) {
    try {
      started.child.kill('SIGKILL')
    } catch {}
  }
  rmSync(scratch, { recursive: true, force: true })
}
