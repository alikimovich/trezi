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
        let pageIdentity: String
        init(image: CGImage, context: [String: Any], pageIdentity: String = "") {
            self.image = image; self.context = context; self.pageIdentity = pageIdentity
        }
    }
    struct Failure: Error { let message: String }
    typealias Capture = (@escaping (Result<Captured, Failure>) -> Void) -> Void

    private let parent: NSView
    private let emit: ([String: Any]) -> Void
    private let refusal: () -> String?
    private let capture: Capture
    private let restoreFocus: (NSResponder?) -> Void
    private let changed: () -> Void
    private let currentPageIdentity: () -> String
    private let budget: Int
    private let captureTimeout: TimeInterval
    private(set) var session: String?
    private(set) var overlay: PreviewMarkupOverlay?
    private(set) var context: [String: Any] = [:]
    private var suspended = false
    private var capturedPageIdentity = ""
    private var area: NSRect?, page: NSRect?
    private weak var previousFocus: NSResponder?

    init(parent: NSView, emit: @escaping ([String: Any]) -> Void, refusal: @escaping () -> String?, capture: @escaping Capture,
         restoreFocus: @escaping (NSResponder?) -> Void, changed: @escaping () -> Void, currentPageIdentity: @escaping () -> String = { "" }, budget: Int = MarkupEncoder.budget,
         captureTimeout: TimeInterval = PreviewMarkup.captureTimeout) {
        self.parent = parent; self.emit = emit; self.refusal = refusal; self.capture = capture
        self.restoreFocus = restoreFocus; self.changed = changed; self.currentPageIdentity = currentPageIdentity
        self.budget = budget; self.captureTimeout = captureTimeout
    }
    /// Under the page's own 3 s fail-safe that brings its chrome back (`PreviewMarkupScript`),
    /// so a snapshot is never taken after the chrome returned: a slower capture is given up.
    static let captureTimeout: TimeInterval = 2.5
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
        // A page stuck in a loop never answers: say so and free the session, so the next press
        // works. Whatever arrives later finds no session and is dropped.
        DispatchQueue.main.asyncAfter(deadline: .now() + captureTimeout) { [weak self] in
            guard let self, self.session == token, self.overlay == nil else { return }
            self.session = nil
            self.report(token, "failed", message: "The preview did not answer, so nothing was captured. Try Mark up again.")
        }
    }
    private func open(_ captured: Captured, _ token: String) {
        let currentIdentity = currentPageIdentity()
        if !captured.pageIdentity.isEmpty && !currentIdentity.isEmpty && captured.pageIdentity != currentIdentity {
            session = nil
            report(token, "failed", message: "The preview changed before Mark up opened. Try again on the current page.")
            return
        }
        let view = PreviewMarkupOverlay(image: captured.image)
        context = captured.context
        capturedPageIdentity = captured.pageIdentity
        previousFocus = parent.window?.firstResponder
        view.onCancel = { [weak self] in self?.cancel() }
        view.onAdd = { [weak self] in self?.add() }
        view.frame = area ?? parent.bounds
        // Above the floating islands and the page: the snapshot is all there is to click.
        parent.addSubview(view, positioned: .above, relativeTo: nil)
        view.page = page
        overlay = view
        view.isHidden = suspended
        view.layoutSubtreeIfNeeded()
        // The overlay takes the keys, so preview shortcuts never reach the page.
        if !suspended { parent.window?.makeFirstResponder(view) }
        changed()
        report(token, "open")
    }
    private func close() {
        overlay?.removeFromSuperview()
        overlay = nil; session = nil; context = [:]; suspended = false; capturedPageIdentity = ""
        changed()
    }
    /// Selection may use the live page while this snapshot and its edits remain in memory.
    func suspend() {
        suspended = true
        overlay?.canvas.commitText()
        overlay?.isHidden = true
        if overlay != nil { restoreFocus(previousFocus) }
        changed()
    }
    func resume() {
        let currentIdentity = currentPageIdentity()
        if let token = session, !capturedPageIdentity.isEmpty, !currentIdentity.isEmpty, capturedPageIdentity != currentIdentity {
            report(token, "suspended", message: "The preview changed. Your mark up is preserved; return to its page or Cancel it.")
            return
        }
        suspended = false
        overlay?.isHidden = false
        if let overlay { parent.window?.makeFirstResponder(overlay) }
        changed()
    }
    /// Discards everything; nothing was written, so nothing is left to clean.
    func cancel() {
        guard let token = session else { return }
        // A capture still in flight has not taken the focus yet.
        let focus = overlay == nil ? nil : previousFocus
        close()
        restoreFocus(focus)
        report(token, "cancelled")
    }
    /// LKM-448: Bun's Cancel for the top bar button, the same path as the overlay's. A token
    /// this side no longer holds is answered as cancelled, so Bun never stays stuck on it.
    func cancel(_ token: String) {
        guard session == token else { report(token, "cancelled"); return }
        cancel()
    }
    /// Bun's discard: the chat or project changed.
    func end(_ token: String) {
        guard session == token else { return }
        close()
    }
    func add() {
        overlay?.canvas.commitText()
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
        guard overlay?.isHidden == false, overlay?.ownsFocus == true else { return false }
        cancel()
        return true
    }
    /// The menu's Undo, when no text view took it.
    func undo() -> Bool {
        guard let overlay, !overlay.isHidden else { return false }
        overlay.undo()
        return true
    }
    /// `area` is what the overlay covers; `page` the live page's frame, both in the parent's
    /// coordinates. LKM-448: the snapshot takes the page's frame, so nothing moves or resizes.
    func place(area: NSRect, page: NSRect? = nil) {
        self.area = area; self.page = page
        guard let overlay, overlay.frame != area || overlay.page != page else { return }
        overlay.frame = area; overlay.page = page
        overlay.layoutSubtreeIfNeeded()
        changed()
    }
}
