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
    /// The Layers island's size and, once its header was dragged, its top-right corner
    /// relative to the preview's (LKM-179); nil hangs it under the Layers button.
    var layersSize = LayersPlacement.standard, layersOffset: NSPoint?
    /// How the island was last placed: hidden, anchored, beside, stacked or custom.
    private(set) var layersMode = "hidden"
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
        host.layers.moved = { [weak self] frame, ended in self?.moveLayers(frame, ended: ended) }
        host.layers.resized = { [weak self] frame, edges, ended in self?.resizeLayers(frame, edges: edges, ended: ended) }
        host.layers.reset = { [weak self] in guard let self else { return }; self.layersOffset = nil; self.layout(); self.saveSizes() }
        inspectorDivider.vertical = true
        inspectorDivider.changed = { [weak self] delta in guard let self else { return }; self.inspectorWidth = max(220, min(500, self.inspectorWidth - delta)); self.layout(); self.saveSizes() }
        device.image = NSImage(contentsOfFile: host.directory + "/device.png")
        device.imageScaling = .scaleProportionallyUpOrDown
        device.isHidden = true
        host.canvas.addSubview(device, positioned: .below, relativeTo: host.views["preview"])
    }
    func saveSizes() {
        var sizes: [String: Any] = ["event":"native-layout-sizes", "source":Double(sourceHeight), "layers":Double(layersSize.height), "layersWidth":Double(layersSize.width), "inspector":Double(inspectorWidth)]
        if let layersOffset { sizes["layersX"] = Double(layersOffset.x); sizes["layersY"] = Double(layersOffset.y) }
        emit(sizes)
    }
    func restoreSizes(_ values: [String: Double]) {
        sourceHeight = min(1500, max(160, values["source"] ?? 380)); inspectorWidth = min(500, max(220, values["inspector"] ?? 300))
        // A docked panel's saved `layers` height (before LKM-179) becomes the island's height.
        layersSize = NSSize(width: min(800, max(LayersPlacement.minimum.width, values["layersWidth"] ?? LayersPlacement.standard.width)), height: min(1500, max(LayersPlacement.minimum.height, values["layers"] ?? LayersPlacement.standard.height)))
        layersOffset = values["layersX"].flatMap { x in values["layersY"].map { NSPoint(x: x, y: $0) } }
        layout()
    }
    /// Where a dragged island may go: inside the preview, left of an open editing island.
    private func layersRegion() -> NSRect {
        guard let host else { return .zero }
        let inspector = NativeEditingInspector.frame(in: previewArea, width: inspectorWidth, visible: !host.editingInspector.isHidden)
        return LayersPlacement.region(inner: previewArea.insetBy(dx: NativeEditingInspector.inset, dy: NativeEditingInspector.inset), inspector: inspector)
    }
    func moveLayers(_ frame: NSRect, ended: Bool) {
        guard layersMode != "stacked", layersMode != "hidden" else { return }
        let next = LayersPlacement.clamp(frame, to: layersRegion())
        layersOffset = NSPoint(x: next.maxX - previewArea.maxX, y: next.minY - previewArea.minY)
        layout(); if ended { saveSizes() }
    }
    func resizeLayers(_ frame: NSRect, edges: Set<NativeLayers.Edge>, ended: Bool) {
        guard let host, layersMode != "hidden" else { return }
        let region = layersRegion(), current = host.layers.frame
        let width = max(LayersPlacement.minimum.width, min(frame.width, edges.contains(.left) ? current.maxX - region.minX : region.maxX - current.minX))
        let height = max(LayersPlacement.minimum.height, min(frame.height, region.maxY - current.minY))
        layersSize = NSSize(width: layersMode == "stacked" ? layersSize.width : width, height: height)
        // A resized island stays where it is instead of re-centring under the button.
        if layersMode != "stacked" {
            let x = edges.contains(.left) ? current.maxX - width : current.minX
            layersOffset = NSPoint(x: x + width - previewArea.maxX, y: current.minY - previewArea.minY)
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
        var page = available
        previewArea = available
        // The inspector floats over the preview, so opening it never reflows the page.
        var island = NativeEditingInspector.frame(in: available, width: inspectorWidth, visible: !host.editingInspector.isHidden)
        // The Layers island hangs under its toolbar button and never covers the editing island.
        layersAnchor = host.shell.toolbarButtonFrame("layers").map { host.canvas.convert(NSPoint(x: $0.midX, y: $0.midY), from: nil).x }
        let placed = LayersPlacement.frames(area: available, size: layersSize, offset: layersOffset, anchor: layersAnchor, visible: !host.layers.isHidden, inspector: island)
        if placed.reset { layersOffset = nil }
        layersMode = placed.mode; island = placed.inspector
        host.editingInspector.frame = island
        if host.layers.frame != placed.layers { host.layers.frame = placed.layers; host.window.invalidateCursorRects(for: host.layers) }
        let mobile = viewportWidth == nil && shellState["viewport"] as? String == "mobile"
        var zoom: CGFloat = 1
        if let width = viewportWidth { (page, zoom) = PreviewAgent.frame(width: width, in: available) }
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
