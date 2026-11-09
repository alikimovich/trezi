import AppKit
import SwiftUI

// LKM-601: Up/Down stepping in the real NativeEditingInspector (off-screen window, x: -4000).
// Each case focuses one production TextField, sends real keyDown/keyUp events through the
// window and records the text, the focus, the selection and every action the island sent.
// The arithmetic table checks InspectorNumberStep.stepped directly.
var emitted: [[String: Any]] = []
func emit(_ value: [String: Any]) { emitted.append(value) }
func fail(_ message: String) -> Never { fputs("FAIL: \(message)\n", stderr); exit(1) }
func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
func pump(_ seconds: Double = 0.15) {
    let end = Date(timeIntervalSinceNow: seconds)
    while Date() < end { RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.016)) }
}

let table: [[String: Any]] = [
    ("0", 1.0, -400.0, 400.0, "px", 1.0), ("0", 1, -400, 400, "px", -1), ("0", 1, 0, 400, "px", -1),
    ("0px", 1, 0, 400, "px", 1), ("114.203125", nil, 0, 2000, "px", 1), ("0.5", 0.01, 0, 1, "", 1),
    ("0.2", 0.1, 0, 1, "", 1), ("-0.1", 0.1, -10, 20, "px", 1), ("400", 1, -400, 400, "px", 1),
    ("399.5", 1, -400, 400, "px", 1), ("1.5em", 1, -400, 400, "px", 1), ("0.5em", 10, 0, 400, "px", -1),
    ("200ms", 10, 0, 5000, "ms", 1), ("auto", 1, 0, 400, "px", 1), ("var(--space)", 1, 0, 400, "px", 1),
    ("calc(1px + 2px)", 1, 0, 400, "px", 1), ("", 1, 0, 400, "px", 1), ("1px 2px", 1, 0, 400, "px", 1),
    ("12", nil, nil, nil, nil, -1), (".5", nil, nil, nil, nil, 1), ("700", 100, 100, 900, "", 1)
].map { (text: String, step: Double?, min: Double?, max: Double?, unit: String?, direction: Double) in
    ["text": text, "direction": direction, "result": InspectorNumberStep.stepped(text, step: step, min: min, max: max, unit: unit, direction: direction) ?? NSNull()]
}

_ = NSApplication.shared
NSApp.setActivationPolicy(.accessory)
let fields: [[String: Any]] = [
    ["id": "style:width", "label": "width", "group": "layout", "kind": "number", "value": "114.203125", "layout": "size", "min": 0, "max": 2000, "unit": "px"],
    ["id": "style:height", "label": "height", "group": "layout", "kind": "number", "value": "auto", "layout": "size", "min": 0, "max": 2000, "step": 1, "unit": "px"],
    ["id": "style:padding-top", "label": "Top", "group": "layout", "kind": "number", "value": "0px", "layout": "padding", "axis": "top", "expanded": true, "min": 0, "max": 400, "step": 1, "unit": "px"],
    ["id": "style:margin-vertical", "label": "Vertical", "group": "layout", "kind": "number", "value": "3", "layout": "margin", "axis": "vertical", "min": -400, "max": 400, "step": 1, "unit": "px"],
    ["id": "style:gap", "label": "gap", "group": "layout", "kind": "number", "value": "8px", "layout": "gap", "disabled": true, "min": 0, "max": 400, "step": 1, "unit": "px"],
    ["id": "style:opacity", "label": "opacity", "group": "appearance", "kind": "number", "value": "0.5", "min": 0, "max": 1, "step": 0.01, "unit": ""],
    ["id": "style:box-shadow", "label": "box-shadow", "group": "appearance", "kind": "text", "value": "0 1px 2px black"]
]
func state(_ tab: String, _ fields: [[String: Any]]) -> InspectorState {
    let raw: [String: Any] = ["root": "/fixture", "generation": 1, "visible": true, "title": "div", "tab": tab, "fields": fields, "actions": [], "error": "", "busy": false]
    return try! JSONDecoder().decode(InspectorState.self, from: JSONSerialization.data(withJSONObject: raw))
}

let window = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: 340, height: 760), styleMask: [.titled], backing: .buffered, defer: false)
window.isReleasedWhenClosed = false
window.makeKeyAndOrderFront(nil)
NSApp.activate(ignoringOtherApps: true)
let island = NativeEditingInspector()
window.contentView!.addSubview(island)
island.frame = NSRect(x: 20, y: 20, width: 300, height: 720)

func key(_ code: UInt16, repeat isRepeat: Bool = false) {
    let chars = code == 126 ? "\u{F700}" : code == 125 ? "\u{F701}" : code == 36 ? "\r" : "x"
    let flags: NSEvent.ModifierFlags = code == 126 || code == 125 ? [.numericPad, .function] : []
    for type in [NSEvent.EventType.keyDown, .keyUp] {
        let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: isRepeat && type == .keyDown, keyCode: code)!
        // The app's own event path: queued, dequeued (where local monitors run), then sent.
        NSApp.postEvent(event, atStart: false)
        while let next = NSApp.nextEvent(matching: .any, until: Date(timeIntervalSinceNow: 0.02), inMode: .default, dequeue: true) { NSApp.sendEvent(next) }
        pump(0.04)
    }
}
func textField(_ value: String) -> NSTextField? {
    descendants(island).compactMap { $0 as? NSTextField }.first { $0.isEditable && $0.stringValue == value }
}
var cases: [[String: Any]] = []
/// Focus the field showing `initial`, press `keys` (126 up, 125 down, 36 Return; a negative
/// code is that key as a repeat), then optionally leave the field.
func run(_ name: String, initial: String, keys: [Int], blur: Bool = false, caret: Int? = nil) {
    window.makeFirstResponder(nil); pump(0.1)
    guard let field = textField(initial) else { fail("\(name): no field showing \(initial) in \(descendants(island).compactMap { ($0 as? NSTextField)?.stringValue }) after \(cases)") }
    let focused = window.makeFirstResponder(field); pump(0.15)
    emitted = []
    if let caret, let editor = window.firstResponder as? NSTextView { editor.setSelectedRange(NSRange(location: caret, length: 0)) }
    var wholeSelected: [Bool] = [], selections: [[Int]] = []
    for code in keys {
        key(UInt16(abs(code)), repeat: code < 0); pump(0.05)
        if let editor = window.firstResponder as? NSTextView {
            selections.append([editor.selectedRange().location, editor.selectedRange().length])
            wholeSelected.append(editor.selectedRange() == NSRange(location: 0, length: (editor.string as NSString).length))
        }
    }
    let editor = window.firstResponder as? NSTextView
    let kept = editor.map { ($0.delegate as? NSTextField) === field } ?? false
    if blur { window.makeFirstResponder(nil); pump(0.15) }
    cases.append([
        "case": name, "focused": focused, "kept": kept, "text": field.stringValue,
        "whole": wholeSelected, "selections": selections,
        "actions": emitted.map { [$0["action"] as? String ?? "", $0["field"] as? String ?? "", $0["value"] as? String ?? ""] }
    ])
}

island.model.show(state("styles", fields)); island.isHidden = false
pump(0.4); island.layoutSubtreeIfNeeded(); pump(0.2)
run("margin", initial: "3", keys: [126, -126, 125, 125, 125, 125, 125, 36])
run("padding", initial: "0px", keys: [126, 126, 125, 125, 125], blur: true)
run("width", initial: "114.203125", keys: [126])
// A caret before the unit stays before it: "1|px" → "2|px" → "3|px".
run("padding-caret", initial: "0px", keys: [126, 126, 126], blur: true, caret: 1)
run("auto", initial: "auto", keys: [126, 125])
run("gap-disabled", initial: "8px", keys: [126])
run("opacity", initial: "0.5", keys: [126, 126, -126], blur: true)
run("shadow-text", initial: "0 1px 2px black", keys: [126, 125])
// Props: a number prop with no declared step; Return stages it, leaving the field does not.
island.model.show(state("props", [
    ["id": "prop:count", "label": "count", "group": "Card", "kind": "number", "value": "7", "reset": true],
    ["id": "prop:label", "label": "label", "group": "Card", "kind": "text", "value": "Hello"]
])); pump(0.4)
run("prop-blur", initial: "7", keys: [126, 126], blur: true)
run("prop-return", initial: "9", keys: [125, 36])
let data = try! JSONSerialization.data(withJSONObject: ["table": table, "cases": cases])
print(String(data: data, encoding: .utf8)!)
