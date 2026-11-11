import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-638: a submitted Apply's preview layer in the real preload, in a real WKWebView. The
// lifted `base` read (how the inspector learns the page renders A itself) paints no frame
// without the override and starts no transition; `keep` retires one layer and leaves the
// other; the final retire after the source rendered is pixel-identical in WebKit's own
// snapshot. PNGs: test/artifacts/preview-apply-layers/ (gitignored).
if (process.platform !== 'darwin') {
  console.log('PREVIEW-APPLY-LAYERS SKIP — macOS WebKit required')
} else {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'trezi-apply-layers-'))
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
    const binary = swiftBuild('preview-apply-layers', [
      'test/fixtures/preview-apply-layers/main.swift'
    ])
    const report = JSON.parse(
      runFixture(binary, [script, join(root, 'test/artifacts/preview-apply-layers')]).trim()
    )
    assert.equal(report.pending.base['padding-top'], '4px')
    assert.equal(report.pending.values['padding-top'], '12px')
    assert.ok(report.pending.frames > 0, 'frames were sampled during the lifted read')
    assert.equal(report.retire.pixelsChanged, 0)
    assert.ok(report.retire.frames > 0)
    assert.deepEqual(report.jsx, { adopted: '12px', rewriteBase: '14px', afterClear: '14px' })
    console.log(`PREVIEW-APPLY-LAYERS ${JSON.stringify(report)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
