/**
 * LKM-271: native Swift component previews. The manifest/diagnostics helpers and the
 * launch command, then the real loop on a copy of `test/fixtures/swift-components`:
 * build the preview host, render the SwiftUI, AppKit and mixed previews, click and type
 * into them, rebuild after a source edit, show a compile error while the last good
 * build stays up, recover after the fix, and serve all of it from the driver's page.
 * Frames land in `test/artifacts/swift-preview/`.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODULE_CACHE, SWIFT_CACHE } from './helpers/swift-build.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURE = join(ROOT, 'test/fixtures/swift-components')
const ARTIFACTS = join(ROOT, 'test/artifacts/swift-preview')
const { collectSources, hostCompileArgs, parseDiagnostics, parseManifest } = await import(
  '../src/swift-preview/manifest.ts'
)
const { PreviewSession } = await import('../src/swift-preview/session.ts')
const { SWIFT_PREVIEW_DRIVER, swiftPreviewCommand } = await import('../src/main/swift-preview.ts')
const { detectProject } = await import('../src/main/project-detect.ts')

// --- Pure helpers ---
const manifest = parseManifest(readFileSync(join(FIXTURE, 'trezi-previews.json'), 'utf8'))
assert.deepEqual(manifest, {
  name: 'Swift components demo',
  sources: ['Sources/DemoComponents'],
  previews: ['Previews'],
  exclude: []
})
assert.throws(() => parseManifest('{'), /not valid JSON/)
assert.throws(() => parseManifest('[]'), /must contain an object/)
assert.throws(() => parseManifest('{"sources":["a"]}'), /"previews" must be a list/)
assert.throws(() => parseManifest('{"sources":[],"previews":["p"]}'), /at least one path/)
assert.throws(() => parseManifest('{"sources":["../x"],"previews":["p"]}'), /outside the project/)
assert.throws(() => parseManifest('{"sources":["/etc"],"previews":["p"]}'), /outside the project/)
assert.deepEqual(parseManifest('{"sources":["a/"],"previews":["./p"],"exclude":["a/App.swift"]}'), {
  name: '',
  sources: ['a'],
  previews: ['p'],
  exclude: ['a/App.swift']
})

const project = mkdtempSync(join(tmpdir(), 'swift-preview-'))
cpSync(FIXTURE, project, { recursive: true })
mkdirSync(join(project, 'Sources/DemoComponents/.build'), { recursive: true })
writeFileSync(join(project, 'Sources/DemoComponents/.build/Generated.swift'), '')
writeFileSync(join(project, 'Sources/DemoComponents/notes.md'), '')
const relative = (files) => files.map((file) => file.slice(project.length + 1))
assert.deepEqual(relative(collectSources(project, manifest)), [
  'Previews/TreziPreviews.swift',
  'Sources/DemoComponents/ProfileCard.swift',
  'Sources/DemoComponents/RatingControl.swift',
  'Sources/DemoComponents/SearchPanelController.swift'
])
assert.deepEqual(
  relative(
    collectSources(project, {
      ...manifest,
      exclude: ['Sources/DemoComponents/RatingControl.swift']
    })
  ),
  [
    'Previews/TreziPreviews.swift',
    'Sources/DemoComponents/ProfileCard.swift',
    'Sources/DemoComponents/SearchPanelController.swift'
  ]
)

assert.deepEqual(
  parseDiagnostics(
    [
      `${project}/Sources/A.swift:12:5: error: cannot find 'x' in scope`,
      '    x += 1',
      '/elsewhere/PreviewHost.swift:3:1: warning: unused',
      'error: fatal'
    ].join('\n'),
    project
  ),
  [
    {
      file: 'Sources/A.swift',
      line: 12,
      column: 5,
      severity: 'error',
      message: "cannot find 'x' in scope"
    },
    { file: 'PreviewHost.swift', line: 3, column: 1, severity: 'warning', message: 'unused' }
  ]
)
const args = hostCompileArgs({
  host: 'H.swift',
  sources: ['a.swift'],
  moduleCache: 'mc',
  output: 'out'
})
assert.deepEqual(args.slice(0, 4), ['--sdk', 'macosx', 'swiftc', '-parse-as-library'])
assert.deepEqual(args.slice(-2), ['H.swift', 'a.swift'])

assert.equal(swiftPreviewCommand('/A b/bun', "/x'y/driver.ts"), `'/A b/bun' '/x'\\''y/driver.ts'`)
assert.ok(existsSync(SWIFT_PREVIEW_DRIVER), 'the launch command names the checkout driver')
const detected = await detectProject(project)
assert.equal(detected.framework, 'swift')
assert.equal(detected.devCommand, '', 'the command comes from Trezi, never the project')
assert.equal(detected.previewKind, 'web')

// --- The build, render, interact, edit, error and recover loop ---
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, label, timeout = 180_000) {
  const end = Date.now() + timeout
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) throw new Error(`Timed out: ${label}`)
    await sleep(100)
  }
}
rmSync(ARTIFACTS, { recursive: true, force: true })
mkdirSync(ARTIFACTS, { recursive: true })
const logs = []
const session = new PreviewSession({
  root: project,
  cacheDir: join(project, '..', `${project.split('/').pop()}-cache`),
  hostSource: join(ROOT, 'src/swift-preview/PreviewHost.swift'),
  moduleCache: MODULE_CACHE,
  log: (line) => logs.push(line),
  pollMs: 150
})
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const frame = async (id, name) => {
  const shot = await session.frame(id)
  assert.ok(shot.png.subarray(0, 4).equals(PNG), `${id} frame is a PNG`)
  if (name) writeFileSync(join(ARTIFACTS, `${name}.png`), shot.png)
  return shot
}
const click = async (id, x, y) => {
  await session.input(id, { type: 'mousedown', x, y })
  await sleep(50)
  await session.input(id, { type: 'mouseup', x, y })
  await sleep(120)
}
const type = async (id, text) => {
  for (const key of text) {
    await session.input(id, { type: 'keydown', key })
    await session.input(id, { type: 'keyup', key })
  }
  await sleep(150)
}
const texts = (id) => session.describe(id)
const edit = (file, from, to) => {
  const path = join(project, file)
  const text = readFileSync(path, 'utf8')
  assert.ok(text.includes(from), `${file} contains ${from}`)
  writeFileSync(path, text.replace(from, to))
}

try {
  mkdirSync(SWIFT_CACHE, { recursive: true })
  session.start()
  await until(() => session.state.status === 'ready', `first build (${logs.join(' | ')})`)
  assert.equal(session.state.generation, 1)
  assert.deepEqual(
    session.state.previews.map((p) => [p.id, p.kind]),
    [
      ['profile-card', 'SwiftUI'],
      ['rating-control', 'AppKit'],
      ['search-panel', 'AppKit view controller']
    ]
  )

  // Real rendering: each frame is the declared size at 2x and differs by component.
  const profile = await frame('profile-card', 'swiftui-profile-card')
  const rating = await frame('rating-control', 'appkit-rating-control')
  const search = await frame('search-panel', 'mixed-search-panel')
  assert.deepEqual(
    [profile.width, profile.height, rating.width, search.width],
    [320, 330, 240, 340]
  )
  assert.ok(profile.png.length > 10_000, 'the SwiftUI card drew its content')
  assert.deepEqual(await texts('rating-control'), ['Rating', '3 of 5 stars'])
  assert.ok((await texts('search-panel')).includes('Type a query and press Search'))

  // Interaction: SwiftUI button and text field, AppKit view mouse and keys, AppKit
  // text field, Return and a SwiftUI badge inside the AppKit controller.
  await click('profile-card', 160, 211)
  await click('profile-card', 160, 245)
  await type('profile-card', 'Hi Ada')
  assert.ok((await texts('profile-card')).includes('Hi Ada'), 'typing reached the SwiftUI field')
  const followed = await frame('profile-card', 'swiftui-profile-card-interacted')
  assert.ok(!followed.png.equals(profile.png), 'the SwiftUI card changed after the clicks')
  await click('rating-control', 180, 16)
  assert.ok(
    (await texts('rating-control')).includes('5 of 5 stars'),
    'a click set the AppKit rating'
  )
  await session.input('rating-control', { type: 'keydown', key: 'ArrowLeft' })
  await sleep(100)
  assert.ok((await texts('rating-control')).includes('4 of 5 stars'), 'an arrow key changed it')
  await frame('rating-control', 'appkit-rating-control-interacted')
  await click('search-panel', 100, 62)
  await type('search-panel', 'sl')
  await session.input('search-panel', { type: 'keydown', key: 'Enter' })
  await sleep(150)
  assert.ok((await texts('search-panel')).includes('Results for sl: Slider'), 'the search ran')
  await frame('search-panel', 'mixed-search-panel-interacted')
  // Input goes to the addressed preview only.
  assert.ok(!(await texts('profile-card')).some((text) => text.includes('sl')))

  // A source edit (what a chat turn lands in the live tree) rebuilds and swaps hosts.
  edit(
    'Sources/DemoComponents/SearchPanelController.swift',
    '"Search components"',
    '"Find components"'
  )
  await until(
    () => session.state.generation === 2 && session.state.status === 'ready',
    'edit rebuild'
  )
  assert.ok((await texts('search-panel')).includes('Find components'), 'the edit is on screen')
  await frame('search-panel', 'mixed-search-panel-edited')

  // A compile error: reported with its location, the last good build stays up.
  edit(
    'Sources/DemoComponents/SearchPanelController.swift',
    'index.search(query)',
    'index.serch(query)'
  )
  await until(() => session.state.status === 'failed', 'failed build')
  const error = session.state.diagnostics.find((d) => d.severity === 'error')
  assert.equal(error?.file, 'Sources/DemoComponents/SearchPanelController.swift')
  assert.equal(error.line, 59)
  assert.match(error.message, /has no member 'serch'/)
  assert.equal(session.state.stale, true)
  assert.equal(session.state.generation, 2)
  assert.match(session.state.message, /Build failed: 1 error/)
  assert.ok((await texts('search-panel')).includes('Find components'), 'the old host still answers')
  assert.ok(
    logs.some((line) => line.includes('SearchPanelController.swift') && line.includes('error'))
  )

  // The fix recovers.
  edit(
    'Sources/DemoComponents/SearchPanelController.swift',
    'index.serch(query)',
    'index.search(query)'
  )
  await until(() => session.state.status === 'ready' && session.state.generation === 3, 'recovery')
  assert.deepEqual(
    session.state.diagnostics.filter((d) => d.severity === 'error'),
    []
  )
  assert.equal(session.state.stale, false)
  assert.ok((await texts('search-panel')).includes('Find components'))
} finally {
  await session.stop()
}
await assert.rejects(() => session.frame('profile-card'), /No preview host/)

// --- The driver Trezi runs: the page, its state and its request checks ---
const port = await new Promise((resolve, reject) => {
  const probe = createServer()
  probe.on('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})
const driverLog = []
const driver = spawn(process.execPath, [SWIFT_PREVIEW_DRIVER], {
  cwd: project,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    TREZI_SWIFT_PREVIEW_CACHE: join(SWIFT_CACHE, 'swift-preview')
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
driver.stdout.on('data', (chunk) => driverLog.push(String(chunk)))
driver.stderr.on('data', (chunk) => driverLog.push(String(chunk)))
const base = `http://127.0.0.1:${port}`
try {
  await until(() => driverLog.join('').includes(`Serving at ${base}`), 'driver URL', 20_000)
  const page = await (await fetch(`${base}/`)).text()
  assert.match(page, /__treziSwiftPreview/)
  const token = /const token = "([0-9a-f]{32})"/.exec(page)?.[1]
  assert.ok(token, 'the page carries its input token')
  const state = await until(
    async () => {
      const value = await (await fetch(`${base}/state`)).json()
      return value.status === 'ready' && value
    },
    `driver build (${driverLog.join('')})`
  )
  assert.equal(state.name, 'Swift components demo')
  const png = await fetch(`${base}/frame?preview=rating-control`)
  assert.equal(png.headers.get('content-type'), 'image/png')
  const input = (headers, host) =>
    fetch(`${base}/input?preview=rating-control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers, ...(host ? { host } : {}) },
      body: JSON.stringify({ type: 'keydown', key: 'ArrowRight' })
    })
  assert.equal((await input({})).status, 403, 'input needs the page token')
  assert.equal((await input({ 'x-trezi-token': token })).status, 200)
  await sleep(150)
  const described = await (await fetch(`${base}/describe?preview=rating-control`)).json()
  assert.ok(described.texts.includes('4 of 5 stars'))
  const rebound = await new Promise((resolve) => {
    const request = spawn('curl', [
      '-s',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      '-H',
      'Host: evil.example',
      `${base}/state`
    ])
    let out = ''
    request.stdout.on('data', (chunk) => (out += chunk))
    request.on('close', () => resolve(out))
  })
  assert.equal(rebound, '403', 'another Host name is refused')
} finally {
  driver.kill('SIGTERM')
  await until(() => driver.exitCode !== null || driver.signalCode !== null, 'driver exit', 10_000)
  rmSync(project, { recursive: true, force: true })
  rmSync(join(project, '..', `${project.split('/').pop()}-cache`), { recursive: true, force: true })
}
console.log('swift-preview: ok')
