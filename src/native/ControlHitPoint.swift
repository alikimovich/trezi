import AppKit

/// LKM-457: where a posted click on a control lands, read only from its laid-out geometry
/// (`SourcePopoutAcceptance.swift`). Since the macOS 14 SDK a view's `clipsToBounds` is false by
/// default, and `visibleRect` is then the part of the window its ancestors show, not of the view:
/// the pop-out's 15×13 × reported the whole 1000×732 frame view, so the midpoint of `visibleRect`
/// was the window centre ([500,366]), over the code's NSClipView. The point is the centre of the
/// control's own bounds clipped to what its ancestors show. A hidden, empty, clipped or off-window
/// control refuses, as does a point off the screen of a window that must be on one; nothing is
/// guessed. Reads only: activates, orders, lays out and focuses nothing.
enum ControlHitPoint {
    struct Located { let point: NSPoint?; let refused: String?; let info: [String: Any] }

    /// `onScreen`: the point must lie on the window's screen. Off for AppKit's full-screen title-bar
    /// window, whose reveal AppKit manages; its on-screen state is still recorded.
    @MainActor static func locate(_ view: NSView, in host: NSWindow, onScreen: Bool = true) -> Located {
        func rect(_ r: NSRect) -> [Double] { r.isNull ? [] : [r.minX, r.minY, r.width, r.height].map(Double.init) }
        let shown = view.bounds.intersection(view.visibleRect), frameView = host.contentView?.superview ?? host.contentView
        // `screen` can be nil for a window not yet ordered in; its frame still says where it would be.
        let screen = host.screen ?? NSScreen.screens.first { $0.frame.intersects(host.frame) }
        var ancestors: [[String: Any]] = [], next = view.superview
        while let ancestor = next {
            ancestors.append(["view": String(describing: type(of: ancestor)), "frame": rect(ancestor.frame), "bounds": rect(ancestor.bounds),
                              "flipped": ancestor.isFlipped, "clipsToBounds": ancestor.clipsToBounds, "hidden": ancestor.isHidden])
            next = ancestor.superview
        }
        var info: [String: Any] = ["view": String(describing: type(of: view)), "frame": rect(view.frame), "bounds": rect(view.bounds),
                                   "visibleRect": rect(view.visibleRect), "shownBounds": rect(shown), "rectInWindow": rect(view.convert(view.bounds, to: nil)),
                                   "flipped": view.isFlipped, "hidden": view.isHiddenOrHasHiddenAncestor, "windowFrame": rect(host.frame),
                                   "frameView": rect(frameView?.frame ?? .null), "contentLayoutRect": rect(host.contentLayoutRect),
                                   "screenFrame": rect(screen?.frame ?? .null), "onScreenRequired": onScreen, "ancestors": ancestors]
        func refuse(_ reason: String) -> Located { Located(point: nil, refused: reason, info: info) }
        guard view.window === host else { return refuse("the control is not in the window \"\(host.title)\"") }
        guard !view.isHiddenOrHasHiddenAncestor else { return refuse("the control is hidden") }
        guard view.bounds.width > 0, view.bounds.height > 0 else { return refuse("the control has no size: bounds \(view.bounds)") }
        guard !shown.isNull, !shown.isEmpty else { return refuse("the control is clipped out of view: visibleRect \(view.visibleRect)") }
        guard let frameView else { return refuse("the window has no frame view") }
        let point = view.convert(NSPoint(x: shown.midX, y: shown.midY), to: nil)
        info["point"] = [Double(point.x), Double(point.y)]
        guard frameView.frame.contains(point) else { return refuse("the control's centre \(point) lies outside the window \(frameView.frame)") }
        let pointOnScreen = screen.map { $0.frame.contains(host.convertPoint(toScreen: point)) } ?? false
        info["pointOnScreen"] = pointOnScreen
        if onScreen && !pointOnScreen { return refuse("the control's centre \(point) is off screen") }
        // `hitTest` takes the point in the superview's coordinates; the frame view has none, so window coordinates.
        let hit = frameView.hitTest(point)
        info["hitView"] = hit.map { String(describing: type(of: $0)) } ?? ""
        info["hitIsTarget"] = hit.map { $0 === view || $0.isDescendant(of: view) } ?? false
        return Located(point: point, refused: nil, info: info)
    }
}
