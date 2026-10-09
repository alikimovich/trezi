import AppKit

/// AppKit owns all application frames; WebKit only receives the preview viewport.
final class WorkspaceLayout {
    weak var host: Host?
    var shellState: [String: Any] = [:]
    var chatState: [String: Any] = [:]
    var desiredWidth: CGFloat = 440
    var fraction: CGFloat = 1
    var previewVisible = false
    /// A temporary CSS width from `preview_viewport` (LKM-138); it replaces the bezel.
    var viewportWidth: CGFloat?
    let sourceDivider = NativePanelDivider(), inspectorDivider = NativePanelDivider()
    var sourceHeight: CGFloat = 380, inspectorWidth: CGFloat = 300
    /// The Layers island's size and, once its header was dragged, where it was put (LKM-179);
    /// nil hangs it under the Layers button.
    var layersSize = LayersPlacement.standard, layersSpot: IslandSpot?
    /// Where the editing island was dragged (LKM-180); nil keeps it on the right.
    var inspectorSpot: IslandSpot?
    /// How the island was last placed: hidden, anchored, beside, stacked or custom.
    private(set) var layersMode = "hidden"
    /// The island whose header is being dragged, and Layers' frame held still while the
    /// editing island moves, so it does not hop away from under the pointer.
    private var dragging: FloatingIsland?, heldLayers: NSRect?
    /// The Layers button's centre in canvas coordinates when the island was last placed.
    private(set) var layersAnchor: CGFloat?
    let device = NSImageView()
    private var animation: Timer?
    private var layingOut = false
    private var lastFrame = NSRect.zero
    private var lastLeading: CGFloat = -1
    /// The area right of the chat, above a docked source editor and beside a docked Web
    /// Inspector; the inspector island floats inside it.
    private(set) var previewArea = NSRect.zero
    init(host: Host) {
        self.host = host
        for divider in [sourceDivider, inspectorDivider] { divider.isHidden = true; host.canvas.addSubview(divider) }
        sourceDivider.changed = { [weak self] delta in guard let self else { return }; self.sourceHeight = max(160, min((self.host?.canvas.bounds.height ?? 700) * 0.8, self.sourceHeight + delta)); self.layout(); self.saveSizes() }
        for island in [host.editingInspector, host.layers] as [FloatingIsland] {
            island.moved = { [weak self, weak island] frame, ended in if let island { self?.move(island, to: frame, ended: ended) } }
            island.reset = { [weak self, weak island] in if let island { self?.resetPosition(island) } }
        }
        host.layers.resized = { [weak self] frame, edges, ended in self?.resizeLayers(frame, edges: edges, ended: ended) }
        inspectorDivider.vertical = true
        inspectorDivider.changed = { [weak self] delta in
            guard let self else { return }
            let width = max(220, min(500, self.inspectorWidth - delta))
            // An island kept from the left edge grows leftwards too: its left edge follows the pointer.
            if var spot = self.inspectorSpot, spot.left { spot.x = max(FloatingIsland.inset, spot.x + self.inspectorWidth - width); self.inspectorSpot = spot }
            self.inspectorWidth = width; self.layout(); self.saveSizes()
        }
        device.image = NSImage(contentsOfFile: host.directory + "/device.png")
        device.imageScaling = .scaleProportionallyUpOrDown
        device.isHidden = true
        host.canvas.addSubview(device, positioned: .below, relativeTo: host.views["preview"])
    }
    func saveSizes() {
        var sizes: [String: Any] = ["event":"native-layout-sizes", "source":Double(sourceHeight), "layers":Double(layersSize.height), "layersWidth":Double(layersSize.width), "inspector":Double(inspectorWidth)]
        if let layersSpot { sizes["layersX"] = Double(layersSpot.x); sizes["layersY"] = Double(layersSpot.y); sizes["layersCorner"] = layersSpot.corner }
        if let inspectorSpot { sizes["inspectorX"] = Double(inspectorSpot.x); sizes["inspectorCorner"] = inspectorSpot.corner }
        emit(sizes)
    }
    func restoreSizes(_ values: [String: Double]) {
        sourceHeight = min(1500, max(160, values["source"] ?? 380)); inspectorWidth = min(500, max(220, values["inspector"] ?? 300))
        // A docked panel's saved `layers` height (before LKM-179) becomes the island's height.
        layersSize = NSSize(width: min(800, max(LayersPlacement.minimum.width, values["layersWidth"] ?? LayersPlacement.standard.width)), height: min(1500, max(LayersPlacement.minimum.height, values["layers"] ?? LayersPlacement.standard.height)))
        // LKM-179 saved only layersX/layersY, from the top-right corner: corner 0.
        layersSpot = values["layersX"].flatMap { x in values["layersY"].map { IslandSpot(x: CGFloat(x), y: CGFloat($0), corner: values["layersCorner"] ?? 0) } }
        inspectorSpot = values["inspectorX"].map { IslandSpot(x: CGFloat($0), y: FloatingIsland.inset, corner: values["inspectorCorner"] ?? 0) }
        layout()
    }
    /// A header drag (LKM-180): kept inside the preview, snapped to its edges and the other
    /// island's, and on release moved off the other island to the nearest free place.
    func move(_ island: FloatingIsland, to frame: NSRect, ended: Bool) {
        guard let host, !island.isHidden else { return }
        let isLayers = island === host.layers, inner = previewArea.insetBy(dx: FloatingIsland.inset, dy: FloatingIsland.inset)
        // Stacked in the editing island's column, Layers goes where that island goes.
        if isLayers, layersMode == "stacked" || layersMode == "hidden" { return }
        if !isLayers, dragging == nil { heldLayers = host.layers.isHidden || layersMode == "stacked" ? nil : host.layers.frame }
        dragging = ended ? nil : island
        let other = isLayers ? (host.editingInspector.isHidden ? .zero : host.editingInspector.frame) : heldLayers ?? .zero
        var next = frame
        // The editing island keeps the preview's full height; only its side moves.
        if !isLayers { next.origin.y = inner.minY; next.size.height = inner.height }
        next = IslandPlacement.snap(IslandPlacement.clamp(next, to: inner), inner: inner, others: [other])
        // A drop onto the other island moves to the nearest free place, or home when there is none.
        let spot = (ended ? IslandPlacement.free(next, inner: inner, avoiding: other) : next).map { IslandSpot($0, in: previewArea) }
        if isLayers { layersSpot = spot } else { inspectorSpot = spot }
        if ended { heldLayers = nil }
        layout(); if ended { saveSizes() }
    }
    /// A header double-click or Reset Position: back to the island's default place.
    func resetPosition(_ island: FloatingIsland) {
        guard let host else { return }
        if island === host.layers { layersSpot = nil } else { inspectorSpot = nil }
        dragging = nil; heldLayers = nil; layout(); saveSizes()
    }
    /// Where the Layers island may grow: the preview, short of an editing island beside it.
    private func layersRoom() -> NSRect {
        guard let host else { return .zero }
        var room = previewArea.insetBy(dx: FloatingIsland.inset, dy: FloatingIsland.inset)
        let inspector = host.editingInspector.isHidden ? NSRect.zero : host.editingInspector.frame, layers = host.layers.frame
        guard !inspector.isEmpty, layersMode != "stacked", inspector.minY < layers.maxY, layers.minY < inspector.maxY else { return room }
        if inspector.minX >= layers.maxX { room.size.width = max(0, inspector.minX - LayersPlacement.gap - room.minX) }
        else if inspector.maxX <= layers.minX { let right = room.maxX; room.origin.x = inspector.maxX + LayersPlacement.gap; room.size.width = max(0, right - room.minX) }
        return room
    }
    func resizeLayers(_ frame: NSRect, edges: Set<NativeLayers.Edge>, ended: Bool) {
        guard let host, layersMode != "hidden" else { return }
        let region = layersRoom(), current = host.layers.frame
        let width = max(LayersPlacement.minimum.width, min(frame.width, edges.contains(.left) ? current.maxX - region.minX : region.maxX - current.minX))
        let height = max(LayersPlacement.minimum.height, min(frame.height, region.maxY - current.minY))
        layersSize = NSSize(width: layersMode == "stacked" ? layersSize.width : width, height: height)
        // A resized island stays where it is instead of re-centring under the button.
        if layersMode != "stacked" {
            let x = edges.contains(.left) ? current.maxX - width : current.minX
            layersSpot = IslandSpot(NSRect(x: x, y: current.minY, width: width, height: height), in: previewArea)
        }
        layout(); if ended { saveSizes() }
    }
    func width() -> CGFloat { min(desiredWidth, max(320, min(760, (host?.canvas.bounds.width ?? 1080) - 624))) }
    func update(_ state: [String: Any]) {
        let wasHidden = shellState["chatHidden"] as? Bool ?? false
        shellState = state
        let hidden = state["chatHidden"] as? Bool ?? false
        if hidden != wasHidden {
            animation?.invalidate()
            let from = fraction, target: CGFloat = hidden ? 0 : 1
            if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { fraction = target }
            else {
                let start = Date.timeIntervalSinceReferenceDate
                animation = Timer.scheduledTimer(withTimeInterval: 1 / 60, repeats: true) { [weak self] timer in
                    guard let self else { timer.invalidate(); return }
                    let progress = min(1, (Date.timeIntervalSinceReferenceDate - start) / 0.24)
                    let eased = 1 - pow(1 - progress, 3)
                    self.fraction = from + (target - from) * eased; self.layout()
                    if progress >= 1 { timer.invalidate(); self.animation = nil }
                }
            }
        }
        layout()
    }
    func resized(_ width: CGFloat) {
        desiredWidth = width
        layout()
        emit(["event":"native-layout-width", "width":Double(width)])
    }
    func nativeChatState() -> [String: Any] {
        guard let host else { return chatState }
        var state = chatState
        let full = width(), shown = full * fraction
        let visible = chatReady && shown > 60 && host.canvas.bounds.height > 30
        state["visible"] = visible
        state["bounds"] = ["x":0.0, "y":0.0, "width":Double(full), "height":Double(host.canvas.bounds.height)]
        return state
    }
    /// The selected project finished opening. Before that (opening, failed open) the
    /// column keeps its width, so nothing moves when the chat appears, but stays empty.
    var chatReady: Bool { shellState["project"] is String && shellState["chatReady"] as? Bool == true }
    func layout() {
        guard let host, !layingOut else { return }
        layingOut = true; defer { layingOut = false }
        let bounds = host.canvas.bounds
        let leading: CGFloat = shellState["project"] is String ? width() * fraction : 0
        host.shell.setChatGeometry(leading)
        let state = nativeChatState()
        host.chat.place(state, composer: host.composer)
        host.chat.isHidden = !(state["visible"] as? Bool ?? false)
        host.composer.isHidden = host.chat.isHidden
        host.chat.model.cat.show(!host.chat.isHidden)
        // Clip the disappearing column while retaining the text and glass layout.
        host.chatColumn.frame = NSRect(x: 0, y: 0, width: leading, height: bounds.height)
        host.chatColumn.isHidden = leading < 1 || !chatReady
        var dividerState = state
        dividerState["bounds"] = ["x":0, "y":0, "width":Double(leading), "height":Double(bounds.height)]
        host.chatDivider.update(dividerState)
        host.chatDivider.isHidden = host.chat.isHidden || fraction < 1
        // No docked column takes width from the preview: the inspector floats over it.
        let right: CGFloat = 0
        let bottom = host.dockedSource != nil ? min(sourceHeight, bounds.height * 0.8) : 0
        host.dockedSource?.frame = NSRect(x: leading, y: bounds.height - bottom, width: max(0, bounds.width - leading), height: bottom)
        // A docked Web Inspector lives in this slot (never over the chat); the page and island take the rest.
        host.inspectorSlot.frame = NSRect(x: leading, y: 0, width: max(0, bounds.width - leading - right), height: max(0, bounds.height - bottom))
        host.inspectorSlot.fit()
        let available = host.canvas.convert(host.inspectorSlot.page, from: host.inspectorSlot)
        // Opening and failed-open states own the whole content area, the chat column included.
        host.previewStatus.frame = chatReady ? available : NSRect(x: 0, y: 0, width: available.maxX, height: available.height)
        // Shown rulers take a strip at the top and left of the area (LKM-205).
        let ruler = host.previewOverlay?.inset ?? 0
        let pageArea = NSRect(x: available.minX + ruler, y: available.minY + ruler, width: max(0, available.width - ruler), height: max(0, available.height - ruler))
        var page = pageArea
        previewArea = available
        // The inspector floats over the preview, so opening it never reflows the page.
        let editing = !host.editingInspector.isHidden
        // A moved island that no longer fits the preview goes back to its default place.
        if editing, let spot = inspectorSpot, available.width > 0, NativeEditingInspector.moved(in: available, width: inspectorWidth, spot: spot) == nil { inspectorSpot = nil }
        var island = NativeEditingInspector.frame(in: available, width: inspectorWidth, visible: editing, spot: inspectorSpot)
        // The Layers island hangs under its toolbar button and never covers the editing island.
        layersAnchor = host.shell.toolbarButtonFrame("layers").map { host.canvas.convert(NSPoint(x: $0.midX, y: $0.midY), from: nil).x }
        var placed = LayersPlacement.frames(area: available, size: layersSize, spot: layersSpot, anchor: layersAnchor, visible: !host.layers.isHidden, inspector: island, dragging: dragging === host.layers)
        if let held = heldLayers, placed.mode != "hidden" { placed = LayersPlacement.Frames(layers: held, inspector: island, mode: layersMode, reset: false) }
        if placed.reset { layersSpot = nil }
        layersMode = placed.mode; island = placed.inspector
        host.editingInspector.place(island)
        host.layers.place(placed.layers)
        let mobile = viewportWidth == nil && shellState["viewport"] as? String == "mobile"
        var zoom: CGFloat = 1
        if let width = viewportWidth { (page, zoom) = PreviewAgent.frame(width: width, in: pageArea) }
        // Opening, setup and error own the content area: the last project's page must not cover them.
        let shown = previewVisible && host.previewStatus.isHidden
        device.isHidden = !mobile || !shown
        if mobile {
            let height = min(880, max(120, available.height - 32), max(120, available.width - 32) * 1252 / 606)
            let bezel = NSRect(x: available.midX - height * 606 / 1252 / 2, y: available.midY - height / 2, width: height * 606 / 1252, height: height)
            device.frame = bezel
            page = NSRect(x: bezel.minX + bezel.width * 0.0396, y: bezel.minY + bezel.height * 0.01677, width: bezel.width * (1 - 0.0396 - 0.04125), height: bezel.height * (1 - 0.01677 * 2))
        }
        if let preview = host.views["preview"] {
            preview.autoresizingMask = []; preview.frame = page
            if preview.pageZoom != zoom { preview.pageZoom = zoom }
            preview.layer?.cornerRadius = mobile ? page.width * 0.12 : 0
            preview.layer?.masksToBounds = mobile
            preview.isHidden = !shown || page.width <= 0 || page.height <= 0
        }
        // Loading and HTTP-error pill over the page (LKM-196), never over Opening or error states.
        host.previewLoad.place(in: page, visible: shown && host.views["preview"]?.isHidden == false)
        // Rulers along the preview area, zeroed at the page origin; guides and grids over the page (LKM-205).
        host.previewOverlay?.place(page: page, area: available, scale: zoom * (host.views["preview"]?.magnification ?? 1), radius: mobile ? page.width * 0.12 : 0, visible: shown && host.views["preview"]?.isHidden == false)
        host.speedBadge.place(in: page, visible: shown && host.views["preview"]?.isHidden == false)
        host.statesSwitcher.place(in: page, visible: shown && host.views["preview"]?.isHidden == false)
        let threeDInsets = host.threeD.place(in: page, visible: shown && host.views["preview"]?.isHidden == false)
        if host.threeD.active {
            host.canvas.addSubview(host.threeD.header, positioned: .above, relativeTo: nil)
            host.canvas.addSubview(host.threeD.footer, positioned: .above, relativeTo: nil)
        }
        if host.threeD.active { host.sendThreeDAppearance(threeDInsets.0, threeDInsets.1) }
        sourceDivider.isHidden = bottom == 0; sourceDivider.frame = NSRect(x: leading, y: bounds.height - bottom - 3, width: bounds.width - leading, height: 6)
        // Straddles the island's left edge below and above its rounded corners.
        let corner = min(NativeEditingInspector.cornerRadius, island.height / 2)
        inspectorDivider.isHidden = island.width == 0; inspectorDivider.frame = NSRect(x: island.minX - 3, y: island.minY + corner, width: 6, height: max(0, island.height - 2 * corner))
        for divider in [sourceDivider, inspectorDivider] { host.canvas.addSubview(divider, positioned: .above, relativeTo: nil); divider.window?.invalidateCursorRects(for: divider) }
        // The isolated preview owns the single readout, using CSS viewport pixels.
        host.previewSurface.needsDisplay = true
        // The page shields what the island covers; sent here, on change, never per pointer move.
        host.sendPreviewCover()
        if page != lastFrame || leading != lastLeading {
            lastFrame = page; lastLeading = leading
            emit(["event":"native-layout-frame", "frame":["x":Double(page.minX), "y":Double(page.minY), "width":Double(page.width), "height":Double(page.height), "radius":mobile ? Double(page.width * 0.12) : 0, "leading":Double(leading)]])
        }
    }
    func inspect() -> [String: Any] { ["native":true, "windowHeight":Double(host?.window.frame.height ?? 0), "canvasHeight":Double(host?.canvas.bounds.height ?? 0), "captureHeight":Double(host?.window.contentView?.superview?.bounds.height ?? 0), "width":Double(width()), "fraction":Double(fraction), "preview":NSStringFromRect(host?.views["preview"]?.frame ?? .zero), "panel":NSStringFromRect(host?.editingInspector.frame ?? .zero),
        "leading":Double(lastLeading), "chatReady":chatReady, "chatColumnHidden":host?.chatColumn.isHidden ?? true, "chatHidden":host?.chat.isHidden ?? true,
        "status":NSStringFromRect(host?.previewStatus.frame ?? .zero), "statusHidden":host?.previewStatus.isHidden ?? true, "previewHidden":host?.views["preview"]?.isHidden ?? true,"statusKind":host?.previewStatus.model.kind ?? ""] }
}
