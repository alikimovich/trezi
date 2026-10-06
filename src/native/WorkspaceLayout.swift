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
    let sourceDivider = NativePanelDivider(), layersDivider = NativePanelDivider(), inspectorDivider = NativePanelDivider()
    var sourceHeight: CGFloat = 380, layersHeight: CGFloat = 260, inspectorWidth: CGFloat = 300
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
        for divider in [sourceDivider, layersDivider, inspectorDivider] { divider.isHidden = true; host.canvas.addSubview(divider) }
        sourceDivider.changed = { [weak self] delta in guard let self else { return }; self.sourceHeight = max(160, min((self.host?.canvas.bounds.height ?? 700) * 0.8, self.sourceHeight + delta)); self.layout(); self.saveSizes() }
        layersDivider.changed = { [weak self] delta in guard let self else { return }; self.layersHeight = max(100, min((self.host?.canvas.bounds.height ?? 700) * 0.7, self.layersHeight - delta)); self.layout(); self.saveSizes() }
        inspectorDivider.vertical = true
        inspectorDivider.changed = { [weak self] delta in guard let self else { return }; self.inspectorWidth = max(220, min(500, self.inspectorWidth - delta)); self.layout(); self.saveSizes() }
        device.image = NSImage(contentsOfFile: host.directory + "/device.png")
        device.imageScaling = .scaleProportionallyUpOrDown
        device.isHidden = true
        host.canvas.addSubview(device, positioned: .below, relativeTo: host.views["preview"])
    }
    func saveSizes() { emit(["event":"native-layout-sizes", "source":Double(sourceHeight), "layers":Double(layersHeight), "inspector":Double(inspectorWidth)]) }
    func restoreSizes(_ values: [String: Double]) {
        sourceHeight = min(1500, max(160, values["source"] ?? 380)); layersHeight = min(1500, max(100, values["layers"] ?? 260)); inspectorWidth = min(500, max(220, values["inspector"] ?? 300)); layout()
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
        let top: CGFloat = host.layers.isHidden ? 0 : min(layersHeight, host.canvas.bounds.height * 0.7)
        let full = width(), shown = full * fraction
        let visible = chatReady && shown > 60 && host.canvas.bounds.height > 30
        state["visible"] = visible
        state["bounds"] = ["x":0.0, "y":Double(top), "width":Double(full), "height":Double(max(0, host.canvas.bounds.height - top))]
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
        host.layers.frame = NSRect(x: 0, y: 0, width: leading, height: host.layers.isHidden ? 0 : min(layersHeight, bounds.height * 0.7))
        host.canvas.addSubview(host.layers, positioned: .above, relativeTo: host.chatColumn)
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
        let island = NativeEditingInspector.frame(in: available, width: inspectorWidth, visible: !host.editingInspector.isHidden)
        host.editingInspector.frame = island
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
        layersDivider.isHidden = host.layers.isHidden; layersDivider.frame = NSRect(x: 0, y: host.layers.frame.maxY - 3, width: leading, height: 6)
        // Straddles the island's left edge below and above its rounded corners.
        let corner = min(NativeEditingInspector.cornerRadius, island.height / 2)
        inspectorDivider.isHidden = island.width == 0; inspectorDivider.frame = NSRect(x: island.minX - 3, y: island.minY + corner, width: 6, height: max(0, island.height - 2 * corner))
        for divider in [sourceDivider, layersDivider, inspectorDivider] { host.canvas.addSubview(divider, positioned: .above, relativeTo: nil); divider.window?.invalidateCursorRects(for: divider) }
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
