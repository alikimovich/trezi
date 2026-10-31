import AppKit

/// LKM-391: one Mark up session, from the capture to Add or Cancel. Bun issues the session
/// token, bound to a chat and project, and ends it when they change; a capture or answer for
/// any other token is dropped. The snapshot exists only in memory, inside the overlay: Cancel
/// releases it and leaves no file, and only the composite ever leaves this class.
final class PreviewMarkup {
    struct Captured {
        let image: CGImage
        /// `url`, CSS viewport, zoom and scroll at the moment of capture.
        let context: [String: Any]
    }
    struct Failure: Error { let message: String }
    typealias Capture = (@escaping (Result<Captured, Failure>) -> Void) -> Void

    private let parent: NSView
    private let emit: ([String: Any]) -> Void
    private let refusal: () -> String?
    private let capture: Capture
    private let restoreFocus: (NSResponder?) -> Void
    private let changed: () -> Void
    private let budget: Int
    private(set) var session: String?
    private(set) var overlay: PreviewMarkupOverlay?
    private(set) var context: [String: Any] = [:]
    private var area: NSRect?
    private weak var previousFocus: NSResponder?

    init(parent: NSView, emit: @escaping ([String: Any]) -> Void, refusal: @escaping () -> String?, capture: @escaping Capture,
         restoreFocus: @escaping (NSResponder?) -> Void, changed: @escaping () -> Void, budget: Int = MarkupEncoder.budget) {
        self.parent = parent; self.emit = emit; self.refusal = refusal; self.capture = capture
        self.restoreFocus = restoreFocus; self.changed = changed; self.budget = budget
    }
    private func report(_ session: String, _ state: String, message: String? = nil) {
        var event: [String: Any] = ["event":"markup-state", "session":session, "state":state]
        if let message { event["message"] = message }
        emit(event)
    }
    func begin(_ token: String) {
        guard session == nil else { report(token, "failed", message: "A mark up is already open."); return }
        if let message = refusal() { report(token, "failed", message: message); return }
        session = token
        capture { [weak self] result in
            guard let self, self.session == token else { return }
            switch result {
            case .success(let captured): self.open(captured, token)
            case .failure(let failure):
                self.session = nil
                self.report(token, "failed", message: failure.message)
            }
        }
    }
    private func open(_ captured: Captured, _ token: String) {
        let view = PreviewMarkupOverlay(image: captured.image)
        context = captured.context
        previousFocus = parent.window?.firstResponder
        view.onCancel = { [weak self] in self?.cancel() }
        view.onAdd = { [weak self] in self?.add() }
        view.frame = area ?? parent.bounds
        // Above the floating islands and the page: the snapshot is all there is to click.
        parent.addSubview(view, positioned: .above, relativeTo: nil)
        overlay = view
        view.layoutSubtreeIfNeeded()
        // The overlay takes the keys, so preview shortcuts never reach the page.
        parent.window?.makeFirstResponder(view)
        changed()
        report(token, "open")
    }
    private func close() {
        overlay?.removeFromSuperview()
        overlay = nil; session = nil; context = [:]
        changed()
    }
    /// Discards everything; nothing was written, so nothing is left to clean.
    func cancel() {
        guard let token = session else { return }
        let focus = previousFocus
        close()
        restoreFocus(focus)
        report(token, "cancelled")
    }
    /// Bun's discard: the chat or project changed.
    func end(_ token: String) {
        guard session == token else { return }
        close()
    }
    func add() {
        guard let overlay, let token = session, overlay.addEnabled else { return }
        overlay.show(error: nil)
        let canvas = overlay.canvas
        guard let encoded = MarkupEncoder.encode(canvas.image, marks: canvas.document.marks, budget: budget) else {
            overlay.show(error: "Mark up could not make an image small enough to send. Nothing was added.")
            return
        }
        overlay.adding = true
        var capture = context
        capture["imageWidth"] = encoded.width; capture["imageHeight"] = encoded.height
        emit(["event":"markup-add", "session":token, "name":encoded.name, "type":encoded.type,
              "data":encoded.data.base64EncodedString(), "capture":capture])
    }
    /// Bun's answer to `markup-add`. A refusal keeps the marks and shows why.
    func finished(_ token: String, ok: Bool, message: String?) {
        guard session == token, let overlay else { return }
        if ok { close(); return }
        overlay.adding = false
        overlay.show(error: message ?? "The image could not be added to the chat.")
    }
    /// The host's Escape; the chat next to it keeps its own.
    func escape() -> Bool {
        guard overlay?.ownsFocus == true else { return false }
        cancel()
        return true
    }
    /// The menu's Undo, when no text view took it.
    func undo() -> Bool {
        guard let overlay else { return false }
        overlay.undo()
        return true
    }
    func place(area: NSRect) {
        self.area = area
        guard let overlay, overlay.frame != area else { return }
        overlay.frame = area
        changed()
    }
}
