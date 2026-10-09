import AppKit

/// The header row of a floating island (LKM-180): dragging it moves the island, a
/// double-click puts it back. Its labels drag too; its buttons and menus keep their clicks
/// and show the arrow, the rest of the row an open hand (closed while dragging).
final class IslandHeader: NSView {
    /// Window points where the drag started and is now; `ended` on release.
    var dragged: ((NSPoint, NSPoint, Bool) -> Void)?, reset: (() -> Void)?
    /// Room at each end left to the island's own resize rim.
    var margin: CGFloat = 0
    private var start: NSPoint?, moving = false
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard let hit = super.hitTest(point) else { return nil }
        if let label = hit as? NSTextField, !label.isEditable, !label.isSelectable { return self }
        return hit
    }
    override func mouseDown(with event: NSEvent) {
        moving = false
        if event.clickCount == 2 { start = nil; reset?() } else { start = event.locationInWindow }
    }
    override func mouseDragged(with event: NSEvent) {
        guard let start else { return }
        let p = event.locationInWindow
        // A click that wobbles a point or two is not a move.
        if !moving, hypot(p.x - start.x, p.y - start.y) < 3 { return }
        moving = true; NSCursor.closedHand.set()
        dragged?(start, p, false)
    }
    override func mouseUp(with event: NSEvent) {
        if let start, moving { dragged?(start, event.locationInWindow, true) }
        start = nil; moving = false; window?.invalidateCursorRects(for: self)
    }
    /// The parts of the row that are not a control: they take the open hand.
    func handRects() -> [NSRect] {
        let controls = subviews.filter { !$0.isHidden && $0 is NSControl && !($0 is NSTextField) }.map { $0.frame.insetBy(dx: -2, dy: 0) }.sorted { $0.minX < $1.minX }
        var rects: [NSRect] = [], x = margin
        for control in controls {
            if control.minX > x { rects.append(NSRect(x: x, y: 0, width: control.minX - x, height: bounds.height)) }
            x = max(x, control.maxX)
        }
        if bounds.width - margin > x { rects.append(NSRect(x: x, y: 0, width: bounds.width - margin - x, height: bounds.height)) }
        return rects
    }
    override func resetCursorRects() { for rect in handRects() { addCursorRect(rect, cursor: .openHand) } }
    override func layout() { super.layout(); window?.invalidateCursorRects(for: self) }
}

/// An island's opaque face: the page must not show through its controls (LKM-162).
final class IslandFace: NSView {
    override func draw(_ dirtyRect: NSRect) { NSColor.windowBackgroundColor.setFill(); NSBezierPath(roundedRect: bounds, xRadius: FloatingIsland.cornerRadius, yRadius: FloatingIsland.cornerRadius).fill() }
}

/// What every island over the preview shares (LKM-180): the composer's inset, radius and
/// Liquid Glass edge, an opaque face, a header that moves it, and a frame that owns the
/// pointer, so neither the island nor a move hands hover, clicks or scrolls to the page
/// (LKM-162/LKM-173). Where it goes is `WorkspaceLayout`'s and `IslandPlacement`'s job.
class FloatingIsland: NSView {
    // ChatLayout.composerInset and the composer's radius.
    static let inset: CGFloat = 10, cornerRadius: CGFloat = 24, headerHeight: CGFloat = 40, padding: CGFloat = 14
    let face = IslandFace(), header = IslandHeader(), title = NSTextField(labelWithString: "")
    private(set) var glass = false
    /// The island's frame in its superview while its header is dragged; `ended` on release.
    var moved: ((NSRect, Bool) -> Void)?, reset: (() -> Void)?
    private var moving: NSRect?
    override var isFlipped: Bool { true }
    init(title text: String) {
        super.init(frame: .zero); isHidden = true
        title.stringValue = text; title.font = .systemFont(ofSize: 13, weight: .semibold); title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        header.dragged = { [weak self] start, point, ended in self?.drag(from: start, to: point, ended: ended) }
        header.reset = { [weak self] in self?.reset?() }
        title.translatesAutoresizingMaskIntoConstraints = false; header.addSubview(title)
        header.translatesAutoresizingMaskIntoConstraints = false; face.addSubview(header)
        let backdrop: NSView
        if #available(macOS 26.0, *) {
            let effect = NSGlassEffectView(); effect.style = .regular
            effect.cornerRadius = Self.cornerRadius; effect.contentView = face
            backdrop = effect; glass = true
        } else {
            let effect = NSVisualEffectView(); effect.material = .popover
            effect.blendingMode = .withinWindow; effect.state = .followsWindowActiveState
            effect.wantsLayer = true; effect.layer?.cornerRadius = Self.cornerRadius; effect.layer?.masksToBounds = true
            effect.addSubview(face); backdrop = effect
        }
        face.frame = backdrop.bounds; face.autoresizingMask = [.width, .height]
        backdrop.frame = bounds; backdrop.autoresizingMask = [.width, .height]; addSubview(backdrop)
        NSLayoutConstraint.activate([
            header.leadingAnchor.constraint(equalTo: face.leadingAnchor), header.trailingAnchor.constraint(equalTo: face.trailingAnchor),
            header.topAnchor.constraint(equalTo: face.topAnchor), header.heightAnchor.constraint(equalToConstant: Self.headerHeight),
            title.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: Self.padding), title.centerYAnchor.constraint(equalTo: header.centerYAnchor)
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
    /// A header drag from window point `start` to `point`, measured in the superview, which
    /// does not move while the island does.
    func drag(from start: NSPoint, to point: NSPoint, ended: Bool) {
        guard let superview else { return }
        let a = superview.convert(start, from: nil), b = superview.convert(point, from: nil)
        let from = moving ?? frame
        moving = ended ? nil : from
        moved?(from.offsetBy(dx: b.x - a.x, dy: b.y - a.y), ended)
    }
    /// Sets the frame and refreshes the header's hand cursor where it changed.
    func place(_ next: NSRect) {
        guard frame != next else { return }
        frame = next; window?.invalidateCursorRects(for: self); window?.invalidateCursorRects(for: header)
    }
    // The island's whole frame takes the pointer (LKM-162): AppKit otherwise handed a click
    // or scroll its glass, padding or labels left unhandled to the preview beneath.
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden, frame.contains(point) else { return nil }
        return super.hitTest(point) ?? self
    }
    override func mouseDown(with event: NSEvent) {}
    override func rightMouseDown(with event: NSEvent) {}
    override func otherMouseDown(with event: NSEvent) {}
    override func scrollWheel(with event: NSEvent) {}
}
