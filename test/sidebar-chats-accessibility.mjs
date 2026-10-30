import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-379: "View all chats" is an AXButton that VoiceOver reaches and can press. On macOS 27
// the NSButton view is ignored (its own role is AXUnknown) and its cell is the element, so
// the sidebar-chats smoke read AXUnknown from the view. The fixture hosts the real button in
// an outline row and inspects the element VoiceOver gets through the seam the smoke uses.
if (process.platform !== 'darwin') {
  console.log('SIDEBAR-CHATS-ACCESSIBILITY SKIP — macOS AppKit required')
} else {
  const binary = swiftBuild('sidebar-chats-accessibility', [
    'test/fixtures/sidebar-chats-accessibility/main.swift',
    'src/native/SidebarChatsAccessibility.swift'
  ])
  const report = JSON.parse(runFixture(binary))
  const check = (key, expected) =>
    assert.equal(
      report[key],
      expected,
      `${key}: actual ${JSON.stringify(report[key])}, expected ${JSON.stringify(expected)}\n${JSON.stringify(report)}`
    )
  check('role', 'AXButton')
  check('label', 'View all chats')
  check('axTitle', 'View all chats')
  check('element', true)
  // VoiceOver navigates window > scroll area > outline > row > cell > button.
  assert.deepEqual(
    report.axPath,
    ['AXWindow', 'AXScrollArea', 'AXOutline', 'AXRow', 'AXCell', 'AXButton'],
    `axPath: ${JSON.stringify(report)}`
  )
  check('hit', true)
  check('press', true)
  check('presses', 1)

  // The smoke's inspection reads the element, never the ignored view.
  const swift = readFileSync('src/native/SidebarChats.swift', 'utf8')
  assert.match(swift, /AccessibilityElementInspect\.inspect\(button\)/)
  assert.doesNotMatch(swift, /button\??\.accessibility(Role|Label)\(\)/)
  assert.doesNotMatch(
    swift,
    /button\.setAccessibilityLabel/,
    'a view label blanks the cell description'
  )
  console.log(
    `SIDEBAR-CHATS-ACCESSIBILITY PASS — element ${report.role} "${report.label}", reachable, press runs the action (view role ${report.viewRole || 'none'})`
  )
}
