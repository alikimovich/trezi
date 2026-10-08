// LKM-197 acceptance: a Vite project with a local `file:` dependency whose CSS changes.
// After the dependency changes on disk, the dependency watch fires, the project restarts
// through the real Swift RuntimeOwner with clean dependency caches, the preview (system
// WebKit) reloads past its caches on the same path, and the page shows the new computed
// style without a manual action. Real Vite, real WebKit: SKIPs without a native build, a
// working install, or local port binding.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { cp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { registerServiceDevServer } from '../src/main/devserver-service.ts'
import { PAGE_ASSETS, staleAsset } from '../src/main/preview-freshness.ts'
import { DependencyWatch } from '../src/native/dependency-watch.ts'
import { serviceRuntime } from '../src/native/runtime-service.ts'
import { spawnHostBridge } from './helpers/host-bridge.mjs'
import { swiftBuild } from './helpers/swift-build.mjs'

const NAME = 'DEPENDENCY-REFRESH-VITE'
const skip = (why) => {
  console.log(`${NAME} SKIP — ${why}`)
  process.exit(0)
}
const host = resolve('out/native/Trezi.app/Contents/MacOS/TreziHost')
if (process.platform !== 'darwin' || !existsSync(host)) skip('build the macOS native host first.')

const bindable = await new Promise((done) => {
  const probe = createServer()
  probe.once('error', () => done(false))
  probe.listen(0, '127.0.0.1', () => probe.close(() => done(true)))
})
if (!bindable) skip('local port binding is unavailable in this environment.')

const scratch = mkdtempSync(join(tmpdir(), 'trezi-dependency-refresh-'))
const fixture = resolve('test/fixtures/dependency-refresh-vite')
const app = join(scratch, 'app')
const ui = join(scratch, 'ui')
const children = new Set()
let bridge
const cleanup = () => {
  try {
    bridge?.send('quit')
  } catch {}
  for (const child of children) child.kill('SIGKILL')
  rmSync(scratch, { recursive: true, force: true })
}
process.on('exit', cleanup)

await cp(fixture, scratch, { recursive: true })
const installed = spawnSync('bun', ['install'], { cwd: app, stdio: 'pipe', timeout: 120000 })
if (installed.status !== 0)
  skip(
    `could not install fixture dependencies: ${(installed.stderr || installed.stdout)?.toString().slice(0, 240)}`
  )
// Vite refuses files outside its root when a `file:` package is symlinked: serve a real copy.
const installedUi = join(app, 'node_modules', 'ui')
if (lstatSync(installedUi).isSymbolicLink()) {
  await rm(installedUi)
  await cp(ui, installedUi, { recursive: true })
}

// The compiled RuntimeOwner fixture (the same one test/runtime-owner.mjs drives).
const sources = [
  'ServiceContract',
  'LedgerStore',
  'OperationLedger',
  'PreferencesFile',
  'PreferencesOwner',
  'WorkspaceFile',
  'WorkspaceOwner',
  'DomainChannel',
  'ProcessGuardian',
  'ManagedProcess',
  'RuntimeNet',
  'RuntimeDetect',
  'StaticSite',
  'StaticServer',
  'RuntimeServer',
  'RuntimeOwner'
].map((name) => `src/service/${name}.swift`)
const binary = join(scratch, 'runtime-fixture')
swiftBuild(
  'runtime-owner',
  [...sources, 'test/fixtures/runtime-owner/main.swift', '-framework', 'CoreServices'],
  { out: binary }
)
mkdirSync(join(scratch, 'profile'))
const child = spawn(binary, [join(scratch, 'profile')], {
  // Its own port range: unit tests run in parallel and the default base (7777) is shared with
  // island-flicker-frameworks, whose probe-then-bind would race this server for the same port.
  env: {
    ...process.env,
    RUNTIME_PORT: '',
    RUNTIME_PORT_BASE: '8300',
    RUNTIME_READY_TIMEOUT: '90'
  },
  stdio: ['pipe', 'pipe', 'inherit']
})
children.add(child)
const link = new EventEmitter()
link.sendService = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`)
const ready = new Promise((resolveReady) =>
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.event === 'service-reply' || message.event === 'service-event')
      link.emit(message.event, message)
    else if (message.ready) resolveReady()
  })
)
await ready
const handlers = new Map()
const logs = []
registerServiceDevServer(
  { handle: (name, fn) => handlers.set(name, fn) },
  serviceRuntime(link),
  (line) => logs.push(line)
)
const start = (cleanCache) =>
  handlers.get('devserver:start')(
    {},
    { root: app, command: 'bun run dev', framework: 'vite', ...(cleanCache ? { cleanCache } : {}) }
  )

bridge = spawnHostBridge(host, resolve('out/native'), 'ephemeral')
await once(bridge, 'ready', { signal: AbortSignal.timeout(15000) })
bridge.send('visible', { view: 'preview', visible: true })
const page = (code) => bridge.request('evaluate', { view: 'preview', code })
async function until(check, label, polls = 200) {
  for (let i = 0; i < polls; i++) {
    try {
      const value = await check()
      if (value) return value
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`timed out: ${label}`)
}
const color = () => page('getComputedStyle(document.querySelector("#probe")).color')
const pathOf = () => page('location.pathname + location.search')

// The owner probes a free port from 7777 and then Vite binds it; another dev server (a
// parallel unit test such as island-flicker-frameworks, or another checkout) can take
// the port in between. Only that lost race is retried: the owner then assigns the next
// free port. The clean restart below keeps its port, as the hard reload requires.
async function firstStart() {
  for (let attempt = 1; ; attempt++) {
    try {
      return await start(false)
    } catch (error) {
      if (attempt >= 3 || !/Port \d+ is already in use|EADDRINUSE/i.test(String(error?.message)))
        throw error
      console.log(`${NAME} port taken during start (attempt ${attempt}); starting again`)
    }
  }
}

try {
  const first = await firstStart()
  const entry = `${first.url.replace(/\/$/, '')}/nested/page?keep=1`
  bridge.send('load', { view: 'preview', url: entry })
  await until(async () => (await color()) === 'rgb(1, 2, 3)', 'the first style in the preview')
  await page('(() => { window.beforeRefresh = true; return true })()')

  // The stale Vite pre-bundle a clean start must drop (Vite itself keeps nothing at this path).
  const marker = join(app, 'node_modules', '.vite', 'stale-marker.json')
  mkdirSync(join(app, 'node_modules', '.vite'), { recursive: true })
  writeFileSync(marker, '{}')

  let refresh
  const watch = new DependencyWatch(
    () => ({ key: 'dependency-refresh', root: app }),
    () => {
      refresh = (async () => {
        const server = await start(true)
        assert.equal(server.url.startsWith('http://127.0.0.1:'), true, 'the server runs again')
        bridge.send('reload', { view: 'preview', hard: true })
      })()
    }
  )
  await watch.tick()
  await watch.tick()
  assert.equal(refresh, undefined, 'nothing changed: the watch stays quiet')

  // The upgrade: new CSS in the package, a new version, installed as a fresh copy.
  writeFileSync(join(ui, 'style.css'), '#probe {\n  color: rgb(10, 20, 30);\n}\n')
  writeFileSync(
    join(ui, 'package.json'),
    '{\n  "name": "ui",\n  "version": "1.0.1",\n  "private": true\n}\n'
  )
  await rm(installedUi, { recursive: true })
  await cp(ui, installedUi, { recursive: true })
  await watch.tick()
  assert.equal(refresh, undefined, 'one poll is not enough: an install may still be running')
  await watch.tick()
  assert.ok(refresh, 'the change held for two polls and fired')
  await refresh

  await until(
    async () =>
      (await color()) === 'rgb(10, 20, 30)' &&
      (await page('typeof window.beforeRefresh')) === 'undefined',
    'the preview shows the new computed style after the refresh'
  )
  assert.equal(await pathOf(), '/nested/page?keep=1', 'the hard reload kept the path')
  assert.equal(existsSync(marker), false, 'the clean start removed node_modules/.vite')
  assert.ok(logs.includes('Cleared the dependency cache node_modules/.vite.'), logs.join('\n'))

  // open_preview / reload_preview report `assets.matches`: what the page loaded equals what Vite serves.
  const origin = new URL(entry).origin
  const loaded = await page(PAGE_ASSETS)
  assert.ok(Array.isArray(loaded) && loaded.length > 0, 'the page lists its assets')
  let compared = 0
  for (const asset of loaded) {
    const url = new URL(asset.url)
    if (url.origin !== origin) continue
    const served = await (await fetch(url, { cache: 'no-store' })).text()
    assert.equal(staleAsset(asset, served), false, `${url.pathname} is not stale`)
    compared++
  }
  assert.ok(compared > 0, 'at least one asset was compared with the dev server')
  const css = await readFile(join(app, 'node_modules/ui/style.css'), 'utf8')
  assert.match(css, /rgb\(10, 20, 30\)/)
  console.log(`${NAME} PASS (${compared} assets match the dev server)`)
} finally {
  cleanup()
}
process.exit(0)
