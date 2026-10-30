import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-381: + opens the native file chooser directly. The fixture hosts the real composer in
// a window that is never ordered in and replaces only the chooser presenter.
if (process.platform !== 'darwin') {
  console.log('COMPOSER-ATTACH SKIP — macOS AppKit required')
} else {
  const binary = swiftBuild('composer-attach', [
    'test/fixtures/composer-attach/main.swift',
    'src/native/SidebarChatsAccessibility.swift',
    ...[
      'ChatScrollStyle',
      'ChatEnvironment',
      'ScrollerDrag',
      'ChatLatestButton',
      'Composer',
      'ComposerProject',
      'ComposerVerification',
      'ComposerAttachments',
      'AttachmentThumbnail',
      'ComposerQueue',
      'ComposerBeam',
      'ComposerSending'
    ].map((name) => `src/native/${name}.swift`)
  ])
  const report = JSON.parse(runFixture(binary))
  const check = (key, expected) =>
    assert.deepEqual(
      report[key],
      expected,
      `${key}: actual ${JSON.stringify(report[key])}, expected ${JSON.stringify(expected)}\n${JSON.stringify(report)}`
    )
  // A plain button, no menu: one press opens the chooser.
  check('popUp', false)
  check('menu', false)
  check('attachIsPlus', true)
  check('role', 'AXButton')
  check('label', 'Attach files')
  check('axPress', true)
  check('pressOpens', 1)
  check('clickOpens', 2)
  // Cancel keeps the draft and the .mov; OK appends in order; repeated use keeps working.
  check('afterCancel', { text: 'Keep this draft', attached: ['clip.mov'] })
  check('afterAccept', {
    text: 'Keep this draft',
    attached: ['clip.mov', 'notes.txt', 'more.txt']
  })
  // Each on the composer's window, after the previous one finished.
  const chooser = { window: true, pending: false }
  check('presented', [chooser, chooser, chooser])
  // Busy: disabled and opens nothing, then works again.
  check('busyEnabled', false)
  check('busyOpens', 0)
  check('afterBusyOpens', 1)

  const swift = readFileSync('src/native/Composer.swift', 'utf8')
  assert.doesNotMatch(swift, /Attach Files…/, 'the intermediate menu item is gone')
  assert.doesNotMatch(
    swift,
    /plus\.setAccessibilityLabel/,
    'a view label blanks the cell (LKM-379)'
  )
  console.log(
    'COMPOSER-ATTACH PASS — + is an AXButton "Attach files"; press and click open the chooser at once; Cancel keeps draft and .mov; OK appends; busy disables it'
  )
}
