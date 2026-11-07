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
    source.indexOf('struct IslandInput:'),
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
// Host the real SwiftUI wrapper: a plain delegate Binding cannot exercise its
// focus/source-change/blur semantics. This window is never activated or ordered.
final class FieldModel: ObservableObject {
    @Published var value = "0.75"
    @Published var enabled = true
    var commits: [String] = []
}
struct HostedField: View {
    @ObservedObject var model: FieldModel
    var body: some View {
        IslandInput(label: "Light X", value: model.value, kind: .number(-1...1)) { model.commits.append($0.text) }
            .disabled(!model.enabled)
    }
}
func pump() { RunLoop.main.run(until: Date(timeIntervalSinceNow:0.08)) }
func findField(_ view:NSView) -> NSTextField? {
    if let field=view as? NSTextField,field.accessibilityIdentifier()=="island-field-Light X" {return field}
    return view.subviews.lazy.compactMap(findField).first
}
let model=FieldModel()
let window=NSWindow(contentRect:NSRect(x:0,y:0,width:300,height:70),styleMask:[.borderless],backing:.buffered,defer:false)
window.contentView=NSHostingView(rootView:HostedField(model:model))
pump();window.contentView!.layoutSubtreeIfNeeded();pump()
let hosted=findField(window.contentView!)!
precondition(hosted.stringValue=="0.75")
precondition(window.makeFirstResponder(hosted))
pump()
let editor=hosted.currentEditor() as! NSTextView
editor.insertText("0.25",replacementRange:NSRange(location:0,length:(editor.string as NSString).length))
pump();model.value="-0.5";pump()
precondition(editor.string=="0.25","source refresh clobbered typed field")
precondition(window.makeFirstResponder(nil));pump()
precondition(model.commits==["0.25"],"blur must apply typed value exactly once")
model.value="0.25";pump()
precondition(window.makeFirstResponder(hosted));pump()
let second=hosted.currentEditor() as! NSTextView
second.insertText("0.5",replacementRange:NSRange(location:0,length:(second.string as NSString).length))
pump();second.doCommand(by:#selector(NSResponder.insertNewline(_:)));pump()
precondition(model.commits==["0.25","0.5"],"Return applies once")
precondition(window.makeFirstResponder(nil));pump()
precondition(model.commits==["0.25","0.5"],"Return followed by blur must not duplicate")
model.enabled=false;pump()
precondition(!hosted.isEnabled)
precondition(hosted.textColor==NSColor.disabledControlTextColor)
window.close()
print("NATIVE-ISLAND-INPUT PASS — hosted native focus, source refresh, blur, Return deduplication and disabled appearance")
`
    )
    const built = swiftCompile([input, 'src/native/IslandEditing.swift'], output)
    assert.equal(built.status, 0, built.stderr)
    console.log(runFixture(output).trim())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
