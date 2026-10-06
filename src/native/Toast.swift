import AppKit
import SwiftUI

/// A short confirmation inside the main window (LKM-170): never a window or a modal.
/// It floats at the top center of the workspace, offers at most one action and
/// dismisses itself after `seconds`; a newer toast replaces it.
final class ToastModel: ObservableObject {
    @Published var id = ""
    @Published var message = ""
    @Published var action: String?
    var hide: () -> Void = {}
    func perform() {
        guard !id.isEmpty else { return }
        emit(["event":"toast-action", "id":id]); hide()
    }
}
struct ToastContent: View {
    @ObservedObject var model: ToastModel
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).accessibilityHidden(true)
            Text(model.message).font(.system(size: 13, weight: .medium))
            if let action = model.action {
                Text("—").foregroundStyle(.secondary).accessibilityHidden(true)
                Button(action) { model.perform() }.buttonStyle(.link)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().stroke(Color(nsColor: .separatorColor).opacity(0.6)))
        .shadow(color: .black.opacity(0.15), radius: 8, y: 2)
        .fixedSize()
        .accessibilityElement(children: .contain)
    }
}
final class NativeToast: NSHostingView<ToastContent> {
    let model = ToastModel()
    var timer: Timer?
    var coverChanged: (() -> Void)?
    init() {
        super.init(rootView: ToastContent(model: model))
        model.hide = { [weak self] in self?.hide() }
        translatesAutoresizingMaskIntoConstraints = false; isHidden = true
    }
    required init(rootView: ToastContent) { fatalError("init(rootView:) has not been implemented") }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func show(_ state: [String: Any], in canvas: NSView) {
        guard let id = state["id"] as? String, let message = state["message"] as? String else { return }
        model.id = id; model.message = message; model.action = state["action"] as? String
        // Above everything the workspace added since (source editors, islands).
        if superview !== canvas || canvas.subviews.last !== self {
            removeFromSuperview(); canvas.addSubview(self, positioned: .above, relativeTo: nil)
            NSLayoutConstraint.activate([
                centerXAnchor.constraint(equalTo: canvas.centerXAnchor),
                topAnchor.constraint(equalTo: canvas.topAnchor, constant: 12)
            ])
        }
        isHidden = false; alphaValue = 1
        invalidateIntrinsicContentSize()
        canvas.layoutSubtreeIfNeeded()
        layoutSubtreeIfNeeded()
        coverChanged?()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: max(1, state["seconds"] as? Double ?? 6), repeats: false) { [weak self] _ in self?.hide() }
    }
    func hide() {
        timer?.invalidate(); timer = nil
        guard !isHidden else { return }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.2; animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            guard let self, self.alphaValue == 0 else { return }
            self.isHidden = true; self.model.id = ""
            self.coverChanged?()
        })
    }
    override func hitTest(_ point: NSPoint) -> NSView? { super.hitTest(point) ?? (!isHidden && frame.contains(point) ? self : nil) }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func scrollWheel(with event: NSEvent) {}
    func inspect() -> [String: Any] { ["visible":!isHidden && alphaValue > 0, "message":model.message, "action":model.action ?? "", "frame":NSStringFromRect(frame), "inWindow":window != nil, "pending":timer != nil] }
}
