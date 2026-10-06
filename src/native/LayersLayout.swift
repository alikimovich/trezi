import AppKit

/// Where the Layers island floats (LKM-179). By default it hangs under the toolbar's Layers
/// button at the top of the preview. With the editing island open it sits beside it on the
/// left, or, when the window is too narrow for both, takes the top of the editing island's
/// column and pushes that island down. The two never cover each other.
enum LayersPlacement {
    static let minimum = NSSize(width: 220, height: 160), standard = NSSize(width: 260, height: 380), gap: CGFloat = 10
    struct Frames { var layers: NSRect; var inspector: NSRect; var mode: String; var reset: Bool }
    /// `offset` is a dragged island's top-right corner relative to the area's; `anchor` the
    /// Layers button's horizontal centre in the same coordinates (y grows downwards).
    static func frames(area: NSRect, size: NSSize, offset: NSPoint?, anchor: CGFloat?, visible: Bool, inspector: NSRect) -> Frames {
        let inset = NativeEditingInspector.inset, inner = area.insetBy(dx: inset, dy: inset)
        guard visible, inner.width > 0, inner.height > 0 else { return Frames(layers: .zero, inspector: inspector, mode: "hidden", reset: false) }
        let height = max(0, min(max(minimum.height, size.height), inner.height))
        let region = self.region(inner: inner, inspector: inspector)
        if region.width < minimum.width, inspector.width > 0 {
            // Too narrow to sit side by side: stack above the editing island in its column.
            let layers = NSRect(x: inspector.minX, y: inspector.minY, width: inspector.width, height: max(0, min(height, (inspector.height - gap) / 2)))
            var below = inspector; below.origin.y = layers.maxY + gap; below.size.height = max(0, inspector.maxY - below.minY)
            return Frames(layers: layers, inspector: below, mode: "stacked", reset: false)
        }
        let width = max(0, min(max(minimum.width, size.width), region.width))
        if let offset {
            let custom = NSRect(x: area.maxX + offset.x - width, y: area.minY + offset.y, width: width, height: height)
            if !inner.insetBy(dx: -0.5, dy: -0.5).contains(custom) { return Frames(layers: placed(region, width, height, anchor), inspector: inspector, mode: inspector.width > 0 ? "beside" : "anchored", reset: true) }
            if !custom.intersects(inspector) { return Frames(layers: custom, inspector: inspector, mode: "custom", reset: false) }
        }
        return Frames(layers: placed(region, width, height, anchor), inspector: inspector, mode: inspector.width > 0 ? "beside" : "anchored", reset: false)
    }
    /// The part of the preview the island may occupy: left of an open editing island.
    static func region(inner: NSRect, inspector: NSRect) -> NSRect {
        guard inspector.width > 0 else { return inner }
        var region = inner; region.size.width = max(0, inspector.minX - gap - inner.minX); return region
    }
    /// Centred under the Layers button, kept inside `region`; flush right without a button.
    static func placed(_ region: NSRect, _ width: CGFloat, _ height: CGFloat, _ anchor: CGFloat?) -> NSRect {
        let x = anchor.map { $0 - width / 2 } ?? region.maxX - width
        return NSRect(x: max(region.minX, min(region.maxX - width, x)), y: region.minY, width: width, height: height)
    }
    /// A dragged frame kept inside `region` at the island's current size.
    static func clamp(_ frame: NSRect, to region: NSRect) -> NSRect {
        var next = frame
        next.origin.x = max(region.minX, min(region.maxX - frame.width, frame.minX))
        next.origin.y = max(region.minY, min(region.maxY - frame.height, frame.minY))
        return next
    }
}
