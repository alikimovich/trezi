// LOCAL-WEBKIT-4: Settings → Browser Checks states against isolated fixtures (fake HOME and
// PATH, a scripted agent-browser and headless shell, a fake platform owner): clean, CLI
// only, shell only, unsupported version, missing npm, old Node, failed / cancelled / retried
// installs, the real launch check through bin/managed/agent-browser, a stale daemon and a
// changed tool. Built-in WebKit stays available throughout; nothing real is installed.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { BROWSER_TOOL_COMMANDS, BROWSER_TOOL_LINKS } from '../bin/trezi-browser-tools.mjs'
import {
  BrowserSetup,
  checkBrowserTools,
  setupReport,
  shortenHome
} from '../src/main/browser-setup.ts'
import { PlatformError } from '../src/main/platform-owner.ts'
import { browserPane, installBlocker } from '../src/native/settings-browser.ts'
import {
  fakeCliScript,
  fixtureProcessList,
  writeBrowserFixture
} from '../src/native/smoke-browser-fixture.ts'

const wrapper = join(import.meta.dir, '../bin/managed/agent-browser')
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const T = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-browser-setup-')))
const root = join(T, 'sessions')
const decoys = []
process.on('exit', () => {
  for (const child of decoys) child.kill('SIGKILL')
  rmSync(T, { recursive: true, force: true })
})

const tools = (home) => join(home, 'Library/Caches/Trezi/browser-tools')
const ownedCli = (home) =>
  join(tools(home), `agent-browser/node_modules/agent-browser/bin/agent-browser-darwin-${arch}`)
const shellAt = (cache) =>
  join(
    cache,
    `chromium_headless_shell-1228/chrome-headless-shell-mac-${arch}/chrome-headless-shell`
  )
const ownedShell = (home) => shellAt(join(tools(home), 'ms-playwright'))
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

// The service stand-in: each press resolves or rejects as the scenario says.
const calls = []
let pending = null
const owner = {
  progress: [],
  next: async () => {
    throw new Error('no install expected')
  },
  onBrowserToolsProgress(listener) {
    this.progress.push(listener)
  },
  browserToolsInstall(step) {
    calls.push(step)
    return this.next(step)
  },
  async browserToolsCancel() {
    if (!pending) return false
    pending(new PlatformError('cancelled', 'The install was cancelled. Nothing was marked ready.'))
    pending = null
    return true
  }
}
let psCalls = 0
const listed = fixtureProcessList(root)
let extraProcesses = []
const ps = async () => {
  psCalls++
  return [...extraProcesses, ...(await listed())]
}
const make = (options = {}) =>
  new BrowserSetup({
    owner: () => owner,
    wrapper: () => wrapper,
    ps,
    timeoutMs: 30_000,
    ...options
  })
const action = (status, id) => browserPane(status).actions.find((a) => a.id === id)
const field = (status, id) => browserPane(status).fields.find((f) => f.id === id)
const assertWebkit = (status) => {
  assert.equal(status.webkit, 'available')
  assert.equal(field(status, 'browserWebkit').value, 'Available')
}

// Clean machine with no Node.js at all: WebKit available, Chromium not installed, and the
// Install buttons say why they cannot run instead of failing later.
{
  const fx = writeBrowserFixture(join(T, 'bare'), { npm: false })
  const home = join(T, 'bare-home')
  const setup = make()
  setup.setFixture({ env: envFor(home, fx.bin), home })
  const status = await setup.refresh()
  assertWebkit(status)
  assert.equal(status.state, 'unavailable')
  assert.equal(
    status.detection.prerequisites.npm,
    undefined,
    'fixture PATH only, no Homebrew folders'
  )
  assert.equal(status.detection.prerequisites.node, undefined)
  assert.match(installBlocker(status, 'cli'), /npm was not found/)
  assert.match(installBlocker(status, 'shell'), /npx was not found/)
  assert.equal(action(status, 'browser-install-cli').disabled, true)
  assert.equal(action(status, 'browser-install-shell').disabled, true)
  assert.equal(action(status, 'browser-check').disabled, false)
  assert.equal(field(status, 'browserChromium').value, 'Not installed')
  assert.equal(field(status, 'browserNode').value, 'Not found')
  assert.match(field(status, 'browserNode').help, /nodejs\.org/)
  assert.doesNotMatch(JSON.stringify(browserPane(status)), /Trezi (is|will not) (broken|work)/i)
  const before = psCalls
  const checked = await setup.recheck()
  assert.equal(checked.state, 'unavailable', 'nothing to launch, so no Ready and no check')
  assert.equal(checked.check, undefined)
  assert.equal(psCalls, before)
  assert.deepEqual(calls, [], 'no install without a press')
}

// The pane's copy commands, links and Install buttons.
const fx = writeBrowserFixture(join(T, 'fixture'))
{
  const home = join(T, 'pane-home')
  const setup = make()
  setup.setFixture({ env: envFor(home, fx.bin), home })
  const status = await setup.refresh()
  const { fields, actions } = browserPane(status)
  assert.equal(actions.find((a) => a.id === 'browser-copy-cli').copy, BROWSER_TOOL_COMMANDS.cli)
  assert.equal(actions.find((a) => a.id === 'browser-copy-shell').copy, BROWSER_TOOL_COMMANDS.shell)
  assert.equal(BROWSER_TOOL_COMMANDS.cli, 'npm install -g agent-browser@0.26.0')
  assert.equal(
    BROWSER_TOOL_COMMANDS.shell,
    'npx --yes --package=playwright@1.64.1 playwright install chromium-headless-shell --no-remove'
  )
  assert.equal(BROWSER_TOOL_LINKS.agentBrowser, 'https://agent-browser.dev/installation')
  assert.equal(BROWSER_TOOL_LINKS.playwrightBrowsers, 'https://playwright.dev/docs/browsers')
  for (const id of ['browserCliCommand', 'browserShellCommand', 'browserCliDocs', 'browserNode'])
    assert.ok(fields.find((f) => f.id === id).action, `${id} is pressable`)
  assert.match(fields.find((f) => f.id === 'browserCliDocs').help, /Chrome for Testing/)
  assert.equal(status.detection.prerequisites.node.major, 22)
  assert.equal(installBlocker(status, 'cli'), null)
  assert.equal(installBlocker(status, 'shell'), null)
  assert.equal(action(status, 'browser-install-cli').disabled, false)
  assert.equal(action(status, 'browser-install-shell').disabled, false)
  assert.equal(action(status, 'browser-cancel'), undefined)
  // Node 18 cannot run Playwright 1.64.1: the shell install is blocked, the CLI install is not.
  fx.nodeVersion('v18.19.0')
  const old = await setup.refresh()
  assert.match(installBlocker(old, 'shell'), /Node\.js 20 or later \(found 18\)/)
  assert.equal(action(old, 'browser-install-shell').disabled, true)
  assert.equal(action(old, 'browser-install-cli').disabled, false)
  fx.nodeVersion('v22.11.0')
}

// CLI only, then shell only: partial, naming what is missing; never launched.
{
  const home = join(T, 'cli-home')
  place(fx.payload.cli, ownedCli(home))
  const setup = make()
  setup.setFixture({ env: envFor(home, fx.bin), home })
  const status = await setup.recheck()
  assertWebkit(status)
  assert.equal(status.state, 'partial')
  assert.match(status.summary, /Chromium headless shell is missing/)
  assert.equal(status.detection.cli.source, 'trezi')
  assert.equal(status.detection.cli.version, '0.26.0')
  assert.equal(action(status, 'browser-install-cli'), undefined)
  assert.ok(action(status, 'browser-install-shell'))
  assert.equal(status.check, undefined)
}
{
  const home = join(T, 'shell-home')
  place(fx.payload.shell, shellAt(join(home, 'Library/Caches/ms-playwright')))
  const setup = make()
  setup.setFixture({ env: envFor(home, fx.bin), home })
  const status = await setup.recheck()
  assert.equal(status.state, 'partial')
  assert.match(status.summary, /agent-browser CLI is missing/)
  assert.equal(status.detection.shell.source, 'playwright', 'another tool’s cache is used in place')
  assert.equal(status.detection.shell.version, '149.0.7827.55')
  assert.equal(field(status, 'browserShell').value, '149.0.7827.55')
}

// An untested newer CLI on PATH is unsupported and never launched; Trezi's own 0.26.0 wins.
{
  const home = join(T, 'newer-home')
  const bin = join(T, 'newer-bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'agent-browser'), fakeCliScript(join(T, 'unused-mode'), '0.39.1'))
  chmodSync(join(bin, 'agent-browser'), 0o755)
  place(fx.payload.shell, ownedShell(home))
  const setup = make()
  setup.setFixture({
    env: { ...envFor(home, fx.bin), PATH: `${bin}:${fx.bin}:/usr/bin:/bin` },
    home
  })
  const before = psCalls
  const status = await setup.recheck()
  assert.equal(status.state, 'unsupported')
  assert.match(status.summary, /0\.39\.1 is not supported yet.*0\.26\.x \(0\.26\.0\)/)
  assert.equal(status.detection.cli.source, 'path')
  assert.equal(field(status, 'browserCli').value, '0.39.1 (unsupported)')
  assert.ok(action(status, 'browser-install-cli'), 'Install offers the tested release')
  assert.equal(status.check, undefined)
  assert.equal(psCalls, before, 'an unsupported CLI is never launched')
  place(fx.payload.cli, ownedCli(home))
  const owned = await setup.refresh()
  assert.equal(owned.detection.cli.source, 'trezi')
  assert.equal(owned.state, 'unchecked', 'found but not Ready until a check passes')
}

// Installs and checks on one machine: failed, cancelled, retried, then a real launch check.
const home = join(T, 'home')
const env = envFor(home, fx.bin)
const setup = make()
setup.setFixture({ env, home })
let changes = 0
setup.onChange(() => changes++)
place(fx.payload.cli, ownedCli(home))
assert.equal((await setup.refresh()).state, 'partial')

owner.next = async () => {
  throw new PlatformError(
    'ioFailure',
    'npx exited with status 1; the Chromium headless shell was not installed.\nnpm error code ENOTFOUND'
  )
}
let status = await setup.installTool('shell')
assertWebkit(status)
assert.equal(status.state, 'partial', 'a failed install leaves the state as found')
assert.equal(status.install.error.includes('ENOTFOUND'), true)
assert.equal(status.install.cancelled, false)
assert.equal(status.check, undefined)
assert.equal(field(status, 'browserInstall').value, 'Failed')
assert.equal(action(status, 'browser-install-shell').disabled, false, 'retry is offered')

// Cancel: Installing… while it runs (Cancel offered, other presses refused), then Cancelled.
owner.next = () =>
  new Promise((_, reject) => {
    pending = reject
  })
const cancelled = setup.installTool('shell')
await Promise.resolve()
for (const listener of owner.progress) listener('shell', 'Downloading Chromium Headless Shell')
for (const listener of owner.progress) listener('cli', 'not this install')
status = setup.status()
assert.equal(status.state, 'installing')
assert.equal(setup.busy, true)
assert.deepEqual(status.install.lines, ['Downloading Chromium Headless Shell'])
assert.ok(action(status, 'browser-cancel'))
assert.equal(action(status, 'browser-check').disabled, true)
assert.equal(action(status, 'browser-install-shell').disabled, true)
assert.equal(field(status, 'browserInstall').value, 'Running')
await assert.rejects(setup.recheck(), /Wait for the running install/)
await assert.rejects(setup.installTool('cli'), /Wait for the running install/)
assert.equal(await setup.cancelInstall(), true)
status = await cancelled
assert.equal(status.state, 'partial')
assert.equal(status.install.cancelled, true)
assert.equal(field(status, 'browserInstall').value, 'Cancelled')
assert.equal(await setup.cancelInstall(), false, 'nothing left to cancel')

// Retry succeeds: the service placed the shell, so the setup checks it at once and only a
// passing launch through the wrapper makes it Ready.
owner.next = async (step) => {
  place(fx.payload.shell, ownedShell(home))
  return { step, path: ownedShell(home), revision: 1228 }
}
const beforePs = psCalls
// A poller (the native smoke, the pane) settles once it sees no work running: from the
// install on, every idle reading must already show the new shell, never the old detection.
const idle = []
const installing = setup.installTool('shell')
const poll = setInterval(() => {
  if (!setup.busy) idle.push(setup.status().detection.shell?.path)
}, 1)
status = await installing
clearInterval(poll)
assert.deepEqual(
  idle.filter((path) => path !== ownedShell(home)),
  [],
  'never idle on the detection from before the install'
)
assert.equal(status.state, 'ready', status.check?.message ?? status.summary)
assert.ok(psCalls > beforePs, 'Ready needs the fresh browser process')
assert.equal(status.check.ok, true)
assert.equal(status.check.browser.cli, ownedCli(home))
assert.equal(status.check.browser.shell, ownedShell(home))
assert.ok(Number.isInteger(status.check.browser.pid))
assert.deepEqual(readdirSync(root), [], 'the check closed its session and removed its folder')
assert.match(
  status.install.done,
  /Installed the Chromium headless shell in Trezi’s tools folder \(~\//
)
assert.equal(field(status, 'browserChromium').value, 'Ready')
assert.ok(field(status, 'browserChecked'))
assert.deepEqual(calls, ['shell', 'shell', 'shell'])
assert.ok(changes > 0)

// A changed tool is no longer Ready (the check was of the old one).
writeFileSync(ownedShell(home), '#!/bin/bash\necho "Chromium 149.0.7827.60"\n')
status = await setup.refresh()
assert.equal(status.state, 'unchecked')
assert.equal(status.check, undefined)
assert.equal((await setup.recheck()).state, 'ready')

// A failed install after Ready forgets Ready.
owner.next = async () => {
  throw new PlatformError(
    'ioFailure',
    'npm exited with status 1; the agent-browser CLI was not installed.'
  )
}
status = await setup.installTool('cli')
assert.notEqual(status.state, 'ready')
assert.equal(status.check, undefined)
assert.equal(status.state, 'unchecked')

// A stale daemon answers but starts no browser for this check: only its old shell runs.
fx.mode('cli', 'no-browser')
const decoy = spawn('/bin/sleep', ['60'], {
  argv0: `${ownedShell(home)} --headless --user-data-dir=${join(root, 'tzab-501-olddaemon000/p')}`,
  stdio: 'ignore'
})
decoys.push(decoy)
extraProcesses = [
  {
    pid: decoy.pid,
    command: `${ownedShell(home)} --headless --user-data-dir=${join(root, 'tzab-501-olddaemon000/p')}`
  }
]
status = await setup.recheck()
assert.equal(status.state, 'failed')
assert.match(status.check.message, /older agent-browser daemon/)
assert.equal(field(status, 'browserChromium').value, 'Check failed')
assert.equal(field(status, 'browserChecked'), undefined)
extraProcesses = []
decoy.kill('SIGKILL')

// A browser that cannot start is a failed check with the CLI's own error.
fx.mode('cli', 'fail')
status = await setup.recheck()
assert.equal(status.state, 'failed')
assert.match(
  status.check.message,
  /could not open a page \(exit 1\): Chromium exited during startup/
)
fx.mode('cli', 'ok')
assert.equal((await setup.recheck()).state, 'ready')

// The check itself: a missing shell is the wrapper's dependency answer, not a launch.
{
  const bare = join(T, 'check-home')
  place(fx.payload.cli, ownedCli(bare))
  const result = await checkBrowserTools({
    wrapper,
    cli: ownedCli(bare),
    shell: ownedShell(bare),
    env: envFor(bare, fx.bin),
    home: bare,
    ps
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /headless shell is not installed/)
}
assert.deepEqual(
  setupReport('x\nTrezi agent-browser: setup: {"cli":"/a","shell":"/b","base":"/c"}\n'),
  { cli: '/a', shell: '/b', base: '/c' }
)
assert.equal(setupReport('Trezi agent-browser: setup: {"cli":1}'), null)
// A home under /var (whose real path is /private/var) is shortened in both forms, and only
// where a path starts: never "/private~/…" (the native smoke's service answers real paths).
{
  const linked = join(T, 'linked-home')
  symlinkSync(join(T, 'home'), linked)
  assert.equal(
    shortenHome(`in (${join(T, 'home')}/a) and ${linked}/b; /x${linked}/c ${linked}x`, linked),
    `in (~/a) and ~/b; /x${linked}/c ${linked}x`
  )
  assert.equal(shortenHome('/var/h/a /private/var/h/b', '/var/h'), '~/a /private/var/h/b')
}

// A build without the packaged wrapper never reports Ready.
{
  const missing = make({ wrapper: () => undefined })
  missing.setFixture({ env, home })
  const result = await missing.recheck()
  assertWebkit(result)
  assert.equal(result.state, 'failed')
  assert.match(result.summary, /wrapper is missing from this build/)
}

console.log('browser-setup: ok')
