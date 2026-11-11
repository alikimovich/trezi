import assert from 'node:assert/strict'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-646: Mark up's Select region tool: the region model (either drag direction, clamping,
// move, resize, Escape), the crop through the existing renderer and encoder at Retina scale,
// on-screen guides that never reach the image, Add with no marks, and no attachment on cancel,
// an empty region or a failed crop. Real views in a window that is never ordered in.
if (process.platform !== 'darwin') {
  console.log('PREVIEW-MARKUP-REGION SKIP — macOS AppKit required')
} else {
  const binary = swiftBuild('preview-markup-region', [
    'test/fixtures/preview-markup-region/main.swift',
    'src/native/KeyShortcuts.swift',
    'src/native/PreviewMarkupModel.swift',
    'src/native/PreviewMarkupRegion.swift',
    'src/native/PreviewMarkupSelection.swift',
    'src/native/PreviewMarkupView.swift',
    'src/native/PreviewMarkupOverlay.swift',
    'src/native/PreviewMarkup.swift'
  ])
  assert.deepEqual(JSON.parse(runFixture(binary)), { ok: true })
  console.log('PREVIEW-MARKUP-REGION PASS')
}
