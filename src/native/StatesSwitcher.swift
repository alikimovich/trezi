import AppKit
import SwiftUI

/// The states workbench switcher (LKM-207). Bun sends `statesState` while the preview is on
/// a recorded workbench route (`src/native/states-controller.ts`); the island lists the
/// component's states in order, plus All states and Hide. Each click goes back to Bun as a
/// `states-action`, which switches through the page's URL (`src/preview/states-switch.ts`).
/// It takes clicks, so the page shields it (`PreviewCover.swift`). LKM-220: "← Back to
/// <page>" returns to the page the workbench was opened from; Continue in Chat focuses the
/// chat that built it, or a new one with the workbench as a chip.
struct StatesItem: Identifiable, Equatable {
    let id: String
    let label: String
    let note: String
}

final class StatesSwitcherModel: ObservableObject {
    @Published var component = ""
    @Published var states: [StatesItem] = []
    @Published var missing: [StatesItem] = []
    @Published var current = ""
    /// "Back to <page>", empty when the page it came from is not known.
    @Published var back = ""
    func action(_ name: String, _ id: String = "") { emit(["event":"states-action", "action":name, "id":id]) }
}

struct StatesSwitcherContent: View {
    @ObservedObject var model: StatesSwitcherModel
    var body: some View {
        HStack(spacing: 4) {
            if !model.back.isEmpty {
                Button { model.action("back") } label: {
                    Label(model.back, systemImage: "chevron.left").font(.system(size: 12, weight: .medium)).lineLimit(1).truncationMode(.middle)
                        .frame(maxWidth: 200).padding(.horizontal, 6).padding(.vertical, 3).contentShape(Capsule())
                }
                .buttonStyle(.plain).help(model.back).accessibilityLabel(model.back)
                Divider().frame(height: 14).padding(.horizontal, 2)
            }
            Text(model.component).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary).lineLimit(1)
                .padding(.trailing, 4)
            ForEach(Array(model.states.enumerated()), id: \.element.id) { index, state in
                segment(state.label, selected: model.current == state.id) { model.action("select", state.id) }
                    .help(index < 9 ? "\(state.label) (\(index + 1))" : state.label)
            }
            ForEach(model.missing) { state in
                Text(state.label).font(.system(size: 12)).strikethrough().foregroundStyle(.tertiary)
                    .padding(.horizontal, 6).help("Missing in the code\(state.note.isEmpty ? "" : ": " + state.note)")
            }
            Divider().frame(height: 14).padding(.horizontal, 2)
            segment(nil, symbol: "square.stack", selected: model.current == "all") { model.action("all") }
                .help("All states side by side").accessibilityLabel("All states")
            Button { model.action("continue") } label: { Image(systemName: "bubble.left").frame(width: 22, height: 20) }
                .buttonStyle(.borderless).help("Continue in Chat").accessibilityLabel("Continue in Chat")
            Button { model.action("hide") } label: { Image(systemName: "eye.slash").frame(width: 22, height: 20) }
                .buttonStyle(.borderless).help("Hide for screenshots (H)").accessibilityLabel("Hide states switcher")
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().stroke(Color(nsColor: .separatorColor).opacity(0.6)))
        .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
        .fixedSize()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("States")
    }
    private func segment(_ label: String?, symbol: String? = nil, selected: Bool, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Group {
                if let label { Text(label).font(.system(size: 12, weight: .medium)).lineLimit(1) }
                if let symbol { Image(systemName: symbol) }
            }
            .padding(.horizontal, 8).padding(.vertical, 3)
            .foregroundStyle(selected ? Color.white : Color.primary)
            .background(selected ? Color.accentColor : Color.clear, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

final class NativeStatesSwitcher: NSHostingView<StatesSwitcherContent> {
    let model = StatesSwitcherModel()
    init() { super.init(rootView: StatesSwitcherContent(model: model)); sizingOptions = []; isHidden = true }
    required init(rootView: StatesSwitcherContent) { fatalError("init(rootView:) has not been implemented") }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    /// On a workbench route (`active`) and not hidden by H or its button (`wanted`).
    var active = false
    var wanted = false
    func update(_ state: [String: Any]?) {
        func items(_ key: String) -> [StatesItem] {
            (state?[key] as? [[String: Any]] ?? []).compactMap { item in
                guard let id = item["id"] as? String else { return nil }
                return StatesItem(id: id, label: item["label"] as? String ?? id, note: item["note"] as? String ?? "")
            }
        }
        let states = items("states"), missing = items("missing")
        if model.states != states { model.states = states }
        if model.missing != missing { model.missing = missing }
        model.component = state?["component"] as? String ?? ""
        model.current = state?["current"] as? String ?? ""
        let back = state?["back"] as? String ?? ""
        if model.back != back { model.back = back }
        active = state != nil && !states.isEmpty
        wanted = active && state?["hidden"] as? Bool != true
    }
    /// With no sizing options the view has no intrinsic size (`fittingSize` is zero), so the
    /// same content is measured off-screen, as `SheetAlert.swift` does.
    private lazy var measure: NSHostingController<StatesSwitcherContent> = {
        let controller = NSHostingController(rootView: StatesSwitcherContent(model: model)); controller.sizingOptions = []; return controller
    }()
    /// Bottom center of the page, clear of the loading pill at the top.
    func place(in page: NSRect, visible: Bool) {
        isHidden = !wanted || !visible || page.width < 200
        guard !isHidden else { return }
        let fits = measure.sizeThatFits(in: NSSize(width: 10_000, height: 200))
        let size = NSSize(width: ceil(fits.width), height: ceil(fits.height))
        let width = min(size.width, page.width - 24)
        frame = NSRect(x: page.midX - width / 2, y: page.maxY - size.height - 12, width: width, height: size.height)
    }
    override func hitTest(_ point: NSPoint) -> NSView? { super.hitTest(point) ?? (!isHidden && frame.contains(point) ? self : nil) }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func scrollWheel(with event: NSEvent) {}
    /// Test broker: the same event a click sends, only while the control could take it.
    func perform(_ action: String, _ id: String) -> Bool {
        guard active, !isHidden || action == "hide" else { return false }
        model.action(action, id); return true
    }
    func inspect() -> [String: Any] {
        ["visible":!isHidden, "active":active, "hidden":active && !wanted, "component":model.component, "states":model.states.map(\.id),
         "labels":model.states.map(\.label), "missing":model.missing.map(\.id), "current":model.current, "back":model.back, "frame":NSStringFromRect(frame)]
    }
}
