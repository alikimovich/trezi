import AppKit
import QuartzCore

/// Dots every 24 pt in the scene's grid color, redrawn on resize and appearance change.
final class ThreeDGridLayer: CALayer {
    var dot = CGColor(gray: 0.5, alpha: 1) { didSet { setNeedsDisplay() } }
    override init() { super.init(); needsDisplayOnBoundsChange = true }
    override init(layer: Any) { super.init(layer: layer) }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(in ctx: CGContext) {
        ctx.setFillColor(dot)
        var y: CGFloat = 12
        while y < bounds.height {
            var x: CGFloat = 12
            while x < bounds.width { ctx.fillEllipse(in: CGRect(x: x - 0.75, y: y - 0.75, width: 1.5, height: 1.5)); x += 24 }
            y += 24
        }
    }
}

/// The scene's background over the whole preview area, so the page never shows through the
/// translucent native bars above and below the scene.
final class ThreeDBackdrop: NSView {
    override init(frame: NSRect) { super.init(frame: frame); wantsLayer = true }
    required init?(coder: NSCoder) { fatalError() }
    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() { layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor }
}

/// The exploded view itself (LKM-227): one Core Animation plane per captured surface inside a
/// CATransformLayer, with perspective on the stage's `sublayerTransform`. It covers the preview
/// area between the native bars; the WKWebView stays mounted underneath for identity and capture.
/// The camera and layer spacing live here; selection goes back through the preview.
final class ThreeDSceneView: NSView {
    static let perspective = 1600.0
    var onSelect: ((Int) -> Void)?
    private let canvas = NSView()
    private let grid = ThreeDGridLayer()
    private let stage = CALayer()
    private let world = CATransformLayer()
    private(set) var planes: [CALayer] = []
    private(set) var layers: [ThreeDLayer] = []
    private var extent = CGSize(width: 1, height: 1)
    private var maxDepth = 0
    private(set) var pitch = 48.0, yaw = -28.0, zoom = 1.0, pan = CGPoint.zero
    private(set) var separation = 36.0
    private(set) var selected = -1, hovered = -1
    private(set) var message = ""
    var sideInsets = (left: 0.0, right: 0.0) { didSet { if sideInsets != oldValue { apply(animated: false) } } }
    let hoverLabel = NSTextField(labelWithString: "")
    let messageLabel = NSTextField(wrappingLabelWithString: "")
    private var colors = (outline: CGColor(gray: 0.6, alpha: 1), accent: CGColor(gray: 0.3, alpha: 1))
    private var dragStart: NSPoint?
    private var dragged = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        canvas.wantsLayer = true
        canvas.layer?.addSublayer(grid)
        canvas.layer?.addSublayer(stage)
        stage.addSublayer(world)
        var perspective = CATransform3DIdentity
        perspective.m34 = -1 / Self.perspective
        stage.sublayerTransform = perspective
        addSubview(canvas)
        hoverLabel.font = .systemFont(ofSize: NSFont.smallSystemFontSize, weight: .medium)
        hoverLabel.drawsBackground = true; hoverLabel.isBordered = false
        hoverLabel.wantsLayer = true; hoverLabel.layer?.cornerRadius = 4; hoverLabel.layer?.masksToBounds = true
        hoverLabel.isHidden = true
        addSubview(hoverLabel)
        messageLabel.alignment = .center
        messageLabel.font = .systemFont(ofSize: NSFont.systemFontSize)
        messageLabel.textColor = .secondaryLabelColor
        messageLabel.isHidden = true
        addSubview(messageLabel)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("3D component layers. Drag to orbit, Shift-drag or two fingers to pan, pinch or scroll to zoom.")
        updateColors()
    }
    required init?(coder: NSCoder) { fatalError() }

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { frame.contains(point) && !isHidden ? self : nil }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); updateColors() }
    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        grid.contentsScale = window?.backingScaleFactor ?? 2; grid.setNeedsDisplay()
    }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
    }
    override func layout() {
        super.layout()
        canvas.frame = bounds
        CATransaction.begin(); CATransaction.setDisableActions(true)
        grid.frame = canvas.bounds; stage.frame = canvas.bounds
        CATransaction.commit()
        let width = min(bounds.width - 40, 420)
        let size = messageLabel.sizeThatFits(NSSize(width: width, height: .greatestFiniteMagnitude))
        messageLabel.frame = NSRect(x: (bounds.width - width) / 2, y: (bounds.height - size.height) / 2, width: width, height: size.height)
        apply(animated: false)
    }

    /// Semantic colors resolved under the view's effective appearance (light/dark).
    func updateColors() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
            grid.dot = NSColor.quaternaryLabelColor.cgColor
            colors = (NSColor.tertiaryLabelColor.cgColor, NSColor.controlAccentColor.cgColor)
            hoverLabel.backgroundColor = .controlBackgroundColor
            hoverLabel.textColor = .labelColor
            hoverLabel.layer?.borderColor = NSColor.separatorColor.cgColor; hoverLabel.layer?.borderWidth = 1
        }
        apply(animated: false)
    }
    var backgroundHex: String {
        var hex = ""
        effectiveAppearance.performAsCurrentDrawingAppearance { hex = NSColor.windowBackgroundColor.hexString }
        return hex
    }

    /// Replaces the planes with a new capture. `images[i]` is layer `i`'s matted surface.
    func show(_ next: [ThreeDLayer], images: [CGImage?], width: Double, height: Double) {
        CATransaction.begin(); CATransaction.setDisableActions(true)
        planes.forEach { $0.removeFromSuperlayer() }
        layers = next
        extent = CGSize(width: max(1, width), height: max(1, height))
        maxDepth = next.map(\.depth).max() ?? 0
        planes = next.enumerated().map { index, item in
            let plane = CALayer()
            plane.bounds = CGRect(x: 0, y: 0, width: max(1, item.width), height: max(1, item.height))
            plane.contents = index < images.count ? images[index] : nil
            plane.minificationFilter = .trilinear
            plane.isOpaque = false
            plane.name = String(index)
            world.addSublayer(plane)
            return plane
        }
        if !layers.indices.contains(selected) { selected = -1 }
        if !layers.indices.contains(hovered) { hover(-1, at: nil) }
        CATransaction.commit()
        setMessage(next.isEmpty ? "This component has no visible layers to show in 3D." : "")
        apply(animated: false)
    }
    func clearPlanes(message text: String) {
        CATransaction.begin(); CATransaction.setDisableActions(true)
        planes.forEach { $0.removeFromSuperlayer() }
        planes = []; layers = []; selected = -1
        CATransaction.commit()
        hover(-1, at: nil)
        setMessage(text)
    }
    private func setMessage(_ text: String) {
        message = text
        messageLabel.stringValue = text; messageLabel.isHidden = text.isEmpty
        setAccessibilityValue(text.isEmpty ? "\(layers.count) \(layers.count == 1 ? "layer" : "layers")" : text)
        needsLayout = true
    }

    func select(_ index: Int) {
        selected = layers.indices.contains(index) ? index : -1
        apply(animated: false)
    }
    func setSeparation(_ value: Double) { separation = min(100, max(0, value)); apply(animated: false) }
    /// Front assembles the layers face-on; Reset restores the opening camera. Both animate.
    func front() { pitch = 0; yaw = 0; zoom = 1; pan = .zero; separation = 0; apply(animated: true) }
    func reset(animated: Bool = true) { pitch = 48; yaw = -28; zoom = 1; pan = .zero; separation = 36; apply(animated: animated) }

    private var fit: Double {
        let width = Double(bounds.width) - sideInsets.left - sideInsets.right - 70
        let height = Double(bounds.height) - 70
        let fit = min(width / extent.width, height / (extent.height + Double(maxDepth) * separation), 1.5)
        return max(0.04, fit)
    }
    private var worldTransform: CATransform3D {
        let scale = CGFloat(fit * zoom)
        var t = CATransform3DMakeRotation(CGFloat(yaw * .pi / 180), 0, 1, 0)
        t = CATransform3DConcat(t, CATransform3DMakeRotation(CGFloat(-pitch * .pi / 180), 1, 0, 0))
        t = CATransform3DConcat(t, CATransform3DMakeScale(scale, scale, scale))
        return CATransform3DConcat(t, CATransform3DMakeTranslation(pan.x, pan.y, 0))
    }
    /// Plane centre in world space (y up, origin at the subtree's centre) and its depth offset.
    func planeCenter(_ index: Int) -> (x: Double, y: Double, z: Double) {
        let item = layers[index]
        return (item.x + item.width / 2 - extent.width / 2,
                extent.height / 2 - (item.y + item.height / 2),
                (Double(item.depth) - Double(maxDepth) / 2) * separation + Double(index) * 0.02)
    }
    private var worldOffset: CGFloat { CGFloat(sideInsets.left - sideInsets.right) / 2 }

    func apply(animated: Bool) {
        CATransaction.begin()
        if animated {
            CATransaction.setAnimationDuration(0.35)
            CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .easeInEaseOut))
        } else { CATransaction.setDisableActions(true) }
        world.position = CGPoint(x: stage.bounds.midX + worldOffset, y: stage.bounds.midY)
        world.transform = worldTransform
        let line = CGFloat(1 / (fit * zoom))
        for (index, plane) in planes.enumerated() {
            let c = planeCenter(index)
            plane.position = CGPoint(x: c.x, y: c.y)
            plane.transform = CATransform3DMakeTranslation(0, 0, CGFloat(c.z))
            let marked = index == selected || index == hovered
            plane.borderColor = marked ? colors.accent : colors.outline
            plane.borderWidth = marked ? 2 * line : line
        }
        CATransaction.commit()
    }

    /// Spacing actually applied between adjacent depths, read back from the planes.
    var spacing: Double {
        guard maxDepth > 0 else { return 0 }
        let z = planes.map { Double($0.transform.m43) }
        return ((z.max() ?? 0) - (z.min() ?? 0) - Double(planes.count - 1) * 0.02) / Double(maxDepth)
    }

    private func transformed(_ p: (x: Double, y: Double, z: Double)) -> (x: Double, y: Double, z: Double) {
        let m = worldTransform
        return (p.x * Double(m.m11) + p.y * Double(m.m21) + p.z * Double(m.m31) + Double(m.m41) + Double(worldOffset),
                p.x * Double(m.m12) + p.y * Double(m.m22) + p.z * Double(m.m32) + Double(m.m42),
                p.x * Double(m.m13) + p.y * Double(m.m23) + p.z * Double(m.m33) + Double(m.m43))
    }
    /// Stage point relative to its centre (y up), or nil behind the eye.
    private func project(_ p: (x: Double, y: Double, z: Double)) -> CGPoint? {
        let w = 1 - p.z / Self.perspective
        return w > 0.01 ? CGPoint(x: p.x / w, y: p.y / w) : nil
    }
    /// Where layer `index`'s centre appears, in view coordinates.
    func screenPoint(_ index: Int) -> NSPoint? {
        guard layers.indices.contains(index), let p = project(transformed(planeCenter(index))) else { return nil }
        return NSPoint(x: bounds.midX + p.x, y: isFlipped ? bounds.midY - p.y : bounds.midY + p.y)
    }
    /// Front-most plane under a view point. Core Animation does not hit-test CATransformLayer.
    func layerIndex(at point: NSPoint) -> Int? {
        let local = CGPoint(x: point.x - bounds.midX, y: isFlipped ? bounds.midY - point.y : point.y - bounds.midY)
        // The planes are parallel: along any ray the nearer one has the larger depth offset when
        // they face the viewer (the plane normal's z, m33, is positive) and the smaller from behind.
        let facing = worldTransform.m33 >= 0 ? 1.0 : -1.0
        var best: (index: Int, z: Double)?
        for index in layers.indices {
            let c = planeCenter(index), w = layers[index].width / 2, h = layers[index].height / 2
            let corners = [(-w, -h), (w, -h), (w, h), (-w, h)].compactMap { project(transformed((c.x + $0.0, c.y + $0.1, c.z))) }
            guard corners.count == 4 else { continue }
            var sign = 0.0, inside = true
            for i in 0..<4 {
                let a = corners[i], b = corners[(i + 1) % 4]
                let cross = Double((b.x - a.x) * (local.y - a.y) - (b.y - a.y) * (local.x - a.x))
                if cross == 0 { continue }
                if sign == 0 { sign = cross } else if (cross > 0) != (sign > 0) { inside = false; break }
            }
            let z = c.z * facing
            if inside, sign != 0, best == nil || z > best!.z { best = (index, z) }
        }
        return best?.index
    }

    private func hover(_ index: Int, at point: NSPoint?) {
        let next = layers.indices.contains(index) ? index : -1
        if next != hovered { hovered = next; apply(animated: false) }
        guard next >= 0, let point else { hoverLabel.isHidden = true; return }
        hoverLabel.stringValue = " \(layers[next].label) "
        hoverLabel.sizeToFit()
        let size = hoverLabel.frame.size
        let x = min(max(4, point.x + 12), bounds.width - size.width - 4)
        let y = isFlipped ? min(max(4, point.y + 16), bounds.height - size.height - 4) : max(4, min(point.y - 16 - size.height, bounds.height - size.height - 4))
        hoverLabel.frame = NSRect(x: x, y: y, width: size.width, height: size.height)
        hoverLabel.isHidden = false
    }
    /// Hover by layer index (inspection and tests); nil clears.
    func hoverLayer(_ index: Int?) { hover(index ?? -1, at: index.flatMap(screenPoint)) }
    var hoverText: String { hoverLabel.isHidden ? "" : hoverLabel.stringValue.trimmingCharacters(in: .whitespaces) }

    /// A click without a drag selects the front-most layer under the pointer.
    @discardableResult func click(at point: NSPoint) -> Int? {
        guard let index = layerIndex(at: point) else { return nil }
        onSelect?(index)
        return index
    }

    override func mouseMoved(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        hover(layerIndex(at: point) ?? -1, at: point)
    }
    override func mouseExited(with event: NSEvent) { hover(-1, at: nil) }
    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        dragStart = event.locationInWindow; dragged = false
    }
    override func mouseDragged(with event: NSEvent) {
        guard let start = dragStart else { return }
        let now = event.locationInWindow
        let dx = Double(now.x - start.x), dy = Double(now.y - start.y)
        if !dragged && abs(dx) + abs(dy) < 4 { return }
        dragged = true; dragStart = now
        if event.modifierFlags.contains(.shift) { pan.x += dx; pan.y += dy }
        else { yaw += dx * 0.4; pitch = min(80, max(-80, pitch + dy * 0.4)) }
        hover(-1, at: nil)
        apply(animated: false)
    }
    override func mouseUp(with event: NSEvent) {
        defer { dragStart = nil }
        if dragStart != nil && !dragged { click(at: convert(event.locationInWindow, from: nil)) }
    }
    /// Two-finger trackpad scrolls pan; a mouse wheel (or ⌘-scroll) zooms.
    override func scrollWheel(with event: NSEvent) {
        if event.hasPreciseScrollingDeltas && !event.modifierFlags.contains(.command) {
            pan.x += Double(event.scrollingDeltaX); pan.y -= Double(event.scrollingDeltaY)
        } else {
            let delta = Double(event.hasPreciseScrollingDeltas ? event.scrollingDeltaY * 0.1 : event.scrollingDeltaY)
            zoom = min(4, max(0.2, zoom * exp(delta * 0.05)))
        }
        apply(animated: false)
    }
    override func magnify(with event: NSEvent) {
        zoom = min(4, max(0.2, zoom * (1 + Double(event.magnification))))
        apply(animated: false)
    }
    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 123: yaw -= 5
        case 124: yaw += 5
        case 126: pitch = max(-80, pitch - 5)
        case 125: pitch = min(80, pitch + 5)
        default:
            switch event.charactersIgnoringModifiers {
            case "+", "=": zoom = min(4, zoom * 1.1)
            case "-": zoom = max(0.2, zoom / 1.1)
            default: super.keyDown(with: event); return
            }
        }
        apply(animated: false)
    }
}
