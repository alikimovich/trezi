// LOCAL-WEBKIT-4: the Swift platform owner's Settings → Browser Checks installs
// (src/service/BrowserTools.swift), compiled into the platform fixture and driven through
// Bun's real client with a scripted node / npm / npx under a fake HOME. Checks the fixed
// argv and environment, Trezi's own tools folder, redacted bounded progress, failure with a
// redacted tail, Node and npm prerequisites, busy refusal, cancel of the whole process
// group, retry, planted links at the install destinations, and the request schema. Nothing is downloaded or installed for real.
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  FIXTURE_SECRET,
  installerArgv,
  installerRun,
  writeBrowserFixture
} from '../src/native/smoke-browser-fixture.ts'
import { skipUnlessDarwin } from './helpers/darwin.mjs'
import { compilePlatformFixture, startPlatformFixture } from './helpers/platform-fixture.mjs'

skipUnlessDarwin('the Swift browser tool installer')
const T = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-browser-install-')))
const binary = compilePlatformFixture()
const fixtures = []
process.on('exit', () => rmSync(T, { recursive: true, force: true }))
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
const until = async (what, test, ms = 10_000) => {
  const deadline = Date.now() + ms
  while (!test()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
const start = async (name, search) => {
  const profile = join(T, `${name}-profile`)
  const home = join(T, `${name}-home`)
  mkdirSync(profile, { recursive: true })
  const fixture = await startPlatformFixture(binary, profile, {
    PLATFORM_BROWSER_HOME: home,
    PLATFORM_BROWSER_SEARCH: search,
    PLATFORM_BROWSER_TIMEOUT: '30',
    NPM_TOKEN: FIXTURE_SECRET,
    HTTPS_PROXY: 'http://proxy.example:3128'
  })
  fixtures.push(fixture)
  const owner = fixture.owner()
  const lines = []
  owner.onBrowserToolsProgress((step, line) => lines.push({ step, line }))
  return { fixture, owner, home, lines, tools: join(home, 'Library/Caches/Trezi/browser-tools') }
}
const refusal = async (promise, code, pattern) => {
  const error = await promise.then(
    () => assert.fail(`expected ${code}`),
    (e) => e
  )
  assert.equal(error.code, code, error.message)
  if (pattern) assert.match(error.message, pattern)
  return error
}

try {
  // No npm or npx at all: an honest prerequisite answer, nothing started.
  {
    const empty = join(T, 'empty-bin')
    mkdirSync(empty)
    const { owner, tools } = await start('bare', empty)
    await refusal(owner.browserToolsInstall('cli'), 'unavailable', /npm was not found.*nodejs\.org/)
    await refusal(owner.browserToolsInstall('shell'), 'unavailable', /npx was not found/)
    assert.equal(existsSync(tools), false, 'no tools folder without an install')
  }

  const fx = writeBrowserFixture(join(T, 'fixture'))
  const { fixture, owner, home, lines, tools } = await start('main', fx.bin)
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'

  // The CLI: the fixed npm argv into Trezi's prefix, then this Mac's binary made executable.
  const cli = await owner.browserToolsInstall('cli')
  const binaryPath = join(
    tools,
    `agent-browser/node_modules/agent-browser/bin/agent-browser-darwin-${arch}`
  )
  assert.deepEqual(cli, { step: 'cli', path: binaryPath, version: '0.26.0' })
  assert.equal(statSync(binaryPath).mode & 0o777, 0o755)
  assert.deepEqual(installerArgv(fx.dir, 'npm'), [
    `install --prefix ${tools}/agent-browser --ignore-scripts --no-save --no-package-lock --no-fund --no-audit --omit=dev --loglevel=http agent-browser@0.26.0`
  ])
  const npm = installerRun(fx.dir, 'npm')
  assert.equal(npm.env.HOME, home, 'npm runs under the given HOME')
  assert.equal(npm.env.TMPDIR, `${tools}/tmp`)
  assert.equal(npm.env.npm_config_cache, `${tools}/npm-cache`)
  assert.equal(npm.env.HTTPS_PROXY, 'http://proxy.example:3128', 'proxies pass through')
  assert.equal(npm.env.NPM_TOKEN, undefined, 'credentials in the environment are never passed on')
  assert.equal(npm.env.PLAYWRIGHT_BROWSERS_PATH, undefined)
  assert.ok(npm.env.PATH.startsWith(`${fx.bin}:`), npm.env.PATH)
  assert.equal(statSync(tools).mode & 0o777, 0o700, 'a private tools folder')
  const cliLines = lines.filter((l) => l.step === 'cli').map((l) => l.line)
  assert.equal(
    cliLines[0],
    '$ npm install --prefix ~/Library/Caches/Trezi/browser-tools/agent-browser --ignore-scripts --no-save --no-package-lock --no-fund --no-audit --omit=dev --loglevel=http agent-browser@0.26.0'
  )
  assert.ok(cliLines.includes('added 1 package in 1s'), cliLines.join('\n'))
  assert.ok(
    cliLines.some((l) => l.includes('authorization: ***')),
    'auth headers redacted'
  )

  // Node 18 cannot run Playwright 1.64.1: refused before npx starts.
  fx.nodeVersion('v18.19.0')
  await refusal(
    owner.browserToolsInstall('shell'),
    'unavailable',
    /needs Node\.js 20 or later.*Node\.js 18/
  )
  assert.equal(installerRun(fx.dir, 'npx'), undefined)
  fx.nodeVersion('v22.11.0')

  // A failed npx: an error with a redacted tail, nothing reported installed.
  fx.mode('npx', 'fail')
  const failed = await refusal(
    owner.browserToolsInstall('shell'),
    'ioFailure',
    /npx exited with status 1; the Chromium headless shell was not installed\.[\s\S]*ENOTFOUND/
  )
  assert.doesNotMatch(failed.message, new RegExp(FIXTURE_SECRET))

  // Cancel: the running install refuses a second one, then its whole group is stopped.
  fx.mode('npx', 'slow')
  const slow = owner.browserToolsInstall('shell')
  await until('the slow install', () => lines.some((l) => l.line.startsWith('Downloading')))
  const { pid } = installerRun(fx.dir, 'npx')
  assert.ok(alive(pid))
  await refusal(owner.browserToolsInstall('cli'), 'busy', /still running/)
  assert.equal(await owner.browserToolsCancel(), true)
  await refusal(slow, 'cancelled', /cancelled\. Nothing was marked ready/)
  await until('the cancelled group to exit', () => !alive(pid))
  assert.equal(await owner.browserToolsCancel(), false, 'nothing left to cancel')

  // Retry: into Trezi's own Playwright cache only, leaving any other cache alone.
  fx.mode('npx', 'ok')
  const shell = await owner.browserToolsInstall('shell')
  assert.deepEqual(shell, {
    step: 'shell',
    path: join(
      tools,
      `ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-${arch}/chrome-headless-shell`
    ),
    revision: 1228
  })
  assert.equal(
    installerArgv(fx.dir, 'npx').at(-1),
    '--yes --package=playwright@1.64.1 playwright install chromium-headless-shell --no-remove'
  )
  assert.equal(installerRun(fx.dir, 'npx').env.PLAYWRIGHT_BROWSERS_PATH, `${tools}/ms-playwright`)
  assert.equal(existsSync(join(home, 'Library/Caches/ms-playwright')), false)

  // Repair: pressing Install again drops Playwright's "already installed" marker first (it
  // would otherwise skip a broken copy), then installs again; a failed run leaves it off.
  const marker = join(tools, 'ms-playwright/chromium_headless_shell-1228/INSTALLATION_COMPLETE')
  assert.equal(existsSync(marker), true, 'the scripted install marks the revision complete')
  fx.mode('npx', 'fail')
  await refusal(owner.browserToolsInstall('shell'), 'ioFailure', /npx exited with status 1/)
  assert.equal(existsSync(marker), false, 'the marker was removed before the repair ran')
  fx.mode('npx', 'ok')
  await owner.browserToolsInstall('shell')
  assert.equal(existsSync(marker), true)

  // Every progress line is redacted and bounded, and the home folder reads as ~.
  assert.ok(lines.length > 4)
  for (const { line } of lines) {
    assert.doesNotMatch(line, new RegExp(FIXTURE_SECRET), line)
    assert.ok(!line.includes(home), line)
    assert.ok(line.length <= 301, line)
  }

  // A planted link at either destination (or above it, or inside it) is refused before the
  // installer starts: nothing is written through it and the outside folder stays as it was.
  {
    const lx = writeBrowserFixture(join(T, 'fixture-links'))
    const links = await start('links', lx.bin)
    const outside = join(T, 'outside-tools')
    mkdirSync(outside)
    writeFileSync(join(outside, 'precious'), 'keep')
    const untouched = () =>
      assert.deepEqual(readdirSync(outside), ['precious'], 'outside folder unchanged')
    const plant = (where) => {
      mkdirSync(dirname(where), { recursive: true })
      symlinkSync(outside, where)
    }
    const cases = [
      ['cli', links.tools, 'agent-browser', /agent-browser is a link/],
      ['shell', links.tools, 'ms-playwright', /ms-playwright is a link/],
      [
        'shell',
        join(links.tools, 'ms-playwright'),
        'chromium_headless_shell-1228',
        /chromium_headless_shell-1228 is a link/
      ],
      [
        'cli',
        join(links.tools, 'agent-browser/node_modules'),
        'agent-browser',
        /node_modules\/agent-browser is a link/
      ],
      ['cli', join(links.home, 'Library/Caches'), 'Trezi', /Trezi is a link or not a folder/]
    ]
    for (const [step, parent, name, pattern] of cases) {
      const target = join(parent, name)
      if (name === 'Trezi') {
        mkdirSync(parent, { recursive: true })
        symlinkSync(outside, target)
      } else {
        plant(target)
      }
      await refusal(links.owner.browserToolsInstall(step), 'ioFailure', pattern)
      untouched()
      assert.equal(
        installerRun(lx.dir, step === 'cli' ? 'npm' : 'npx'),
        undefined,
        'the installer never started'
      )
      rmSync(name === 'Trezi' ? target : join(links.home, 'Library'), {
        recursive: true,
        force: true
      })
    }
    // Without a planted link the same fixture installs normally.
    const clean = await links.owner.browserToolsInstall('cli')
    assert.equal(clean.version, '0.26.0')
    untouched()
  }

  // Only the two fixed installs, with an explicit intent and nothing else.
  for (const [method, body] of [
    ['browserToolsInstall', { intent: 'install', step: 'brew' }],
    ['browserToolsInstall', { intent: 'install', step: 'cli', command: 'curl … | sh' }],
    ['browserToolsInstall', { intent: 'install', step: 'cli', argv: ['--global'] }],
    ['browserToolsInstall', { step: 'cli' }],
    ['browserToolsInstall', { intent: 'cancel', step: 'cli' }],
    ['browserToolsCancel', { intent: 'cancel', step: 'cli' }],
    ['browserToolsCancel', {}]
  ]) {
    const result = await fixture.frame(method, body)
    assert.equal(result.kind, 'failed', `${method} ${JSON.stringify(body)}`)
    assert.equal(result.payload.code, 'invalidRequest', result.payload.message)
  }
  console.log('browser-tools-install: ok')
} finally {
  for (const fixture of fixtures) await fixture.stop()
}
