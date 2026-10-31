import AppKit
import CryptoKit

/// LKM-391: what Mark up draws. No view or host here: a mark is stored in the captured
/// image's pixels, top-left origin, so it stays on the same page pixel through Retina, preview
/// zoom, responsive width and overlay resizes, and one renderer paints the canvas and the
/// composite, so the two agree by construction.
enum MarkupTool: String, CaseIterable {
    case pen, rectangle, circle, arrow
    var label: String { rawValue.capitalized }
    /// The plain key that picks it.
    var key: String { String(rawValue.prefix(1)) }
    var symbol: String {
        switch self {
        case .pen: "pencil"
        case .rectangle: "rectangle"
        case .circle: "circle"
        case .arrow: "arrow.up.right"
        }
    }
}

struct MarkupMark: Equatable {
    var tool: MarkupTool
    var points: [CGPoint]
}

/// The marks on one snapshot. Clear is one undo step, so ⌘Z brings back what it removed.
struct MarkupDocument {
    /// A shape smaller than this, in captured pixels, is a click, not a shape.
    static let minimumShape: CGFloat = 3
    let size: CGSize
    private(set) var marks: [MarkupMark] = []
    private var history: [[MarkupMark]] = []
    private var stroke: MarkupMark?

    init(size: CGSize) { self.size = size }
    var isDrawing: Bool { stroke != nil }
    var canUndo: Bool { isDrawing || !history.isEmpty }
    /// The finished marks and the stroke in progress.
    var visible: [MarkupMark] { marks + (stroke.map { [$0] } ?? []) }
    private func clamped(_ point: CGPoint) -> CGPoint {
        CGPoint(x: min(size.width, max(0, point.x)), y: min(size.height, max(0, point.y)))
    }
    mutating func begin(_ tool: MarkupTool, at point: CGPoint) {
        stroke = MarkupMark(tool: tool, points: [clamped(point)])
    }
    mutating func extend(to point: CGPoint) {
        guard var mark = stroke else { return }
        if mark.tool == .pen { mark.points.append(clamped(point)) } else { mark.points = [mark.points[0], clamped(point)] }
        stroke = mark
    }
    mutating func finish() {
        guard let mark = stroke else { return }
        stroke = nil
        if mark.tool != .pen {
            guard mark.points.count == 2, hypot(mark.points[1].x - mark.points[0].x, mark.points[1].y - mark.points[0].y) >= Self.minimumShape else { return }
        }
        history.append(marks); marks.append(mark)
    }
    mutating func undo() {
        if stroke != nil { stroke = nil; return }
        if let previous = history.popLast() { marks = previous }
    }
    mutating func clear() {
        stroke = nil
        guard !marks.isEmpty else { return }
        history.append(marks); marks = []
    }
}

/// The snapshot, aspect-fitted and centered in a view with a top-left origin.
struct MarkupMapping {
    let image: CGSize
    let frame: CGRect
    var scale: CGFloat { image.width > 0 ? frame.width / image.width : 1 }
    init(image: CGSize, bounds: CGRect) {
        self.image = image
        let scale = image.width > 0 && image.height > 0 ? min(bounds.width / image.width, bounds.height / image.height) : 1
        let size = CGSize(width: image.width * scale, height: image.height * scale)
        frame = CGRect(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2, width: size.width, height: size.height)
    }
    func toView(_ point: CGPoint) -> CGPoint { CGPoint(x: frame.minX + point.x * scale, y: frame.minY + point.y * scale) }
    func toImage(_ point: CGPoint) -> CGPoint {
        scale > 0 ? CGPoint(x: (point.x - frame.minX) / scale, y: (point.y - frame.minY) / scale) : point
    }
}

enum MarkupRenderer {
    private static let ink = CGColor(srgbRed: 0.87, green: 0.1, blue: 0.1, alpha: 1)
    private static let halo = CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.9)
    /// In captured pixels: heavy enough to survive the send size and the provider's own scaling.
    static func lineWidth(for size: CGSize) -> CGFloat { max(4, max(size.width, size.height) * 0.003) }

    private static func path(_ mark: MarkupMark, width: CGFloat) -> CGPath {
        let path = CGMutablePath(), points = mark.points
        guard let first = points.first, let last = points.last else { return path }
        let box = CGRect(x: min(first.x, last.x), y: min(first.y, last.y), width: abs(last.x - first.x), height: abs(last.y - first.y))
        switch mark.tool {
        case .pen:
            path.addLines(between: points.count == 1 ? [first, first] : points)
        case .rectangle:
            path.addRect(box)
        case .circle:
            path.addEllipse(in: box)
        case .arrow:
            path.addLines(between: [first, last])
            let angle = atan2(last.y - first.y, last.x - first.x), head = width * 4.5
            for side in [CGFloat.pi * 0.82, -CGFloat.pi * 0.82] {
                path.move(to: last)
                path.addLine(to: CGPoint(x: last.x + cos(angle + side) * head, y: last.y + sin(angle + side) * head))
            }
        }
        return path
    }
    /// `context` has a top-left origin and captured-pixel units. A white halo keeps the ink
    /// readable on any page. `minimumWidth` keeps a mark visible on a small canvas.
    static func draw(_ marks: [MarkupMark], in context: CGContext, size: CGSize, minimumWidth: CGFloat = 0) {
        let width = max(lineWidth(for: size), minimumWidth)
        context.saveGState(); defer { context.restoreGState() }
        context.setLineCap(.round); context.setLineJoin(.round)
        for (color, stroke) in [(halo, width * 1.8), (ink, width)] {
            context.setStrokeColor(color); context.setLineWidth(stroke)
            for mark in marks { context.addPath(path(mark, width: width)); context.strokePath() }
        }
    }
    /// The snapshot scaled to at most `maxPixels` with the marks drawn at that scale, not over
    /// a scaled bitmap of them, so they stay crisp.
    static func composite(_ image: CGImage, marks: [MarkupMark], maxPixels: CGFloat) -> CGImage? {
        let captured = CGSize(width: image.width, height: image.height), longest = max(captured.width, captured.height)
        let scale = min(1, maxPixels / max(longest, 1))
        let width = max(1, Int((captured.width * scale).rounded())), height = max(1, Int((captured.height * scale).rounded()))
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        context.translateBy(x: 0, y: CGFloat(height)); context.scaleBy(x: scale, y: -scale)
        draw(marks, in: context, size: captured)
        return context.makeImage()
    }
}

struct MarkupEncoded {
    let data: Data, type: String, name: String, width: Int, height: Int
}

/// Fingerprint of an image's pixels, for the smoke's proof that the frozen snapshot did not
/// change under the overlay. SHA-256 over every pixel (RGBA8, sRGB), so one changed pixel
/// changes it; the size is part of the input.
enum MarkupDigest {
    static func hex(_ image: CGImage) -> String {
        let width = image.width, height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        pixels.withUnsafeMutableBytes { raw in
            guard let context = CGContext(data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                          space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        var hash = SHA256()
        hash.update(data: Data("\(width)x\(height):".utf8))
        hash.update(data: pixels)
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

/// PNG at 2048 px first, not the agent frame's 1280 px JPEG: the choice and its measurements
/// are in docs/PROGRESS.md (LKM-391). A page PNG cannot hold falls back to JPEG, then to
/// smaller sizes; past the last step the Add fails out loud.
enum MarkupEncoder {
    /// Raw bytes, so one image's base64 stays under the strictest provider's 5 MB per image,
    /// well inside `LIMITS.imageBase64`.
    static let budget = 3_600_000
    private enum Format { case png, jpeg(Double) }
    private static let steps: [(CGFloat, Format)] = [(2048, .png), (2048, .jpeg(0.9)), (1536, .jpeg(0.85)), (1024, .jpeg(0.8)), (768, .jpeg(0.8))]

    static func encode(_ image: CGImage, marks: [MarkupMark], budget: Int = budget) -> MarkupEncoded? {
        for (maxPixels, format) in steps {
            guard let frame = MarkupRenderer.composite(image, marks: marks, maxPixels: maxPixels) else { return nil }
            let rep = NSBitmapImageRep(cgImage: frame)
            switch format {
            case .png:
                if let data = rep.representation(using: .png, properties: [:]), data.count <= budget {
                    return MarkupEncoded(data: data, type: "image/png", name: "Mark up.png", width: frame.width, height: frame.height)
                }
            case .jpeg(let quality):
                if let data = rep.representation(using: .jpeg, properties: [.compressionFactor: quality]), data.count <= budget {
                    return MarkupEncoded(data: data, type: "image/jpeg", name: "Mark up.jpg", width: frame.width, height: frame.height)
                }
            }
        }
        return nil
    }
}

/// Run in the isolated preview world around the snapshot. The page's own world never sees
/// the restore function; a capture that dies restores by timer.
enum PreviewMarkupScript {
    /// Every element the preview instrumentation appends to the document. Pins, the toolbar,
    /// the selection and hover boxes live in `data-trezi-overlay`'s shadow root.
    static let selectors = ["[data-trezi-overlay]", "[data-trezi-status]", "[data-trezi-cover]", "[data-trezi-frame]", "[data-trezi-viewport-size]", "[data-trezi-drop-line]"]
    static let hide = """
    globalThis.__treziMarkupRestore?.();
    const hidden = Array.from(document.querySelectorAll('\(selectors.joined(separator: ","))')).map((element) => {
      const { style } = element, value = style.getPropertyValue('display'), priority = style.getPropertyPriority('display');
      style.setProperty('display', 'none', 'important');
      return [style, value, priority];
    });
    const restore = () => {
      clearTimeout(timer);
      globalThis.__treziMarkupRestore = null;
      for (const [style, value, priority] of hidden) value ? style.setProperty('display', value, priority) : style.removeProperty('display');
    };
    const timer = setTimeout(restore, 3000);
    globalThis.__treziMarkupRestore = restore;
    await new Promise((done) => {
      let frames = 2;
      const step = () => (--frames ? requestAnimationFrame(step) : done());
      requestAnimationFrame(step);
      setTimeout(done, 120);
    });
    return JSON.stringify({ width: innerWidth, height: innerHeight, scrollX, scrollY });
    """
    static let restore = "globalThis.__treziMarkupRestore?.(); return true;"
}
