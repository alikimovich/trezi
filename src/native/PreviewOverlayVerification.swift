import AppKit

/// Test-broker commands for the rulers, guides and grids (LKM-205). A guide drag goes
/// through the window's own hit testing and the views' mouse handlers with ordinary
/// NSEvents (no CGEvent, nothing posted to the system); shortcuts go through the main menu.
extension Host {
    func previewOverlayInspect() -> [String: Any] {
        guard let overlay = previewOverlay else { return [:] }
        func box(_ r: NSRect) -> [String: Double] { ["x":Double(r.minX), "y":Double(r.minY), "width":Double(r.width), "height":Double(r.height)] }
        let viewMenu = NSApp.mainMenu?.items.first { $0.title == "View" }?.submenu
        var menu: [String: Any] = [:]
        for item in viewMenu?.items ?? [] where item.target === overlay {
            let enabled = overlay.validateMenuItem(item)
            menu[item.title] = ["state":item.state == .on, "enabled":enabled, "key":item.keyEquivalent, "modifiers":Int(item.keyEquivalentModifierMask.rawValue)]
        }
        let columns = overlay.state.shownGrids.filter { $0.kind == "columns" }.map { grid in
            OverlayMath.columns(grid, width: overlay.viewportWidth).map { ["start":$0.start, "width":$0.width, "viewX":Double(overlay.view($0.start, axis: "x"))] }
        }
        return ["key":overlay.key.map { $0 as Any } ?? NSNull(), "viewport":overlay.viewport, "state":overlay.state.json(), "shown":overlay.shown,
                "scale":Double(overlay.scale), "frame":box(overlay.frame), "top":box(overlay.top.frame), "left":box(overlay.left.frame),
                "guideBounds":box(overlay.guides.bounds), "guideFrame":box(overlay.guides.frame),
                "clipToBounds":overlay.guides.layer?.masksToBounds == true, "cornerRadius":Double(overlay.guides.layer?.cornerRadius ?? 0),
                "previewFrame":views["preview"].map { box($0.frame) } ?? [:],
                "previewScale":Double((views["preview"]?.pageZoom ?? 1) * (views["preview"]?.magnification ?? 1)),
                "rulersHidden":overlay.top.isHidden, "guidesHidden":overlay.guides.isHidden, "selected":overlay.selected.map { $0 as Any } ?? NSNull(),
                "page":["scrollX":overlay.page.scrollX, "scrollY":overlay.page.scrollY, "width":overlay.page.width, "height":overlay.page.height,
                        "selection":overlay.page.selection.map { box($0) as Any } ?? NSNull()],
                "viewportWidth":overlay.viewportWidth, "columns":columns, "menu":menu, "panelShown":overlay.popover.isShown, "panelNote":overlay.panelNote,
                "buttonEnabled":shell.toolbarItems["overlay"]?.isEnabled ?? false,
                "cover":previewCoverRects(), "superview":overlay.guides.superview === canvas && overlay.top.superview === canvas]
    }

    @MainActor func previewOverlayTest(_ c: [String: Any]) async throws -> [String: Any] {
        guard let overlay = previewOverlay else { throw overlayError("No overlay") }
        switch c["action"] as? String {
        case "rulers": overlay.toggleRulers(nil)
        case "grid": overlay.toggleGrid(nil)
        case "lock": overlay.toggleLock(nil)
        case "fixed": overlay.toggleFixed(nil)
        case "clear": overlay.clearGuides(nil)
        case "panel": overlay.togglePanel(); try await Task.sleep(nanoseconds: 200_000_000)
        case "set": overlay.update { $0 = OverlayState(json: c["state"] as? [String: Any] ?? [:]) }
        case "key":
            // ⇧⌘R or ⌃G through the main menu, as a typed shortcut reaches it.
            let rulers = c["key"] as? String == "rulers"
            guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: rulers ? [.command, .shift] : .control, timestamp: ProcessInfo.processInfo.systemUptime,
                                               windowNumber: window.windowNumber, context: nil, characters: rulers ? "R" : "\u{07}", charactersIgnoringModifiers: rulers ? "R" : "g", isARepeat: false, keyCode: rulers ? 15 : 5)
            else { throw overlayError("No key event") }
            var result = previewOverlayInspect(); result["handled"] = NSApp.mainMenu?.performKeyEquivalent(with: event) ?? false
            result["after"] = overlay.state.json()
            return result
        case "drag": return try await overlayDrag(overlay, c)
        case "capture": return try await captureOverlay(dark: c["dark"] as? Bool == true)
        case "anchors": return toolbarAnchorInspect()
        case "fullscreen": return try await toolbarFullScreen(c["value"] as? Bool == true)
        case "menu": return toolbarMenuProbe(c["key"] as? String ?? "speed")
        default: break
        }
        return previewOverlayInspect()
    }

    /// From a ruler (`from: "top" | "left"`) or an existing guide (`from: <id>`) to `to`, a
    /// point in the page's CSS viewport coordinates; `remove` drops it back on its ruler.
    @MainActor private func overlayDrag(_ overlay: PreviewOverlay, _ c: [String: Any]) async throws -> [String: Any] {
        guard let theme = window.contentView?.superview, let to = c["to"] as? [String: Any] else { throw overlayError("Bad drag") }
        let from = c["from"] as? String ?? "top"
        let target = NSPoint(x: overlay.frame.minX + CGFloat(OverlayMath.finite(to["x"]) ?? 0) * overlay.scale,
                             y: overlay.frame.minY + CGFloat(OverlayMath.finite(to["y"]) ?? 0) * overlay.scale)
        var start: NSPoint
        switch from {
        case "top": start = NSPoint(x: target.x, y: overlay.top.frame.midY)
        case "left": start = NSPoint(x: overlay.left.frame.midX, y: target.y)
        default:
            guard let guide = overlay.state.guides.first(where: { $0.id == from }) else { throw overlayError("No guide \(from)") }
            let at = overlay.view(guide.position, axis: guide.axis)
            func along(_ offset: CGFloat) -> NSPoint {
                guide.axis == "x" ? NSPoint(x: overlay.frame.minX + at, y: offset) : NSPoint(x: offset, y: overlay.frame.minY + at)
            }
            // Grab it where it shows: a floating island over the page covers it elsewhere.
            let (low, high) = guide.axis == "x" ? (overlay.frame.minY, overlay.frame.maxY) : (overlay.frame.minX, overlay.frame.maxX)
            start = along(guide.axis == "x" ? target.y : target.x)
            if theme.hitTest(canvas.convert(start, to: nil)) !== overlay.guides,
               let open = stride(from: low + 4, to: high - 4, by: 8).map(along).first(where: { theme.hitTest(canvas.convert($0, to: nil)) === overlay.guides }) { start = open }
        }
        var end = target
        if c["remove"] as? Bool == true { end = from == "left" || overlay.state.guides.first(where: { $0.id == from })?.axis == "x" ? NSPoint(x: overlay.left.frame.midX, y: target.y) : NSPoint(x: target.x, y: overlay.top.frame.midY) }
        let window = self.window!, startWindow = canvas.convert(start, to: nil), endWindow = canvas.convert(end, to: nil)
        guard let hit = theme.hitTest(startWindow) else { throw overlayError("Nothing under the drag start") }
        let owner = hit === overlay.top ? "top" : hit === overlay.left ? "left" : hit === overlay.guides ? "guide" : String(describing: type(of: hit))
        func event(_ type: NSEvent.EventType, _ point: NSPoint) -> NSEvent? {
            NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
        }
        guard [overlay.top, overlay.left, overlay.guides].contains(where: { $0 === hit }), let down = event(.leftMouseDown, startWindow) else { return ["owner":owner, "state":overlay.state.json()] }
        hit.mouseDown(with: down)
        await overlay.snapLoad?.value
        var midpoint = startWindow; midpoint.x = (startWindow.x + endWindow.x) / 2; midpoint.y = (startWindow.y + endWindow.y) / 2
        for point in [midpoint, endWindow] { if let move = event(.leftMouseDragged, point) { hit.mouseDragged(with: move) } }
        let label = overlay.drag.map { ["position":$0.position, "snapped":$0.snapped, "removing":$0.removing] as [String: Any] } ?? [:]
        if let up = event(.leftMouseUp, endWindow) { hit.mouseUp(with: up) }
        var result = previewOverlayInspect(); result["owner"] = owner; result["drag"] = label
        return result
    }

    /// The window in light or dark with the overlay showing; only this window's appearance changes.
    @MainActor private func captureOverlay(dark: Bool) async throws -> [String: Any] {
        guard let content = window.contentView?.superview, let overlay = previewOverlay else { throw overlayError("No window content") }
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        defer { window.appearance = nil }
        overlay.redraw(); content.layoutSubtreeIfNeeded(); content.displayIfNeeded()
        try await Task.sleep(nanoseconds: 400_000_000)
        var image = try await captureVisibleRegion(window: window, view: content, region: content.bounds, recognize: false)
        image["frame"] = NSStringFromRect(content.convert(overlay.frame, from: canvas))
        image["dark"] = window.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        // The fixture uses opaque #ff00ff columns. Count only that distinctive colour
        // in the foreground capture, inside the preview's vertical band. A column with
        // a negative start used to paint into the chat even though its view had a frame.
        if let encoded = image["png"] as? String, let data = Data(base64Encoded: encoded),
           let bitmap = NSBitmapImageRep(data: data), content.bounds.width > 0, content.bounds.height > 0 {
            let page = content.convert(overlay.frame, from: canvas)
            let sx = CGFloat(bitmap.pixelsWide) / content.bounds.width
            let sy = CGFloat(bitmap.pixelsHigh) / content.bounds.height
            let left = Int((page.minX - content.bounds.minX) * sx), right = Int((page.maxX - content.bounds.minX) * sx)
            let top = Int((content.bounds.maxY - page.maxY) * sy), bottom = Int((content.bounds.maxY - page.minY) * sy)
            // LKM-331: one region is not the page and is not counted: the toolbar's own strip
            // across the page's width, from the window top down to the toolbar's bottom edge
            // (contentLayoutRect's top). The system's glass and scroll-edge effect there show
            // the page's edge colour behind the toolbar (the nightly's stray count fits that
            // strip: about 650 x 55 pt). The overlay itself is clipped to the page, so it cannot
            // reach it. Everything else outside the page (the rulers and any gap between the
            // toolbar and the page, the chat, the sidebar, beside or below the page) is counted
            // at the strict colour threshold (LKM-332).
            let toolbarBottom = content.bounds.maxY - content.convert(NSPoint(x: 0, y: window.contentLayoutRect.maxY), from: nil).y
            let toolbar = min(Int(toolbarBottom * sy), top - 1)
            var inside = 0, outside = 0, band = 0
            // Where stray paint lies (window points, top-left origin), so a failure names it.
            var stray = CGRect.null, bandBox = CGRect.null
            for y in stride(from: 0, to: bitmap.pixelsHigh, by: 2) {
                for x in stride(from: 0, to: bitmap.pixelsWide, by: 2) {
                    guard let c = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB),
                          c.redComponent > 0.82, c.greenComponent < 0.35, c.blueComponent > 0.75 else { continue }
                    let spot = CGRect(x: CGFloat(x) / sx, y: CGFloat(y) / sy, width: 2 / sx, height: 2 / sy)
                    if x >= left - 1 && x < right + 1 && y >= top - 1 && y < bottom + 1 { inside += 1 }
                    else if x >= left - 1 && x < right + 1 && y < toolbar { band += 1; bandBox = bandBox.union(spot) }
                    else { outside += 1; stray = stray.union(spot) }
                }
            }
            image["magentaInside"] = inside; image["magentaOutside"] = outside; image["magentaToolbarBand"] = band
            if !bandBox.isNull { image["magentaToolbarBandBox"] = NSStringFromRect(bandBox.integral) }
            // The band's limits (window points, top-left), so the evidence shows what was left out.
            image["toolbarBandLimits"] = NSStringFromRect(NSRect(x: CGFloat(left) / sx, y: 0, width: CGFloat(right - left) / sx, height: CGFloat(max(toolbar, 0)) / sy))
            image["pageTopLeft"] = NSStringFromRect(NSRect(x: page.minX - content.bounds.minX, y: content.bounds.maxY - page.maxY, width: page.width, height: page.height))
            if !stray.isNull { image["magentaOutsideBox"] = NSStringFromRect(stray.integral) }
            image["pixelScale"] = ["x":Double(sx), "y":Double(sy)]
        }
        return image
    }
    private func overlayError(_ message: String) -> NSError { NSError(domain: "PreviewOverlay", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}
