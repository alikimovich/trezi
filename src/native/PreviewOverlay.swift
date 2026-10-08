import AppKit
import SwiftUI
import WebKit

/// Rulers, guides and layout grids over the preview (LKM-205), drawn by native views
/// above the web view: the page's DOM and CSS never change, and the page keeps its
/// input everywhere except on a ruler or within a few points of an unlocked guide.
/// Settings belong to a project and viewport; main stores them and sends them back when
/// either changes (`preview-overlay-controller.ts`). The page reports its scroll, viewport
/// and selection while anything is shown (`src/preview/overlay-guides.ts`). Pure math:
/// `PreviewOverlayModel.swift`; drawing: `PreviewRulers.swift`; popover:
/// `PreviewOverlayPanel.swift`. Guides show with the rulers; ⇧⌘R toggles both.
final class PreviewOverlay: NSObject, ObservableObject, NSMenuItemValidation {
    weak var host: Host?
    @Published private(set) var state = OverlayState()
    /// The project and viewport the settings belong to; nil without an open project.
    private(set) var key: String?
    private(set) var viewport = "desktop"
    struct Page: Equatable { var scrollX = 0.0, scrollY = 0.0, width = 0.0, height = 0.0; var selection: CGRect? }
    private(set) var page = Page()
    let guides = PreviewGuideView()
    let top = PreviewRuler(vertical: false), left = PreviewRuler(vertical: true)
    let corner = PreviewRulerCorner()
    static let thickness: CGFloat = 16
    /// Points per CSS pixel, and the page's frame in canvas coordinates.
    private(set) var scale: CGFloat = 1
    private(set) var frame = NSRect.zero
    private(set) var shown = false
    /// The pointer over the page, in the guide view's coordinates, for the ruler markers.
    private(set) var pointer: NSPoint?
    struct Drag { var id: String?; var axis: String; var position: Double; var snapped = false; var removing = false }
    private(set) var drag: Drag?
    private(set) var selected: String?
    /// Element rects in the overlay's space, read from the page when a drag starts.
    private var snapRects: [CGRect] = []
    private(set) var snapLoad: Task<Void, Never>?
    private var lines: NSDictionary?
    let popover = NSPopover()

    init(host: Host) {
        self.host = host
        super.init()
        for view in [guides, top, left] as [NSView] { view.isHidden = true }
        corner.isHidden = true
        guides.overlay = self; top.overlay = self; left.overlay = self
        // Over the page and the docked inspector slot, under the status, islands and chat.
        host.canvas.addSubview(guides, positioned: .above, relativeTo: host.inspectorSlot)
        host.canvas.addSubview(top, positioned: .above, relativeTo: guides)
        host.canvas.addSubview(left, positioned: .above, relativeTo: top)
        host.canvas.addSubview(corner, positioned: .above, relativeTo: left)
        popover.behavior = .transient
        host.shell.overlayAction = { [weak self] in self?.togglePanel() }
    }

    // MARK: State

    /// Settings for a project and viewport from main, never echoed back.
    func apply(_ c: [String: Any]) {
        let next = c["key"] as? String
        if next != key { drag = nil; selected = nil; page.selection = nil; if popover.isShown, next == nil { popover.close() } }
        key = next; viewport = c["viewport"] as? String == "mobile" ? "mobile" : "desktop"
        state = OverlayState(json: c["state"] as? [String: Any] ?? [:])
        host?.nativeLayout.layout()
    }
    /// A user change: clamped like stored settings, then saved by main and redrawn.
    func update(_ change: (inout OverlayState) -> Void) {
        guard let key else { return }
        var next = state; change(&next)
        next = OverlayState(json: next.json())
        guard next != state else { return }
        state = next
        if let selected, !state.guides.contains(where: { $0.id == selected }) { self.selected = nil }
        emit(["event":"preview-overlay", "key":key, "state":state.json()])
        host?.nativeLayout.layout()
    }
    @objc func toggleRulers(_ sender: Any?) { update { $0.rulers.toggle() } }
    @objc func toggleGrid(_ sender: Any?) {
        let preset = OverlayMath.presets[viewport == "mobile" ? 1 : 0].grid
        update { $0.gridVisible.toggle(); if $0.gridVisible && $0.grids.isEmpty { $0.grids = [preset] } }
    }
    @objc func toggleLock(_ sender: Any?) { update { $0.locked.toggle() } }
    @objc func toggleFixed(_ sender: Any?) { update { $0.fixed.toggle() } }
    @objc func clearGuides(_ sender: Any?) { update { $0.guides = [] } }
    func addGrid(_ grid: OverlayGrid) { update { $0.gridVisible = true; if $0.grids.count < OverlayState.maxGrids { $0.grids.append(grid) } } }
    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        switch item.action {
        case #selector(toggleRulers(_:)): item.state = state.rulers ? .on : .off
        case #selector(toggleGrid(_:)): item.state = state.gridVisible ? .on : .off
        case #selector(toggleLock(_:)): item.state = state.locked ? .on : .off
        case #selector(toggleFixed(_:)): item.state = state.fixed ? .on : .off
        case #selector(clearGuides(_:)): return key != nil && !state.guides.isEmpty
        default: break
        }
        return key != nil
    }
    /// View menu items; the shortcuts route through the menu like every native shortcut.
    /// ⇧⌘R is the uppercase "R": a shifted key event's characters are uppercase, and a
    /// lowercase "r" would leave it to Reload Preview (⌘R).
    func menuItems() -> [NSMenuItem] {
        [("Show Rulers", #selector(toggleRulers(_:)), "R", NSEvent.ModifierFlags([.command, .shift])),
         ("Show Layout Grid", #selector(toggleGrid(_:)), "g", NSEvent.ModifierFlags.control),
         ("Lock Guides", #selector(toggleLock(_:)), "", []),
         ("Guides Fixed to Viewport", #selector(toggleFixed(_:)), "", []),
         ("Clear Guides", #selector(clearGuides(_:)), "", [])].map { title, action, key, mask in
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
            item.keyEquivalentModifierMask = mask; item.target = self
            return item
        }
    }
    func togglePanel() {
        guard let host, let window = host.window, let theme = window.contentView?.superview else { return }
        if popover.isShown { popover.close(); return }
        guard key != nil, let button = host.shell.toolbarButtonFrame("overlay") else { return }
        if popover.contentViewController == nil {
            let controller = NSHostingController(rootView: PreviewOverlayPanel(overlay: self))
            controller.sizingOptions = .preferredContentSize
            popover.contentViewController = controller
        }
        popover.show(relativeTo: theme.convert(button, from: nil), of: theme, preferredEdge: theme.isFlipped ? .maxY : .minY)
    }

    // MARK: Geometry

    /// Called from `WorkspaceLayout.layout()`: the page frame, the preview area beside it
    /// (where the rulers go), the page scale and the bezel's corner radius.
    func place(page pageFrame: NSRect, area: NSRect, scale pageScale: CGFloat, radius: CGFloat, visible: Bool) {
        frame = pageFrame; scale = max(pageScale, 0.01)
        shown = visible && key != nil && pageFrame.width > 0 && pageFrame.height > 0
        if !shown { drag = nil }
        guides.frame = pageFrame
        guides.wantsLayer = true; guides.layer?.cornerRadius = radius; guides.layer?.masksToBounds = radius > 0
        let t = Self.thickness
        top.frame = NSRect(x: area.minX, y: area.minY, width: area.width, height: t)
        left.frame = NSRect(x: area.minX, y: area.minY, width: t, height: area.height)
        corner.frame = NSRect(x: area.minX, y: area.minY, width: t, height: t)
        let rulers = shown && state.rulers
        for view in [top, left, corner] as [NSView] where view.isHidden == rulers { view.isHidden = !rulers }
        let hidden = !shown || (!state.rulers && state.shownGrids.isEmpty)
        if guides.isHidden != hidden { guides.isHidden = hidden; guides.window?.invalidateCursorRects(for: guides) }
        redraw(); sendLines()
    }
    /// The room the rulers take from the page area: they sit beside the page, never over
    /// it, so a guide can go anywhere on the page and dropping on a ruler removes it.
    var inset: CGFloat { key != nil && state.rulers ? Self.thickness : 0 }
    func redraw() { guides.needsDisplay = true; top.needsDisplay = true; left.needsDisplay = true }
    /// The viewport width the columns divide, as the page reported it.
    var viewportWidth: Double { page.width > 0 ? page.width : Double(frame.width / scale) }
    func view(_ css: Double, axis: String) -> CGFloat {
        CGFloat(OverlayMath.toView(css, scroll: axis == "x" ? page.scrollX : page.scrollY, scale: Double(scale), fixed: state.fixed))
    }
    func css(_ view: CGFloat, axis: String) -> Double {
        OverlayMath.toCSS(Double(view), scroll: axis == "x" ? page.scrollX : page.scrollY, scale: Double(scale), fixed: state.fixed)
    }
    /// What the page reports (`trezi:preview:overlay-geometry`), taken by the host directly.
    func receive(_ args: Any?) {
        guard let raw = (args as? [Any])?.first as? [String: Any] else { return }
        func value(_ key: String, _ from: [String: Any] = raw) -> Double { OverlayMath.clamp(OverlayMath.finite(from[key]) ?? 0, -1e6, 1e6) }
        var next = Page(scrollX: value("scrollX"), scrollY: value("scrollY"), width: max(0, value("width")), height: max(0, value("height")))
        if let s = raw["selection"] as? [String: Any] {
            next.selection = CGRect(x: value("left", s), y: value("top", s), width: max(0, value("right", s) - value("left", s)), height: max(0, value("bottom", s) - value("top", s)))
        }
        guard next != page else { return }
        page = next; redraw(); sendLines()
    }
    /// The lines the page labels hover distances to, and whether it should report geometry.
    func sendLines() {
        var x: [Double] = [], y: [Double] = [], periods: [[String: Any]] = []
        if shown {
            if state.rulers { for guide in state.guides { if guide.axis == "x" { x.append(guide.position) } else { y.append(guide.position) } } }
            for grid in state.shownGrids {
                switch grid.kind {
                case "columns": for column in OverlayMath.columns(grid, width: viewportWidth) { x += [column.start, column.start + column.width].map { ($0 * 100).rounded() / 100 } }
                case "rows": periods.append(["axis":"y", "step":grid.step, "offset":grid.offset])
                default: periods += ["x", "y"].map { ["axis":$0, "step":grid.size, "offset":0.0] }
                }
            }
        }
        let report = shown && (state.rulers || !state.shownGrids.isEmpty)
        let value: NSDictionary = ["report":report, "fixed":state.fixed, "x":x, "y":y, "periods":periods]
        guard value != lines else { return }
        lines = value
        emit(["event":"preview-overlay-lines", "lines":value])
    }

    // MARK: Guides

    /// The unlocked guide within grabbing distance of a point in the guide view.
    func guide(at point: NSPoint) -> OverlayGuide? {
        guard shown, state.rulers, !state.locked, drag == nil else { return nil }
        return state.guides.last { abs((($0.axis == "x") ? point.x : point.y) - view($0.position, axis: $0.axis)) <= 3 }
    }
    func moved(_ point: NSPoint?) {
        guard pointer != point else { return }
        pointer = point
        if state.rulers { top.needsDisplay = true; left.needsDisplay = true }
        if let point, let guide = guide(at: point) { (guide.axis == "x" ? NSCursor.resizeLeftRight : NSCursor.resizeUpDown).set() }
    }
    func select(_ id: String?) { guard selected != id else { return }; selected = id; guides.needsDisplay = true }
    @discardableResult func deleteSelected() -> Bool {
        guard let selected, !state.locked, state.guides.contains(where: { $0.id == selected }) else { return false }
        update { $0.guides.removeAll { $0.id == selected } }
        return true
    }
    /// A drag from a ruler creates a guide (the top ruler a horizontal one, the left ruler a
    /// vertical one); a drag on a guide moves it. Window coordinates.
    func grab(axis: String, id: String?, at point: NSPoint) {
        guard shown, state.rulers, id == nil || !state.locked else { return }
        let existing = id.flatMap { id in state.guides.first { $0.id == id } }
        drag = Drag(id: existing?.id, axis: axis, position: existing?.position ?? 0)
        selected = existing?.id
        guides.window?.makeFirstResponder(guides)
        loadSnapTargets()
        dragged(to: point)
    }
    func dragged(to point: NSPoint) {
        guard var drag, let host else { return }
        let local = guides.convert(point, from: nil), canvas = host.canvas.convert(point, from: nil)
        pointer = local
        let threshold = 5 / Double(scale)
        let raw = css(drag.axis == "x" ? local.x : local.y, axis: drag.axis)
        let here = CGPoint(x: css(local.x, axis: "x"), y: css(local.y, axis: "y"))
        let lines = OverlayMath.gridLines(state.shownGrids, axis: drag.axis, viewport: viewportWidth, in: (raw - threshold)...(raw + threshold))
        let snap = OverlayMath.snap(raw, candidates: OverlayMath.elementCandidates(snapRects, axis: drag.axis, point: here, threshold: threshold) + lines, threshold: threshold)
        drag.position = snap.value; drag.snapped = snap.snapped
        // Back onto its ruler, or off the page, removes the guide on release.
        drag.removing = drag.axis == "x"
            ? canvas.x < max(frame.minX, left.isHidden ? frame.minX : left.frame.maxX) || canvas.x > frame.maxX
            : canvas.y < max(frame.minY, top.isHidden ? frame.minY : top.frame.maxY) || canvas.y > frame.maxY
        self.drag = drag
        redraw()
    }
    func released(at point: NSPoint) {
        dragged(to: point)
        guard let drag else { return }
        self.drag = nil; snapLoad?.cancel(); snapLoad = nil; snapRects = []
        if drag.removing {
            if let id = drag.id { update { $0.guides.removeAll { $0.id == id } } }
            selected = nil; redraw(); return
        }
        let id = drag.id ?? "g" + UUID().uuidString.prefix(8).lowercased()
        update { state in
            if let index = state.guides.firstIndex(where: { $0.id == id }) { state.guides[index].position = drag.position }
            else if state.guides.count < OverlayState.maxGuides { state.guides.append(OverlayGuide(id: id, axis: drag.axis, position: drag.position)) }
        }
        selected = id; redraw()
    }
    /// Visible element rects for snapping, read once per drag from the isolated world;
    /// never while the page navigates (evaluating then trips WebKit's executor check).
    private func loadSnapTargets() {
        snapRects = []; snapLoad?.cancel(); snapLoad = nil
        guard let host, let view = host.views["preview"], !view.isLoading, view.url != nil else { return }
        let world = host.world, fixed = state.fixed
        snapLoad = Task { @MainActor [weak self] in
            guard let json = try? await view.callAsyncJavaScript(Self.rectsScript, arguments: [:], in: nil, contentWorld: world) as? String,
                  let values = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [Double], values.count >= 2, let self, !Task.isCancelled, self.drag != nil else { return }
            let dx = fixed ? 0 : values[0], dy = fixed ? 0 : values[1]
            self.snapRects = stride(from: 2, to: values.count - 3, by: 4).map { CGRect(x: values[$0] + dx, y: values[$0 + 1] + dy, width: values[$0 + 2], height: values[$0 + 3]) }
        }
    }
    /// Trezi's own instrumentation is skipped; at most 4000 elements in the viewport.
    static let rectsScript = """
    const skip = '[data-trezi-overlay],[data-trezi-cover],[data-trezi-viewport-size],[data-trezi-frame],[data-trezi-status],[data-trezi-composer]'
    const out = [scrollX, scrollY], W = innerWidth, H = innerHeight
    for (const el of document.querySelectorAll('body, body *')) {
      if (out.length >= 16002) break
      if (el.closest(skip)) continue
      const r = el.getBoundingClientRect()
      if ((r.width <= 0 && r.height <= 0) || r.bottom < 0 || r.right < 0 || r.top > H || r.left > W) continue
      out.push(r.left, r.top, r.width, r.height)
    }
    return JSON.stringify(out)
    """
}
