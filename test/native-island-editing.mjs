import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runFixture, swiftBuild, swiftCompile } from './helpers/swift-build.mjs'

// Compiles the islands' live-write and typed-entry policy (IslandEditing.swift) without a window.
if (process.platform !== 'darwin') {
  console.log('NATIVE-ISLAND-EDITING SKIP — macOS Swift toolchain required')
} else {
  const binary = swiftBuild('island-editing', [
    'test/fixtures/island-editing/main.swift',
    'src/native/IslandEditing.swift'
  ])
  console.log(runFixture(binary).trim())
}

if (process.platform === 'darwin') {
  const source = readFileSync(new URL('../src/native/ChatIsland.swift', import.meta.url), 'utf8')
  const nativeField = source.slice(
    source.indexOf('struct IslandNativeInput:'),
    source.indexOf('struct IslandPoint:')
  )
  const dir = mkdtempSync(join(tmpdir(), 'trezi-island-field-'))
  try {
    const input = join(dir, 'main.swift'),
      output = join(dir, 'field')
    writeFileSync(
      input,
      `import AppKit
import SwiftUI
${nativeField}
let app = NSApplication.shared
var text = "0.75", focused = false, submits = 0
let input = IslandNativeInput(label: "Light X", text: Binding(get: { text }, set: { text = $0 }),
    focused: Binding(get: { focused }, set: { focused = $0 }), invalid: false, submit: { submits += 1 })
let coordinator = input.makeCoordinator()
let field = NSTextField(string: "-0.25")
let notification = Notification(name: NSControl.textDidChangeNotification, object: field)
coordinator.controlTextDidBeginEditing(notification)
precondition(focused)
coordinator.controlTextDidChange(notification)
precondition(text == "-0.25")
precondition(coordinator.control(field, textView: NSTextView(), doCommandBy: #selector(NSResponder.insertNewline(_:))))
precondition(submits == 1)
precondition(!coordinator.control(field, textView: NSTextView(), doCommandBy: #selector(NSResponder.moveLeft(_:))))
precondition(submits == 1)
coordinator.controlTextDidEndEditing(notification)
precondition(!focused)
print("NATIVE-ISLAND-INPUT PASS — real native edit, focus, Return and responder delegation")
`
    )
    const built = swiftCompile([input], output)
    assert.equal(built.status, 0, built.stderr)
    console.log(runFixture(output).trim())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
