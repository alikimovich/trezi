import AppKit
import WebKit

/// The project preview's pointer gate (LKM-162). AppKit hit-tests clicks to the native
/// views that float over the page, but WebKit's own tracking area hands it every mouse
/// move in its frame, the window does too while the page is first responder, and a click
/// a floating view left unhandled still reached it. So the editing island was
/// click-through: the page hovered and selected under it. Pointer events now reach WebKit
/// only where the page is the window's hit view, and moving onto a native view tells the
/// page the pointer left.
final class PreviewWebView: WKWebView {
    /// WebKit's tracking areas, each replaced by one whose owner filters for it.
    private var gates: [ObjectIdentifier: (original: NSTrackingArea, replacement: NSTrackingArea, gate: PreviewPointerGate)] = [:]
    private var away = false
    /// Pointer events passed to WebKit, by kind. Test-only: the island verification resets and reads it.
    var delivered: [String: Int] = [:]

    /// Whether the window hit-tests `event`'s point to the page rather than to a view above it.
    func reaches(_ event: NSEvent) -> Bool {
        guard let window, event.windowNumber == window.windowNumber, let hit = window.contentView?.superview?.hitTest(event.locationInWindow) else { return true }
        return hit.isDescendant(of: self)
    }
    /// Passes a move, enter or click to WebKit when it is the page's, else drops it.
    func gate(_ event: NSEvent, _ kind: String, _ deliver: () -> Void) {
        guard reaches(event) else { if kind != "down" && kind != "wheel" { leave(event) }; return }
        if kind == "move" || kind == "enter" { away = false }
        delivered[kind, default: 0] += 1
        deliver()
    }
    /// The pointer moved onto a native view: an exit outside the page's frame drops the
    /// page's hover box (preload's mouseout without a relatedTarget), once per visit.
    private func leave(_ event: NSEvent) {
        guard !away else { return }
        away = true
        // The page's cursor (select mode's crosshair) must not follow the pointer onto native views.
        NSCursor.arrow.set()
        let outside = convert(NSPoint(x: -1, y: -1), to: nil)
        guard let exit = NSEvent.enterExitEvent(with: .mouseExited, location: outside, modifierFlags: event.modifierFlags, timestamp: event.timestamp,
                                                windowNumber: event.windowNumber, context: nil, eventNumber: 0, trackingNumber: 0, userData: nil) else { return }
        delivered["exit", default: 0] += 1
        if let owner = gates.values.first(where: { $0.original.options.contains(.mouseMoved) })?.gate.owner, owner.responds(to: #selector(NSResponder.mouseExited(with:))) {
            owner.perform(#selector(NSResponder.mouseExited(with:)), with: exit)
        } else { super.mouseExited(with: exit) }
    }

    override func addTrackingArea(_ area: NSTrackingArea) {
        guard let owner = area.owner as? NSObject, owner !== self, area.options.contains(.mouseMoved) || area.options.contains(.mouseEnteredAndExited) else { return super.addTrackingArea(area) }
        let gate = PreviewPointerGate(preview: self, owner: owner)
        let replacement = NSTrackingArea(rect: area.rect, options: area.options, owner: gate, userInfo: area.userInfo)
        gates[ObjectIdentifier(area)] = (area, replacement, gate)
        super.addTrackingArea(replacement)
    }
    override func removeTrackingArea(_ area: NSTrackingArea) {
        super.removeTrackingArea(gates.removeValue(forKey: ObjectIdentifier(area))?.replacement ?? area)
    }
    // The window's own deliveries: mouse moves while the page is first responder, and
    // clicks or scrolls a floating view above the page left unhandled.
    override func mouseMoved(with event: NSEvent) { gate(event, "move") { super.mouseMoved(with: event) } }
    override func mouseDown(with event: NSEvent) { gate(event, "down") { super.mouseDown(with: event) } }
    override func rightMouseDown(with event: NSEvent) { gate(event, "down") { super.rightMouseDown(with: event) } }
    override func otherMouseDown(with event: NSEvent) { gate(event, "down") { super.otherMouseDown(with: event) } }
    override func scrollWheel(with event: NSEvent) { gate(event, "wheel") { super.scrollWheel(with: event) } }
}

/// Owns one of WebKit's tracking areas in its place and forwards to WebKit's owner only
/// the events whose point the page owns.
final class PreviewPointerGate: NSObject {
    weak var preview: PreviewWebView?
    // WebKit keeps its tracking observer alive for the view's lifetime; AppKit never retained it.
    weak var owner: NSObject?
    init(preview: PreviewWebView, owner: NSObject) { self.preview = preview; self.owner = owner }
    private func forward(_ selector: Selector, _ event: NSEvent) {
        if let owner, owner.responds(to: selector) { owner.perform(selector, with: event) }
    }
    @objc func mouseMoved(with event: NSEvent) {
        guard let preview else { return }
        preview.gate(event, "move") { forward(#selector(mouseMoved(with:)), event) }
    }
    @objc func mouseEntered(with event: NSEvent) {
        guard let preview else { return }
        preview.gate(event, "enter") { forward(#selector(mouseEntered(with:)), event) }
    }
    @objc func mouseExited(with event: NSEvent) { forward(#selector(mouseExited(with:)), event) }
    @objc func cursorUpdate(with event: NSEvent) {
        if preview?.reaches(event) ?? true { forward(#selector(cursorUpdate(with:)), event) }
    }
}
