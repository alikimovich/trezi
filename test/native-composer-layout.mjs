import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

if (process.platform !== 'darwin') {
  console.log('NATIVE-COMPOSER-LAYOUT SKIP — macOS AppKit required')
} else {
  const binary = swiftBuild('composer-layout', [
    'test/fixtures/composer-layout/main.swift',
    ...[
      'ChatScrollStyle',
      'ChatEnvironment',
      'ScrollerDrag',
      'ChatLatestButton',
      'Composer',
      'ComposerVerification',
      'ComposerAttachments',
      'AttachmentThumbnail',
      'ComposerQueue',
      'ComposerBeam'
    ].map((name) => `src/native/${name}.swift`)
  ])
  console.log(runFixture(binary).trim())
}
