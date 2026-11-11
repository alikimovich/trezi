import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-647: the compact, contextual Mark up island (idle, drawing tool, content, selected mark,
// region, busy, error, constrained width), its trailing Close, single-mark selection (colour
// and stroke for that mark only, move, resize, Delete), annotation Redo, and that selection
// decoration never reaches the attachment. Real views in a window that is never ordered in.
// TREZI_MARKUP_TOOLBAR_SHOTS=<dir> also writes each state as a PNG for review.
if (process.platform !== 'darwin') {
  console.log('PREVIEW-MARKUP-TOOLBAR SKIP — macOS AppKit required')
} else {
  const binary = swiftBuild('preview-markup-toolbar', [
    'test/fixtures/preview-markup-toolbar/main.swift',
    'src/native/KeyShortcuts.swift',
    'src/native/PreviewMarkupModel.swift',
    'src/native/PreviewMarkupRegion.swift',
    'src/native/PreviewMarkupSelection.swift',
    'src/native/PreviewMarkupView.swift',
    'src/native/PreviewMarkupOverlay.swift',
    'src/native/PreviewMarkup.swift'
  ])
  const shots = process.env.TREZI_MARKUP_TOOLBAR_SHOTS
  if (shots) {
    mkdirSync(shots, { recursive: true })
    process.env.MARKUP_TOOLBAR_SHOTS = shots
  }
  assert.deepEqual(JSON.parse(runFixture(binary)), { ok: true })
  console.log('PREVIEW-MARKUP-TOOLBAR PASS')
}
