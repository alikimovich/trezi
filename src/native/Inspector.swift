import AppKit
import WebKit

/// Direct presentation is WebKit SPI. Keep it guarded and separate from the
/// untrusted preview bridge; public isInspectable still supports Safari fallback.
enum PreviewInspector {
    static func enable(_ preferences: WKPreferences) {
        if preferences.responds(to: NSSelectorFromString("_setDeveloperExtrasEnabled:")) {
            preferences.setValue(true, forKey: "developerExtrasEnabled")
        }
    }
    /// WebKit docks its inspector beside the attachment view, inside that view's superview,
    /// and resizes both to the superview's bounds. The default attachment view is the preview
    /// itself, whose superview is the whole window, so a docked inspector spanned the chat.
    static func confine(_ view: WKWebView, to slot: PreviewInspectorSlot) {
        let selector = NSSelectorFromString("_setInspectorAttachmentView:")
        guard view.responds(to: selector) else { return }
        view.perform(selector, with: slot.attachment)
    }
    static func controller(_ view: WKWebView?) -> NSObject? {
        let selector = NSSelectorFromString("_inspector")
        guard let view, view.responds(to: selector) else { return nil }
        return view.perform(selector)?.takeUnretainedValue() as? NSObject
    }
    /// `show` keeps WebKit's own docked/detached choice: a docked inspector stays in the preview slot.
    @discardableResult static func perform(_ action: String, on view: WKWebView?) -> Bool {
        guard ["show", "showConsole", "close", "attach", "detach"].contains(action), let inspector = controller(view) else { return false }
        let selector = NSSelectorFromString(action)
        guard inspector.responds(to: selector) else { return false }
        inspector.perform(selector)
        return true
    }
    static func status(_ view: WKWebView?) -> [String: Any] {
        guard let inspector = controller(view) else { return ["available":false, "visible":false] }
        return ["available":true, "visible":inspector.value(forKey: "isVisible") as? Bool ?? false,
                "inspectable":view?.isInspectable ?? false]
    }
}

/// The preview area (right of the chat, below the toolbar, above a docked source editor).
/// Unflipped, as WebKit's docking math expects. It passes the pointer through everywhere
/// except a docked inspector; the page itself is laid out into `page` (LKM-129).
final class PreviewInspectorSlot: NSView {
    let attachment = NSView()
    var changed: (() -> Void)?
    override init(frame: NSRect) {
        super.init(frame: frame)
        attachment.autoresizingMask = [.width, .height]; addSubview(attachment)
        attachment.postsFrameChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(attachmentChanged), name: NSView.frameDidChangeNotification, object: attachment)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    deinit { NotificationCenter.default.removeObserver(self) }
    /// The inspector's own web view while WebKit has it docked here.
    var docked: NSView? { subviews.first { $0 !== attachment } }
    /// The whole slot, or the part WebKit leaves beside a docked inspector.
    var page: NSRect { docked == nil ? bounds : attachment.frame.intersection(bounds) }
    /// Undocked, the attachment view fills the slot so the next dock starts from the full area.
    func fit() { if docked == nil, attachment.frame != bounds { attachment.frame = bounds } }
    override func hitTest(_ point: NSPoint) -> NSView? { let hit = super.hitTest(point); return hit === self || hit === attachment ? nil : hit }
    override func didAddSubview(_ subview: NSView) { super.didAddSubview(subview); attachmentChanged() }
    override func willRemoveSubview(_ subview: NSView) { super.willRemoveSubview(subview); attachmentChanged() }
    // WebKit docks, undocks and resizes asynchronously; relayout once it has.
    @objc private func attachmentChanged() { DispatchQueue.main.async { [weak self] in self?.changed?() } }
}

extension Host {
    @objc func showPreviewInspector(_ sender: NSMenuItem) {
        if !PreviewInspector.perform(sender.representedObject as? String ?? "show", on: views["preview"]) {
            let alert = NSAlert()
            alert.messageText = "Open Web Inspector from Safari"
            alert.informativeText = "This WebKit version cannot open an inspector directly. In Safari, enable developer features in Settings → Advanced, then use Develop → this Mac → Trezi to inspect the preview."
            alert.beginSheetModal(for: window)
        }
    }
    /// Test-only geometry in window coordinates: the docked inspector, the slot, the page, the chat column and the editing island.
    func previewInspectorReport() -> [String: Any] {
        var report = PreviewInspector.status(views["preview"])
        nativeLayout.layout()
        func frame(_ view: NSView?) -> [String: Double] {
            guard let view, !view.isHidden, view.window != nil else { return ["x":0, "y":0, "width":0, "height":0] }
            let r = view.convert(view.bounds, to: nil)
            return ["x":Double(r.minX), "y":Double(r.minY), "width":Double(r.width), "height":Double(r.height)]
        }
        func target(_ view: NSView?) -> String {
            guard let view, !view.isHidden else { return "none" }
            let r = view.convert(view.bounds, to: nil)
            // The bottom-left, where the full-width inspector used to cover the transcript and composer.
            let point = NSPoint(x: r.minX + min(40, r.width / 2), y: r.minY + min(40, r.height / 2))
            // The frame view is the window's root, so it takes window coordinates.
            guard let hit = window.contentView?.superview?.hitTest(point) else { return "none" }
            if let docked = inspectorSlot.docked, hit.isDescendant(of: docked) { return "inspector" }
            if hit.isDescendant(of: chatColumn) { return "chat" }
            if let page = views["preview"], hit.isDescendant(of: page) { return "preview" }
            return String(describing: type(of: hit))
        }
        report["attached"] = inspectorSlot.docked != nil
        report["inspector"] = frame(inspectorSlot.docked); report["area"] = frame(inspectorSlot); report["page"] = frame(views["preview"])
        report["chat"] = frame(chatColumn); report["island"] = frame(editingInspector)
        report["hits"] = ["chat":target(chatColumn), "inspector":target(inspectorSlot.docked)]
        report["contentTop"] = Double(window.contentLayoutRect.maxY)
        report["window"] = ["width":Double(window.frame.width), "height":Double(window.frame.height)]
        report["minWindow"] = ["width":Double(window.minSize.width), "height":Double(window.minSize.height)]
        return report
    }
}
