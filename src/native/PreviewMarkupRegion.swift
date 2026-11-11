import AppKit

/// LKM-646: the Select region tool's rectangle, in the frozen snapshot's captured pixels
/// (top-left origin, whole pixels, always inside the image). Add sends exactly this part of the
/// snapshot instead of the whole image. It is never a mark: it is not in the marks' Undo/Clear
/// history and it is never drawn into the composite. Its guides exist only on screen
/// (`MarkupRegionChrome`).
struct MarkupRegion {
    /// Smaller than this on either side, in captured pixels, is a click, not a region.
    static let minimum: CGFloat = 4
    enum Edge { case none, low, high }
    private enum Drag {
        case create(CGPoint)
        case move(CGRect, CGPoint)
        case resize(CGRect, Edge, Edge)
    }
    let size: CGSize
    private(set) var rect: CGRect?
    private var drag: Drag?

    init(size: CGSize) { self.size = size }
    var isDragging: Bool { drag != nil }
    /// What Add crops to: a finished region at least `minimum` a side, or nil.
    var valid: CGRect? {
        guard drag == nil, let rect, rect.width >= Self.minimum, rect.height >= Self.minimum else { return nil }
        return rect
    }
    private func clamped(_ point: CGPoint) -> CGPoint {
        let x = point.x.isFinite ? point.x.rounded() : 0, y = point.y.isFinite ? point.y.rounded() : 0
        return CGPoint(x: min(size.width, max(0, x)), y: min(size.height, max(0, y)))
    }
    private static func box(_ a: CGPoint, _ b: CGPoint) -> CGRect {
        CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y))
    }
    /// The eight handles, corners and edge midpoints, each with the edges it moves.
    static func handles(of rect: CGRect) -> [(point: CGPoint, x: Edge, y: Edge)] {
        [(CGPoint(x: rect.minX, y: rect.minY), .low, .low), (CGPoint(x: rect.midX, y: rect.minY), .none, .low),
         (CGPoint(x: rect.maxX, y: rect.minY), .high, .low), (CGPoint(x: rect.maxX, y: rect.midY), .high, .none),
         (CGPoint(x: rect.maxX, y: rect.maxY), .high, .high), (CGPoint(x: rect.midX, y: rect.maxY), .none, .high),
         (CGPoint(x: rect.minX, y: rect.maxY), .low, .high), (CGPoint(x: rect.minX, y: rect.midY), .low, .none)]
    }
    /// The handle within `tolerance` captured pixels of `point`, corners first.
    func handle(at point: CGPoint, tolerance: CGFloat) -> (x: Edge, y: Edge)? {
        guard let rect else { return nil }
        let near = Self.handles(of: rect).filter { abs($0.point.x - point.x) <= tolerance && abs($0.point.y - point.y) <= tolerance }
        return (near.first { $0.x != .none && $0.y != .none } ?? near.first).map { ($0.x, $0.y) }
    }
    /// A press: on a handle it resizes, inside the region it moves it, anywhere else it starts a
    /// new region (and a click there clears the old one, as in other macOS selections).
    mutating func begin(at point: CGPoint, tolerance: CGFloat = 0) {
        let start = clamped(point)
        if let rect, let edges = handle(at: point, tolerance: tolerance) { drag = .resize(rect, edges.x, edges.y) }
        else if let rect, rect.contains(point) { drag = .move(rect, start) }
        else { drag = .create(start); rect = CGRect(origin: start, size: .zero) }
    }
    /// Either direction: the rectangle is always the box between the anchor and the pointer.
    mutating func extend(to point: CGPoint) {
        guard let drag else { return }
        let to = clamped(point)
        switch drag {
        case .create(let anchor): rect = Self.box(anchor, to)
        case .move(let start, let from):
            let x = min(max(0, start.minX + to.x - from.x), size.width - start.width)
            let y = min(max(0, start.minY + to.y - from.y), size.height - start.height)
            rect = CGRect(x: x, y: y, width: start.width, height: start.height)
        case .resize(let start, let edgeX, let edgeY):
            var a = CGPoint(x: start.minX, y: start.minY), b = CGPoint(x: start.maxX, y: start.maxY)
            switch edgeX { case .low: a.x = to.x; case .high: b.x = to.x; case .none: break }
            switch edgeY { case .low: a.y = to.y; case .high: b.y = to.y; case .none: break }
            rect = Self.box(a, b)
        }
    }
    /// A new region too small to send is no region; a resize too small keeps the one it started from.
    mutating func finish() {
        guard let drag else { return }
        self.drag = nil
        guard let rect, rect.width < Self.minimum || rect.height < Self.minimum else { return }
        if case .resize(let start, _, _) = drag { self.rect = start } else { self.rect = nil }
    }
    /// Escape, or a press that ends nothing: the region goes, nothing else.
    @discardableResult mutating func clear() -> Bool {
        let had = rect != nil || drag != nil
        rect = nil; drag = nil
        return had
    }
}

/// The region's on-screen guides: restrained dimming outside it, a thin outline and, while the
/// tool is active, its handles. Drawn by the canvas after the marks; never by the composite.
enum MarkupRegionChrome {
    static let handleSize: CGFloat = 8
    /// How close, in view points, a press must be to grab a handle.
    static let grab: CGFloat = 7

    static func viewRect(_ rect: CGRect, _ mapping: MarkupMapping) -> CGRect {
        CGRect(origin: mapping.toView(rect.origin), size: CGSize(width: rect.width * mapping.scale, height: rect.height * mapping.scale))
    }
    static func draw(_ rect: CGRect, mapping: MarkupMapping, handles: Bool, in context: CGContext) {
        let shown = viewRect(rect, mapping)
        context.saveGState(); defer { context.restoreGState() }
        context.setFillColor(CGColor(gray: 0, alpha: 0.38))
        context.addRect(mapping.frame); context.addRect(shown)
        context.fillPath(using: .evenOdd)
        // Just outside the region, so the outline never covers a pixel that will be sent.
        let outline = shown.insetBy(dx: -0.5, dy: -0.5)
        context.setStrokeColor(CGColor(gray: 0, alpha: 0.45)); context.setLineWidth(2.5); context.stroke(outline.insetBy(dx: -0.5, dy: -0.5))
        context.setStrokeColor(CGColor(gray: 1, alpha: 1)); context.setLineWidth(1); context.stroke(outline)
        guard handles else { return }
        for handle in MarkupRegion.handles(of: rect) {
            let center = mapping.toView(handle.point)
            let square = CGRect(x: center.x - handleSize / 2, y: center.y - handleSize / 2, width: handleSize, height: handleSize)
            context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fillEllipse(in: square)
            context.setStrokeColor(CGColor(gray: 0, alpha: 0.55)); context.setLineWidth(1); context.strokeEllipse(in: square.insetBy(dx: 0.5, dy: 0.5))
        }
    }
    /// The pointer over the canvas while Select region is the tool: resize on a handle, a hand
    /// inside the region, a crosshair elsewhere on the snapshot.
    static func cursor(at point: CGPoint, region: MarkupRegion, mapping: MarkupMapping) -> NSCursor {
        let image = mapping.toImage(point), tolerance = mapping.scale > 0 ? grab / mapping.scale : grab
        if let edges = region.handle(at: image, tolerance: tolerance) { return resize(edges.x, edges.y) }
        if let rect = region.rect, rect.contains(image) { return .openHand }
        return .crosshair
    }
    private static func resize(_ x: MarkupRegion.Edge, _ y: MarkupRegion.Edge) -> NSCursor {
        if #available(macOS 15.0, *) {
            let position: NSCursor.FrameResizePosition
            switch (x, y) {
            case (.low, .low): position = .topLeft
            case (.high, .low): position = .topRight
            case (.low, .high): position = .bottomLeft
            case (.high, .high): position = .bottomRight
            case (.low, _): position = .left
            case (.high, _): position = .right
            case (_, .low): position = .top
            default: position = .bottom
            }
            return .frameResize(position: position, directions: .all)
        }
        if y == .none { return .resizeLeftRight }
        if x == .none { return .resizeUpDown }
        return .crosshair
    }
}

/// The smoke's reading of an attachment the composer holds: its size, how many pixels are near
/// `ink`, and how many are neither that nor near `expect` (a selection outline, the dimming or
/// neighbouring content would be), plus the colours at its corners and centre.
enum MarkupImageStats {
    static func measure(_ data: Data, expect: String?, ink: String?, tolerance: Double) -> [String: Any] {
        guard let image = NSBitmapImageRep(data: data)?.cgImage, image.width > 0, image.height > 0,
              let space = CGColorSpace(name: CGColorSpace.sRGB) else { return ["error":"Image unreadable"] }
        // Drawn into an sRGB bitmap, the way the composite was made: no colour-space guesswork.
        let width = image.width, height = image.height
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        bytes.withUnsafeMutableBytes { raw in
            CGContext(data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space,
                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)?.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        let expected = expect.flatMap { MarkupInk(hex: $0) }, inked = ink.flatMap { MarkupInk(hex: $0) }
        func color(_ x: Int, _ y: Int) -> MarkupInk {
            let i = (y * width + x) * 4
            return MarkupInk(red: Double(bytes[i]) / 255, green: Double(bytes[i + 1]) / 255, blue: Double(bytes[i + 2]) / 255)
        }
        func near(_ a: MarkupInk, _ b: MarkupInk) -> Bool {
            abs(a.red - b.red) <= tolerance && abs(a.green - b.green) <= tolerance && abs(a.blue - b.blue) <= tolerance
        }
        var other = 0, inkPixels = 0
        for y in 0..<height {
            for x in 0..<width {
                let pixel = color(x, y)
                if let inked, near(pixel, inked) { inkPixels += 1 } else if let expected, !near(pixel, expected) { other += 1 }
            }
        }
        let w = width - 1, h = height - 1
        return ["width":width, "height":height, "other":other, "ink":inkPixels,
                "corners":[(0, 0), (w, 0), (0, h), (w, h)].map { color($0.0, $0.1).hex }, "center":color(w / 2, h / 2).hex]
    }
}
