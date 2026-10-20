/**
 * LOCAL-WEBKIT-2 repair: the bounds of `preview_verify` without a desktop. A hung or
 * delayed managed CLI cannot hold a run past its deadline and leaves no child behind
 * (a fake wrapper that ignores SIGTERM, with a grandchild that does too); a check round
 * and a step's wait stop at their own deadline; Chromium checks are pinned to the page's
 * full URL and any later route change invalidates them; refs of a browser's current
 * document survive more than 200 other scopes; and a closed session's receipts and
 * artifact folders are removed.
 *
 * Run with: bun test/browser-verify-bounds.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refScope, refToken, resolveRef } from '../src/main/agent-refs.ts'
import { CHECK_LIMITS, parseChecks, pollChecks } from '../src/main/browser-checks.ts'
import {
  CLI_ABANDON_AFTER_MS,
  CLI_KILL_AFTER_MS,
  runManagedCli
} from '../src/main/managed-browser-cli.ts'
import {
  artifactDirectory,
  receiptSession,
  recordReceipt,
  releaseSessionReceipts,
  sessionReceipts,
  setVerificationArtifactsRoot,
  writeArtifact
} from '../src/main/verification-receipts.ts'
import { parseVerify } from '../src/main/verify-args.ts'
import { runChromiumChecks } from '../src/main/verify-chromium.ts'

const work = mkdtempSync(join(tmpdir(), 'trezi-verify-bounds-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// --- refs: a current scope survives eviction -------------------------------------------------
{
  const mine = refScope('browser-mine', 1, 'doc-1')
  const token = refToken(mine, 'e7')
  // Another browser's documents come and go: far more than the scope limit of 200.
  const first = refToken(refScope('browser-churn', 1, 'doc-0'), 'e1')
  for (let i = 1; i < 450; i++) refScope('browser-churn', 1, `doc-${i}`)
  assert.equal(refScope('browser-mine', 1, 'doc-1'), mine, 'the current scope is still current')
  assert.deepEqual(
    resolveRef({ id: 'browser-mine', navigation: 1 }, token),
    { ref: 'e7', document: 'doc-1' },
    'a current scope resolves after more than 200 other scopes'
  )
  assert.ok(
    'error' in resolveRef({ id: 'browser-churn', navigation: 1 }, first),
    'an old scope that was evicted is refused'
  )
  assert.ok(
    'error' in resolveRef({ id: 'browser-churn', navigation: 1 }, token),
    "another browser's ref is refused"
  )
  const last = refToken(refScope('browser-churn', 1, 'doc-449'), 'e2')
  assert.ok('ref' in resolveRef({ id: 'browser-churn', navigation: 1 }, last))
}

// --- receipts: a closed session's evidence is removed ---------------------------------------
{
  const root = join(work, 'receipts')
  setVerificationArtifactsRoot(root)
  const shot = (session, name) =>
    writeArtifact(session, name, Buffer.from(name), 'image/png', { width: 1, height: 1 })
  const receipt = (artifacts) => ({ id: 'vr-x', artifacts, runtime: { root: '/wt' } })
  // Two chats without a worktree share the live root: only their keys tell them apart.
  const closed = receiptSession('chat-closed', '/live')
  const sibling = receiptSession('chat-sibling', '/live')
  const elsewhere = receiptSession('chat-closed', '/wt-b')
  const failedRun = receiptSession('chat-failed', '/live')
  assert.equal(new Set([closed, sibling, elsewhere, failedRun]).size, 4)
  const kept = shot(sibling, 'a.png')
  const keptElsewhere = shot(elsewhere, 'a.png')
  const first = shot(closed, 'a.png')
  recordReceipt(closed, receipt([first]))
  recordReceipt(sibling, receipt([kept]))
  recordReceipt(elsewhere, receipt([keptElsewhere]))
  artifactDirectory(failedRun) // a failed run's folder, no receipt
  releaseSessionReceipts('chat-closed', '/live')
  assert.deepEqual(sessionReceipts(closed), [])
  assert.equal(existsSync(join(root, closed)), false, 'the artifact folder is gone')
  assert.equal(sessionReceipts(sibling).length, 1, 'a chat on the same root keeps its receipts')
  assert.equal(existsSync(kept.path), true, 'and its screenshot')
  assert.equal(sessionReceipts(elsewhere).length, 1, 'the same chat in another checkout stays')
  assert.equal(existsSync(keptElsewhere.path), true)
  releaseSessionReceipts('chat-closed', '/live') // releasing twice is harmless
  assert.equal(sessionReceipts(sibling).length, 1)
  releaseSessionReceipts('chat-failed', '/live')
  assert.equal(existsSync(join(root, failedRun)), false, 'a receipt-less folder goes too')
  assert.equal(existsSync(kept.path), true, 'the sibling still has its evidence')
  releaseSessionReceipts('chat-sibling', '/live')
  assert.deepEqual(sessionReceipts(sibling), [])
  assert.equal(existsSync(kept.path), false)
  releaseSessionReceipts('chat-closed', '/wt-b')
  assert.equal(existsSync(keptElsewhere.path), false)
  setVerificationArtifactsRoot(null)
}

// --- a round that never answers stops at the total budget ------------------------------------
{
  const total = CHECK_LIMITS.totalMs
  CHECK_LIMITS.totalMs = 300
  try {
    const checks = parseChecks([{ kind: 'exists', selector: '#a' }], 'webkit').checks
    const started = Date.now()
    const polled = await pollChecks(checks, () => new Promise(() => {}))
    assert.ok(Date.now() - started < 1500, 'a hung round is abandoned at the budget')
    assert.match(polled.aborted, /ran out of time/)
    assert.equal(polled.results[0].pass, false)
  } finally {
    CHECK_LIMITS.totalMs = total
  }
}

// --- a fake managed wrapper: scripted answers, or a hang that ignores SIGTERM ------------------
const state = join(work, 'state')
mkdirSync(state)
const wrapper = join(work, 'fake-wrapper.mjs')
writeFileSync(
  wrapper,
  `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
const dir = process.env.FAKE_DIR
const args = process.argv.slice(4).filter((a) => a !== '--json')
const [cmd, a] = args
const ok = (data) => console.log(JSON.stringify({ success: true, data }))
const hang = () => {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'inherit' })
  appendFileSync(dir + '/pids', process.pid + ',' + child.pid + ',')
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
}
const hangs = (process.env.FAKE_HANG ?? '').split('|')
if (hangs.includes('all') || hangs.includes(cmd + ' ' + a) || hangs.includes(cmd)) hang()
else if (cmd === 'get' && a === 'url') {
  const urls = JSON.parse(process.env.FAKE_URLS ?? '["http://127.0.0.1:4100/settings"]')
  const file = dir + '/urls.n'
  const n = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0
  writeFileSync(file, String(n + 1))
  ok({ url: urls[Math.min(n, urls.length - 1)] })
} else if (cmd === 'get' && a === 'count') ok({ count: 1 })
else ok({})
`
)
const pids = () => {
  const file = join(state, 'pids')
  return existsSync(file) ? readFileSync(file, 'utf8').split(',').filter(Boolean).map(Number) : []
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** Every recorded fake process is gone (SIGKILL lands a moment after the run resolves). */
const allGone = async () => {
  for (let i = 0; i < 40 && pids().some(alive); i++) await sleep(50)
  return pids().every((pid) => !alive(pid))
}
const reset = (env = {}) => {
  rmSync(state, { recursive: true, force: true })
  mkdirSync(state)
  for (const key of ['FAKE_HANG', 'FAKE_URLS']) delete process.env[key]
  Object.assign(process.env, { FAKE_DIR: state, ...env })
}
const CLEANUP = CLI_KILL_AFTER_MS + CLI_ABANDON_AFTER_MS

// A hung wrapper (and the grandchild it started) is killed and the call settles in time.
{
  reset({ FAKE_HANG: 'all' })
  const started = Date.now()
  const result = await runManagedCli(wrapper, 'trezi-vtest', work, ['get', 'url'], 3000)
  const took = Date.now() - started
  assert.equal(result.timedOut, true)
  assert.ok(took >= 3000 && took < 3000 + CLEANUP + 2500, `settled within the bound (${took} ms)`)
  assert.equal(pids().length, 2, 'the wrapper and its child ran')
  assert.equal(await allGone(), true, 'neither the wrapper nor its child outlives the call')
  // A spent deadline starts nothing.
  reset()
  const none = await runManagedCli(wrapper, 'trezi-vtest', work, ['get', 'url'], 0)
  assert.equal(none.timedOut, true)
  assert.deepEqual(pids(), [])
  assert.equal(existsSync(join(state, 'urls.n')), false, 'no process was spawned')
}

const one = parseChecks([{ kind: 'exists', selector: '#a' }], 'chromium').checks
const run = (over = {}) => ({
  wrapper,
  cwd: work,
  url: 'http://127.0.0.1:4100/settings',
  origin: 'http://127.0.0.1:4100',
  viewport: { width: 390, height: 700, theme: 'system' },
  steps: [],
  checks: one,
  screenshotPath: null,
  ...over
})

// The run's budget bounds a CLI that never answers a read; nothing is left running.
{
  reset({ FAKE_HANG: 'get count' })
  const started = Date.now()
  const outcome = await runChromiumChecks(run({ budgetMs: 8000 }))
  const took = Date.now() - started
  assert.ok(took < 8000 + CLEANUP + 4000, `the run stayed inside its budget (${took} ms)`)
  assert.ok(pids().length >= 2, 'the hung read ran, with its child')
  assert.equal(outcome.checks[0].pass, false)
  assert.ok(outcome.stopped, 'a run that ran out of time is never verified')
  assert.equal(await allGone(), true, 'no child outlives the run')
}

// A wait step keeps its own timeout even when each read hangs.
{
  reset({ FAKE_HANG: 'get count' })
  const started = Date.now()
  const outcome = await runChromiumChecks(
    run({
      steps: parseVerify({
        checks: one,
        engine: 'chromium',
        steps: [{ action: 'wait', selector: '#late', timeoutMs: 300 }]
      }).steps
    })
  )
  const took = Date.now() - started
  assert.ok(took < 300 + CLEANUP + 8000, `the wait stopped at its timeout (${took} ms)`)
  assert.match(outcome.stopped, /^step-failed: wait/)
  assert.equal(outcome.checks.length, 0)
  assert.equal(await allGone(), true)
}

// The checks are pinned to the page's full URL: a same-origin route change invalidates them.
{
  const settings = 'http://127.0.0.1:4100/settings'
  const other = 'http://127.0.0.1:4100/settings/profile'
  reset({ FAKE_URLS: JSON.stringify([settings, other]) })
  const moved = await runChromiumChecks(run())
  assert.equal(moved.pinned, settings)
  assert.equal(moved.stopped, 'the page navigated during the checks')
  assert.equal(moved.checks[0].pass, false, 'a check on another route never passes')

  reset({ FAKE_URLS: JSON.stringify([settings, settings, other]) })
  const after = await runChromiumChecks(run())
  assert.equal(after.checks[0].pass, true, 'the check held on the pinned page')
  assert.equal(after.url, other)
  assert.equal(after.stopped, 'the page navigated during the checks', 'but the run is stopped')

  reset({ FAKE_URLS: JSON.stringify([settings]) })
  const steady = await runChromiumChecks(run())
  assert.equal(steady.stopped, null)
  assert.equal(steady.pinned, settings)
  assert.equal(steady.checks[0].pass, true)

  reset({ FAKE_URLS: JSON.stringify(['https://example.com/']) })
  const off = await runChromiumChecks(run())
  assert.equal(off.stopped, 'the page left the dev server')
  assert.equal(off.pinned, null, 'nothing is pinned off the server')
}

// The release is wired into the real session close paths (chat close and detached spawns).
{
  const source = readFileSync(join(import.meta.dir, '../src/main/agent.ts'), 'utf8')
  assert.match(
    source,
    /function releaseRuntimes\(s: ProviderSession, emitKey: string\)[\s\S]*?releaseSessionReceipts\(emitKey, projectKey\(s\.root\)\)/,
    'the release is keyed by the closing session, never by the bare root'
  )
  assert.doesNotMatch(source, /releaseReceiptsFor/)
  assert.match(
    source.slice(source.indexOf('function closeChat(')),
    /^[\s\S]*?releaseRuntimes\(s, sessionKey\)/,
    'a chat releases under its own session key'
  )
  assert.match(
    source.slice(source.indexOf('function closeSession(')),
    /^[\s\S]*?releaseRuntimes\(s, parentSessionKey\)/,
    "a spawn releases under the key its tools ran with (the parent's emitKey)"
  )
  assert.match(source, /closeSession\(session, parentSessionKey\)/)
}

rmSync(work, { recursive: true, force: true })
console.log(
  'BROWSER-VERIFY-BOUNDS OK — refs survive eviction, receipts released with the session, hung CLI killed and bounded, round and wait deadlines, Chromium document pinned'
)
