import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-380: in full screen the first ⌘. (Actions → Toggle UI) left full screen. The fixture
// presses ⌘. three times with the focus in the real views (text views, a text field, a
// WKWebView, nothing) in AppKit's key order, in a window that reports full screen, with and
// without MenuFirstShortcut's key-down filter ahead of the views.
if (process.platform !== 'darwin') {
  console.log('MENU-FIRST-SHORTCUTS SKIP — macOS AppKit required')
} else {
  const binary = swiftBuild('menu-first-shortcuts', [
    'test/fixtures/menu-first-shortcuts/main.swift',
    'src/native/MenuFirstShortcuts.swift',
    'src/native/KeyShortcuts.swift'
  ])
  const report = JSON.parse(runFixture(binary))
  const dump = JSON.stringify(report)
  const focuses = ['composer', 'source', 'address', 'preview', 'none']

  // The cause, as AppKit and WebKit behave without the filter: the focused WKWebView claims
  // ⌘. before the menu, so Toggle UI never runs; and ⌘. that reaches a text view's keyDown
  // is cancelOperation:, which exits full screen (windowed it does not).
  for (const mode of ['full', 'windowed']) {
    const preview = report[`${mode}.appkit.preview`]
    assert.deepEqual(preview.routes, ['view', 'view', 'view'], `${mode} preview claims ⌘.: ${dump}`)
    assert.equal(preview.toggles, 0, `${mode} preview: the menu never sees ⌘.: ${dump}`)
    assert.deepEqual(
      report[`${mode}.keyDown`].cancels,
      ['cancelOperation:'],
      `${mode} keyDown: ${dump}`
    )
  }
  assert.equal(report['full.keyDown'].exits, 1, `full screen: cancelOperation: exits it: ${dump}`)
  assert.equal(report['windowed.keyDown'].exits, 0, `windowed: cancelOperation: stays: ${dump}`)

  // The fix: every press toggles once, from the menu, with any focus, and nothing exits
  // full screen or reaches a cancel; the focus stays where it was.
  for (const mode of ['full', 'windowed'])
    for (const focus of focuses) {
      const entry = report[`${mode}.fixed.${focus}`]
      const at = `${mode} ${focus}: ${JSON.stringify(entry)}`
      assert.deepEqual(entry.routes, ['menu-first', 'menu-first', 'menu-first'], at)
      assert.equal(entry.toggles, 3, at)
      assert.equal(entry.exits, 0, at)
      assert.deepEqual(entry.cancels, [], at)
      assert.equal(entry.focus, true, at)
    }

  // Escape is untouched: never routed, still the text view's cancelOperation:, no toggle.
  assert.equal(report['escape.routed'], false, dump)
  assert.equal(report['escape.commandRouted'], false, dump)
  assert.equal(report['escape.route'], 'keyDown', dump)
  assert.equal(report['escape.toggles'], 0, dump)
  assert.deepEqual(report['escape.cancels'], ['cancelOperation:'], dump)
  assert.deepEqual(report['filter.escape'], { passed: true, toggles: 0 }, dump)
  // The monitor swallows ⌘. once the menu took it, and leaves it while a menu tracks.
  assert.deepEqual(report['filter.period'], { passed: false, toggles: 1 }, dump)
  assert.deepEqual(report['filter.tracking'], { passed: true, toggles: 0 }, dump)
  assert.ok(report['monitor.calls'] >= 1, `the installed monitor runs in sendEvent: ${dump}`)
  // Only exactly ⌘., on any layout, for the main or the full-screen toolbar window.
  assert.equal(report['shiftPeriod.routed'], false, dump)
  assert.equal(report['optionPeriod.routed'], false, dump)
  assert.equal(report['russian.routed'], true, dump)
  assert.equal(report['toolbarWindow.routed'], true, dump)
  if (report['otherWindow.distinct']) assert.equal(report['otherWindow.routed'], false, dump)

  // The host installs the filter.
  const host = readFileSync('src/native/Host.swift', 'utf8')
  assert.match(host, /MenuFirstShortcut\.install\(/)
  console.log(
    `MENU-FIRST-SHORTCUTS PASS — ⌘. toggles 3/3 from the menu with ${focuses.length} focuses in full screen and windowed, 0 full-screen exits; unfiltered, the WKWebView claims it and keyDown exits full screen${report['otherWindow.distinct'] ? '' : ' (other-window check needs a window server)'}`
  )
}
