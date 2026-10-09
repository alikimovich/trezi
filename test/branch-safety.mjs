// LKM-185 branch safety: landed chat commits never become unreachable from the live
// checkout. The real Swift workflow and repository owners (one fixture process) run
// against scratch repositories, a bare "GitHub" remote and the scripted `gh`, whose
// `pr merge --delete-branch` does what the real one does locally (checks out the base,
// force-deletes the head branch). No network, no GitHub, no real user repository.
// - publish: a landing while the PR description is written, with and without the
//   merge reply lost, keeps every landing on trezi/main; no gh --delete-branch, no
//   branch recreated from a remote-tracking ref, recovery refs written, remote cleaned;
// - an overlapping merged base keeps the branch as it was, with a notice;
// - ensure: never switches onto a trezi/main lacking the checkout's landings, and
//   fast-forwards one that is behind (old tip kept at a recovery ref);
// - recovery: the reported state (landings on main, trezi/main recreated from a stale
//   remote) is found by the open-time notice and merged back; a conflict stays for
//   per-file resolution; changes already in the checkout are not listed; Ignore holds.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureBranch } from '../src/main/git.ts'
import { setRepositoryOwner } from '../src/main/repository-owner.ts'
import { strandedLandingsNotice, strandedMessage } from '../src/native/stranded-landings.ts'
import {
  compileWorkflowFixture,
  installFakes,
  startWorkflowFixture
} from './helpers/workflow-fixture.mjs'

// The scripted `gh` must be on PATH before this process starts (see workflow-owner.mjs).
if (!process.env.TREZI_WORKFLOW_FAKES) {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-branch-safety-fakes-')))
  installFakes(bin)
  const child = spawnSync(
    process.execPath,
    ['--no-install', new URL(import.meta.url).pathname, ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      env: { ...process.env, TREZI_WORKFLOW_FAKES: bin, PATH: `${bin}:${process.env.PATH}` }
    }
  )
  rmSync(bin, { recursive: true, force: true })
  process.exit(child.status ?? 1)
}
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-branch-safety-')))
const binary = compileWorkflowFixture()
const env = {
  GIT_AUTHOR_NAME: 'Tester',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'Tester',
  GIT_COMMITTER_EMAIL: 't@example.com'
}
const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
const succeeds = (cwd, ...args) => {
  try {
    git(cwd, ...args)
    return true
  } catch {
    return false
  }
}
const describe = async (base) => ({
  title: 'Update the greeting',
  body: `Changes against ${base}.`
})
const fixtures = []

/** A project with a bare origin and pushed main, on trezi/main, and its owners. */
async function world(name) {
  const base = join(scratch, name)
  mkdirSync(base, { recursive: true })
  const w = {
    origin: join(base, 'origin.git'),
    local: join(base, 'project'),
    gh: join(base, 'gh.json')
  }
  mkdirSync(join(base, 'profile'))
  git(base, 'init', '-q', '--initial-branch=main', w.local)
  git(w.local, 'config', 'user.name', 'Tester')
  git(w.local, 'config', 'user.email', 't@example.com')
  writeFileSync(join(w.local, 'a.txt'), 'one\n')
  git(w.local, 'add', '-A')
  git(w.local, 'commit', '-qm', 'start')
  git(base, 'init', '-q', '--bare', '--initial-branch=main', w.origin)
  git(w.local, 'remote', 'add', 'origin', w.origin)
  git(w.local, 'push', '-q', '-u', 'origin', 'main')
  git(w.local, 'remote', 'set-head', 'origin', 'main')
  git(w.local, 'checkout', '-q', '-b', 'trezi/main')
  writeFileSync(w.gh, '{}')
  const fixture = await startWorkflowFixture(binary, join(base, 'profile'), {
    FAKE_GH_STATE: w.gh,
    FAKE_PM_STATE: join(base, 'pm.json')
  })
  fixtures.push(fixture)
  w.repository = fixture.owner()
  w.workflows = fixture.workflows()
  setRepositoryOwner(w.repository)
  w.landed = []
  /** A chat landing on whatever branch the live checkout has (identity Trezi). */
  w.land = async (file, content) => {
    writeFileSync(join(w.local, file), content)
    const result = await w.repository.commitLive(w.local, [file], `Chat: ${file}`)
    assert.equal(result.committed, true)
    w.landed.push(result.sha)
    return result.sha
  }
  w.ghState = () => JSON.parse(readFileSync(w.gh, 'utf8'))
  w.branch = () => git(w.local, 'rev-parse', '--abbrev-ref', 'HEAD')
  w.unreachable = () =>
    w.landed.filter((sha) => !succeeds(w.local, 'merge-base', '--is-ancestor', sha, 'HEAD'))
  w.recovery = () =>
    git(w.local, 'for-each-ref', '--format=%(refname)', 'refs/trezi/recovery/')
      .split('\n')
      .filter(Boolean)
  w.recreated = () =>
    /Created from refs\/remotes/.test(git(w.local, 'reflog', 'show', '--format=%gs', 'trezi/main'))
  return w
}

/** After a publish: on trezi/main, every landing reachable, nothing recreated, remote clean. */
function kept(w) {
  assert.equal(w.branch(), 'trezi/main')
  assert.deepEqual(
    w.unreachable(),
    [],
    'every landed commit stays reachable from the live checkout'
  )
  assert.equal(w.recreated(), false, 'trezi/main is never recreated from a remote-tracking ref')
  assert.equal(w.ghState().counts.deleteLocalBranch, undefined, 'gh never deletes the local branch')
  assert.ok(!w.ghState().calls.some((call) => call.includes('--delete-branch')))
  assert.deepEqual(git(w.origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'), 'main')
  assert.equal(
    succeeds(w.local, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/trezi/main'),
    false
  )
  assert.ok(
    succeeds(w.local, 'merge-base', '--is-ancestor', git(w.origin, 'rev-parse', 'main'), 'HEAD')
  )
}

try {
  // ── Publish: a landing arrives while the description is written ──
  {
    const w = await world('publish-landing')
    await w.land('a.txt', 'two\n')
    const result = await w.workflows.publish(w.local, 'merge', async (base) => {
      await w.land('late.txt', 'late landing\n')
      return describe(base)
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.notice, undefined)
    kept(w)
    assert.equal(git(w.local, 'show', 'HEAD:late.txt'), 'late landing')
    assert.ok(w.recovery().some((ref) => ref.startsWith('refs/trezi/recovery/trezi/main/')))
    // The next publish carries only the late landing; a synced branch alone is nothing.
    const again = await w.workflows.publish(w.local, 'merge', describe)
    assert.equal(again.ok, true, JSON.stringify(again))
    kept(w)
    assert.equal(git(w.origin, 'show', 'main:late.txt'), 'late landing')
    const nothing = await w.workflows.publish(w.local, 'merge', describe)
    assert.equal(nothing.error, 'Nothing to publish — no changes since main.')
    console.log('BRANCH-SAFETY publish keeps landings PASS')
  }

  // ── The same with the merge reply lost: the retry finishes from GitHub's state ──
  {
    const w = await world('publish-lost')
    writeFileSync(w.gh, JSON.stringify({ faults: ['pr-merge-lost'] }))
    await w.land('a.txt', 'two\n')
    const failed = await w.workflows.publish(w.local, 'merge', async (base) => {
      await w.land('late.txt', 'late landing\n')
      return describe(base)
    })
    assert.equal(failed.ok, false)
    assert.equal(w.branch(), 'trezi/main', 'a failed merge leaves the checkout where it was')
    assert.deepEqual(w.unreachable(), [])
    await w.land('between.txt', 'landed between the attempts\n')
    const again = await w.workflows.publish(w.local, 'merge', describe)
    assert.equal(again.ok, true, JSON.stringify(again))
    kept(w)
    assert.equal(w.ghState().counts.prMerge, 1)
    console.log('BRANCH-SAFETY lost merge reply PASS')
  }

  // ── The merged base overlaps the branch: kept as it was, with a notice ──
  {
    const w = await world('publish-overlap')
    await w.land('a.txt', 'two\n')
    const result = await w.workflows.publish(w.local, 'merge', async (base) => {
      await w.land('a.txt', 'three\n')
      return describe(base)
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.match(result.notice, /trezi\/main was kept as it was/)
    assert.equal(w.branch(), 'trezi/main')
    assert.deepEqual(w.unreachable(), [])
    assert.equal(git(w.local, 'status', '--porcelain'), '', 'the failed sync left no merge behind')
    assert.equal(w.recreated(), false)
    console.log('BRANCH-SAFETY overlapping base kept PASS')
  }

  // ── Ensure never switches onto a trezi/main that lacks the checkout's landings ──
  {
    const w = await world('ensure')
    const theirs = await w.land('a.txt', 'two\n')
    git(w.local, 'push', '-q', '-u', 'origin', 'trezi/main')
    git(w.local, 'checkout', '-q', 'main')
    const ours = await w.land('b.txt', 'on main\n')
    const refused = await ensureBranch(w.local)
    assert.match(
      refused.error,
      /trezi\/main has commits that are not on main, so Trezi stayed on main/
    )
    assert.equal(w.branch(), 'main')
    assert.ok(succeeds(w.local, 'merge-base', '--is-ancestor', ours, 'HEAD'))
    assert.equal(git(w.local, 'rev-parse', 'trezi/main'), theirs, 'trezi/main untouched')
    // Behind instead of diverged: trezi/main fast-forwards, its old tip kept.
    git(w.local, 'merge', '-q', '--no-edit', 'trezi/main')
    const before = w.recovery().length
    const joined = await ensureBranch(w.local)
    assert.equal(joined.branch, 'trezi/main', JSON.stringify(joined))
    assert.equal(w.branch(), 'trezi/main')
    assert.equal(git(w.local, 'rev-parse', 'HEAD'), git(w.local, 'rev-parse', 'main'))
    assert.equal(w.recovery().length, before + 1)
    assert.deepEqual(w.unreachable(), [])
    console.log('BRANCH-SAFETY ensure PASS')
  }

  // ── Recovery: the reported state, found on open and brought back ──
  {
    const w = await world('recover')
    await w.land('a.txt', 'two\n')
    git(w.local, 'push', '-q', '-u', 'origin', 'trezi/main')
    // An older publish: checkout on main, trezi/main deleted, landings on main, and
    // trezi/main recreated from the stale remote-tracking ref.
    git(w.local, 'checkout', '-q', 'main')
    git(w.local, 'merge', '-q', '--ff-only', 'trezi/main')
    git(w.local, 'branch', '-D', 'trezi/main')
    await w.land('b.txt', 'first on main\n')
    await w.land('c.txt', 'second on main\n')
    git(w.local, 'checkout', '-q', 'trezi/main')
    assert.equal(w.recreated(), true, 'the reported mechanism (Git DWIM checkout)')
    assert.equal(w.unreachable().length, 2)
    const found = await w.repository.strandedLandings(w.local)
    assert.deepEqual(found, {
      current: 'trezi/main',
      branches: [{ branch: 'main', tip: git(w.local, 'rev-parse', 'main'), count: 2 }]
    })
    const toasts = [],
      logs = [],
      restored = []
    const prefs = new Map()
    const deps = {
      sheets: { toast: (message, actions) => toasts.push({ message, actions }) },
      owner: () => w.repository,
      preferences: {
        get: (key) => prefs.get(key) ?? null,
        set: async (key, value) => void prefs.set(key, value)
      },
      log: (text, kind) => logs.push({ text, kind }),
      restored: async (root, files) => void restored.push({ root, files })
    }
    const notice = strandedLandingsNotice(deps)
    assert.equal(
      await notice(w.local),
      '2 earlier chat changes are on branch main, not on trezi/main'
    )
    assert.equal(await notice(w.local), null, 'once per project per launch')
    assert.deepEqual(
      toasts[0].actions.map((a) => a.label),
      ['Bring them back', 'Ignore']
    )
    await toasts[0].actions[0].run()
    assert.deepEqual(w.unreachable(), [], JSON.stringify(logs))
    assert.equal(w.branch(), 'trezi/main')
    assert.deepEqual(restored, [{ root: w.local, files: ['b.txt', 'c.txt'] }])
    assert.equal(logs[0].kind, 'success')
    assert.equal(w.recovery().filter((ref) => /-(live|stranded)$/.test(ref)).length, 2)
    assert.deepEqual((await w.repository.strandedLandings(w.local)).branches, [], 'nothing left')
    console.log('BRANCH-SAFETY recovery merge PASS')

    // A conflicting stranded change stays for per-file resolution.
    git(w.local, 'checkout', '-q', 'main')
    await w.land('b.txt', 'main edits b\n')
    git(w.local, 'checkout', '-q', 'trezi/main')
    writeFileSync(join(w.local, 'b.txt'), 'trezi edits b\n')
    git(w.local, 'commit', '-qam', 'user edit')
    const tip = git(w.local, 'rev-parse', 'main')
    const conflicted = await w.repository.restoreLandings(w.local, 'main', tip)
    assert.equal(conflicted.merged, false)
    assert.deepEqual(conflicted.conflictFiles, ['b.txt'])
    assert.equal(conflicted.recoveryRefs.length, 2)
    assert.ok(succeeds(w.local, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD'))
    git(w.local, 'merge', '--abort')
    assert.equal(
      strandedMessage(1, 'main', 'trezi/main'),
      '1 earlier chat change is on branch main, not on trezi/main'
    )

    // Ignore holds for that tip.
    const ignoring = strandedLandingsNotice(deps)
    toasts.length = 0
    assert.equal(
      await ignoring(w.local),
      '1 earlier chat change is on branch main, not on trezi/main'
    )
    await toasts[0].actions[1].run()
    assert.equal(await strandedLandingsNotice(deps)(w.local), null)
    // Changes already in the checkout (a cherry-pick) are not listed.
    git(w.local, 'cherry-pick', '-X', 'theirs', tip)
    prefs.clear()
    assert.equal(await strandedLandingsNotice(deps)(w.local), null)
    console.log('BRANCH-SAFETY recovery conflict, ignore, already included PASS')
  }
} finally {
  setRepositoryOwner(null)
  for (const fixture of fixtures) await fixture.stop()
  rmSync(scratch, { recursive: true, force: true })
}
console.log('BRANCH-SAFETY OK — publish, lost merge, overlap, ensure, recovery')
