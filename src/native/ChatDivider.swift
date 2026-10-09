import AppKit

/// Native surfaces sit above WKWebView. Keep divider input in the same native
/// layer so a resized conversation cannot cover its next drag target.
final class NativeChatDivider: NSView {
    private var origin: CGFloat = 0
    private var startMouse: CGFloat = 0
    private var startWidth: CGFloat = 0
    private(set) var dragging = false
    private(set) var width: CGFloat = 440
    var changed: ((CGFloat) -> Void)?
    override var acceptsFirstResponder: Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .resizeLeftRight) }
    func update(_ state: [String: Any]) {
        guard let rect = state["bounds"] as? [String: Double] else { isHidden = true; return }
        let w = rect["width"] ?? 0
        isHidden = !(state["visible"] as? Bool ?? false) || w < 60
        origin = rect["x"] ?? 0
        if !dragging { width = w }
        frame = NSRect(x: origin + width - 4, y: rect["y"] ?? 0, width: 8, height: rect["height"] ?? 0)
        window?.invalidateCursorRects(for: self)
    }
    func begin(at point: NSPoint) { dragging = true; startMouse = point.x; startWidth = width }
    func drag(to point: NSPoint) {
        guard dragging else { return }
        let maximum = max(320, min(760, (superview?.bounds.width ?? 1320) - 624))
        width = min(maximum, max(320, startWidth + point.x - startMouse))
        frame.origin.x = origin + width - 4
        changed?(width)
    }
    func end() { dragging = false; changed?(width) }
    override func mouseDown(with event: NSEvent) { begin(at: event.locationInWindow) }
    override func mouseDragged(with event: NSEvent) { drag(to: event.locationInWindow) }
    override func mouseUp(with event: NSEvent) { end() }
    override func viewDidMoveToWindow() { if window == nil { end() } }
}

final class NativePanelDivider: NSView {
    var vertical = false
    var changed: ((CGFloat) -> Void)?
    private var previous: NSPoint?
    override func resetCursorRects() { addCursorRect(bounds, cursor: vertical ? .resizeLeftRight : .resizeUpDown) }
    override func mouseDown(with event: NSEvent) { previous = event.locationInWindow }
    override func mouseDragged(with event: NSEvent) { guard let previous else { return }; self.previous = event.locationInWindow; changed?(vertical ? event.locationInWindow.x - previous.x : event.locationInWindow.y - previous.y) }
    override func mouseUp(with event: NSEvent) { previous = nil }
}
