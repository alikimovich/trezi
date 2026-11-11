import assert from 'node:assert/strict'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-644: Edit → Undo (⌘Z) / Redo (⇧⌘Z) with real key events through the key window's
// views, the main menu and the responder chain, with the focus in the composer, the code
// editor, an inspector Styles field (typing / committed), the address bar, nothing and the
// preview WKWebView. `EditUndo` (src/native/EditUndo.swift) decides who answers.
if (process.platform !== 'darwin') {
  console.log('EDIT-UNDO-KEYS SKIP — macOS AppKit required')
} else {
  const binary = swiftBuild('edit-undo-keys', [
    'test/fixtures/edit-undo-keys/main.swift',
    'src/native/EditUndo.swift',
    'src/native/KeyShortcuts.swift'
  ])
  const report = JSON.parse(runFixture(binary).trim().split('\n').pop())
  const dump = JSON.stringify(report)
  const once = (entry, route, visual, text, page = []) => {
    assert.equal(entry.route, route, dump)
    assert.deepEqual(entry.visual, visual, dump)
    assert.deepEqual(entry.text, text, dump)
    assert.deepEqual(entry.page, page, dump)
  }
  // No focus: the visual draft, each key once, through the menu.
  once(report['none.undo'], 'menu', ['undo'], [])
  once(report['none.redo'], 'menu', ['redo'], [])
  // The composer and the code editor keep their own Undo; visual Undo never runs with them,
  // even with nothing left to undo in the text.
  once(report['composer.undo'], 'menu', [], ['undo'])
  assert.equal(report['composer.afterUndo'], '', dump)
  once(report['composer.redo'], 'menu', [], ['redo'])
  assert.equal(report['composer.afterRedo'], 'hello', dump)
  once(report['composer.empty'], 'menu', [], ['undo'])
  once(report['source.undo'], 'menu', [], ['undo'])
  assert.equal(report['source.after'], '', dump)
  // An inspector field: uncommitted typing is the field's; after commit the key is visual
  // and the field keeps focus and its text (the controller publishes the restored value).
  assert.equal(report['field.isEditor'], true, dump)
  once(report['field.typing'], 'menu', [], ['undo'])
  assert.equal(report['field.typingAfter'], '', dump)
  once(report['field.committed'], 'menu', ['undo'], [])
  once(report['field.committedRedo'], 'menu', ['redo'], [])
  assert.equal(report['field.committedAfter'], '0.75rem', dump)
  assert.equal(report['field.stillFocused'], true, dump)
  once(report.address, 'menu', [], ['undo'])
  // Menu titles and state.
  assert.deepEqual(report['validate.none'], { enabled: true, title: 'Undo Style Change' }, dump)
  assert.deepEqual(report['validate.composerRedo'], { enabled: false, title: 'Redo' }, dump)
  // Layout-aware: ⌘ on the Z key under Russian is still Undo / Redo.
  once(report['russian.undo'], 'menu', ['undo'], [])
  once(report['russian.redo'], 'menu', ['redo'], [])
  assert.deepEqual(report.optionZ.visual, [], dump)
  // The preview claims ⌘Z for the page. Taken by the page outside its fields, the menu
  // never runs for it (no double step: src/preview/history-keys.ts sends the one step).
  once(report['preview.undo'], 'view', [], [])
  once(report['preview.redo'], 'view', [], [])
  assert.deepEqual(report['preview.pageKeys'], ['z@box:taken', 'shift+Z@box:taken'], dump)
  // In a page field WebKit re-sends the unhandled key to the menu: the page's own Undo.
  once(report['previewField.undo'], 'view', [], [], ['undo'])
  assert.deepEqual(report['previewField.pageKeys'], ['z@field'], dump)
  // WebKit re-sends it as the current event: Host's `NSApp.currentEvent` key check holds.
  assert.deepEqual(report['previewField.currentEvent'], ['10:z'], dump)
  assert.deepEqual(report['preview.menuClick'], ['undo'], dump)
  assert.deepEqual(report.textBindings.bound, [], dump)
  console.log(
    'EDIT-UNDO-KEYS PASS — ⌘Z / ⇧⌘Z routed by focus, layout-aware, page keys reach the page'
  )
}
