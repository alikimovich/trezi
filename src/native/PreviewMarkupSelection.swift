import AppKit

/// LKM-647: one drawn mark picked with the Select tool, so its colour and stroke can change,
/// it can move, and a rectangle, circle or arrow can be resized from its handles. Editor
/// decoration only: the outline and handles are drawn by the canvas after the marks and never
/// by the composite, and they are no crop (that is `MarkupRegion`). Pen strokes and text move;
/// they show an outline and no handles, so nothing on screen offers what does nothing.
enum MarkupSelection {
    static let handleSize: CGFloat = 9
    /// How close, in view points, a press must be to grab a mark or a handle.
    static let grab: CGFloat = 6
    enum Handle: Equatable {
        /// A box handle of a rectangle or circle, with the edges it moves.
        case box(MarkupRegion.Edge, MarkupRegion.Edge)
        /// An arrow's tail (0) or head (1).
        case end(Int)
    }

    /// The box a rectangle or circle is drawn in, captured pixels.
    static func box(_ mark: MarkupMark) -> CGRect {
        guard let first = mark.points.first, let last = mark.points.last else { return .null }
        return CGRect(x: min(first.x, last.x), y: min(first.y, last.y), width: abs(last.x - first.x), height: abs(last.y - first.y))
    }
    /// What the outline surrounds: the painted ink, captured pixels.
    static func bounds(_ mark: MarkupMark, size: CGSize) -> CGRect {
        if mark.tool == .text { return MarkupRenderer.textBounds(mark) }
        let width = MarkupRenderer.width(of: mark, size: size)
        return MarkupRenderer.outline(mark, size: size).boundingBoxOfPath.insetBy(dx: -width / 2, dy: -width / 2)
    }
    static func handles(_ mark: MarkupMark) -> [(point: CGPoint, handle: Handle)] {
        switch mark.tool {
        case .rectangle, .circle:
            return MarkupRegion.handles(of: box(mark)).map { ($0.point, .box($0.x, $0.y)) }
        case .arrow:
            guard let first = mark.points.first, let last = mark.points.last, mark.points.count == 2 else { return [] }
            return [(first, .end(0)), (last, .end(1))]
        default: return []
        }
    }
    /// The handle within `tolerance` captured pixels of `point`, corners and ends first.
    static func handle(of mark: MarkupMark, at point: CGPoint, tolerance: CGFloat) -> Handle? {
        let near = handles(mark).filter { abs($0.point.x - point.x) <= tolerance && abs($0.point.y - point.y) <= tolerance }
        return (near.first { if case .box(let x, let y) = $0.handle { x != .none && y != .none } else { true } } ?? near.first)?.handle
    }
    /// The topmost mark whose ink is within `tolerance` of `point`: the stroke of an unfilled
    /// shape, not its inside, so a press inside a rectangle still reaches the snapshot.
    static func hit(_ marks: [MarkupMark], at point: CGPoint, tolerance: CGFloat, size: CGSize) -> Int? {
        marks.indices.reversed().first { index in
            let mark = marks[index]
            if mark.tool == .text { return MarkupRenderer.textBounds(mark).insetBy(dx: -tolerance, dy: -tolerance).contains(point) }
            let width = MarkupRenderer.width(of: mark, size: size)
            return MarkupRenderer.outline(mark, size: size)
                .copy(strokingWithWidth: width + tolerance * 2, lineCap: .round, lineJoin: .round, miterLimit: 10)
                .contains(point)
        }
    }
    /// The points of `mark` (as it was when the drag began) after a drag from `from` to `to`:
    /// the whole mark without a handle, kept inside the snapshot; one handle's edges or end
    /// otherwise. A resize too small to be a shape keeps the mark as it was.
    static func dragged(_ mark: MarkupMark, handle: Handle?, from: CGPoint, to: CGPoint, size: CGSize) -> [CGPoint] {
        guard let handle else {
            let xs = mark.points.map(\.x), ys = mark.points.map(\.y)
            guard let minX = xs.min(), let maxX = xs.max(), let minY = ys.min(), let maxY = ys.max() else { return mark.points }
            let dx = min(max(to.x - from.x, -minX), size.width - maxX), dy = min(max(to.y - from.y, -minY), size.height - maxY)
            return mark.points.map { CGPoint(x: $0.x + dx, y: $0.y + dy) }
        }
        var points: [CGPoint]
        switch handle {
        case .end(let end):
            points = mark.points
            points[end == 0 ? 0 : points.count - 1] = to
        case .box(let edgeX, let edgeY):
            let start = box(mark)
            var a = CGPoint(x: start.minX, y: start.minY), b = CGPoint(x: start.maxX, y: start.maxY)
            switch edgeX { case .low: a.x = to.x; case .high: b.x = to.x; case .none: break }
            switch edgeY { case .low: a.y = to.y; case .high: b.y = to.y; case .none: break }
            points = [CGPoint(x: min(a.x, b.x), y: min(a.y, b.y)), CGPoint(x: max(a.x, b.x), y: max(a.y, b.y))]
        }
        guard let first = points.first, let last = points.last,
              hypot(last.x - first.x, last.y - first.y) >= MarkupDocument.minimumShape else { return mark.points }
        return points
    }
    /// The pointer over a selected mark: resize on a box handle, a crosshair on an arrow's end,
    /// a hand on the mark. Nil off it.
    static func cursor(at point: CGPoint, selected: MarkupMark?, marks: [MarkupMark], mapping: MarkupMapping) -> NSCursor? {
        let image = mapping.toImage(point), tolerance = mapping.scale > 0 ? grab / mapping.scale : grab
        if let selected, let handle = handle(of: selected, at: image, tolerance: tolerance) {
            if case .box(let x, let y) = handle { return MarkupRegionChrome.resize(x, y) }
            return .crosshair
        }
        return hit(marks, at: image, tolerance: tolerance, size: mapping.image) != nil ? .openHand : nil
    }
    /// The accent outline around the selected mark and its handles, in view points.
    static func draw(_ mark: MarkupMark, mapping: MarkupMapping, in context: CGContext) {
        let shown = MarkupRegionChrome.viewRect(bounds(mark, size: mapping.image), mapping).insetBy(dx: -3, dy: -3)
        let accent = NSColor.controlAccentColor.usingColorSpace(.sRGB)?.cgColor ?? CGColor(srgbRed: 0.04, green: 0.52, blue: 1, alpha: 1)
        context.saveGState(); defer { context.restoreGState() }
        context.setStrokeColor(accent); context.setLineWidth(1)
        if handles(mark).isEmpty { context.setLineDash(phase: 0, lengths: [4, 3]) }
        context.stroke(shown.insetBy(dx: 0.5, dy: 0.5))
        context.setLineDash(phase: 0, lengths: [])
        for handle in handles(mark) {
            let center = mapping.toView(handle.point)
            let dot = CGRect(x: center.x - handleSize / 2, y: center.y - handleSize / 2, width: handleSize, height: handleSize)
            context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fillEllipse(in: dot)
            context.setFillColor(accent); context.fillEllipse(in: dot.insetBy(dx: 1.5, dy: 1.5))
        }
    }
}
