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
    @Published var status = ""
    @Published var reason = ""
    /// "Back to <page>", empty when the page it came from is not known.
    @Published var back = ""
    func action(_ name: String, _ id: String = "") { emit(["event":"states-action", "action":name, "id":id]) }
}

struct StatesSwitcherContent: View {
    @ObservedObject var model: StatesSwitcherModel
    var body: some View {
        ViewThatFits(in: .horizontal) {
            fullRow
            compactRow
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color(nsColor: .separatorColor).opacity(0.6)))
        .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("States")
    }
    private var statePicker: some View {
        Picker("State", selection: Binding(get: { model.current }, set: { model.action($0 == "all" ? "all" : "select", $0) })) {
            ForEach(model.states) { state in Text(state.label).tag(state.id) }
            Divider()
            Text("All states").tag("all")
        }
        .pickerStyle(.menu).labelsHidden().frame(width: 130)
        .accessibilityLabel("State")
    }
    private var fullRow: some View {
        HStack(spacing: 6) {
            if !model.back.isEmpty {
                Button { model.action("back") } label: {
                    Label(model.back, systemImage: "chevron.left").font(.system(size: 12)).lineLimit(1)
                }
                .buttonStyle(.bordered).help(model.back)
            }
            Text(model.component).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                .lineLimit(1).frame(maxWidth: 110)
            if model.status == "loading" { ProgressView().controlSize(.small).help("Loading component") }
            if model.status == "error" {
                Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange)
                    .help(model.reason).accessibilityLabel("Canvas error: \(model.reason)")
            }
            statePicker
            if !model.missing.isEmpty {
                Menu("Missing \(model.missing.count)") {
                    ForEach(model.missing) { state in
                        Text("\(state.label) — \(state.note.isEmpty ? "Not implemented" : state.note)")
                    }
                }.menuStyle(.borderlessButton).frame(maxWidth: 110)
            }
            Button { model.action("continue") } label: { Image(systemName: "bubble.left") }
                .buttonStyle(.bordered).help("Continue in Chat").accessibilityLabel("Continue in Chat")
            Button { model.action("hide") } label: { Image(systemName: "eye.slash") }
                .buttonStyle(.bordered).help("Hide for screenshots (H)").accessibilityLabel("Hide states switcher")
        }
    }
    private var compactRow: some View {
        HStack(spacing: 4) {
            if !model.back.isEmpty {
                Button { model.action("back") } label: { Image(systemName: "chevron.left") }
                    .buttonStyle(.bordered).help(model.back).accessibilityLabel(model.back)
            }
            statePicker
            Menu {
                Button { model.action("continue") } label: { Label("Continue in Chat", systemImage: "bubble.left") }
                Button { model.action("hide") } label: { Label("Hide", systemImage: "eye.slash") }
                ForEach(model.missing) { state in
                    Text("Missing: \(state.label) — \(state.note)")
                }
            } label: { Image(systemName: "ellipsis") }
                .menuStyle(.borderlessButton).frame(width: 28).accessibilityLabel("More states actions")
        }
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
        model.status = state?["status"] as? String ?? ""
        model.reason = state?["reason"] as? String ?? ""
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
        let fits = measure.sizeThatFits(in: NSSize(width: max(180, page.width - 24), height: 200))
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
