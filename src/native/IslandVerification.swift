import AppKit

/// Test-only (ephemeral profile) checks for moving the islands (LKM-180): header drags
/// through the header's own path, snapping, drops onto the other island, header controls,
/// resets and restoring a saved place.
extension Host {
    func verifyIslands(_ c: [String: Any]) -> [String: Any] {
        if let width = c["windowWidth"] as? Double, let height = c["windowHeight"] as? Double {
            let size = NSSize(width: max(window.minSize.width, width), height: max(window.minSize.height, height))
            window.setFrame(NSRect(x: window.frame.minX, y: window.frame.maxY - size.height, width: size.width, height: size.height), display: true)
        }
        if c["prepare"] as? Bool == true { NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil) }
        window.contentView?.superview?.layoutSubtreeIfNeeded(); nativeLayout.layout()
        let island: FloatingIsland = c["island"] as? String == "layers" ? layers : editingInspector
        var result: [String: Any] = [:]
        switch c["action"] as? String {
        case "drag":
            // A pointer drag on the header in `steps` window moves, then the release.
            guard !island.isHidden else { return ["ok":false] }
            let start = NSPoint(x: island.frame.minX + island.title.frame.maxX + 6, y: island.frame.minY + FloatingIsland.headerHeight / 2)
            let dx = CGFloat(c["dx"] as? Double ?? 0), dy = CGFloat(c["dy"] as? Double ?? 0), steps = max(1, c["steps"] as? Int ?? 6)
            let from = canvas.convert(start, to: nil)
            for step in 1...steps {
                let t = CGFloat(step) / CGFloat(steps)
                island.drag(from: from, to: canvas.convert(NSPoint(x: start.x + dx * t, y: start.y + dy * t), to: nil), ended: step == steps)
                if step == steps - 1 { result["during"] = box(island.frame) }
            }
        case "reset": island.header.reset?() // The header's double-click.
        case "menuReset":
            guard let item = editingInspector.actionMenu().items.first(where: { $0.title == "Reset Position" }), let action = item.action else { return ["ok":false] }
            NSApp.sendAction(action, to: item.target, from: item)
        case "close": editingInspector.close.performClick(nil)
        case "restore": nativeLayout.restoreSizes(c["sizes"] as? [String: Double] ?? [:])
        default: break
        }
        nativeLayout.layout(); editingInspector.layoutSubtreeIfNeeded(); layers.layoutSubtreeIfNeeded()
        func target(_ point: NSPoint) -> String {
            guard let hit = canvas.hitTest(canvas.convert(point, to: canvas.superview)) else { return "none" }
            if hit === editingInspector.close { return "close" }
            if hit === editingInspector.more { return "more" }
            if hit === editingInspector.header || hit === layers.header { return "header" }
            if hit.isDescendant(of: editingInspector) || hit.isDescendant(of: layers) { return "island:" + String(describing: type(of: hit)) }
            if let page = views["preview"], hit.isDescendant(of: page) { return "preview" }
            return String(describing: type(of: hit))
        }
        func center(_ view: NSView) -> NSPoint { canvas.convert(NSPoint(x: view.bounds.midX, y: view.bounds.midY), from: view) }
        var hits: [String: String] = [:]
        if !editingInspector.isHidden {
            let header = editingInspector.header
            hits = ["title":target(center(editingInspector.title)), "close":target(center(editingInspector.close)), "more":target(center(editingInspector.more)),
                    "blank":target(canvas.convert(NSPoint(x: (editingInspector.title.frame.maxX + editingInspector.more.frame.minX) / 2, y: header.bounds.midY), from: header))]
        }
        if !layers.isHidden { hits["layersTitle"] = target(center(layers.title)) }
        // The open hand never covers a header button.
        let header = editingInspector.header, hands = header.handRects()
        let handsClear = !hands.isEmpty && hands.allSatisfy { !$0.intersects(editingInspector.more.frame) && !$0.intersects(editingInspector.close.frame) }
        func spot(_ spot: IslandSpot?) -> Any { spot.map { ["x":Double($0.x), "y":Double($0.y), "corner":$0.corner] as Any } ?? NSNull() }
        return result.merging([
            "ok":true, "inset":Double(FloatingIsland.inset), "threshold":Double(IslandPlacement.threshold), "gap":Double(IslandPlacement.gap),
            "area":box(nativeLayout.previewArea), "preview":box(views["preview"]?.frame ?? .zero),
            "inspector":["visible":!editingInspector.isHidden, "frame":box(editingInspector.isHidden ? .zero : editingInspector.frame), "spot":spot(nativeLayout.inspectorSpot)],
            "layers":["visible":!layers.isHidden, "frame":box(layers.isHidden ? .zero : layers.frame), "spot":spot(nativeLayout.layersSpot), "mode":nativeLayout.layersMode],
            "hits":hits, "handsClear":handsClear, "menu":editingInspector.actionMenu().items.map { $0.isSeparatorItem ? "-" : $0.title },
            "cover":previewCoverRects(), "window":["width":Double(window.frame.width), "height":Double(window.frame.height)]
        ]) { _, new in new }
    }
    private func box(_ r: NSRect) -> [String: Double] { ["x":Double(r.minX), "y":Double(r.minY), "width":Double(r.width), "height":Double(r.height)] }
}
