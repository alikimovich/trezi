/** Independent real-host scenario extracted from swift-preview.mjs (LKM-816). */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODULE_CACHE, SWIFT_CACHE } from './helpers/swift-build.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const { PreviewSession } = await import('../src/swift-preview/session.ts')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const startedAt = Date.now()
const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, label, timeout = 180_000) {
  const name = label.replace(/ \(.*$/s, '')
  const begun = Date.now()
  const end = begun + timeout
  console.log(`swift-preview: [${elapsed()}] start ${name}`)
  for (;;) {
    const value = await check()
    if (value) {
      console.log(
        `swift-preview: [${elapsed()}] done ${name} (${((Date.now() - begun) / 1000).toFixed(1)}s)`
      )
      return value
    }
    if (Date.now() > end) throw new Error(`Timed out: ${label}`)
    await sleep(100)
  }
}
mkdirSync(SWIFT_CACHE, { recursive: true })
const { collectSources, parseManifest } = await import('../src/swift-preview/manifest.ts')
const ARTIFACTS = join(ROOT, 'test/artifacts/swift-preview')
mkdirSync(ARTIFACTS, { recursive: true })
// --- A library module: the app module imports a separately built module ---
const libraryProject = mkdtempSync(join(tmpdir(), 'swift-preview-lib-'))
cpSync(join(ROOT, 'test/fixtures/swift-library-app'), libraryProject, { recursive: true })
const libraryLogs = []
const librarySession = new PreviewSession({
  root: libraryProject,
  cacheDir: join(libraryProject, '..', `${libraryProject.split('/').pop()}-cache`),
  hostSource: join(ROOT, 'src/swift-preview/PreviewHost.swift'),
  moduleCache: MODULE_CACHE,
  log: (line) => libraryLogs.push(line),
  pollMs: 150
})
try {
  assert.deepEqual(
    collectSources(
      libraryProject,
      parseManifest(readFileSync(join(libraryProject, 'trezi-previews.json'), 'utf8'))
    ).map((file) => file.slice(libraryProject.length + 1)),
    ['App/GreetingBadge.swift', 'Previews/TreziPreviews.swift'],
    'the @main file is excluded and library sources are not app sources'
  )
  librarySession.start()
  await until(
    () => librarySession.state.status === 'ready',
    `library build (${libraryLogs.join(' | ')})`
  )
  assert.ok(libraryLogs.some((line) => line.includes('library GreetKit')))
  await until(
    async () => (await librarySession.describe('greeting-badge')).includes('Hello, Ada!'),
    'the library greeting is drawn'
  )
  const shot = await librarySession.frame('greeting-badge')
  assert.ok(shot.png.subarray(0, 4).equals(PNG), 'the library-backed view rendered')
  writeFileSync(join(ARTIFACTS, 'library-greeting-badge.png'), shot.png)
  // Editing the library's source rebuilds the library and the host.
  const kit = join(libraryProject, 'Kit/Sources/GreetKit/Greeter.swift')
  writeFileSync(kit, readFileSync(kit, 'utf8').replace('"Hello"', '"Welcome"'))
  await until(
    async () => (await librarySession.describe('greeting-badge')).includes('Welcome, Ada!'),
    'library edit rebuilt'
  )
} finally {
  await librarySession.stop()
  rmSync(libraryProject, { recursive: true, force: true })
  rmSync(join(libraryProject, '..', `${libraryProject.split('/').pop()}-cache`), {
    recursive: true,
    force: true
  })
}
console.log('swift-preview-library: ok')
