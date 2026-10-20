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
import { ReconciliationCoordinator } from '../src/main/conflict-resolution.ts'
import { passCheck, replayFixtureChecks } from './helpers/gate-checks.mjs'

const dir = mkdtempSync(join(tmpdir(), 'trezi-auto-reconcile-'))
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
let id = 0
async function fixture() {
  const key = `chat-${id++}`
  const root = join(dir, key)
  mkdirSync(root)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(root, '.gitignore'), 'node_modules\n.env\n')
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n')
  writeFileSync(join(root, 'other.txt'), 'unrelated\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'initial')
  const cwd = await isolatedCwd(root, key)
  await beforeTurn(key, 'edit')
  events.length = 0
  return { key, root, cwd }
}
let replayPasses = true
const replays = replayFixtureChecks(() => replayPasses)
try {
  // Same-file edits in separate regions land without a card or a provider turn. The
  // reconciled source is new: the host runs the chat's passing check on it again first.
  const clean = await fixture()
  writeFileSync(join(clean.cwd, 'a.txt'), 'CHAT\ntwo\nthree\nfour\nfive\n')
  await passCheck(clean.key, clean.cwd)
  writeFileSync(join(clean.root, 'a.txt'), 'one\ntwo\nthree\nfour\nLIVE\n')
  writeFileSync(join(clean.root, 'other.txt'), 'staged user work\n')
  git(clean.root, 'add', 'other.txt')
  assert.equal(await afterTurn(clean.key, 'edit', [], 'success', true), null)
  assert.equal(replays.length, 1, 'the clean reconcile replayed the check')
  assert.equal(readFileSync(join(clean.root, 'a.txt'), 'utf8'), 'CHAT\ntwo\nthree\nfour\nLIVE\n')
  assert.equal(git(clean.root, 'diff', '--cached', '--name-only'), 'other.txt')
  assert.equal(git(clean.root, 'log', '-1', '--format=%s'), 'Update a.txt')
  assert(!events.some((e) => e.state === 'parked'))
  assert.equal(isolationSnapshot(clean.key).state, 'isolated')
  await beforeTurn(clean.key, 'next')
  assert.equal(
    readFileSync(join(clean.cwd, 'a.txt'), 'utf8'),
    readFileSync(join(clean.root, 'a.txt'), 'utf8')
  )
  await releaseChat(clean.key)

  // LOCAL-WEBKIT-3: a reconciled result whose replayed check fails never lands.
  const failing = await fixture()
  writeFileSync(join(failing.cwd, 'a.txt'), 'CHAT\ntwo\nthree\nfour\nfive\n')
  await passCheck(failing.key, failing.cwd)
  writeFileSync(join(failing.root, 'a.txt'), 'one\ntwo\nthree\nfour\nLIVE\n')
  replayPasses = false
  assert.equal(await afterTurn(failing.key, 'edit', [], 'success', true), null)
  replayPasses = true
  assert.equal(readFileSync(join(failing.root, 'a.txt'), 'utf8'), 'one\ntwo\nthree\nfour\nLIVE\n')
  assert.equal(isolationSnapshot(failing.key).state, 'parked')
  assert.match(isolationSnapshot(failing.key).error, /did not pass on this exact source/)
  await releaseChat(failing.key, 'failed')

  // Real overlap is staged privately, returns exact files for one automatic turn.
  const overlap = await fixture()
  writeFileSync(join(overlap.cwd, 'a.txt'), 'CHAT\ntwo\nthree\nfour\nfive\n')
  await passCheck(overlap.key, overlap.cwd)
  writeFileSync(join(overlap.root, 'a.txt'), 'LIVE\ntwo\nthree\nfour\nfive\n')
  assert.deepEqual(await afterTurn(overlap.key, 'edit', [], 'success', true), ['a.txt'])
  assert(readFileSync(join(overlap.cwd, 'a.txt'), 'utf8').includes('<<<<<<<'))
  assert(!readFileSync(join(overlap.root, 'a.txt'), 'utf8').includes('<<<<<<<'))
  assert(
    !events.some((e) => e.state === 'parked'),
    'no interruption card while automatic work is starting'
  )
  // A resolver that fails to remove markers parks once, with no automatic retry.
  assert.equal(await afterTurn(overlap.key, 'edit', [], 'success', false), null)
  assert(events.some((e) => e.state === 'parked'))
  assert.equal(isolationSnapshot(overlap.key).state, 'parked')
  // Explicit retry can finish and clear the durable park, once the resolution is checked.
  writeFileSync(join(overlap.cwd, 'a.txt'), 'LIVE + CHAT\ntwo\nthree\nfour\nfive\n')
  await afterTurn(overlap.key, 'edit', [], 'success', false)
  assert.equal(isolationSnapshot(overlap.key).reason, 'failed', 'an unchecked resolution holds')
  assert(!readFileSync(join(overlap.root, 'a.txt'), 'utf8').startsWith('LIVE + CHAT'))
  await passCheck(overlap.key, overlap.cwd)
  await afterTurn(overlap.key, 'edit', [], 'success', false)
  assert.equal(isolationSnapshot(overlap.key).state, 'isolated')
  assert(readFileSync(join(overlap.root, 'a.txt'), 'utf8').startsWith('LIVE + CHAT'))
  await releaseChat(overlap.key)

  // Failed/interrupted work and ambiguous binary decisions never auto-resolve.
  for (const binary of [false, true]) {
    const f = await fixture()
    writeFileSync(join(f.cwd, 'a.txt'), binary ? Buffer.from([0, 1, 2]) : 'CHAT\n')
    await passCheck(f.key, f.cwd)
    writeFileSync(join(f.root, 'a.txt'), binary ? Buffer.from([0, 3, 4]) : 'LIVE\n')
    const before = readFileSync(join(f.root, 'a.txt'))
    assert.equal(await afterTurn(f.key, 'edit', [], binary ? 'success' : 'failed', true), null)
    assert.equal(isolationSnapshot(f.key).state, 'parked')
    assert.deepEqual(readFileSync(join(f.root, 'a.txt')), before)
    await releaseChat(f.key, 'failed')
  }
  // Provider continuation: one attempt, exact session, Stop/close and failures.
  for (const scenario of ['success', 'cancel', 'close', 'send-failure', 'provider-failure']) {
    const running = new Set()
    const preparations = new Map()
    const emitted = []
    const sent = []
    const landed = []
    let resolveLanding
    let active = {
      record: { transcript: [{ role: 'user', text: 'original request', at: 1000 }] },
      emit: (e) => emitted.push(e),
      send: (text) => {
        if (scenario === 'send-failure') throw new Error('provider unavailable')
        sent.push(text)
      }
    }
    let begins = 0
    const coordinator = new ReconciliationCoordinator({
      running,
      preparations,
      currentSession: () => active,
      begin: () => begins++,
      showParked: () => emitted.push({ type: 'fallback' }),
      land: (...args) => {
        landed.push(args)
        return new Promise((resolve) => {
          resolveLanding = resolve
        })
      }
    })
    const finishing = coordinator.finish(
      'origin-chat',
      'original request',
      scenario === 'provider-failure' ? 'failed' : 'success'
    )
    assert(running.has('origin-chat'), 'landing holds the busy gate')
    if (scenario === 'cancel') preparations.get('origin-chat').cancelled = true
    if (scenario === 'close') active = undefined
    resolveLanding(scenario === 'provider-failure' ? null : ['a.txt'])
    await finishing
    if (scenario === 'success') {
      assert.equal(
        active.record.transcript[0].completedAt,
        undefined,
        'Continuation is still part of the same turn'
      )
      assert.equal(sent.length, 1)
      assert(sent[0].includes('a.txt'))
      assert.equal(begins, 1)
      assert(running.has('origin-chat'))
      const retry = coordinator.finish('origin-chat', 'original request', 'success')
      assert.equal(landed[1][4], false, 'automatic continuation cannot schedule another attempt')
      resolveLanding(null)
      await retry
      assert(!running.has('origin-chat'))
      assert.equal(sent.length, 1)
    } else {
      assert.equal(sent.length, 0, `${scenario} must not dispatch a follow-up`)
      if (scenario !== 'close') assert(!running.has('origin-chat'))
    }
    if (active)
      assert(
        active.record.transcript[0].completedAt > 1000,
        'Terminal timing persists after landing'
      )
  }
  console.log('auto-reconciliation: OK')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
