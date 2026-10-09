// LKM-134 startup recovery: the real Swift RepositoryOwner (fixture process) and Bun's
// real client and launch report.
// - once: an interrupted stageResolve is reported at the launch that finds it and never
//   again; its journal entry is resolved and its recovery ref kept, across two restarts;
// - legacy: open entries of a version 1 journal whose refs exist are closed on the first
//   launch with one summary line and no error, and stay closed;
// - refs: recovery refs are listed and deleted only by an explicit, confirmed action,
//   never outside refs/trezi/recovery/ and never once moved; the report has no errors
//   for saved work.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  completeTurn,
  createChatWorktree,
  stageResolve,
  syncFromLive
} from '../src/main/chat-worktrees.ts'
import { setEditingOwner } from '../src/main/editing-owner.ts'
import { setRepositoryOwner } from '../src/main/repository-owner.ts'
import { NativeRecoveryRefs, recoveryNotices } from '../src/native/repository-recovery.ts'
import { compileEditingFixture, startEditingFixture } from './helpers/editing-fixture.mjs'
import { compileRepositoryFixture, startRepositoryFixture } from './helpers/repository-fixture.mjs'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-repository-recovery-')))
const fixtures = new Set()
let repos = 0

const g = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const recovery = (repoRoot) =>
  g(repoRoot, 'for-each-ref', '--format=%(refname)', 'refs/trezi/recovery/')
    .split('\n')
    .filter(Boolean)
const profile = (name) => {
  const path = join(scratch, name)
  mkdirSync(path, { recursive: true })
  return path
}
const journalOf = (home) =>
  JSON.parse(readFileSync(join(home, 'service', 'repository', 'journal.json'), 'utf8'))

function repo() {
  const path = join(scratch, `repo-${++repos}`)
  mkdirSync(path, { recursive: true })
  g(path, 'init', '-q', '-b', 'main')
  g(path, 'config', 'user.name', 'User')
  g(path, 'config', 'user.email', 'user@local')
  g(path, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(path, '.gitignore'), 'node_modules\n.env\n')
  writeFileSync(join(path, 'a.txt'), 'one\n')
  g(path, 'add', '-A')
  g(path, 'commit', '-q', '-m', 'init')
  return path
}

let binary
async function fixture(home, env = {}) {
  const started = await startRepositoryFixture(binary, home, env)
  fixtures.add(started)
  return started
}
async function stop(started) {
  setRepositoryOwner(null)
  await started.stop()
  fixtures.delete(started)
}
async function launch(home) {
  const owned = await fixture(home)
  setRepositoryOwner(owned.owner())
  return owned
}
const status = async (owned) => (await owned.frame('status', {})).payload

try {
  binary = compileRepositoryFixture()
  const editing = await startEditingFixture(compileEditingFixture(), profile('editing'), {
    REPOSITORY_WORKTREES_ROOT: scratch
  })
  fixtures.add(editing)
  setEditingOwner(editing.owners().editing)

  // An interrupted stageResolve: reported once, resolved, its ref kept.
  {
    const home = profile('once')
    const dir = join(home, 'trezi', 'worktrees')
    const live = repo()
    let owned = await launch(home)
    const parked = await createChatWorktree(live, 'once1', dir)
    await syncFromLive(live, parked)
    writeFileSync(join(parked.path, 'a.txt'), "one, the chat's version\n")
    writeFileSync(join(live, 'a.txt'), "one, the user's version\n")
    assert.equal((await completeTurn(live, parked, 'parked turn')).outcome, 'parked')
    const tip = g(parked.path, 'rev-parse', 'HEAD')
    await stop(owned)

    const crashing = await fixture(home, { REPOSITORY_FAULT: 'resolve.reset' })
    setRepositoryOwner(crashing.owner({ timeout: 1500 }))
    const pending = stageResolve(live, parked).then(
      () => 'answered',
      (error) => error
    )
    assert.equal((await crashing.exited).signal, 'SIGKILL', crashing.stderr)
    fixtures.delete(crashing)
    await pending
    setRepositoryOwner(null)

    // The launch that finds it reports it once, at info level.
    owned = await launch(home)
    const first = await status(owned)
    assert.equal(first.recovered.length, 1, JSON.stringify(first))
    const [entry] = first.recovered
    assert.equal(entry.kind, 'stageResolve')
    assert.ok(entry.resolved, 'the entry is resolved when it is reported')
    assert.deepEqual(entry.missing, [])
    const ref = entry.refs.find((name) => name.endsWith('-parked'))
    assert.equal(g(live, 'rev-parse', ref), tip)
    assert.equal(first.closedEarlier, 0)
    const notices = recoveryNotices(first)
    assert.equal(notices.length, 1)
    assert.equal(notices[0].kind, 'info')
    assert.ok(
      notices[0].text.includes(ref) && notices[0].text.includes('stageResolve'),
      notices[0].text
    )
    const stored = journalOf(home)
    assert.equal(stored.version, 2)
    assert.equal(
      stored.interrupted.find((item) => item.operationID === entry.operationID).resolved,
      entry.resolved
    )
    await stop(owned)

    // Two more restarts: nothing is reported again; the entry stays resolved, the ref kept.
    for (const restart of [1, 2]) {
      owned = await launch(home)
      const again = await status(owned)
      assert.deepEqual(again.recovered, [], `restart ${restart}`)
      assert.equal(again.closedEarlier, 0)
      assert.deepEqual(recoveryNotices(again), [], `restart ${restart} reports nothing`)
      assert.equal(
        again.interrupted.find((item) => item.operationID === entry.operationID).resolved,
        entry.resolved
      )
      assert.ok(recovery(live).includes(ref), 'the recovery ref is kept')
      await stop(owned)
    }
    console.log('REPOSITORY-RECOVERY once PASS')
  }

  // A journal from before this fix: five open entries (the LKM-130 Resolve attempts)
  // whose refs exist. One summary line, no error, closed for good.
  const legacyHome = profile('legacy')
  const legacyLive = repo()
  {
    const head = g(legacyLive, 'rev-parse', 'HEAD')
    const entries = [36, 41, 52, 58, 66].map((second, index) => {
      const ref = `refs/trezi/recovery/20260930-1514${second}-stageResolve-0a1b2c3d4e5f-00000${index}-parked`
      g(legacyLive, 'update-ref', ref, head)
      return {
        operationID: `0A1B2C3D-0000-0000-0000-00000000000${index}`,
        kind: 'stageResolve',
        intent: 'reconcile',
        lane: `git:${legacyLive}/.git`,
        root: legacyLive,
        worktree: join(legacyHome, 'wt'),
        branch: 'trezi/chat-legacy',
        refs: [ref],
        started: `2026-09-30T15:14:${second % 60}Z`
      }
    })
    mkdirSync(join(legacyHome, 'service', 'repository'), { recursive: true })
    writeFileSync(
      join(legacyHome, 'service', 'repository', 'journal.json'),
      JSON.stringify({ version: 1, active: [], interrupted: entries })
    )

    let owned = await launch(legacyHome)
    const first = await status(owned)
    assert.deepEqual(first.recovered, [], 'already-reported entries are not reported again')
    assert.equal(first.closedEarlier, 5)
    const notices = recoveryNotices(first)
    assert.equal(notices.length, 1, 'at most one summary line')
    assert.equal(notices[0].kind, 'info')
    assert.match(notices[0].text, /^Closed 5 interrupted repository operations/)
    const stored = journalOf(legacyHome)
    assert.equal(stored.version, 2)
    assert.ok(
      stored.interrupted.length === 5 &&
        stored.interrupted.every((item) => typeof item.resolved === 'string')
    )
    assert.equal(recovery(legacyLive).length, 5, 'no recovery ref is deleted')
    await stop(owned)

    owned = await launch(legacyHome)
    const second = await status(owned)
    assert.equal(second.closedEarlier, 0)
    assert.deepEqual(recoveryNotices(second), [])
    assert.equal(recovery(legacyLive).length, 5)
    await stop(owned)
    console.log('REPOSITORY-RECOVERY legacy PASS')
  }

  // Viewing and deleting recovery refs is explicit; the report never errors for saved work.
  {
    const owned = await launch(legacyHome)
    const client = owned.owner()
    const listed = await client.recoveryRefs([legacyLive, '/nonexistent/trezi-recovery'])
    assert.equal(listed.length, 1)
    assert.equal(listed[0].refs.length, 5)
    const [first, second] = listed[0].refs
    assert.match(first.sha, /^[0-9a-f]{40}$/)
    // The journal's repositories are listed without being asked for.
    assert.equal((await client.recoveryRefs([]))[0].refs.length, 5)

    const outside = await owned.frame('deleteRecoveryRefs', {
      root: legacyLive,
      refs: ['refs/heads/main'],
      shas: [first.sha],
      intent: 'discard'
    })
    assert.equal(outside.kind, 'failed')
    assert.ok(g(legacyLive, 'rev-parse', 'refs/heads/main'))
    assert.equal(
      (
        await owned.frame('deleteRecoveryRefs', {
          root: legacyLive,
          refs: [first.ref],
          shas: [first.sha]
        })
      ).kind,
      'failed',
      'needs its intent'
    )
    const moved = await client.deleteRecoveryRefs(legacyLive, [
      { ref: first.ref, sha: 'f'.repeat(40) }
    ])
    assert.deepEqual(moved, { deleted: [], kept: [first.ref] })
    assert.equal(recovery(legacyLive).length, 5, 'a ref that moved is kept')

    // The Activity action: a sheet lists them; only the selected and confirmed ref goes.
    const presented = [],
      reports = []
    const sheets = {
      current: null,
      present(state, handle) {
        this.current = { state: { ...state, id: `sheet-${presented.length}` }, handle }
        presented.push(this.current)
      }
    }
    const refs = new NativeRecoveryRefs(
      sheets,
      client,
      () => [legacyLive, legacyLive],
      (text, kind) => reports.push({ text, kind })
    )
    await refs.open()
    assert.equal(presented[0].state.fields[0].choices.length, 5)
    await assert.rejects(
      presented[0].handle({ id: 'sheet-0', action: 'delete', values: { refs: '' } }),
      /Select/
    )
    assert.equal(recovery(legacyLive).length, 5)
    const index = listed[0].refs.findIndex((item) => item.ref === second.ref)
    await presented[0].handle({ id: 'sheet-0', action: 'delete', values: { refs: String(index) } })
    assert.equal(presented.length, 2, 'deleting asks for confirmation first')
    assert.equal(recovery(legacyLive).length, 5, 'nothing is deleted before confirming')
    assert.match(presented[1].state.detail, new RegExp(second.ref))
    await presented[1].handle({ id: 'sheet-1', action: 'delete', values: {} })
    assert.deepEqual(recovery(legacyLive).includes(second.ref), false)
    assert.equal(recovery(legacyLive).length, 4)
    assert.deepEqual(reports, [{ text: 'Deleted 1 recovery ref.', kind: 'info' }])
    assert.equal(presented[2].state.fields[0].choices.length, 4, 'the list is shown again')
    await stop(owned)

    // Report levels: saved work is info, a ref not in the repository a warning, only a
    // damaged journal an error.
    const base = {
      operationID: 'x',
      kind: 'stageResolve',
      intent: 'reconcile',
      lane: 'l',
      root: '/r',
      started: 's',
      resolved: 't'
    }
    const kinds = recoveryNotices({
      active: [],
      interrupted: [],
      closedEarlier: 0,
      recovered: [
        { ...base, refs: ['refs/trezi/recovery/a'], missing: [] },
        { ...base, refs: [], missing: [] },
        { ...base, refs: ['refs/trezi/recovery/b'], missing: ['refs/trezi/recovery/b'] },
        {
          ...base,
          refs: ['refs/trezi/recovery/c'],
          missing: ['refs/trezi/recovery/c'],
          unreadable: true
        }
      ]
    }).map((notice) => notice.kind)
    assert.deepEqual(kinds, ['info', 'info', 'warning', 'warning'])
    assert.deepEqual(
      recoveryNotices({
        active: [],
        interrupted: [],
        recovered: [],
        closedEarlier: 0,
        journal: 'damaged'
      }).map((n) => n.kind),
      ['error']
    )
    console.log('REPOSITORY-RECOVERY refs PASS')
  }
  console.log('REPOSITORY-RECOVERY OK')
} finally {
  setRepositoryOwner(null)
  for (const started of fixtures) {
    try {
      started.child.kill('SIGKILL')
    } catch {}
  }
  rmSync(scratch, { recursive: true, force: true })
}
