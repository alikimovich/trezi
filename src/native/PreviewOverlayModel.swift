import CoreGraphics
import Foundation

/// Rulers, guides and layout grids over the preview (LKM-205): the settings and the pure
/// math, all in page CSS pixels. The view converts with the page scale and scroll; nothing
/// here touches AppKit, so `test/preview-overlay.mjs` checks it without a window.
struct OverlayGuide: Equatable {
    /// "x" is a vertical guide at a CSS x, "y" a horizontal guide at a CSS y.
    var id: String, axis: String, position: Double
}

struct OverlayGrid: Equatable {
    /// "columns", "rows" (a baseline grid) or "square".
    var kind = "columns"
    var visible = true
    var count = 12
    /// A fixed column width, or nil to stretch the columns across the viewport.
    var width: Double?
    var gutter = 24.0, margin = 0.0
    /// "left", "center" or "stretch"; centred columns ignore the margin.
    var align = "stretch"
    var step = 8.0, offset = 0.0, size = 8.0
    var color = "#ff3b30", opacity = 0.12
}

struct OverlayState: Equatable {
    var rulers = false, gridVisible = false, locked = false, fixed = false
    var guides: [OverlayGuide] = []
    var grids: [OverlayGrid] = []
    static let maxGuides = 200, maxGrids = 8

    init() {}
    /// Settings come from preferences, which a user could edit: every field is clamped.
    init(json: [String: Any]) {
        rulers = json["rulers"] as? Bool ?? false
        gridVisible = json["gridVisible"] as? Bool ?? false
        locked = json["locked"] as? Bool ?? false
        fixed = json["fixed"] as? Bool ?? false
        guides = (json["guides"] as? [[String: Any]] ?? []).prefix(Self.maxGuides).enumerated().compactMap { index, raw in
            guard let axis = raw["axis"] as? String, axis == "x" || axis == "y", let position = OverlayMath.finite(raw["position"]) else { return nil }
            return OverlayGuide(id: (raw["id"] as? String).flatMap { $0.isEmpty || $0.count > 40 ? nil : $0 } ?? "g\(index)", axis: axis, position: OverlayMath.clamp(position, -100_000, 100_000))
        }
        grids = (json["grids"] as? [[String: Any]] ?? []).prefix(Self.maxGrids).compactMap { raw in
            guard let kind = raw["kind"] as? String, ["columns", "rows", "square"].contains(kind) else { return nil }
            var grid = OverlayGrid(kind: kind)
            grid.visible = raw["visible"] as? Bool ?? true
            grid.count = Int(OverlayMath.clamp(OverlayMath.finite(raw["count"]) ?? 12, 1, 48))
            grid.width = OverlayMath.finite(raw["width"]).map { OverlayMath.clamp($0, 1, 4000) }
            grid.gutter = OverlayMath.clamp(OverlayMath.finite(raw["gutter"]) ?? 24, 0, 1000)
            grid.margin = OverlayMath.clamp(OverlayMath.finite(raw["margin"]) ?? 0, 0, 2000)
            grid.align = ["left", "center", "stretch"].contains(raw["align"] as? String ?? "") ? raw["align"] as! String : "stretch"
            grid.step = OverlayMath.clamp(OverlayMath.finite(raw["step"]) ?? 8, 2, 1000)
            grid.offset = OverlayMath.clamp(OverlayMath.finite(raw["offset"]) ?? 0, -1000, 1000)
            grid.size = OverlayMath.clamp(OverlayMath.finite(raw["size"]) ?? 8, 2, 1000)
            if let color = raw["color"] as? String, OverlayMath.rgb(color) != nil { grid.color = color.lowercased() }
            grid.opacity = OverlayMath.clamp(OverlayMath.finite(raw["opacity"]) ?? 0.12, 0.02, 1)
            return grid
        }
    }
    func json() -> [String: Any] {
        ["rulers":rulers, "gridVisible":gridVisible, "locked":locked, "fixed":fixed,
         "guides":guides.map { ["id":$0.id, "axis":$0.axis, "position":$0.position] },
         "grids":grids.map { grid -> [String: Any] in
            ["kind":grid.kind, "visible":grid.visible, "count":grid.count, "width":grid.width.map { $0 as Any } ?? NSNull(), "gutter":grid.gutter,
             "margin":grid.margin, "align":grid.align, "step":grid.step, "offset":grid.offset, "size":grid.size, "color":grid.color, "opacity":grid.opacity]
         }]
    }
    /// The grids drawn now: the layout grid must be on and the grid itself visible.
    var shownGrids: [OverlayGrid] { gridVisible ? grids.filter(\.visible) : [] }
}

enum OverlayMath {
    static func finite(_ value: Any?) -> Double? { (value as? NSNumber).map(\.doubleValue).flatMap { $0.isFinite ? $0 : nil } }
    static func clamp(_ value: Double, _ low: Double, _ high: Double) -> Double { min(high, max(low, value)) }
    static func rgb(_ hex: String) -> (Double, Double, Double)? {
        guard hex.count == 7, hex.first == "#", let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        return (Double(value >> 16 & 0xff) / 255, Double(value >> 8 & 0xff) / 255, Double(value & 0xff) / 255)
    }

    /// Column spans `(start, width)` in CSS x across a viewport `width` wide.
    /// Stretch: the columns fill the viewport inside the margins. Left: fixed (or stretched)
    /// columns from the margin. Center: fixed columns centred in the viewport.
    static func columns(_ grid: OverlayGrid, width total: Double) -> [(start: Double, width: Double)] {
        let n = max(1, grid.count), gutters = Double(n - 1) * grid.gutter
        let stretched = (total - 2 * grid.margin - gutters) / Double(n)
        let column = grid.align == "stretch" ? stretched : (grid.width ?? stretched)
        guard column > 0 else { return [] }
        let span = Double(n) * column + gutters
        let start = grid.align == "center" ? (total - span) / 2 : grid.margin
        return (0..<n).map { (start + Double($0) * (column + grid.gutter), column) }
    }

    /// Periodic line positions `offset + k·step` that fall inside `range`, at most `limit`.
    static func periodic(step: Double, offset: Double, in range: ClosedRange<Double>, limit: Int = 4000) -> [Double] {
        guard step > 0, range.upperBound >= range.lowerBound else { return [] }
        let first = ((range.lowerBound - offset) / step).rounded(.up)
        var lines: [Double] = [], k = first
        while lines.count < limit {
            let value = offset + k * step
            if value > range.upperBound { break }
            lines.append(value); k += 1
        }
        return lines
    }

    /// Grid lines along one axis, for snapping and the page's distance labels: column edges
    /// on x, baseline rows on y and square lines on both.
    static func gridLines(_ grids: [OverlayGrid], axis: String, viewport: Double, in range: ClosedRange<Double>) -> [Double] {
        var lines: [Double] = []
        for grid in grids {
            switch (grid.kind, axis) {
            case ("columns", "x"): for column in columns(grid, width: viewport) { lines += [column.start, column.start + column.width] }
            case ("rows", "y"): lines += periodic(step: grid.step, offset: grid.offset, in: range)
            case ("square", _): lines += periodic(step: grid.size, offset: 0, in: range)
            default: break
            }
        }
        return Array(Set(lines)).sorted()
    }

    /// The labelled (major) ruler step in CSS px, at least `minimum` points apart on screen,
    /// and how many minor ticks divide it.
    static func rulerStep(scale: Double, minimum: Double = 50) -> (major: Double, minor: Int) {
        let scale = max(scale, 0.01)
        var magnitude = 1.0
        while true {
            for (factor, minor) in [(1.0, 10), (2.0, 4), (5.0, 5)] {
                let step = factor * magnitude
                if step * scale >= minimum { return (step, step * scale / Double(minor) >= 4 ? minor : max(1, minor / 2)) }
            }
            magnitude *= 10
            if magnitude > 1e7 { return (1e7, 1) }
        }
    }

    /// The nearest candidate within `threshold` (CSS px), or the value on a whole pixel.
    static func snap(_ value: Double, candidates: [Double], threshold: Double) -> (value: Double, snapped: Bool) {
        let nearest = candidates.min { abs($0 - value) < abs($1 - value) }
        if let nearest, abs(nearest - value) <= threshold { return (nearest, true) }
        return (value.rounded(), false)
    }

    /// Element edges and centres near `point` on one axis: the element must contain the
    /// pointer on the other axis, so a guide snaps to what is under the pointer.
    static func elementCandidates(_ rects: [CGRect], axis: String, point: CGPoint, threshold: Double) -> [Double] {
        rects.flatMap { r -> [Double] in
            let (low, high, cross, along) = axis == "x" ? (r.minX, r.maxX, r.minY...r.maxY, point.x) : (r.minY, r.maxY, r.minX...r.maxX, point.y)
            guard cross.contains(axis == "x" ? point.y : point.x), along >= low - threshold, along <= high + threshold else { return [] }
            return [Double(low), Double((low + high) / 2), Double(high)]
        }
    }

    /// CSS page coordinate → view point offset, and back. Page-anchored lines move with the
    /// scroll; viewport-fixed ones do not.
    static func toView(_ css: Double, scroll: Double, scale: Double, fixed: Bool) -> Double { (fixed ? css : css - scroll) * scale }
    static func toCSS(_ view: Double, scroll: Double, scale: Double, fixed: Bool) -> Double { view / max(scale, 0.0001) + (fixed ? 0 : scroll) }

    /// Starting points the popover adds; each is one more grid next to the others.
    static let presets: [(name: String, grid: OverlayGrid)] = [
        ("12 Columns, 1200", OverlayGrid(kind: "columns", count: 12, width: 78, gutter: 24, margin: 0, align: "center", color: "#ff3b30", opacity: 0.1)),
        ("4 Columns, Mobile", OverlayGrid(kind: "columns", count: 4, width: nil, gutter: 16, margin: 16, align: "stretch", color: "#007aff", opacity: 0.1)),
        ("8 pt Baseline", OverlayGrid(kind: "rows", step: 8, offset: 0, color: "#00c7be", opacity: 0.35)),
        ("Square, 8 pt", OverlayGrid(kind: "square", size: 8, color: "#8e8e93", opacity: 0.18))
    ]
}
