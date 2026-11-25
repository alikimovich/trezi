/** Independent real-host scenario extracted from swift-preview.mjs (LKM-816). */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODULE_CACHE, SWIFT_CACHE } from './helpers/swift-build.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const { PreviewSession } = await import('../src/swift-preview/session.ts')
const { PreviewHostProcess } = await import('../src/swift-preview/host-client.ts')
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
const project = mkdtempSync(join(tmpdir(), 'swift-preview-stop-'))
cpSync(join(ROOT, 'test/fixtures/swift-components'), project, { recursive: true })
// The original scenario followed the edit/recovery loop in swift-preview.mjs.
const edited = join(project, 'Sources/DemoComponents/SearchPanelController.swift')
writeFileSync(
  edited,
  readFileSync(edited, 'utf8').replace('"Search components"', '"Find components"')
)
try {
  // --- LKM-586: Stop while a candidate host is starting stops it, never installs it ---
  // A real built host whose readiness is held: the host has printed its ready banner,
  // the session stops, then readiness is released to the build still awaiting it.
  {
    let candidate = null
    let realReady = null
    let release = () => {}
    const gatedCache = join(project, '..', `${project.split('/').pop()}-gated-cache`)
    mkdirSync(gatedCache, { recursive: true })
    const gated = new PreviewSession({
      root: project,
      cacheDir: gatedCache,
      hostSource: join(ROOT, 'src/swift-preview/PreviewHost.swift'),
      moduleCache: MODULE_CACHE,
      log: () => {},
      launchHost: (executable, options) => {
        const host = new PreviewHostProcess(executable, options)
        realReady = host.ready
        const held = new Promise((resolve) => {
          release = () => resolve(realReady)
        })
        Object.defineProperty(host, 'ready', { value: held })
        candidate = host
        return host
      }
    })
    try {
      const building = gated.rebuild('Initial build')
      await until(() => candidate, 'gated candidate launched')
      assert.ok((await realReady).length > 0, 'the candidate host itself is ready')
      await gated.stop()
      release()
      await building
      assert.equal(candidate.alive, false, 'the candidate host was stopped')
      assert.equal(gated.state.generation, 0, 'no ready generation published after Stop')
      assert.notEqual(gated.state.status, 'ready')
      assert.deepEqual(gated.state.previews, [])
      await assert.rejects(() => gated.frame('profile-card'), /No preview host/)
    } finally {
      await candidate?.stop()
      rmSync(gatedCache, { recursive: true, force: true })
    }
  }
} finally {
  rmSync(project, { recursive: true, force: true })
}
console.log('swift-preview-stop: ok')
