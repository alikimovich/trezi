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
  // ⌘. before the menu, so Toggle UI never runs (measured on every host, CI included)...
  for (const mode of ['full', 'windowed']) {
    const preview = report[`${mode}.appkit.preview`]
    assert.deepEqual(preview.routes, ['view', 'view', 'view'], `${mode} preview claims ⌘.: ${dump}`)
    assert.equal(preview.toggles, 0, `${mode} preview: the menu never sees ⌘.: ${dump}`)
  }
  // ...and a `cancelOperation:` that reaches NSWindow exits full screen (windowed it does not).
  // That link is AppKit's own: no key event is involved, so it is required on every host,
  // sent straight to the window and through the text view's responder chain.
  for (const via of ['link', 'chain']) {
    for (const [mode, exits] of [
      ['full', 1],
      ['windowed', 0]
    ]) {
      const entry = report[`${mode}.${via}`]
      const at = `${mode} ${via}: ${JSON.stringify(entry)} ${JSON.stringify(report.env)}`
      assert.deepEqual(entry.cancels, ['cancelOperation:'], `${at}: the window gets the cancel`)
      assert.equal(
        entry.exits,
        exits,
        `${at}: cancelOperation: ${exits ? 'exits' : 'keeps'} ${mode}`
      )
    }
  }
  // Whether a key-down in a text view *becomes* `cancelOperation:` is the text input
  // system's key binding, and it is decided per key and per host. GitHub's macOS 26.6.2
  // runner (PR 349; app inactive, window not key, input context present) turned Escape into
  // `cancelOperation:` but produced no command for ⌘. (run 41026167486), and an earlier
  // macOS 26 run produced none for either. So each key is checked on its own against what
  // the host produced: where it produced `cancelOperation:`, that must be the only command
  // and the window must exit full screen (1) and not windowed (0); where it produced
  // nothing, nothing may exit. The mode never changes what a key becomes. Which case ran is
  // printed below.
  const keyDown = {}
  for (const [label, field] of [
    ['⌘.', 'keyDown'],
    ['Escape', 'keyDownEscape']
  ]) {
    keyDown[label] = {}
    for (const mode of ['full', 'windowed']) {
      const entry = report[`${mode}.${field}`]
      const at = `${mode} ${label} key-down: ${JSON.stringify(entry)} ${JSON.stringify(report.env)}`
      keyDown[label][mode] = entry.produced
      if (entry.produced) {
        assert.deepEqual(entry.cancels, ['cancelOperation:'], `${at}: the window gets the cancel`)
        assert.equal(entry.exits, mode === 'full' ? 1 : 0, `${at}: exits only in full screen`)
      } else {
        assert.deepEqual(entry.cancels, [], `${at}: no command`)
        assert.equal(entry.exits, 0, `${at}: no command, no exit`)
      }
    }
    assert.equal(
      keyDown[label].full,
      keyDown[label].windowed,
      `${label}: the key binding does not depend on the mode: ${dump}`
    )
  }

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

  // Escape is untouched: never routed to the menu, dispatched on to the responder chain as
  // before (its cancel is the key-down step above), and no toggle.
  assert.equal(report['escape.routed'], false, dump)
  assert.equal(report['escape.commandRouted'], false, dump)
  assert.equal(report['escape.route'], 'keyDown', dump)
  assert.equal(report['escape.toggles'], 0, dump)
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
    `MENU-FIRST-SHORTCUTS PASS — ⌘. toggles 3/3 from the menu with ${focuses.length} focuses in full screen and windowed, 0 full-screen exits; unfiltered, the WKWebView claims it and cancelOperation: exits full screen (window and responder chain)${report['otherWindow.distinct'] ? '' : ' (other-window check needs a window server)'}`
  )
  // Say which case ran for each key on this host, so a key that produced nothing is never silent.
  for (const label of ['⌘.', 'Escape'])
    console.log(
      `MENU-FIRST-SHORTCUTS key-down ${label} → cancelOperation: ${keyDown[label].full ? 'produced; exits full screen and not windowed asserted' : 'NOT produced on this host; asserted no command and no exit'} (macOS ${report.env.os}, input context ${report.env.inputContext}, app active ${report.env.active}, window key ${report.env.key}, policy ${report.env.policy})`
    )
}
