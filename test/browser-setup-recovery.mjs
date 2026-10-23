// LOCAL-WEBKIT-4: Settings → Browser Checks cannot be fooled or stuck by a broken tool
// (fake HOME and PATH, scripted tools; nothing real is installed or launched):
// - a tool that ignores SIGTERM cannot hang detection, Settings or the wrapper's passthroughs,
//   and no process is left behind;
// - Ready is bound to the executable's identity, so a same-version replacement is not Ready;
// - a `get url` that exits nonzero, or a `close` that fails, is not Ready, and the check's own
//   private browser and folder are cleaned up;
// - a headless shell that is present but broken gets a Repair action, and reinstalling it
//   lets a recheck reach Ready.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { detectBrowserTools, toolVersionAsync } from '../bin/trezi-browser-tools.mjs'
import { BrowserSetup } from '../src/main/browser-setup.ts'
import { browserPane } from '../src/native/settings-browser.ts'
import { fixtureProcessList, writeBrowserFixture } from '../src/native/smoke-browser-fixture.ts'

const wrapper = join(import.meta.dir, '../bin/managed/agent-browser')
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const T = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-browser-recovery-')))
const root = join(T, 'sessions')
process.on('exit', () => rmSync(T, { recursive: true, force: true }))

const tools = (home) => join(home, 'Library/Caches/Trezi/browser-tools')
const ownedCli = (home) =>
  join(tools(home), `agent-browser/node_modules/agent-browser/bin/agent-browser-darwin-${arch}`)
const ownedShell = (home) =>
  join(
    tools(home),
    `ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-${arch}/chrome-headless-shell`
  )
const place = (from, to) => {
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
  chmodSync(to, 0o755)
}
const envFor = (home, bin) => ({
  HOME: home,
  PATH: `${bin}:/usr/bin:/bin`,
  TREZI_BROWSER_TEST: '1',
  TREZI_BROWSER_TEST_ROOT: root
})
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
const until = async (what, test, ms = 30_000) => {
  const deadline = Date.now() + ms
  while (!test()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
const pidsOf = (...files) => files.map((file) => Number(readFileSync(file, 'utf8').trim()))
/**
 * A hung tool is a bash start: on a busy machine (parallel test runs) it may not have recorded
 * its pid before a short probe limit killed it, and then no kill was exercised (LKM-313, ENOENT
 * on the pid file). `attempt(limitMs)` runs with each limit in turn, every bound in it checked
 * each time, until every pid file exists.
 */
async function untilRecorded(files, limits, attempt) {
  for (const limit of limits) {
    for (const file of files) rmSync(file, { force: true })
    await attempt(limit)
    if (files.every((file) => existsSync(file))) return limit
  }
  assert.fail(`the hung tool never recorded its pid: ${files.join(', ')}`)
}
const allDead = (pids) => pids.every((pid) => !alive(pid))

// A tool that ignores TERM: alone (exec'd sleep keeps the ignored signal) or with a child it waits for.
const hung = (path, nested) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    nested
      ? `#!/bin/bash\ntrap '' TERM\necho $$ > ${path}.pid\n/bin/sleep 300 &\necho $! > ${path}.child\nwait\n`
      : `#!/bin/bash\ntrap '' TERM\necho $$ > ${path}.pid\nexec /bin/sleep 300\n`
  )
  chmodSync(path, 0o755)
}

const seen = new Set()
const listed = fixtureProcessList(root)
let psCalls = 0
const ps = async () => {
  psCalls++
  const list = await listed()
  for (const entry of list) seen.add(entry.pid)
  return list
}
const owner = {
  next: async () => {
    throw new Error('no install expected')
  },
  onBrowserToolsProgress() {},
  browserToolsInstall(step) {
    return this.next(step)
  },
  async browserToolsCancel() {
    return false
  }
}
const make = (psHook = ps) =>
  new BrowserSetup({ owner: () => owner, wrapper: () => wrapper, ps: psHook, timeoutMs: 30_000 })
const action = (status, id) => browserPane(status).actions.find((a) => a.id === id)
const field = (status, id) => browserPane(status).fields.find((f) => f.id === id)

// 1. Version probes always settle, kill the whole group, and leave nothing running.
{
  const dir = join(T, 'hung')
  for (const nested of [false, true]) {
    const tool = join(dir, nested ? 'nested' : 'plain')
    hung(tool, nested)
    const files = [`${tool}.pid`, ...(nested ? [`${tool}.child`] : [])]
    await untilRecorded(files, [1500, 6000, 20_000], async (limit) => {
      const started = Date.now()
      assert.equal(await toolVersionAsync(tool, { PATH: '/usr/bin:/bin' }, limit), undefined)
      // The tool sleeps 300 s: only a kill at the limit settles in this time.
      assert.ok(
        Date.now() - started < limit + 3500,
        'settled at the limit, not when the tool exits'
      )
      const pids = files.filter((file) => existsSync(file))
      await until('the hung tool and its child to be gone', () => allDead(pidsOf(...pids)))
    })
  }

  // Detection with a hung CLI, shell and node together still finishes at the probe limit.
  const home = join(T, 'hung-home')
  const bin = join(T, 'hung-bin')
  hung(ownedCli(home), true)
  hung(ownedShell(home), false)
  hung(join(bin, 'node'), false)
  const probed = [
    `${ownedCli(home)}.pid`,
    `${ownedCli(home)}.child`,
    `${ownedShell(home)}.pid`,
    `${join(bin, 'node')}.pid`
  ]
  await untilRecorded(probed, [1500, 6000, 20_000], async (limit) => {
    const started = Date.now()
    const detection = await detectBrowserTools({
      env: envFor(home, bin),
      home,
      probeTimeout: limit
    })
    assert.ok(Date.now() - started < limit + 4500, `detection took ${Date.now() - started} ms`)
    assert.equal(detection.cli.source, 'trezi')
    assert.equal(detection.cli.version, undefined)
    assert.equal(detection.shell.version, undefined)
    assert.equal(detection.prerequisites.node.version, undefined)
    const pids = probed.filter((file) => existsSync(file))
    await until('every probe to be gone', () => allDead(pidsOf(...pids)))
  })

  // The wrapper's --version passthrough is killed outright too (exit 1, not a hang). The
  // wrapper is a Bun start before it runs the CLI, so a short limit may pass before the CLI ran.
  const passthrough = [`${ownedCli(home)}.pid`, `${ownedCli(home)}.child`]
  await untilRecorded(passthrough, [1500, 6000, 20_000], async (limit) => {
    const wrapped = Date.now()
    const result = spawnSync(process.execPath, [wrapper, '--version'], {
      env: { ...envFor(home, bin), TREZI_BROWSER_TEST_PASSTHROUGH_MS: String(limit) },
      encoding: 'utf8',
      timeout: limit + 15_000
    })
    assert.equal(result.status, 1, result.stderr)
    assert.ok(Date.now() - wrapped < limit + 6500)
    const pids = passthrough.filter((file) => existsSync(file))
    await until('the passthrough CLI to be gone', () => allDead(pidsOf(...pids.slice(0, 1))))
    for (const child of pidsOf(...pids.slice(1))) {
      try {
        process.kill(child, 'SIGKILL')
      } catch {}
    }
  })
}

const fx = writeBrowserFixture(join(T, 'fixture'))
const withTools = (name, psHook) => {
  const home = join(T, name)
  place(fx.payload.cli, ownedCli(home))
  place(fx.payload.shell, ownedShell(home))
  const setup = make(psHook)
  setup.setFixture({ env: envFor(home, fx.bin), home })
  return { home, setup }
}

// 2. Ready is about the executable, not just its path and version text.
{
  const { home, setup } = withTools('identity-home')
  assert.equal((await setup.recheck()).state, 'ready')
  const shell = ownedShell(home)
  const original = readFileSync(shell, 'utf8')
  const before = statSync(shell)

  // Same path, same size, same mtime, same version: still replaced.
  writeFileSync(shell, original.replace('Chromium', 'Chromiuz'))
  utimesSync(shell, before.atime, before.mtime)
  assert.equal(statSync(shell).size, before.size)
  assert.notEqual(setup.status().state, 'ready', 'not Ready the moment the file changed')
  let status = await setup.refresh()
  assert.equal(status.detection.shell.version, '149.0.7827.55', 'the version text is unchanged')
  assert.equal(status.state, 'unchecked')
  assert.equal(status.check, undefined)
  assert.equal((await setup.recheck()).state, 'ready')

  // Replaced by another file (a new inode) with identical content.
  const swap = `${shell}.new`
  writeFileSync(swap, readFileSync(shell))
  chmodSync(swap, 0o755)
  renameSync(swap, shell)
  status = await setup.refresh()
  assert.equal(status.state, 'unchecked')
  assert.equal((await setup.recheck()).state, 'ready')

  // The same for the CLI.
  const cli = ownedCli(home)
  const cliBefore = statSync(cli)
  writeFileSync(cli, readFileSync(cli, 'utf8').replace('mode=', 'mode ='))
  utimesSync(cli, cliBefore.atime, cliBefore.mtime)
  status = await setup.refresh()
  assert.notEqual(status.state, 'ready')
}

// 2b. A tool replaced WHILE the check runs: the launched binary is not the one now on disk,
// so the result must not make the new file Ready (the next honest recheck can).
for (const which of ['shell', 'cli']) {
  let replace = true
  let replaced
  const during = async () => {
    const list = await ps()
    if (replace && list.length) {
      replace = false
      replaced = which === 'shell' ? ownedShell(home) : ownedCli(home)
      const swap = `${replaced}.new`
      writeFileSync(swap, readFileSync(replaced))
      chmodSync(swap, 0o755)
      renameSync(swap, replaced)
    }
    return list
  }
  const home = join(T, `midcheck-${which}`)
  place(fx.payload.cli, ownedCli(home))
  place(fx.payload.shell, ownedShell(home))
  const setup = make(during)
  setup.setFixture({ env: envFor(home, fx.bin), home })
  const status = await setup.recheck()
  assert.ok(replaced, `the ${which} was replaced during the check`)
  assert.notEqual(status.state, 'ready', `a ${which} replaced mid-check is not Ready`)
  assert.equal(status.state, 'unchecked')
  assert.equal(status.check, undefined, 'the old launch is not attributed to the new file')
  assert.equal((await setup.recheck()).state, 'ready', 'an undisturbed recheck passes')
  await until('the check’s browser to be gone', () => allDead([...seen]))
}

// 3. `get url` must exit 0; `close` must succeed. Neither gives Ready, and nothing is left.
{
  const { setup } = withTools('outcome-home')
  assert.equal((await setup.recheck()).state, 'ready')

  fx.mode('cli', 'url-fail')
  let status = await setup.recheck()
  assert.equal(status.state, 'failed')
  assert.match(status.check.message, /page request failed \(exit 1\)/)
  assert.deepEqual(readdirSync(root), [], 'the check closed its session')
  await until('the check’s browser to be gone', () => allDead([...seen]))

  seen.clear()
  fx.mode('cli', 'close-fail')
  status = await setup.recheck()
  assert.equal(status.state, 'failed', 'a session that will not close is not Ready')
  assert.equal(status.check.ok, false)
  assert.match(status.check.message, /closing it failed \(exit 1\).*not Ready/)
  assert.equal(field(status, 'browserChromium').value, 'Check failed')
  assert.ok(seen.size > 0, 'the check did start a private browser')
  await until('the leftover browser to be stopped', () => allDead([...seen]))
  assert.deepEqual(readdirSync(root), [], 'the private folder was removed')
  // What was done is stated; the daemon is never claimed stopped.
  assert.match(status.check.message, /stopped 1 headless browser process of this check/)
  assert.match(status.check.message, /daemon .* could not be confirmed stopped/)
  assert.doesNotMatch(status.check.message, /Trezi stopped it/)

  // A failed check whose close also fails reports the cleanup too, not silence.
  fx.mode('cli', 'both-fail')
  status = await setup.recheck()
  assert.equal(status.state, 'failed')
  assert.match(status.check.message, /page request failed \(exit 1\)/)
  assert.match(status.check.message, /Also closing it failed.*stopped 1 headless browser process/)
  assert.match(status.check.message, /could not be confirmed stopped/)
  assert.deepEqual(readdirSync(root), [])
  await until('the leftover browser to be stopped', () => allDead([...seen]))
  fx.mode('cli', 'ok')
}

// 3b. A process of the session that survives the kill: the folder is kept as evidence and the
// message says so; an unrelated process is never touched.
{
  const stale = spawnSync('/usr/bin/true').pid
  const bystander = spawn('/bin/sleep', ['300'], { stdio: 'ignore' })
  let ghosts = []
  const stubborn = async () => {
    const list = await ps()
    // The same browser stays listed under a pid that cannot be signalled: still "running".
    if (list.length && !ghosts.length) ghosts = list.map((entry) => ({ ...entry, pid: stale }))
    return [...list, ...ghosts]
  }
  const withBystander = async () => [
    ...(await stubborn()),
    { pid: bystander.pid, command: '/bin/sleep 300' }
  ]
  const { setup } = withTools('survivor-home', withBystander)
  fx.mode('cli', 'close-fail')
  const status = await setup.recheck()
  assert.notEqual(status.state, 'ready')
  assert.equal(status.state, 'failed')
  assert.match(status.check.message, /still running, so Trezi kept its private folder/)
  assert.doesNotMatch(status.check.message, /removed its private folder/)
  assert.match(status.check.message, /could not be confirmed stopped.*close --all/)
  const kept = readdirSync(root)
  assert.equal(kept.length, 1, 'the private folder was kept for recovery')
  assert.match(kept[0], /^tzab-/)
  assert.equal(alive(bystander.pid), true, 'an unrelated process is never killed')
  bystander.kill('SIGKILL')
  rmSync(join(root, kept[0]), { recursive: true, force: true })
  await until('the check’s browser to be gone', () => allDead([...seen]))
  fx.mode('cli', 'ok')
  assert.equal((await setup.recheck()).state, 'ready', 'a healthy check passes again')
  assert.deepEqual(readdirSync(root), [])
}

// 4. A shell that is present but broken: not launched, Repair offered, reinstall then Ready.
{
  const home = join(T, 'broken-home')
  place(fx.payload.cli, ownedCli(home))
  mkdirSync(dirname(ownedShell(home)), { recursive: true })
  writeFileSync(ownedShell(home), '#!/bin/bash\nexit 1\n')
  chmodSync(ownedShell(home), 0o755)
  const setup = make()
  setup.setFixture({ env: envFor(home, fx.bin), home })
  const launches = psCalls
  let status = await setup.recheck()
  assert.equal(status.webkit, 'available')
  assert.equal(status.detection.shell.version, undefined)
  assert.equal(status.state, 'failed')
  assert.match(status.summary, /did not report its version.*Repair/)
  assert.equal(psCalls, launches, 'a broken shell is never launched')
  assert.equal(action(status, 'browser-install-shell').label, 'Repair Headless Shell')
  assert.equal(action(status, 'browser-install-shell').disabled, false)

  const calls = []
  owner.next = async (step) => {
    calls.push(step)
    place(fx.payload.shell, ownedShell(home))
    return { step, path: ownedShell(home), revision: 1228 }
  }
  status = await setup.installTool('shell')
  assert.deepEqual(calls, ['shell'])
  assert.equal(status.state, 'ready', status.check?.message ?? status.summary)
  assert.equal(
    action(status, 'browser-install-shell'),
    undefined,
    'a healthy shell needs no repair'
  )

  // A shell that reports its version but fails the check is repairable too.
  fx.mode('cli', 'fail')
  status = await setup.recheck()
  assert.equal(status.state, 'failed')
  assert.equal(action(status, 'browser-install-shell').label, 'Repair Headless Shell')
  fx.mode('cli', 'ok')
  assert.equal((await setup.recheck()).state, 'ready')

  // No shell at all is an Install, not a Repair.
  rmSync(dirname(dirname(dirname(ownedShell(home)))), { recursive: true, force: true })
  status = await setup.refresh()
  assert.equal(action(status, 'browser-install-shell').label, 'Install Headless Shell')
}

console.log('browser-setup-recovery: ok')
