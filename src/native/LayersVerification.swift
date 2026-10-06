import AppKit

/// Test-only (ephemeral profile) checks for the Layers island (LKM-179): placement under the
/// toolbar button and beside the editing island, row selection, drops and pointer ownership.
extension Host {
    func verifyLayersIsland(_ c: [String: Any]) -> [String: Any] {
        if let width = c["windowWidth"] as? Double, let height = c["windowHeight"] as? Double {
            let size = NSSize(width: max(window.minSize.width, width), height: max(window.minSize.height, height))
            window.setFrame(NSRect(x: window.frame.minX, y: window.frame.maxY - size.height, width: size.width, height: size.height), display: true)
        }
        if c["prepare"] as? Bool == true { NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil) }
        window.contentView?.superview?.layoutSubtreeIfNeeded(); nativeLayout.layout(); layers.layoutSubtreeIfNeeded()
        let frame = layers.frame, tree = layers.tree
        func target(_ point: NSPoint) -> String {
            guard let hit = canvas.hitTest(canvas.convert(point, to: canvas.superview)) else { return "none" }
            if hit.isDescendant(of: layers) { return "layers" }
            if hit.isDescendant(of: editingInspector) { return "inspector" }
            if let page = views["preview"], hit.isDescendant(of: page) { return "preview" }
            return String(describing: type(of: hit))
        }
        var hits: [String: String] = [:]
        if !frame.isEmpty {
            hits["inside"] = target(NSPoint(x: frame.midX, y: frame.midY))
            hits["header"] = target(NSPoint(x: frame.midX, y: frame.minY + 20))
            hits["below"] = target(NSPoint(x: frame.midX, y: frame.maxY + NativeEditingInspector.inset / 2))
        }
        let row = layers.selectedPath.flatMap { layers.item($0) }.map { tree.row(forItem: $0) } ?? -1
        let shown = tree.rows(in: tree.visibleRect)
        let button = shell.toolbarButtonFrame("layers").map { canvas.convert($0, from: nil) }
        return ["visible":!layers.isHidden, "glass":layers.glass, "cornerRadius":Double(NativeEditingInspector.cornerRadius), "inset":Double(NativeEditingInspector.inset),
            "frame":box(frame), "area":box(nativeLayout.previewArea), "inspector":box(editingInspector.isHidden ? .zero : editingInspector.frame), "inspectorVisible":!editingInspector.isHidden,
            "mode":nativeLayout.layersMode, "anchor":nativeLayout.layersAnchor.map { Double($0) as Any } ?? NSNull(), "button":button.map { box($0) as Any } ?? NSNull(),
            "size":["width":Double(nativeLayout.layersSize.width), "height":Double(nativeLayout.layersSize.height)], "custom":nativeLayout.layersOffset != nil,
            "window":["width":Double(window.frame.width), "height":Double(window.frame.height)],
            "count":layers.nodes.count, "selected":layers.selectedPath.map { $0 as Any } ?? NSNull(), "selectedRow":tree.selectedRow,
            "selectedVisible":row >= 0 && tree.selectedRow == row && NSLocationInRange(row, shown),
            "expandedRows":tree.numberOfRows, "notice":layers.notice.isHidden ? "" : layers.notice.stringValue, "selectionsSent":layers.selectionsSent,
            "hits":hits, "cover":previewCoverRects()]
    }
    /// Drives the island the way a pointer would: a row click, a drop, a header drag or an
    /// edge drag, each through the same path as the real gesture.
    func performLayers(_ c: [String: Any]) -> [String: Any] {
        let path = c["path"] as? [Int]
        switch c["action"] as? String {
        case "select":
            guard let path, let item = layers.item(path) else { return ["ok":false] }
            var parent = item.parent
            while let next = parent { layers.tree.expandItem(next); parent = next.parent }
            let row = layers.tree.row(forItem: item)
            guard row >= 0 else { return ["ok":false] }
            layers.tree.selectRowIndexes([row], byExtendingSelection: false)
            return ["ok":true]
        case "collapse":
            layers.tree.collapseItem(nil, collapseChildren: true)
            layers.tree.deselectAll(nil)
            return ["ok":true, "rows":layers.tree.numberOfRows]
        case "drop":
            guard let path, let dragged = layers.item(path) else { return ["ok":false] }
            let parent = (c["parent"] as? [Int]).flatMap { layers.item($0) }
            let reason = layers.perform(drag: dragged, onto: parent, index: c["index"] as? Int ?? -1, commit: true)
            return ["ok":reason == nil, "reason":reason ?? ""]
        case "move":
            let frame = layers.frame.offsetBy(dx: CGFloat(c["dx"] as? Double ?? 0), dy: CGFloat(c["dy"] as? Double ?? 0))
            layers.moved?(frame, true)
            return verifyLayersIsland([:])
        case "resize":
            var frame = layers.frame
            frame.size = NSSize(width: CGFloat(c["width"] as? Double ?? frame.width), height: CGFloat(c["height"] as? Double ?? frame.height))
            layers.resized?(frame, [.right, .bottom], true)
            return verifyLayersIsland([:])
        case "reset":
            layers.reset?()
            return verifyLayersIsland([:])
        default: return ["ok":false]
        }
    }
    /// LKM-173 for the Layers island: one window mouse move over the page or the island.
    @MainActor func layersPointer(_ c: [String: Any]) async throws -> [String: Any] {
        NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil)
        for _ in 0..<40 where !(window.isKeyWindow && NSApp.isActive) { try await Task.sleep(nanoseconds: 50_000_000) }
        guard let preview = views["preview"], !layers.isHidden, window.isKeyWindow, NSApp.isActive else {
            throw NSError(domain: "LayersIsland", code: 1, userInfo: [NSLocalizedDescriptionKey: "Open Layers over a foreground preview first"])
        }
        let island = canvas.convert(NSPoint(x: layers.frame.midX, y: layers.frame.midY), to: nil), page = previewWindowPoint(preview, c)
        let over = c["target"] as? String == "island"
        let picks = previewPicks
        let (_, owners) = try await movePointer(over: preview, to: over ? island : page, from: over ? page : island)
        return ["owners":owners.count, "picks":previewPicks - picks, "picksTotal":previewPicks, "expectedCover":previewCoverRects()]
    }
    /// The whole window in light or dark: only this window's appearance is forced, then restored.
    @MainActor func captureLayersIsland(dark: Bool) async throws -> [String: Any] {
        guard let content = window.contentView?.superview else { throw NSError(domain: "LayersIsland", code: 2, userInfo: [NSLocalizedDescriptionKey: "No window content"]) }
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        defer { window.appearance = nil }
        content.layoutSubtreeIfNeeded(); content.displayIfNeeded()
        try await Task.sleep(nanoseconds: 400_000_000)
        var image = try await captureVisibleRegion(window: window, view: content, region: content.bounds, recognize: false)
        image["frame"] = box(content.convert(layers.frame, from: canvas))
        image["dark"] = window.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        return image
    }
    private func box(_ r: NSRect) -> [String: Double] { ["x":Double(r.minX), "y":Double(r.minY), "width":Double(r.width), "height":Double(r.height)] }
}
