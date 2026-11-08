import AppKit
import WebKit

/// Only extends the page's paint, never its viewport or hit-testing area.
/// WebKit derives this color from html/body and updates it when the page changes.
final class PreviewSurface: NSView {
    weak var preview: WKWebView?
    weak var canvas: NSView?
    var colorChanged: ((NSColor) -> Void)?
    var leading: (() -> CGFloat)?
    private var observations: [NSKeyValueObservation] = []
    /// LKM-559: the top bar splits at the rule (`NativeShell.toolbarSplitClear`); when it does
    /// not, the rule spans the pane body only, never under a toolbar control.
    private(set) var toolbarSplitClear = true
    func toolbarSplitChanged(_ clear: Bool) { guard clear != toolbarSplitClear else { return }; toolbarSplitClear = clear; needsDisplay = true }

    init(preview: WKWebView, canvas: NSView, container: NSView) {
        self.preview = preview; self.canvas = canvas
        super.init(frame: container.bounds)
        wantsLayer = true
        autoresizingMask = [.width, .height]
        container.addSubview(self, positioned: .above, relativeTo: canvas)
        observations = [
            preview.observe(\.underPageBackgroundColor, options: [.new]) { [weak self] view, _ in
                self?.needsDisplay = true; self?.colorChanged?(view.underPageBackgroundColor)
            },
            preview.observe(\.isHidden, options: [.new]) { [weak self] _, _ in self?.needsDisplay = true }
        ]
        preview.postsFrameChangedNotifications = true
        canvas.postsFrameChangedNotifications = true
        for view in [preview, canvas] {
            NotificationCenter.default.addObserver(self, selector: #selector(changed), name: NSView.frameDidChangeNotification, object: view)
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    @objc private func changed() { needsDisplay = true }
    func inspect() -> [String: Any] {
        guard let preview, let canvas else { return [:] }
        let page = convert(preview.bounds, from: preview)
        let content = convert(canvas.bounds, from: canvas)
        let color = preview.underPageBackgroundColor.usingColorSpace(.deviceRGB) ?? .white
        return ["toolbarHeight": bounds.maxY - content.maxY, "viewportTop": page.maxY,
                "contentTop": content.maxY, "dividerHeight": dividerTop - bounds.minY,
                "surfaceHeight": superview?.bounds.height ?? 0,
                "dividerDrawn": dividerEdge() != nil, "dividerTop": dividerTop, "contentTopInSurface": content.maxY,
                "dividerSpansTopBar": toolbarSplitClear, "dividerX": dividerEdge() ?? -1,
                "dividerWindowX": dividerEdge().map { convert(NSPoint(x: $0, y: 0), to: nil).x } ?? -1,
                "dividerWindowMinX": dividerRule().map { convert(NSPoint(x: $0.minX, y: 0), to: nil).x } ?? -1,
                "dividerWindowMaxX": dividerRule().map { convert(NSPoint(x: $0.maxX, y: 0), to: nil).x } ?? -1,
                "backingScale": window?.backingScaleFactor ?? 2,
                "pageX": page.minX, "paneX": bounds.minX,
                "red": color.redComponent, "green": color.greenComponent, "blue": color.blueComponent]
    }
    /// The chat/preview rule's x in this view, or nil when nothing draws it. LKM-559: it
    /// follows the chat column, so it shows while the preview opens or failed to open,
    /// not only once a page is shown. Without a chat column it edges the pane: a desktop page
    /// fills the pane from that edge; a mobile page sits centred in its device surround, so the
    /// rule never moves onto the phone screen's edge (through the frame and the top bar).
    func dividerEdge() -> CGFloat? {
        guard let preview, let canvas else { return nil }
        let column = leading?() ?? 0
        if column >= 1 { return convert(NSPoint(x: column, y: 0), from: canvas).x }
        guard pageShown else { return nil }
        return preview.layer?.cornerRadius == 0 ? convert(preview.bounds, from: preview).minX : bounds.minX
    }
    /// LKM-587: the rule is one point thick (an even device-pixel count at 2x), centred on the
    /// edge and snapped to device pixels.
    /// AppKit's abutting toolbar slots put an even number of device pixels between New Chat's
    /// glass and the viewport island's (14 px at 2x), so a one-pixel hairline left them 7 px and
    /// 6 px away; an even-width rule centred on the pane boundary leaves the same gap each side.
    func dividerRule() -> NSRect? {
        guard let edge = dividerEdge() else { return nil }
        let scale = window?.backingScaleFactor ?? 2
        let pixels = max(1, scale.rounded())
        let minX = (edge * scale - pixels / 2).rounded() / scale
        return NSRect(x: minX, y: bounds.minY, width: pixels / scale, height: max(0, dividerTop - bounds.minY))
    }
    /// Through the top bar when it splits at the rule, else up to the pane body's top.
    private var dividerTop: CGFloat { toolbarSplitClear || canvas == nil ? bounds.maxY : convert(canvas!.bounds, from: canvas).maxY }
    private var pageShown: Bool { preview.map { !$0.isHidden && $0.frame.width > 0 && $0.frame.height > 0 } ?? false }
    override func draw(_ dirtyRect: NSRect) {
        guard let preview, let canvas else { return }
        let content = convert(canvas.bounds, from: canvas)
        // Mobile retains its device surround; only desktop fills the titlebar.
        if pageShown, preview.layer?.cornerRadius == 0 {
            let page = convert(preview.bounds, from: preview)
            preview.underPageBackgroundColor.setFill()
            NSRect(x: page.minX, y: content.maxY, width: page.width, height: max(0, bounds.maxY - content.maxY)).fill()
        }
        guard let rule = dividerRule() else { return }
        NSColor.separatorColor.withAlphaComponent(0.12).setFill()
        rule.fill()
    }
    deinit { NotificationCenter.default.removeObserver(self) }
}
