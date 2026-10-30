import AppKit

/// LKM-385: where the preview speed badge sits, in the flipped canvas, whose top edge (y = 0) is
/// the toolbar's bottom edge. The anchor's bottom is above that edge while the toolbar is at
/// rest and past it while AppKit's full-screen toolbar window slides down with the menu bar.
enum PreviewSpeedPlacement {
    static let gap: CGFloat = 6, inset: CGFloat = 10
    /// Centered under `anchor`, on whole points so its text stays sharp. Without an anchor (no
    /// toolbar control in a window) it stays on screen, in the page's top trailing corner.
    static func frame(size: NSSize, anchor: NSRect?, page: NSRect) -> NSRect {
        guard let anchor else { return NSRect(x: page.maxX - size.width - inset, y: page.minY + inset, width: size.width, height: size.height) }
        return NSRect(x: (anchor.midX - size.width / 2).rounded(), y: max(anchor.maxY, 0) + gap, width: size.width, height: size.height)
    }
    static func box(_ r: NSRect) -> [String: Double] { ["x":Double(r.minX), "y":Double(r.minY), "width":Double(r.width), "height":Double(r.height)] }
}
