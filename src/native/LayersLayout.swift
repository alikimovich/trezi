import AppKit

/// Where the Layers island floats (LKM-179). By default it hangs under the toolbar's Layers
/// button at the top of the preview, beside the editing island on whichever side of it has
/// room (LKM-180: that island moves too), or, when the window is too narrow for both, takes
/// the top of the editing island's column and pushes that island down. The two never cover
/// each other.
enum LayersPlacement {
    static let minimum = NSSize(width: 220, height: 160), standard = NSSize(width: 260, height: 380), gap = IslandPlacement.gap
    struct Frames { var layers: NSRect; var inspector: NSRect; var mode: String; var reset: Bool }
    /// `spot` is a moved island's place (`IslandSpot`); `anchor` the Layers button's
    /// horizontal centre in canvas coordinates. While the island itself is dragged,
    /// `dragging` keeps its moved frame even over the editing island; the drop resolves that.
    static func frames(area: NSRect, size: NSSize, spot: IslandSpot?, anchor: CGFloat?, visible: Bool, inspector: NSRect, dragging: Bool = false) -> Frames {
        let inset = FloatingIsland.inset, inner = area.insetBy(dx: inset, dy: inset)
        guard visible, inner.width > 0, inner.height > 0 else { return Frames(layers: .zero, inspector: inspector, mode: "hidden", reset: false) }
        let height = max(0, min(max(minimum.height, size.height), inner.height))
        let region = self.region(inner: inner, inspector: inspector, anchor: anchor)
        if region.width < minimum.width, inspector.width > 0 {
            // Too narrow to sit side by side: stack above the editing island in its column.
            let layers = NSRect(x: inspector.minX, y: inspector.minY, width: inspector.width, height: max(0, min(height, (inspector.height - gap) / 2)))
            var below = inspector; below.origin.y = layers.maxY + gap; below.size.height = max(0, inspector.maxY - below.minY)
            return Frames(layers: layers, inspector: below, mode: "stacked", reset: false)
        }
        let mode = inspector.width > 0 ? "beside" : "anchored"
        var reset = false
        if let spot {
            let width = max(0, min(max(minimum.width, size.width), inner.width))
            let custom = spot.frame(NSSize(width: width, height: height), in: area)
            // Off-screen after a resize: back to the default, and forgotten.
            if !inner.insetBy(dx: -0.5, dy: -0.5).contains(custom) { reset = true }
            else if dragging || !custom.intersects(inspector) { return Frames(layers: custom, inspector: inspector, mode: "custom", reset: false) }
        }
        let width = max(0, min(max(minimum.width, size.width), region.width))
        return Frames(layers: placed(region, width, height, anchor), inspector: inspector, mode: mode, reset: reset)
    }
    /// The part of the preview the island may occupy by default: the whole preview, or the
    /// side of an open editing island that has room, preferring the one nearest the button.
    static func region(inner: NSRect, inspector: NSRect, anchor: CGFloat? = nil) -> NSRect {
        guard inspector.width > 0 else { return inner }
        var left = inner; left.size.width = max(0, inspector.minX - gap - inner.minX)
        var right = inner; right.origin.x = min(inner.maxX, inspector.maxX + gap); right.size.width = max(0, inner.maxX - right.minX)
        let target = anchor ?? inner.maxX
        func distance(_ r: NSRect) -> CGFloat { target < r.minX ? r.minX - target : target > r.maxX ? target - r.maxX : 0 }
        let fitting = [left, right].filter { $0.width >= minimum.width }
        return fitting.min { distance($0) < distance($1) } ?? (left.width >= right.width ? left : right)
    }
    /// Centred under the Layers button, kept inside `region`; flush right without a button.
    static func placed(_ region: NSRect, _ width: CGFloat, _ height: CGFloat, _ anchor: CGFloat?) -> NSRect {
        let x = anchor.map { $0 - width / 2 } ?? region.maxX - width
        return NSRect(x: max(region.minX, min(region.maxX - width, x)), y: region.minY, width: width, height: height)
    }
}
