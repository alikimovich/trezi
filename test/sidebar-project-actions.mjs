import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-388: the project row's "…" was a pop-up with an `.inline` bezel, a gray pill next to the
// plain New chat button. It is now the same plain button. The fixture hosts the real `ProjectCell`
// and reads both controls at rest, hovered, pressed, on a selected and an emphasized row, disabled
// and focused, with the old pop-up as the control for the "no pill" pixels.
if (process.platform !== 'darwin') {
  console.log('SIDEBAR-PROJECT-ACTIONS SKIP — macOS AppKit required')
} else {
  const binary = swiftBuild('sidebar-project-actions', [
    'test/fixtures/sidebar-project-actions/main.swift',
    'src/native/ProjectCell.swift',
    'src/native/SourceList.swift',
    'src/native/SidebarIcon.swift',
    'src/native/SidebarChatsAccessibility.swift'
  ])
  const report = JSON.parse(runFixture(binary))

  const states = ['rest', 'hover', 'pressed', 'selected', 'emphasized', 'disabled']
  for (const name of states) {
    const { more, newChat, moreInk, newChatInk } = report[name]
    for (const key of Object.keys(newChat)) {
      if (['class', 'hitHeight', 'label', 'toolTip', 'width'].includes(key)) continue
      assert.equal(more[key], newChat[key], `${name}: "…" and New chat differ on ${key}`)
    }
    // New chat's frame follows its symbol: 24 wide here, 24.5 on a 2× display.
    assert.ok(Math.abs(more.width - newChat.width) <= 1, `${name}: ${newChat.width} wide`)
    assert.match(more.class, /ProjectMoreButton$/, `${name}: "…" is a plain button`)
    assert.equal(newChat.class, 'NSButton', `${name}: New chat is what it was`)
    assert.equal(more.bordered, false, `${name}: no bezel`)
    assert.equal(more.width, 24, `${name}: hit target width`)
    assert.equal(more.hitHeight, 28, `${name}: "…" takes the whole row`)
    assert.equal(more.role, 'AXButton', `${name}: role`)
    assert.equal(more.label, 'Actions for lkmv.ch', `${name}: "…" label`)
    assert.equal(more.toolTip, 'Project Actions', `${name}: "…" tooltip`)
    // New chat is what it was.
    assert.equal(newChat.label, 'New chat in lkmv.ch', `${name}: New chat label`)
    assert.equal(newChat.toolTip, 'New Chat', `${name}: New chat tooltip`)
    assert.equal(moreInk, 0, `${name}: "…" paints nothing outside its glyph (no pill)`)
    assert.equal(newChatInk, 0, `${name}: New chat paints nothing outside its glyph`)
  }
  assert.ok(report.pillInk > 0, `the old pill must fail the ink check: ${report.pillInk}`)

  // Interaction: both are shown together, and only on hover or selection.
  assert.deepEqual(
    states.map((name) => report[name].more.alpha),
    [0, 1, 1, 1, 1, 1]
  )
  assert.equal(report.pressed.more.highlighted, true, 'pressed reaches the button')
  assert.equal(report.disabled.more.enabled, false)
  assert.equal(report.focus.more, report.focus.newChat, 'one rule for keyboard focus')
  assert.equal(report.focus.moreTook, report.focus.newChatTook)
  assert.equal(report.focus.moreAccepts, report.focus.newChatAccepts)
  // A symbol's alignment rect sets a plain button's frame and differs by macOS, so New chat's
  // height is not fixed: "…" takes the whole row and is never the shorter target.
  assert.equal(report.hit.more, report.hit.row, 'AppKit gives "…" every point of the row')
  assert.ok(report.hit.newChat >= 24, `New chat keeps its target: ${report.hit.newChat}`)
  assert.ok(report.hit.more >= report.hit.newChat, '"…" is not a shorter target than New chat')
  assert.deepEqual(report.presses, ['more:p', 'new-chat:p'], 'AX press runs each action')
  assert.deepEqual(report.order, ['more:p', 'new-chat:p'], '"…" stays before New chat')

  // One builder for both, and no way back to the pill.
  const cell = readFileSync('src/native/ProjectCell.swift', 'utf8')
  assert.match(cell, /let more = ProjectMoreButton\(\)/)
  assert.match(cell, /let newChat = NSButton\(\)/)
  assert.doesNotMatch(cell, /NSPopUpButton/)
  assert.doesNotMatch(readFileSync('src/native/Shell.swift', 'utf8'), /more\.bezelStyle/)
  console.log(
    'SIDEBAR-PROJECT-ACTIONS PASS — "…" matches New chat at rest, hover, pressed, selected, emphasized, disabled and focus; no pill; AX press runs both'
  )
}
