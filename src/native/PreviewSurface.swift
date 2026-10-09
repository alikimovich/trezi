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
                "contentTop": content.maxY, "dividerHeight": bounds.height,
                "surfaceHeight": superview?.bounds.height ?? 0,
                "red": color.redComponent, "green": color.greenComponent, "blue": color.blueComponent]
    }
    override func draw(_ dirtyRect: NSRect) {
        guard let preview, let canvas, !preview.isHidden, preview.frame.width > 0, preview.frame.height > 0 else { return }
        let page = convert(preview.bounds, from: preview)
        let content = convert(canvas.bounds, from: canvas)
        // Mobile retains its device surround; only desktop fills the titlebar.
        if preview.layer?.cornerRadius == 0 {
            preview.underPageBackgroundColor.setFill()
            NSRect(x: page.minX, y: content.maxY, width: page.width, height: max(0, bounds.maxY - content.maxY)).fill()
        }
        NSColor.separatorColor.withAlphaComponent(0.12).setFill()
        let scale = window?.backingScaleFactor ?? 2
        let edge = preview.layer?.cornerRadius == 0 ? page.minX : (leading?() ?? page.minX)
        NSRect(x: (edge * scale).rounded() / scale, y: bounds.minY, width: 1 / scale, height: bounds.height).fill()
    }
    deinit { NotificationCenter.default.removeObserver(self) }
}
