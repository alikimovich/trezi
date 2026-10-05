import AppKit

/// Test-only (ephemeral profile) checks for the floating inspector island: window
/// resizes, a left-edge drag, hit targets around the island and its own scrolling.
extension Host {
    func verifyInspectorIsland(_ c: [String: Any]) -> [String: Any] {
        if let width = c["windowWidth"] as? Double, let height = c["windowHeight"] as? Double {
            let size = NSSize(width: max(window.minSize.width, width), height: max(window.minSize.height, height))
            window.setFrame(NSRect(x: window.frame.minX, y: window.frame.maxY - size.height, width: size.width, height: size.height), display: true)
        }
        if c["prepare"] as? Bool == true { NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil) }
        // The same path as a pointer drag on the island's left edge.
        if let delta = c["drag"] as? Double { nativeLayout.inspectorDivider.changed?(CGFloat(delta)) }
        window.contentView?.superview?.layoutSubtreeIfNeeded(); nativeLayout.layout(); editingInspector.layoutSubtreeIfNeeded()
        let island = editingInspector.frame, divider = nativeLayout.inspectorDivider
        let preview = views["preview"]?.frame ?? .zero, area = nativeLayout.previewArea
        func target(_ point: NSPoint) -> String {
            guard let hit = canvas.hitTest(canvas.convert(point, to: canvas.superview)) else { return "none" }
            if hit.isDescendant(of: editingInspector) { return "inspector" }
            if let page = views["preview"], hit.isDescendant(of: page) { return "preview" }
            return hit === divider ? "divider" : String(describing: type(of: hit))
        }
        var hits: [String: String] = [:]
        if !island.isEmpty {
            hits["inside"] = target(NSPoint(x: island.midX, y: island.midY))
            hits["edge"] = target(NSPoint(x: island.minX, y: island.midY))
            hits["above"] = target(NSPoint(x: island.midX, y: island.minY - NativeEditingInspector.inset / 2))
            // Only where the preview shows beside the island, clear of the chat divider on its leading edge.
            if island.minX - preview.minX >= 40 { hits["left"] = target(NSPoint(x: island.minX - 16, y: island.midY)) }
        }
        var report: [String: Any] = ["visible":!editingInspector.isHidden, "glass":editingInspector.glass, "cornerRadius":Double(NativeEditingInspector.cornerRadius), "inset":Double(NativeEditingInspector.inset),
            "island":rect(island), "preview":rect(preview), "area":rect(area), "canvas":rect(canvas.bounds), "divider":rect(divider.isHidden ? .zero : divider.frame),
            "window":["width":Double(window.frame.width), "height":Double(window.frame.height)], "minWindow":["width":Double(window.minSize.width), "height":Double(window.minSize.height)],
            // Window coordinates: the toolbar and address bar end at contentLayoutRect's top.
            "toolbarGap":Double(window.contentLayoutRect.maxY - editingInspector.convert(editingInspector.bounds, to: nil).maxY),
            "inspectorWidth":Double(nativeLayout.inspectorWidth), "hits":hits]
        if let scroll = firstScrollView(in: editingInspector) {
            let frame = scroll.convert(scroll.bounds, to: canvas), visible = scroll.contentView.bounds.height
            let document = scroll.documentView?.frame.height ?? 0
            var scrolled = 0.0
            if c["scroll"] as? Bool == true, document > visible {
                scroll.contentView.scroll(to: NSPoint(x: 0, y: scroll.documentView?.isFlipped == false ? 0 : document - visible))
                scroll.reflectScrolledClipView(scroll.contentView)
                scrolled = Double(abs(scroll.contentView.bounds.minY - (scroll.documentView?.isFlipped == false ? document - visible : 0)))
            }
            report["scroll"] = ["frame":rect(frame), "visible":Double(visible), "document":Double(document), "scrolled":scrolled]
        }
        return report
    }
    /// LKM-162: the open island owns the pointer over its whole frame. With no `step` it switches
    /// to Styles, brings padding-top into view and hit-tests that field, its slider and the tabs
    /// as the window does. "moves" posts moves and a click inside the island, feeds WebKit's
    /// tracking areas the same moves, then moves beside the island, counting what reached the
    /// page each time. "edit" clicks padding-top and submits `value` through its field editor.
    @MainActor func verifyInspectorPointer(_ c: [String: Any]) async throws -> [String: Any] {
        NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil)
        window.contentView?.superview?.layoutSubtreeIfNeeded(); nativeLayout.layout(); editingInspector.layoutSubtreeIfNeeded()
        guard let preview = views["preview"] as? PreviewWebView, let state = editingInspector.model.state, !editingInspector.isHidden else {
            throw NSError(domain: "InspectorIsland", code: 2, userInfo: [NSLocalizedDescriptionKey: "Open the island over the preview first"])
        }
        if state.tab != "styles" { editingInspector.model.send("tab", value: "styles"); return ["tab":state.tab] }
        let all = descendants(of: editingInspector), island = editingInspector.frame
        let field = all.compactMap { $0 as? NSTextField }.first { $0.isEditable && ($0.placeholderString ?? $0.placeholderAttributedString?.string) == "padding-top" }
        field?.scrollToVisible(field?.bounds ?? .zero); editingInspector.layoutSubtreeIfNeeded()
        func center(_ view: NSView) -> NSPoint { view.convert(NSPoint(x: view.bounds.midX, y: view.bounds.midY), to: nil) }
        let fieldY = field.map { center($0).y } ?? 0
        // padding-top's own slider: the nearest one below its field (window coordinates grow upwards).
        let slider = all.compactMap { $0 as? NSSlider }.filter { center($0).y < fieldY }.max { center($0).y < center($1).y }
        let tabs = all.compactMap { $0 as? NSSegmentedControl }.first
        func post(_ type: NSEvent.EventType, _ point: NSPoint) {
            guard let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                                 context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0) else { return }
            NSApp.postEvent(event, atStart: false)
        }
        let settle = { try await Task.sleep(nanoseconds: 400_000_000) }
        switch c["step"] as? String {
        case "moves":
            // Posted moves reach the first responder only in the active key window that accepts them.
            for _ in 0..<40 where !(window.isKeyWindow && NSApp.isActive) { try await Task.sleep(nanoseconds: 50_000_000) }
            guard window.isKeyWindow, NSApp.isActive else { throw NSError(domain: "InspectorIsland", code: 4, userInfo: [NSLocalizedDescriptionKey: "Window must be foreground"]) }
            let accepts = window.acceptsMouseMovedEvents
            window.acceptsMouseMovedEvents = true
            defer { window.acceptsMouseMovedEvents = accepts }
            let picks = previewPicks
            // The preview as first responder gets every window mouse move: the strictest case.
            window.makeFirstResponder(preview); preview.delivered = [:]
            let inside = [NSPoint(x: island.minX + 10, y: island.midY), NSPoint(x: island.midX, y: island.maxY - 6)].map { canvas.convert($0, to: nil) } + [field, slider, tabs].compactMap { $0.map(center) }
            func moved(_ point: NSPoint) -> NSEvent? {
                NSEvent.mouseEvent(with: .mouseMoved, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 0, pressure: 0)
            }
            for point in inside { post(.mouseMoved, point) }
            // A click and a wheel on the island's bare padding, which AppKit used to hand to the page.
            post(.leftMouseDown, inside[0]); post(.leftMouseUp, inside[0])
            // As ChatAcceptance: a window event's CGEvent retyped as a precise wheel event.
            if let cg = moved(inside[0])?.cgEvent {
                cg.type = .scrollWheel
                cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
                cg.setIntegerValueField(.scrollWheelEventDeltaAxis1, value: -1); cg.setIntegerValueField(.scrollWheelEventPointDeltaAxis1, value: -40)
                if let wheel = NSEvent(cgEvent: cg) { NSApp.postEvent(wheel, atStart: false) }
            }
            // What WebKit's tracking areas see as a real pointer moves.
            let gates = preview.trackingAreas.compactMap { $0.owner as? PreviewPointerGate }
            func track(_ points: [NSPoint]) { for gate in gates { for event in points.compactMap(moved) { gate.mouseEntered(with: event); gate.mouseMoved(with: event) } } }
            track(inside)
            try await settle()
            let reached = preview.delivered
            // Beside the island the page still gets moves. Posted moves are counted apart from
            // the tracking areas' (the window may not route them to the first responder).
            window.makeFirstResponder(preview); preview.delivered = [:]
            let besideCanvas = island.minX - preview.frame.minX >= 40 ? NSPoint(x: island.minX - 16, y: island.midY) : NSPoint(x: island.midX, y: island.minY - NativeEditingInspector.inset / 2)
            let beside = [canvas.convert(besideCanvas, to: nil), canvas.convert(NSPoint(x: besideCanvas.x - 4, y: besideCanvas.y), to: nil)]
            for point in beside { post(.mouseMoved, point) }
            try await settle()
            let besideWindow = preview.delivered
            preview.delivered = [:]; track(beside)
            return ["inside":reached, "besideWindow":besideWindow, "besideTracking":preview.delivered, "points":inside.count, "gates":gates.count, "picks":previewPicks - picks,
                    "firstResponder":window.firstResponder === preview]
        case "edit":
            guard let field, let value = c["value"] as? String else { throw NSError(domain: "InspectorIsland", code: 3, userInfo: [NSLocalizedDescriptionKey: "No padding-top field"]) }
            post(.leftMouseDown, center(field)); post(.leftMouseUp, center(field))
            try await settle()
            guard let editor = window.firstResponder as? NSTextView, editor.isFieldEditor, (editor.delegate as? NSView) === field else {
                return ["focused":false, "responder":window.firstResponder.map { String(describing: type(of: $0)) } ?? "none"]
            }
            editor.selectAll(nil); editor.insertText(value, replacementRange: editor.selectedRange())
            editor.doCommand(by: #selector(NSResponder.insertNewline(_:)))
            return ["focused":true]
        default:
            func probe(_ view: NSView?) -> [String: Any] {
                guard let view else { return ["found":false] }
                let point = center(view), hit = window.contentView?.superview?.hitTest(point)
                let target = hit.map { $0.isDescendant(of: editingInspector) ? "inspector" : $0.isDescendant(of: preview) ? "preview" : String(describing: type(of: $0)) } ?? "none"
                return ["found":true, "target":target, "control":hit?.isDescendant(of: view) ?? false, "visible":view.visibleRect.height >= view.bounds.height - 1,
                        "insideIsland":editingInspector.bounds.contains(editingInspector.convert(point, from: nil))]
            }
            return ["tab":state.tab, "island":rect(island), "controls":["field":probe(field), "slider":probe(slider), "tabs":probe(tabs)]]
        }
    }
    private func descendants(of view: NSView) -> [NSView] { view.subviews.flatMap { [$0] + descendants(of: $0) } }
    private func rect(_ r: NSRect) -> [String: Double] { ["x":Double(r.minX), "y":Double(r.minY), "width":Double(r.width), "height":Double(r.height)] }
    private func firstScrollView(in view: NSView) -> NSScrollView? {
        for child in view.subviews { if let scroll = child as? NSScrollView { return scroll }; if let found = firstScrollView(in: child) { return found } }
        return nil
    }
    @MainActor func captureInspectorIsland() async throws -> [String: Any] {
        guard let content = window.contentView?.superview else { throw NSError(domain: "InspectorIsland", code: 1, userInfo: [NSLocalizedDescriptionKey: "No window content"]) }
        return try await captureVisibleRegion(window: window, view: content, region: content.bounds, recognize: false)
    }
}
