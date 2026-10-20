import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  managedBrowserDirectory,
  managedBrowserWrapper
} from '../../src/main/backends/managed-browser-path.ts'
import { FIXTURE_REVISION, writeBrowserFixture } from '../../src/native/smoke-browser-fixture.ts'

/**
 * LOCAL-WEBKIT-4: the built Trezi.app copied somewhere else, with no checkout and no
 * agent-browser or headless shell. Built-in WebKit stays linked into the host, the packaged
 * detection reports nothing installed (never a broken Trezi), the packaged wrapper is the one
 * the bundled backend resolves and exits 3 with the setup hint, and the same packaged wrapper
 * runs a scripted CLI and headless shell from Trezi's own tools folder. Nothing is installed
 * or downloaded; HOME and PATH are private. Run by `bun run test:native` after the build.
 */
const label = 'browser-setup-packaged'
const app = resolve('out/native/Trezi.app')
if (process.platform !== 'darwin') {
  console.log(`${label}: SKIP — macOS native host required.`)
  process.exit(0)
}
if (!existsSync(join(app, 'Contents/MacOS/TreziHost'))) {
  if (process.argv.includes('--require-build')) {
    console.error(`${label}: FAIL — native app missing after build: ${app}`)
    process.exit(1)
  }
  console.log(`${label}: SKIP — build the macOS native app first.`)
  process.exit(0)
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-packaged-')))
try {
  // A relocated copy (a path with a space, outside any checkout).
  const moved = join(root, 'Moved Apps/Trezi.app')
  mkdirSync(dirname(moved), { recursive: true })
  const copy = spawnSync('/usr/bin/ditto', [app, moved], { encoding: 'utf8' })
  assert.equal(copy.status, 0, copy.stderr)
  const contents = join(moved, 'Contents')
  const resources = join(contents, 'Resources')
  const browserBin = join(resources, 'browser/bin')
  const bun = join(contents, 'Helpers/bun')
  const wrapper = join(browserBin, 'managed/agent-browser')

  // Built in: the host links system WebKit; no external tool is part of that.
  const links = spawnSync('/usr/bin/otool', ['-L', join(contents, 'MacOS/TreziHost')], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', TMPDIR: root }
  })
  assert.match(
    links.stdout,
    /\/System\/Library\/Frameworks\/WebKit\.framework\//,
    'host links WebKit'
  )

  // The launcher, detection, guard and policy ship inside the signed app.
  for (const [name, mode] of [
    ['managed/agent-browser', 0o755],
    ['trezi-browser-tools.mjs', 0o644],
    ['trezi-browser-guard.mjs', 0o755],
    ['trezi-browser-policy.mjs', 0o644]
  ]) {
    const stat = statSync(join(browserBin, name))
    assert.equal(stat.mode & 0o777, mode, `packaged ${name} mode`)
  }
  for (const bundle of ['index.cjs', 'provider-helper.cjs'])
    assert.ok(
      readFileSync(join(resources, 'backend', bundle), 'utf8').includes(
        'var __treziResources = require("node:path").resolve(__dirname, "..")'
      ),
      `${bundle} resolves the app's own Resources`
    )
  // The backend's resolution from the moved bundle: the packaged copy, not the checkout.
  const backend = join(resources, 'backend')
  assert.equal(managedBrowserDirectory(backend, undefined, resources), join(browserBin, 'managed'))
  assert.equal(managedBrowserWrapper(backend, undefined, undefined, resources), wrapper)

  const home = join(root, 'home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const work = join(root, 'work')
  mkdirSync(work)
  const env = {
    HOME: home,
    PATH: '/usr/bin:/bin',
    TMPDIR: root,
    TREZI_BROWSER_TEST: '1',
    TREZI_BROWSER_TEST_ROOT: join(root, 'sessions')
  }
  const run = (args, extra = {}) => {
    const proc = spawnSync(bun, args, {
      cwd: work,
      env: { ...env, ...extra },
      encoding: 'utf8',
      timeout: 60_000
    })
    return { code: proc.status, out: proc.stdout, err: proc.stderr }
  }

  // Nothing installed: the packaged detection says so, the platform itself is fine.
  const detect = run([
    '-e',
    `import(${JSON.stringify(join(browserBin, 'trezi-browser-tools.mjs'))}).then(async (m) => console.log(JSON.stringify(await m.detectBrowserTools())))`
  ])
  assert.equal(detect.code, 0, detect.err)
  const detected = JSON.parse(detect.out)
  assert.equal(detected.cli, undefined, 'no CLI in a clean HOME')
  assert.equal(detected.shell, undefined, 'no headless shell in a clean HOME')
  assert.equal(detected.tools, join(home, 'Library/Caches/Trezi/browser-tools'))
  assert.equal(detected.platform.ok, true, JSON.stringify(detected.platform))

  // The packaged wrapper: a missing CLI is a dependency (exit 3), never a launch.
  for (const args of [['--version'], ['--session', 'trezi-packaged', 'open', 'about:blank']]) {
    const missing = run([wrapper, ...args])
    assert.equal(missing.code, 3, `${args.join(' ')}: ${missing.err}`)
    assert.match(missing.err, /dependency: vercel-cli: .*Settings → Browser Checks/)
    assert.equal(missing.out, '')
  }
  // Its policy still refuses a headed route.
  assert.equal(run([wrapper, '--session', 'trezi-packaged', '--headed', 'x', 'open']).code, 2)
  const guard = (command) => {
    const proc = spawnSync(bun, [join(browserBin, 'trezi-browser-guard.mjs'), wrapper], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: work }),
      env,
      encoding: 'utf8'
    })
    assert.equal(proc.status, 0, proc.stderr)
    return proc.stdout
  }
  assert.match(guard('"$TREZI_AGENT_BROWSER" --headed x open'), /"permissionDecision":"deny"/)
  assert.match(guard('agent-browser install'), /"permissionDecision":"deny"/)
  assert.equal(guard('"$TREZI_AGENT_BROWSER" --session trezi-a open about:blank'), '')

  // A scripted CLI and headless shell in Trezi's own tools folder, as its installs leave them.
  const fx = writeBrowserFixture(join(root, 'fixture'), { npm: false })
  const tools = detected.tools
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const cli = join(
    tools,
    `agent-browser/node_modules/agent-browser/bin/agent-browser-darwin-${arch}`
  )
  const shell = join(
    tools,
    `ms-playwright/chromium_headless_shell-${FIXTURE_REVISION}/chrome-headless-shell-mac-${arch}/chrome-headless-shell`
  )
  for (const [from, to] of [
    [fx.payload.cli, cli],
    [fx.payload.shell, shell]
  ]) {
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
    chmodSync(to, 0o755)
  }
  const session = ['--session', 'trezi-packaged']
  const opened = run([wrapper, ...session, 'open', 'about:blank'], {
    TREZI_BROWSER_SETUP_REPORT: '1'
  })
  assert.equal(opened.code, 0, opened.err)
  assert.match(opened.out, /"success":true/)
  const report = JSON.parse(/setup: (\{.*\})/.exec(opened.err)?.[1] ?? '{}')
  assert.deepEqual([report.cli, report.shell], [cli, shell], 'packaged route used the owned tools')
  const launched = readFileSync(join(report.base, 'p/launched'), 'utf8')
  assert.ok(
    launched.includes(`${shell} --headless --user-data-dir=${join(report.base, 'p')}`),
    launched
  )
  assert.match(run([wrapper, ...session, 'get', 'url']).out, /about:blank/)
  assert.equal(run([wrapper, ...session, 'close']).code, 0)
  assert.equal(existsSync(report.base), false, 'close removed the private session')
  assert.deepEqual(readdirSync(join(root, 'sessions')), [])
  console.log(
    `${label}: ok (relocated app: WebKit linked, nothing installed, packaged wrapper dependency hint and owned-tools route)`
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
