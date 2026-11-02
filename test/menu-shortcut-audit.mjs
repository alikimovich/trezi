import assert from 'node:assert/strict'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-432: the shortcut audit of the live menus (toolbar-actions) must not see AppKit's own
// Edit rows. AppKit adds Start Dictation… and Emoji & Symbols to any Edit menu with key
// equivalents that depend on the system (a `d` in the app, none headless), which collided with a
// Trezi `d` binding on some hosts. The fixture builds that menu; every ordinary row, a `d`
// binding included, stays collected, and only the two system selectors are dropped.
// A Trezi row bound to either selector would escape the audit too (documented in
// MenuShortcutAudit.swift); nothing in Trezi binds one.
if (process.platform !== 'darwin') {
  console.log('MENU-SHORTCUT-AUDIT SKIP — macOS AppKit required')
} else {
  const binary = swiftBuild('menu-shortcut-audit', [
    'test/fixtures/menu-shortcut-audit/main.swift',
    'src/native/MenuShortcutAudit.swift'
  ])
  const report = JSON.parse(runFixture(binary))
  const dump = JSON.stringify(report)
  assert.deepEqual(
    report.system,
    ['orderFrontCharacterPalette:', 'startDictation:'],
    'only the two AppKit selectors are exempt'
  )
  const bound = report.rows.map((r) => `${[...r.modifiers].join('+')}+${r.key}`).sort()
  assert.deepEqual(
    bound,
    ['command+d', 'command+f', 'shift+command+g'],
    `ordinary rows stay, system rows go: ${dump}`
  )
  const titles = report.rows.map((r) => r.title).sort()
  assert.deepEqual(titles, ['Duplicate', 'Find…', 'Nested'], dump)
  const duplicate = report.rows.find((r) => r.title === 'Duplicate')
  assert.deepEqual(duplicate, {
    title: 'Duplicate',
    key: 'd',
    menu: 'Edit',
    modifiers: ['command']
  })
  // An upper-case key equivalent means Shift: the audit still reports it.
  const nested = report.rows.find((r) => r.title === 'Nested')
  assert.deepEqual(nested.modifiers, ['shift', 'command'], dump)
  assert.equal(nested.menu, 'More', 'a nested row names its own menu')
  console.log('MENU-SHORTCUT-AUDIT PASS')
}
