import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// Ruler, guide and layout-grid math of the preview overlay (LKM-205).
if (process.platform !== 'darwin') {
  console.log('PREVIEW-OVERLAY SKIP — macOS Swift toolchain required')
} else {
  const binary = swiftBuild('preview-overlay', [
    'test/fixtures/preview-overlay/main.swift',
    'src/native/PreviewOverlayModel.swift'
  ])
  console.log(runFixture(binary).trim())
}
