/**
 * LKM-273: the target-graph preview build on a copy of `test/fixtures/swift-multi-module`
 * (Scraib's shape: an app target with `@main` that depends on a framework target with
 * public SwiftUI and AppKit components). The manifest names only the target: StudioKit
 * is built into its own module and dylib, then the app module against it, then the host
 * with `import StudioKit` and `@testable import Studio`, without the `@main` file. It
 * renders a library SwiftUI and AppKit component and the cross-module app component,
 * reports a library compile error with its module, keeps the last good build, recovers,
 * picks up a new file in a synchronized folder, prefers Trezi's own manifest over the
 * repo's, and generates previews of the only previewable target when neither exists
 * (LKM-276). Then the driver's `/graph` and
 * the backend's `project:native` read. Frames land in `test/artifacts/swift-preview-target/`.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODULE_CACHE, SWIFT_CACHE } from './helpers/swift-build.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURE = join(ROOT, 'test/fixtures/swift-multi-module')
const ARTIFACTS = join(ROOT, 'test/artifacts/swift-preview-target')
const { PreviewSession } = await import('../src/swift-preview/session.ts')
const { SWIFT_PREVIEW_DRIVER, nativeProjectInfo, treziManifestDir } = await import(
  '../src/main/swift-preview.ts'
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Stage lines with elapsed seconds, so the runner's log shows the last stage that
// finished when the outer timeout kills this process (its stdout was blank before).
// Static stage names only: no logs, paths or environment.
const startedAt = Date.now()
const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`
const stage = (name) => console.log(`swift-preview-target: [${elapsed()}] start ${name}`)
async function until(check, label, timeout = 180_000, stageName = label) {
  const begun = Date.now()
  stage(stageName)
  const end = begun + timeout
  let nextHeartbeat = begun + 10_000
  for (;;) {
    const value = await check()
    if (value) {
      console.log(
        `swift-preview-target: [${elapsed()}] done ${stageName} (${((Date.now() - begun) / 1000).toFixed(1)}s)`
      )
      return value
    }
    if (Date.now() > end) throw new Error(`Timed out: ${label}`)
    if (Date.now() >= nextHeartbeat) {
      console.log(`swift-preview-target: [${elapsed()}] waiting ${stageName}`)
      nextHeartbeat = Date.now() + 10_000
    }
    await sleep(100)
  }
}
const temp = mkdtempSync(join(tmpdir(), 'swift-target-'))
const project = join(temp, 'Studio')
cpSync(FIXTURE, project, { recursive: true })
const userData = join(temp, 'userData')
const manifestDir = treziManifestDir(project, userData)
rmSync(ARTIFACTS, { recursive: true, force: true })
mkdirSync(ARTIFACTS, { recursive: true })
mkdirSync(SWIFT_CACHE, { recursive: true })
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const edit = (file, from, to) => {
  const path = join(project, file)
  const text = readFileSync(path, 'utf8')
  assert.ok(text.includes(from), `${file} contains ${from}`)
  writeFileSync(path, text.replace(from, to))
}
const logs = []
const session = new PreviewSession({
  root: project,
  cacheDir: join(temp, 'cache'),
  hostSource: join(ROOT, 'src/swift-preview/PreviewHost.swift'),
  moduleCache: MODULE_CACHE,
  log: (line) => logs.push(line),
  pollMs: 150,
  manifestDir,
  // No Xcode needed: the graph reads project.pbxproj and the scheme files.
  graph: { xcodebuild: join(temp, 'no-xcodebuild') }
})
const frame = async (id, name) => {
  const shot = await session.frame(id)
  assert.ok(shot.png.subarray(0, 4).equals(PNG), `${id} frame is a PNG`)
  writeFileSync(join(ARTIFACTS, `${name}.png`), shot.png)
  return shot
}
const texts = (id) => session.describe(id)

try {
  session.start()
  await until(
    () => session.state.status === 'ready',
    `first build (${logs.join(' | ')})`,
    undefined,
    'first build'
  )
  const { plan, manifest, native } = session.state
  assert.deepEqual(manifest, {
    source: 'repo',
    path: join(project, 'trezi-previews.json'),
    treziPath: join(manifestDir, 'trezi-previews.json')
  })
  assert.deepEqual(
    plan.modules.map((m) => [m.module, m.dependencies, m.sources, m.entries]),
    [
      [
        'StudioKit',
        [],
        [
          'StudioKit/LevelMeterView.swift',
          'StudioKit/StatusBadge.swift',
          'StudioKit/StudioFormat.swift'
        ],
        []
      ],
      ['Studio', ['StudioKit'], ['Studio/ProjectHeader.swift'], ['Studio/StudioApp.swift']]
    ],
    'the library first, the @main file left out'
  )
  assert.deepEqual(plan.blockers, [])
  // LKM-275: the catalog is compiled with actool now, not reported as left out.
  assert.deepEqual(plan.resources.catalogs, [{ module: 'Studio', path: 'Studio/Assets.xcassets' }])
  assert.deepEqual(native.structure.projects, ['Studio.xcodeproj'])
  assert.equal(native.containers[0].schemesFrom, 'scheme files')
  assert.match(session.state.message, /Built 3 previews from StudioKit → Studio\./)
  assert.ok(logs.some((line) => line.includes('compiling library StudioKit')))
  assert.ok(logs.some((line) => line.includes('compiling library Studio…')))
  assert.deepEqual(
    session.state.previews.map((p) => [p.id, p.kind]),
    [
      ['status-badge', 'SwiftUI'],
      ['level-meter', 'AppKit'],
      ['project-header', 'SwiftUI']
    ]
  )
  stage('frames and texts after first build')
  const badge = await frame('status-badge', 'studiokit-swiftui-status-badge')
  const meter = await frame('level-meter', 'studiokit-appkit-level-meter')
  const header = await frame('project-header', 'studio-cross-module-project-header')
  assert.deepEqual([badge.width, meter.width, header.width], [260, 240, 300])
  assert.ok((await texts('status-badge')).includes('Reviews: 2 items'))
  assert.ok((await texts('level-meter')).includes('Level 3 of 5'))
  const headerTexts = await texts('project-header')
  assert.ok(headerTexts.includes('Launch plan'), 'the app-internal model via @testable')
  assert.ok(headerTexts.includes('Open tasks: 3 items'), 'the library badge inside the app view')

  // A compile error in the library module: located there, the last good build stays.
  edit('StudioKit/StudioFormat.swift', 'value == 1 ?', 'valeu == 1 ?')
  await until(() => session.state.status === 'failed', 'failed library build')
  const error = session.state.diagnostics.find((d) => d.severity === 'error')
  assert.deepEqual(
    [error?.module, error?.file, error?.line],
    ['StudioKit', 'StudioKit/StudioFormat.swift', 6]
  )
  assert.match(error.message, /cannot find 'valeu' in scope/)
  assert.match(session.state.message, /^Build failed in StudioKit: 1 error\.$/)
  assert.equal(session.state.stale, true)
  assert.equal(session.state.generation, 1)
  assert.ok((await texts('level-meter')).includes('Level 3 of 5'), 'the old host still answers')

  // The fix recovers; a library edit reaches the app's cross-module view.
  edit('StudioKit/StudioFormat.swift', 'valeu == 1 ?', 'value == 1 ?')
  edit('StudioKit/StudioFormat.swift', '"\\(value) \\(noun)s"', '"\\(value) \\(noun)s total"')
  await until(() => session.state.status === 'ready' && session.state.generation === 2, 'recovery')
  assert.equal(session.state.stale, false)
  assert.deepEqual(
    session.state.diagnostics.filter((d) => d.severity === 'error'),
    []
  )
  assert.ok((await texts('project-header')).includes('Open tasks: 3 items total'))
  await frame('project-header', 'studio-cross-module-project-header-recovered')

  // A new file in StudioKit's synchronized folder joins the module without a pbxproj edit.
  writeFileSync(
    join(project, 'StudioKit/Greeting.swift'),
    'public enum Greeting { public static let text = "Hello from a new file" }\n'
  )
  edit(
    'StudioKit/StatusBadge.swift',
    '.textFieldStyle(.plain)',
    '.textFieldStyle(.plain)\n                .help(Greeting.text)'
  )
  await until(() => session.state.status === 'ready' && session.state.generation === 3, 'new file')
  assert.ok(session.state.plan.modules[0].sources.includes('StudioKit/Greeting.swift'))

  // Trezi's own manifest wins over the repo's; its previews live beside it.
  mkdirSync(join(manifestDir, 'Previews'), { recursive: true })
  writeFileSync(
    join(manifestDir, 'Previews/TreziPreviews.swift'),
    `import StudioKit
import SwiftUI
enum TreziPreviews {
    @MainActor static var all: [TreziPreview] {
        [.swiftUI("trezi-side", "From Trezi's manifest", size: CGSize(width: 240, height: 60)) {
            StatusBadge(title: "Kept outside the repo", count: 1)
        }]
    }
}
`
  )
  writeFileSync(
    join(manifestDir, 'trezi-previews.json'),
    JSON.stringify({ name: 'Studio via Trezi', target: 'Studio', previews: ['Previews'] })
  )
  await until(
    () => session.state.status === 'ready' && session.state.generation === 4,
    'trezi side'
  )
  assert.equal(session.state.manifest.source, 'trezi')
  assert.equal(session.state.name, 'Studio via Trezi')
  assert.deepEqual(
    session.state.previews.map((p) => p.id),
    ['trezi-side']
  )
  assert.ok((await texts('trezi-side')).includes('Kept outside the repo: 1 item'))

  // Neither manifest (LKM-276): Studio is the only previewable target (StudioKit is
  // its dependency), so Trezi generates previews of its components without a choice.
  rmSync(join(manifestDir, 'trezi-previews.json'))
  rmSync(join(project, 'trezi-previews.json'))
  await until(
    () => session.state.status === 'ready' && session.state.generation === 5,
    `generated (${session.state.message})`,
    undefined,
    'generated previews'
  )
  assert.equal(session.state.manifest.source, 'none')
  stage('generated previews describe')
  const { catalog } = session.state
  assert.deepEqual(
    [catalog.target, catalog.project, catalog.chosenBy],
    ['Studio', 'Studio.xcodeproj', 'the only previewable target']
  )
  assert.equal(catalog.dir, join(realpathSync(manifestDir), 'generated'))
  assert.ok(
    session.state.previews.some((p) => p.id === 'component:StudioKit.StatusBadge'),
    'a framework component is listed'
  )
  assert.ok((await texts('component:Studio.ProjectHeader')).includes('Open tasks: 1 item'))
} finally {
  await session.stop()
}

// --- The driver: --manifest-dir, /graph, and the backend read of it ---
cpSync(join(FIXTURE, 'trezi-previews.json'), join(project, 'trezi-previews.json'))
const port = await new Promise((resolve, reject) => {
  const probe = createServer()
  probe.on('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})
const driverLog = []
const driver = spawn(process.execPath, [SWIFT_PREVIEW_DRIVER, '--manifest-dir', manifestDir], {
  cwd: project,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    TREZI_SWIFT_PREVIEW_CACHE: join(temp, 'driver-cache')
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
driver.stdout.on('data', (chunk) => driverLog.push(String(chunk)))
driver.stderr.on('data', (chunk) => driverLog.push(String(chunk)))
const base = `http://127.0.0.1:${port}`
try {
  await until(() => driverLog.join('').includes(`Serving at ${base}`), 'driver URL', 20_000)
  const state = await until(
    async () => {
      const value = await (await fetch(`${base}/state`)).json()
      return value.status === 'ready' && value
    },
    `driver build (${driverLog.join('')})`,
    undefined,
    'driver build'
  )
  stage('driver graph and project info')
  assert.equal(state.manifest.treziPath, join(manifestDir, 'trezi-previews.json'))
  assert.equal(state.plan.target, 'Studio')
  const { graph, plan } = await (await fetch(`${base}/graph`)).json()
  assert.deepEqual(
    graph.containers[0].targets.map((t) => [t.name, t.kind, t.dependencies]),
    [
      ['Studio', 'app', ['StudioKit']],
      ['StudioKit', 'framework', []]
    ]
  )
  assert.deepEqual(
    plan.modules.map((m) => m.module),
    ['StudioKit', 'Studio']
  )
  const page = await (await fetch(`${base}/`)).text()
  assert.match(page, /id="project"/, 'the page has the project panel')
  const info = await nativeProjectInfo(project, userData, { url: base, driver: true })
  assert.equal(info.error, '')
  assert.deepEqual([info.manifest.repoExists, info.manifest.treziExists], [true, false])
  assert.equal(info.graph.containers[0].path, 'Studio.xcodeproj')
} finally {
  driver.kill('SIGTERM')
  await until(() => driver.exitCode !== null || driver.signalCode !== null, 'driver exit', 10_000)
  rmSync(temp, { recursive: true, force: true })
}
console.log('swift-preview-target: ok')
