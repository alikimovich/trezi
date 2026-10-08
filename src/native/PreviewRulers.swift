import AppKit

/// Drawing for `PreviewOverlay`: the two rulers, their corner, and the transparent layer
/// over the page with the grids and guides. Lines sit on device pixels so they stay crisp
/// on Retina; the page keeps its input except within grabbing distance of a guide.
private func pixel(_ view: NSView) -> CGFloat { 1 / max(view.window?.backingScaleFactor ?? 2, 1) }
/// A one-pixel line's position, centred on a device pixel.
private func crisp(_ value: CGFloat, _ view: NSView) -> CGFloat { let p = pixel(view); return (value / p).rounded(.down) * p }
private func color(_ hex: String, _ opacity: Double) -> NSColor {
    let (r, g, b) = OverlayMath.rgb(hex) ?? (1, 0.23, 0.19)
    return NSColor(srgbRed: r, green: g, blue: b, alpha: opacity)
}
func overlayNumber(_ value: Double) -> String {
    let rounded = (value * 10).rounded() / 10
    return rounded == rounded.rounded() ? String(Int(rounded)) : String(format: "%.1f", rounded)
}

final class PreviewRuler: NSView {
    weak var overlay: PreviewOverlay?
    let vertical: Bool
    init(vertical: Bool) { self.vertical = vertical; super.init(frame: .zero) }
    required init?(coder: NSCoder) { nil }
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: vertical ? .resizeLeftRight : .resizeUpDown) }
    /// The top ruler makes horizontal guides, the left ruler vertical ones.
    var axis: String { vertical ? "x" : "y" }
    override func mouseDown(with event: NSEvent) { overlay?.grab(axis: axis, id: nil, at: event.locationInWindow) }
    override func mouseDragged(with event: NSEvent) { overlay?.dragged(to: event.locationInWindow) }
    override func mouseUp(with event: NSEvent) { overlay?.released(at: event.locationInWindow) }

    override func draw(_ dirtyRect: NSRect) {
        guard let overlay else { return }
        let p = pixel(self), length = vertical ? bounds.height : bounds.width, depth = vertical ? bounds.width : bounds.height
        NSColor.windowBackgroundColor.setFill(); bounds.fill()
        // The page origin, along this ruler, in ruler points.
        let origin = vertical ? overlay.frame.minY - frame.minY : overlay.frame.minX - frame.minX
        func rect(_ along: CGFloat, _ size: CGFloat, _ from: CGFloat, _ to: CGFloat) -> NSRect {
            vertical ? NSRect(x: from, y: along, width: to - from, height: size) : NSRect(x: along, y: from, width: size, height: to - from)
        }
        // The selected element's extent, and the pointer.
        if let selection = overlay.page.selection {
            let low = origin + (vertical ? selection.minY : selection.minX) * overlay.scale
            let high = origin + (vertical ? selection.maxY : selection.maxX) * overlay.scale
            NSColor.controlAccentColor.withAlphaComponent(0.22).setFill(); rect(low, max(high - low, p), 0, depth).fill(using: .sourceOver)
            NSColor.controlAccentColor.setFill()
            for edge in [low, high] { rect(crisp(edge, self), p, 0, depth).fill() }
        }
        // Ticks: page CSS px along the ruler, labelled every major step.
        let scale = Double(overlay.scale), step = OverlayMath.rulerStep(scale: scale)
        let first = overlay.css(-origin, axis: axis), last = overlay.css(length - origin, axis: axis)
        let minor = step.major / Double(step.minor)
        let font = NSFont.monospacedDigitSystemFont(ofSize: 9, weight: .regular)
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.secondaryLabelColor]
        NSColor.tertiaryLabelColor.setFill()
        for value in OverlayMath.periodic(step: minor, offset: 0, in: (first - minor)...(last + minor), limit: 2000) {
            let at = crisp(origin + overlay.view(value, axis: axis), self)
            guard at >= -1, at <= length + 1 else { continue }
            let major = abs(value / step.major - (value / step.major).rounded()) < 1e-6
            let tick = major ? depth : (abs(value / (step.major / 2) - (value / (step.major / 2)).rounded()) < 1e-6 && step.minor % 2 == 0 ? depth * 0.5 : depth * 0.3)
            rect(at, p, depth - tick, depth).fill()
            guard major else { continue }
            let label = NSAttributedString(string: overlayNumber(value), attributes: attributes)
            if vertical {
                NSGraphicsContext.saveGraphicsState()
                let transform = NSAffineTransform(); transform.translateX(by: 1, yBy: at - 2); transform.rotate(byDegrees: -90); transform.concat()
                label.draw(at: NSPoint(x: 0, y: 0))
                NSGraphicsContext.restoreGraphicsState()
            } else {
                label.draw(at: NSPoint(x: at + 2, y: 0))
            }
            NSColor.tertiaryLabelColor.setFill()
        }
        if let pointer = overlay.pointer {
            NSColor.controlAccentColor.setFill()
            rect(crisp(origin + (vertical ? pointer.y : pointer.x), self), p, 0, depth).fill()
        }
        NSColor.separatorColor.setFill()
        (vertical ? NSRect(x: bounds.maxX - p, y: 0, width: p, height: length) : NSRect(x: 0, y: bounds.maxY - p, width: length, height: p)).fill()
    }
}

final class PreviewRulerCorner: NSView {
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        let p = pixel(self)
        NSColor.windowBackgroundColor.setFill(); bounds.fill()
        NSColor.separatorColor.setFill()
        NSRect(x: bounds.maxX - p, y: 0, width: p, height: bounds.height).fill()
        NSRect(x: 0, y: bounds.maxY - p, width: bounds.width, height: p).fill()
    }
}

/// Transparent over the page frame: grids and guides. It answers hit tests only near an
/// unlocked guide, so clicks, scrolling and typing reach the page everywhere else.
final class PreviewGuideView: NSView {
    weak var overlay: PreviewOverlay?
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden, let overlay, let superview else { return nil }
        return overlay.guide(at: convert(point, from: superview)) == nil ? nil : self
    }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
    }
    override func mouseMoved(with event: NSEvent) { overlay?.moved(convert(event.locationInWindow, from: nil)) }
    override func mouseExited(with event: NSEvent) { overlay?.moved(nil) }
    override func mouseDown(with event: NSEvent) {
        guard let overlay, let guide = overlay.guide(at: convert(event.locationInWindow, from: nil)) else { return }
        overlay.grab(axis: guide.axis, id: guide.id, at: event.locationInWindow)
    }
    override func mouseDragged(with event: NSEvent) { overlay?.dragged(to: event.locationInWindow) }
    override func mouseUp(with event: NSEvent) { overlay?.released(at: event.locationInWindow) }
    override func keyDown(with event: NSEvent) {
        if [51, 117].contains(event.keyCode), overlay?.deleteSelected() == true { return }
        super.keyDown(with: event)
    }
    override func resignFirstResponder() -> Bool { overlay?.select(nil); return true }

    override func draw(_ dirtyRect: NSRect) {
        guard let overlay else { return }
        let p = pixel(self), state = overlay.state, scale = overlay.scale
        let rangeX = overlay.css(0, axis: "x")...overlay.css(bounds.width, axis: "x")
        let rangeY = overlay.css(0, axis: "y")...overlay.css(bounds.height, axis: "y")
        func line(_ axis: String, _ at: CGFloat, _ width: CGFloat? = nil) {
            let w = width ?? p, position = crisp(at, self)
            (axis == "x" ? NSRect(x: position, y: 0, width: w, height: bounds.height) : NSRect(x: 0, y: position, width: bounds.width, height: w)).fill(using: .sourceOver)
        }
        for grid in state.shownGrids {
            color(grid.color, grid.opacity).setFill()
            switch grid.kind {
            case "columns":
                for column in OverlayMath.columns(grid, width: overlay.viewportWidth) {
                    let x = overlay.view(column.start, axis: "x")
                    NSRect(x: x, y: 0, width: CGFloat(column.width) * scale, height: bounds.height).fill(using: .sourceOver)
                }
            case "rows":
                guard CGFloat(grid.step) * scale >= 2 else { continue }
                for y in OverlayMath.periodic(step: grid.step, offset: grid.offset, in: rangeY) { line("y", overlay.view(y, axis: "y")) }
            default:
                guard CGFloat(grid.size) * scale >= 2 else { continue }
                for x in OverlayMath.periodic(step: grid.size, offset: 0, in: rangeX) { line("x", overlay.view(x, axis: "x")) }
                for y in OverlayMath.periodic(step: grid.size, offset: 0, in: rangeY) { line("y", overlay.view(y, axis: "y")) }
            }
        }
        guard state.rulers else { return }
        let drag = overlay.drag
        for guide in state.guides where guide.id != drag?.id {
            (guide.id == overlay.selected ? NSColor.controlAccentColor : NSColor.systemPink).setFill()
            line(guide.axis, overlay.view(guide.position, axis: guide.axis), guide.id == overlay.selected ? 2 * p : p)
        }
        guard let drag else { return }
        let at = overlay.view(drag.position, axis: drag.axis)
        NSColor.systemPink.withAlphaComponent(drag.removing ? 0.35 : 1).setFill()
        line(drag.axis, at, drag.snapped ? 2 * p : p)
        // The position while dragging, next to the pointer.
        let text = drag.removing ? "Remove" : "\(drag.axis == "x" ? "X" : "Y") \(overlayNumber(drag.position))"
        let label = NSAttributedString(string: text, attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .medium), .foregroundColor: NSColor.white])
        let size = label.size(), pointer = overlay.pointer ?? .zero
        var box = NSRect(x: 0, y: 0, width: size.width + 10, height: size.height + 4)
        box.origin = drag.axis == "x" ? NSPoint(x: at + 6, y: pointer.y + 10) : NSPoint(x: pointer.x + 10, y: at + 6)
        box.origin.x = min(max(box.origin.x, 2), bounds.width - box.width - 2)
        box.origin.y = min(max(box.origin.y, 2), bounds.height - box.height - 2)
        NSColor.systemPink.withAlphaComponent(drag.removing ? 0.6 : 0.95).setFill()
        NSBezierPath(roundedRect: box, xRadius: 4, yRadius: 4).fill()
        label.draw(at: NSPoint(x: box.minX + 5, y: box.minY + 2))
    }
}
