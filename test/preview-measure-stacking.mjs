import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-637: spacing/distance number badges paint above the preview's title chips and the
// selection toolbar, stay pointer-transparent, and follow scroll and resize. The real
// preview bundle runs in a real WKWebView; the fixture samples WebKit's rendered snapshot.
// PNGs: test/artifacts/preview-measure-stacking/ (gitignored).
if (process.platform !== 'darwin') {
  console.log('PREVIEW-MEASURE-STACKING SKIP — macOS WebKit required')
} else {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'trezi-measure-stacking-'))
  try {
    const script = join(dir, 'preview.js')
    // As scripts/build-native.mjs bundles preview.js.
    await build({
      entryPoints: [join(root, 'src/preview/preload.ts')],
      outfile: script,
      bundle: true,
      platform: 'browser',
      target: 'safari16.4',
      format: 'iife',
      logLevel: 'silent'
    })
    const binary = swiftBuild('preview-measure-stacking', [
      'test/fixtures/preview-measure-stacking/main.swift'
    ])
    const report = JSON.parse(
      runFixture(binary, [script, join(root, 'test/artifacts/preview-measure-stacking')]).trim()
    )
    const crossings = ['selectedCard', 'selectedPanel', 'scrolled', 'resized'].flatMap(
      (name) => report[name].crossings
    )
    assert.ok(crossings.some((c) => c.under === 'toolbar'))
    assert.ok(crossings.some((c) => c.under === 'selection-chip'))
    assert.ok(crossings.some((c) => c.under === 'hover-chip'))
    assert.equal(report.passThrough.action, 'delete')
    assert.ok(report.passThrough.button)
    assert.equal(report.clearedAfter, true)
    console.log(`PREVIEW-MEASURE-STACKING ${JSON.stringify(report)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
