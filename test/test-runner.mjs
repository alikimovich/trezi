import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireRunLock,
  killTargetGone,
  runCommand,
  runQueue,
  skipReason
} from './helpers/test-runner.mjs'

const root = mkdtempSync(join(tmpdir(), 'trezi-runner-check-'))
const fixture = join(root, 'worker.mjs')
writeFileSync(
  fixture,
  `
import { writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
const [mode, file] = process.argv.slice(2)
writeFileSync(file, JSON.stringify({ profile: process.env.TREZI_USER_DATA, pid: process.pid }))
if (mode === 'skip') console.log('SKIP missing fixture')
else if (mode === 'partial') console.log('PARTIAL SKIP — one provider unavailable')
else if (mode === 'fail') { console.log('SKIP does not override failure'); process.exitCode = 1 }
else if (mode === 'tree') {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  writeFileSync(file + '.child', String(child.pid))
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
}
else if (mode === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000) }
else console.log('an assertion about SKIP should still pass')
`
)
let id = 0
const run = async (mode, extra = {}) => {
  const name = mode === 'partial' ? 'partial' : `case-${id++}`
  const state = join(root, `${name}.json`)
  const result = await runCommand({
    command: 'node',
    args: [fixture, mode, state],
    cwd: root,
    name,
    log: join(root, `${name}.log`),
    timeoutMs: 5000,
    graceMs: 30,
    ...extra
  })
  if (existsSync(state))
    assert.equal(existsSync(JSON.parse(readFileSync(state)).profile), false, 'profile cleaned')
  return result
}
try {
  const lockPath = join(root, 'lock')
  const unlock = acquireRunLock(lockPath)
  assert.throws(() => acquireRunLock(lockPath), /Another suite owns/)
  unlock()
  unlock()
  acquireRunLock(lockPath)()
  assert.equal(existsSync(lockPath), false)
  assert.equal((await run('pass')).outcome, 'PASS')
  assert.equal((await run('skip')).outcome, 'SKIP')
  assert.equal((await run('partial')).outcome, 'SKIP')
  assert.equal((await run('fail')).outcome, 'FAIL')
  const timeout = await run('hang', { timeoutMs: 300 })
  assert.equal(timeout.outcome, 'TIMEOUT')
  assert(timeout.duration < 4000, 'timeout escalates without hanging')
  if (process.platform !== 'win32') {
    const tree = await run('tree', { timeoutMs: 500 })
    assert.equal(tree.outcome, 'TIMEOUT')
    const childPid = Number(readFileSync(join(root, `${tree.name}.json.child`), 'utf8'))
    const alive = () => {
      try {
        process.kill(childPid, 0)
        return true
      } catch (e) {
        if (e.code === 'ESRCH') return false
        throw e
      }
    }
    for (let i = 0; i < 50 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(alive(), false, 'timeout reaps a stubborn descendant, not just the test process')
  }
  const spawnFailure = await run('pass', { command: join(root, 'missing-command') })
  assert.equal(spawnFailure.outcome, 'FAIL')
  assert.match(spawnFailure.note, /ENOENT/)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 300)
  const cancelled = await run('hang', { signal: controller.signal })
  clearTimeout(timer)
  assert.equal(cancelled.outcome, 'CANCELLED')
  assert.equal((await run('pass', { signal: controller.signal })).outcome, 'CANCELLED')

  // Assert overlap and a hard exclusive barrier, independently of wall-clock speed.
  let active = 0
  let peak = 0
  const events = []
  const items = ['a', 'b', 'exclusive', 'c', 'd'].map((name) => ({
    name,
    exclusive: name === 'exclusive'
  }))
  const results = await runQueue(items, 2, async (item) => {
    if (item.exclusive) assert.equal(active, 0)
    active++
    peak = Math.max(active, peak)
    events.push(`start:${item.name}`)
    await new Promise((resolve) => setTimeout(resolve, item.name === 'a' ? 40 : 10))
    if (item.exclusive) assert.equal(active, 1)
    active--
    events.push(`end:${item.name}`)
    return { name: item.name }
  })
  assert.equal(peak, 2)
  assert.deepEqual(
    results.map((r) => r.name),
    items.map((r) => r.name),
    'stable report order'
  )
  assert(events.indexOf('end:a') < events.indexOf('start:exclusive'))
  assert(events.indexOf('end:exclusive') < events.indexOf('start:c'))
  // LKM-345: one group never overlaps itself; the other tests fill the free workers.
  const grouped = ['p1', 'p2', 'x', 'p3', 'y', 'z'].map((name) => ({
    name,
    group: name.startsWith('p') ? 'swift-preview' : undefined
  }))
  let previews = 0
  let groupPeak = 0
  active = 0
  peak = 0
  events.length = 0
  const groupedResults = await runQueue(grouped, 3, async (item) => {
    if (item.group) previews++
    groupPeak = Math.max(previews, groupPeak)
    active++
    peak = Math.max(active, peak)
    events.push(`start:${item.name}`)
    await new Promise((resolve) => setTimeout(resolve, item.group ? 30 : 5))
    active--
    if (item.group) previews--
    events.push(`end:${item.name}`)
    return { name: item.name }
  })
  assert.equal(groupPeak, 1, 'one swift-preview test at a time')
  assert.equal(peak, 3, 'the rest of the queue runs beside it')
  assert.deepEqual(
    groupedResults.map((r) => r.name),
    grouped.map((r) => r.name),
    'stable report order with groups'
  )
  assert(events.indexOf('end:p1') < events.indexOf('start:p2'))
  assert(events.indexOf('end:p2') < events.indexOf('start:p3'))
  assert(events.indexOf('start:x') < events.indexOf('end:p1'), 'x skips ahead of p2')
  // Only grouped tests left, more workers than one group can use: no deadlock.
  const onlyGroup = ['q1', 'q2', 'q3'].map((name) => ({ name, group: 'g' }))
  assert.deepEqual(
    (await runQueue(onlyGroup, 3, async ({ name }) => ({ name }))).map((r) => r.name),
    ['q1', 'q2', 'q3']
  )
  await assert.rejects(
    runQueue([], 0, () => {}),
    /positive integer/
  )
  let calls = 0
  const stopped = await runQueue(
    items,
    2,
    () => {
      calls++
    },
    controller.signal
  )
  assert.equal(calls, 0)
  assert(stopped.every((r) => r.outcome === 'CANCELLED'))
  const marker = join(root, 'marker.log')
  writeFileSync(marker, 'ok — pruneOrphans must SKIP a live checkout\nOTHER SKIP — unrelated\n')
  assert.equal(await skipReason(marker, 'worktrees'), null)
  writeFileSync(marker, 'AUTO-RECONCILIATION LIVE SKIP — unavailable\n')
  assert.match(await skipReason(marker, 'auto-reconciliation-live'), /unavailable/)
  const cli = join(root, 'cli')
  mkdirSync(join(cli, 'test/helpers'), { recursive: true })
  for (const path of ['run.mjs', 'tiers.mjs', 'helpers/test-runner.mjs', 'helpers/test-plan.mjs'])
    writeFileSync(join(cli, 'test', path), readFileSync(new URL(`./${path}`, import.meta.url)))
  // Populate every native member with a console-only stub; no desktop is launched.
  const nativeFixtures = [
    'native-runtime',
    'native-source-window',
    'native-chat-scroll',
    'native-next-hmr',
    'island-flicker-frameworks',
    'browser-setup-packaged'
  ]
  for (const name of nativeFixtures) {
    writeFileSync(join(cli, `test/${name}.mjs`), `console.log('${name.toUpperCase()} PASS')`)
  }
  writeFileSync(
    join(cli, 'test/native-runtime-live.mjs'),
    "console.log('NATIVE-RUNTIME-LIVE SKIP — no credentials')"
  )
  writeFileSync(
    join(cli, 'test/provider-live-parity.mjs'),
    "console.log('PROVIDER-LIVE-PARITY SKIP: not authorized')"
  )
  const invoke = (args) =>
    spawnSync('node', [join(cli, 'test/run.mjs'), ...args], {
      cwd: cli,
      encoding: 'utf8',
      timeout: 10000
    })
  const report = (result) => {
    const path = /^Report: (.+)$/m.exec(result.stdout)?.[1]
    assert(path, result.stdout + result.stderr)
    assert.equal(existsSync(join(cli, 'test/artifacts/runs/.runner-lock')), false)
    return JSON.parse(readFileSync(path))
  }
  const preview = invoke(['native', '--list'])
  assert.equal(preview.status, 0, preview.stdout + preview.stderr)
  assert.equal(preview.stdout, nativeFixtures.map((name) => `native\t${name}\n`).join(''))
  assert.equal(existsSync(join(cli, 'test/artifacts')), false, 'listing creates no run artifacts')
  const success = invoke(['native', 'live'])
  assert.equal(success.status, 0, success.stdout + success.stderr)
  assert.deepEqual(report(success).counts, { PASS: nativeFixtures.length, SKIP: 2 })
  const focused = invoke(['native', '--filter=native-source-window'])
  assert.equal(focused.status, 0, focused.stdout + focused.stderr)
  assert.deepEqual(
    report(focused).results.map((r) => r.name),
    ['native-source-window']
  )
  const planned = invoke([
    'native',
    'live',
    '--filter=native-source-window,provider-live-parity',
    '--list',
    '--typecheck'
  ])
  assert.equal(planned.status, 0, planned.stdout + planned.stderr)
  assert.equal(
    planned.stdout,
    'native\tnative-source-window\nlive\tprovider-live-parity\ntypecheck\ttypecheck\ntypecheck\ttypecheck-native\n'
  )
  assert.equal(invoke(['native', '--list']).stdout.trim().split('\n').length, nativeFixtures.length)
  writeFileSync(
    join(cli, 'test/native-runtime.mjs'),
    "for (let i = 1; i <= 5; i++) console.log('line ' + i); process.exit(1)"
  )
  const failure = invoke(['native'])
  assert.equal(failure.status, 1)
  assert.equal(report(failure).counts.FAIL, 1)
  assert.doesNotMatch(failure.stdout, /line 5/, 'without --log-tail only the log path is printed')
  // CI keeps only the job output, so --log-tail prints a failing test's last lines inline.
  const tailed = invoke(['native', '--log-tail=2'])
  assert.equal(tailed.status, 1)
  assert.match(
    tailed.stdout,
    /last 2 of 5 log lines -----\nline 4\nline 5\n----- end native-native-runtime -----/,
    tailed.stdout
  )
  assert.doesNotMatch(tailed.stdout, /line 3/)
  assert.doesNotMatch(tailed.stdout, /native-source-window: last/, 'passing tests print no tail')
  for (const args of [
    ['unit', '--jobs=0'],
    ['unit', '--log-tail=0'],
    ['unit', '--filter=missing'],
    ['unit', '--filter='],
    ['unit', '--filter=display-path,'],
    ['native', '--filter=display-path', '--list'],
    ['unit', '--filter=missing', '--list'],
    ['unit', '--filter=', '--list'],
    ['--list'],
    ['constructor']
  ])
    assert.equal(invoke(args).status, 2)
  // macOS reports EPERM for a group holding only unreaped zombies: gone when reaping, never when stopping.
  const eperm = Object.assign(new Error('kill'), { code: 'EPERM' }),
    esrch = Object.assign(new Error('kill'), { code: 'ESRCH' })
  assert.equal(killTargetGone(esrch, false, 'linux'), true)
  assert.equal(killTargetGone(eperm, true, 'darwin'), true)
  assert.equal(
    killTargetGone(eperm, false, 'darwin'),
    false,
    'A failed stop/timeout kill is still a failure'
  )
  assert.equal(killTargetGone(eperm, true, 'linux'), false)
  assert.equal(
    killTargetGone(Object.assign(new Error('kill'), { code: 'EINVAL' }), true, 'darwin'),
    false
  )
  console.log(
    'TEST-RUNNER OK — bounded concurrency, barriers, outcomes, timeout, cancellation, cleanup'
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
