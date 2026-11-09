import AppKit
import SwiftUI

/// LKM-601: Up/Down arrow stepping for the inspector's numeric fields, as in a numeric input.
enum InspectorNumberStep {
    private static let pattern = try! NSRegularExpression(pattern: "^(-?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+))([a-zA-Z%]*)$")

    /// `text` moved one `step` up (`direction` 1) or down (-1), keeping an inline unit
    /// ("0px" → "1px"), or nil when the text is not one plain number (auto, var(), calc(),
    /// a token, mixed/empty) or is already at the bound it would move past. The declared
    /// step and bounds belong to the field's unit: a value written in another unit
    /// ("1.5em" in a px field) steps by 1 and only keeps a nonnegative minimum. The result
    /// is rounded to the value's or the step's decimals, so 0.1 steps never print 0.30000000000000004.
    static func stepped(_ text: String, step declared: Double?, min: Double?, max: Double?, unit: String?, direction: Double) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        let range = NSRange(trimmed.startIndex..., in: trimmed)
        guard let match = pattern.firstMatch(in: trimmed, range: range),
              let numberRange = Range(match.range(at: 1), in: trimmed), let suffixRange = Range(match.range(at: 2), in: trimmed),
              let current = Double(trimmed[numberRange]) else { return nil }
        let number = String(trimmed[numberRange]), suffix = String(trimmed[suffixRange])
        let ownUnit = suffix.isEmpty || suffix.lowercased() == (unit ?? "").lowercased()
        let step = ownUnit ? (declared.flatMap { $0 > 0 && $0.isFinite ? $0 : nil } ?? 1) : 1
        let lower = ownUnit ? min : min.flatMap { $0 >= 0 ? 0 : nil }
        let upper = ownUnit ? max : nil
        if direction > 0, let upper, current >= upper { return nil }
        if direction < 0, let lower, current <= lower { return nil }
        var next = current + direction * step
        if let lower { next = Swift.max(lower, next) }
        if let upper { next = Swift.min(upper, next) }
        let digits = Swift.min(10, Swift.max(decimals(number), decimals(String(step))))
        let factor = pow(10, Double(digits))
        next = (next * factor).rounded() / factor
        var printed = String(format: "%.\(digits)f", next)
        if printed.contains(".") { while printed.hasSuffix("0") { printed.removeLast() }; if printed.hasSuffix(".") { printed.removeLast() } }
        if printed == "-0" { printed = "0" }
        let result = printed + suffix
        return result == trimmed ? nil : result
    }

    /// One plain number with an optional inline unit: the only text arrows step.
    static func isNumber(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        return pattern.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)) != nil
    }

    static func stepped(_ text: String, field: InspectorField, direction: Double) -> String? {
        stepped(text, step: field.step, min: field.min, max: field.max, unit: field.unit, direction: direction)
    }

    private static func decimals(_ number: String) -> Int {
        if number.contains("e") || number.contains("E") { return 10 }
        guard let dot = number.firstIndex(of: ".") else { return 0 }
        return number.distance(from: number.index(after: dot), to: number.endIndex)
    }
}

/// Placed behind one numeric TextField. While `enabled` (an editable field holding a number)
/// and that field's own field editor is first responder, a plain Up/Down key press (repeats
/// included) calls `step` instead of moving the caret, also at a bound, where nothing changes; every other key, field and window is left alone. The AppKit field editor consumes
/// moveUp:/moveDown: itself, so SwiftUI's onMoveCommand never sees them on a focused field.
struct NumericArrowKeys: NSViewRepresentable {
    let enabled: Bool
    /// Moves the value one step; the new text, or nil when it did not change.
    let step: (Double) -> String?
    func makeNSView(context: Context) -> ArrowKeyView { let view = ArrowKeyView(); view.update(enabled: enabled, step: step); return view }
    func updateNSView(_ view: ArrowKeyView, context: Context) { view.update(enabled: enabled, step: step) }
    static func dismantleNSView(_ view: ArrowKeyView, coordinator: ()) { view.stop() }

    final class ArrowKeyView: NSView {
        private var enabled = false
        private var step: ((Double) -> String?)?
        private var monitor: Any?
        private var restore: (NSTextView, String, NSRange)?
        func update(enabled: Bool, step: @escaping (Double) -> String?) {
            self.enabled = enabled; self.step = step
            guard let (editor, text, selection) = restore else { return }
            restore = nil
            DispatchQueue.main.async { [weak editor] in
                guard let editor, editor.window?.firstResponder === editor, editor.string == text else { return }
                editor.setSelectedRange(selection)
            }
        }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            stop()
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, self.handle(event) else { return event }
                return nil
            }
        }
        func stop() { if let monitor { NSEvent.removeMonitor(monitor) }; monitor = nil }
        /// The editable text field this view sits behind (same frame), when its field editor has focus.
        private func editedField(in window: NSWindow) -> (NSTextField, NSTextView)? {
            guard let editor = window.firstResponder as? NSTextView, editor.isFieldEditor,
                  let field = editor.delegate as? NSTextField, field.isEditable, field.window === window else { return nil }
            let mine = convert(bounds, to: nil), theirs = field.convert(field.bounds, to: nil)
            guard mine.width > 0, theirs.contains(NSPoint(x: mine.midX, y: mine.midY)) || mine.contains(NSPoint(x: theirs.midX, y: theirs.midY)) else { return nil }
            return (field, editor)
        }
        func handle(_ event: NSEvent) -> Bool {
            guard enabled, let window, event.window === window, let step,
                  event.keyCode == 126 || event.keyCode == 125,
                  event.modifierFlags.intersection([.command, .option, .control, .shift]).isEmpty,
                  let (_, editor) = editedField(in: window) else { return false }
            let before = editor.selectedRange(), old = (editor.string as NSString).length
            let whole = before.length > 0 && before.length == old
            guard let text = step(event.keyCode == 126 ? 1 : -1) else { return true }
            // The binding already holds `text`: show it now, and keep the selection once SwiftUI
            // has written the same text into the field, which resets it: the whole value stays
            // selected if it was, else the caret keeps its distance from the end ("12|px").
            // Writing `string` sends no text-change callback, so nothing is previewed or staged twice.
            editor.string = text
            let length = (text as NSString).length
            let caret = Swift.max(0, length - Swift.max(0, old - NSMaxRange(before)))
            let selection = whole ? NSRange(location: 0, length: length) : NSRange(location: caret, length: 0)
            editor.setSelectedRange(selection)
            restore = (editor, text, selection)
            return true
        }
    }
}
