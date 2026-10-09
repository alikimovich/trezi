import AppKit
import SwiftUI

struct SheetChoice: Decodable, Identifiable { let value: String; let label: String; var id: String { value } }
struct SheetFieldCondition: Decodable { let field: String; let value: String }
struct SheetField: Decodable, Identifiable { let id: String; let label: String; let kind: String; let value: String; let choices: [SheetChoice]?; let help: String?; let visibleWhen: SheetFieldCondition?; let section: String?; let draft: Bool?; let placeholder: String? }
struct SheetAction: Decodable, Identifiable { let id: String; let label: String; let primary: Bool?; let destructive: Bool?; let section: String?; let cancel: Bool?; let copy: String? }
struct SheetSection: Decodable, Identifiable { let id: String; let label: String; let symbol: String; let detail: String? }
struct SheetState: Decodable { let id: String; let title: String; let detail: String; let fields: [SheetField]; let actions: [SheetAction]; let busy: Bool; let autosave: Bool?; let dismissible: Bool?; let message: String?; let sections: [SheetSection]?; let section: String?; let alert: Bool? }
final class SheetModel: ObservableObject {
    @Published var state: SheetState?
    @Published var filters: [String: String] = [:]
    @Published var values: [String: String] = [:]
    /// The sidebar pane of a sectioned window. Bun only seeds it; the window owns it after that.
    @Published var section: String?
    func update(_ next: SheetState) {
        if state?.id != next.id {
            filters = [:]
            values = Dictionary(uniqueKeysWithValues: next.fields.map { ($0.id, $0.value) })
            section = next.sections.flatMap { sections in sections.first { $0.id == next.section }?.id ?? sections.first?.id }
        } else if let previous = state {
            // A pane swapped its fields in place (the provider editor): seed new ones, forget removed ones.
            let known = Set(previous.fields.map(\.id)), current = Set(next.fields.map(\.id))
            for field in next.fields where !known.contains(field.id) { values[field.id] = field.value }
            values = values.filter { current.contains($0.key) }
        }
        state = next
    }
    func setValue(_ key: String, _ value: String) {
        values[key] = value
        if state?.autosave == true, state?.fields.first(where: { $0.id == key })?.draft != true { perform("change") }
    }
    func perform(_ action: String) {
        guard let state, !state.busy || action == "cancel" else { return }
        if action == "cancel" && !(state.dismissible ?? !state.actions.isEmpty) { return }
        if let text = state.actions.first(where: { $0.id == action })?.copy, !state.busy {
            NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
        }
        var event: [String: Any] = ["event":"sheet-action", "id":state.id, "action":action, "values":values]
        if let section { event["section"] = section }
        emit(event)
    }
    /// Sidebar selection: switches panes at once and tells Bun, which remembers it.
    func select(_ id: String) {
        guard let state, section != id, state.sections?.contains(where: { $0.id == id }) == true else { return }
        section = id
        emit(["event":"sheet-action", "id":state.id, "action":"section", "values":values, "section":id])
    }
}
struct SheetContent: View {
    @ObservedObject var model: SheetModel
    func binding(_ field: SheetField) -> Binding<String> {
        Binding(get: { model.values[field.id] ?? field.value }, set: { model.setValue(field.id, $0) })
    }
    func selected(_ field: SheetField) -> Set<String> { Set((model.values[field.id] ?? field.value).components(separatedBy: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ","))).filter { !$0.isEmpty }) }
    @ViewBuilder func button(_ action: SheetAction, busy: Bool) -> some View {
        if action.primary == true && action.destructive != true {
            Button(action.label) { model.perform(action.id) }.keyboardShortcut(.defaultAction).disabled(busy)
        } else {
            Button(action.label, role: action.destructive == true ? .destructive : nil) { model.perform(action.id) }
                .disabled(busy && action.id != "cancel")
        }
    }
    var body: some View {
        if let state = model.state, let sections = state.sections {
            SectionedSheetContent(model: model, state: state, sections: sections)
        } else if let state = model.state {
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if !state.detail.isEmpty { Text(state.detail).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
                        ForEach(state.fields.filter { field in
                            guard let condition = field.visibleWhen else { return true }
                            return model.values[condition.field] == condition.value
                        }) { field in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(field.label).font(.headline)
                                if let help = field.help {
                                    Text(help).font(.body).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                                }
                                if field.kind == "image", let data = Data(base64Encoded: field.value.components(separatedBy: ",").last ?? ""), let image = NSImage(data: data) {
                                    Image(nsImage: image).resizable().scaledToFit().frame(maxHeight: 160)
                                } else if field.kind == "readonly" {
                                    Text(field.value).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                                } else if field.kind == "multiline" {
                                    TextEditor(text: binding(field)).font(.system(size: 13, design: .monospaced)).frame(minHeight: 220).accessibilityLabel(field.label)
                                } else if field.kind == "choice" {
                                    Picker(field.label, selection: binding(field)) {
                                        ForEach(field.choices ?? []) { choice in Text(choice.label).tag(choice.value) }
                                    }.labelsHidden().accessibilityLabel(field.label)
                                } else if field.kind == "multichoice" {
                                    TextField(field.placeholder ?? "Filter models", text: Binding(get: { model.filters[field.id] ?? "" }, set: { model.filters[field.id] = $0 })).textFieldStyle(.roundedBorder)
                                    VStack(alignment: .leading) {
                                        ForEach((field.choices ?? []).filter { (model.filters[field.id] ?? "").isEmpty || $0.label.localizedCaseInsensitiveContains(model.filters[field.id] ?? "") }) { choice in
                                            Toggle(choice.label, isOn: Binding(get: { selected(field).contains(choice.value) }, set: { enabled in
                                                var values = selected(field)
                                                if enabled { values.insert(choice.value) } else { values.remove(choice.value) }
                                                model.setValue(field.id, values.sorted().joined(separator: "\n"))
                                            })).toggleStyle(.checkbox)
                                        }
                                    }
                                } else if field.kind == "secure" {
                                    SecureField(field.label, text: binding(field)).textFieldStyle(.roundedBorder)
                                } else {
                                    TextField(field.label, text: binding(field)).textFieldStyle(.roundedBorder)
                                }
                            }
                        }
                        if let message = state.message, !message.isEmpty {
                            Text(message).foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(24).disabled(state.busy)
                }
                if !state.actions.isEmpty || state.busy {
                Divider()
                HStack(spacing: 12) {
                    ForEach(state.actions.filter { $0.id != "cancel" && $0.primary != true }) { button($0, busy: state.busy) }
                    if state.busy { ProgressView().controlSize(.small).accessibilityLabel("Working") }
                    Spacer(minLength: 24)
                    ForEach(state.actions.filter { $0.id == "cancel" }) { button($0, busy: state.busy) }
                    ForEach(state.actions.filter { $0.id != "cancel" && $0.primary == true }) { button($0, busy: state.busy) }
                }.padding(20)
                }
            }.frame(minWidth: 540, minHeight: 200).background(Color(nsColor: .windowBackgroundColor))
                .onExitCommand { model.perform("cancel") }
        }
    }
}
final class NativeSheets: NSObject, NSWindowDelegate {
    let model = SheetModel()
    weak var parent: NSWindow?
    var panel: NSWindow?
    init(parent: NSWindow) { self.parent = parent }
    func update(_ raw: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: raw), let state = try? JSONDecoder().decode(SheetState.self, from: data) else { return }
        model.update(state)
        let alert = state.alert == true && state.sections == nil
        // A sectioned window, a plain form and an alert have different window content; never reuse one for another.
        if let panel, (state.sections != nil) != (panel.contentViewController is SheetSplit) || alert != (panel is SheetAlertPanel) {
            (panel.contentViewController as? SheetSplit)?.detach()
            if let parent = panel.sheetParent { parent.endSheet(panel) }
            panel.orderOut(nil); self.panel = nil
        }
        if alert {
            // An alert attaches to the main window as a sheet (LKM-170): no title bar, traffic lights or spare space.
            let sheet = panel as? SheetAlertPanel ?? SheetAlertPanel(model: model)
            sheet.cancel = { [weak self] in self?.model.perform(SheetAlertRoles(self?.model.state?.actions ?? []).escape) }
            sheet.fit()
            if panel == nil {
                panel = sheet
                if let parent, parent.isVisible { parent.beginSheet(sheet) } else { sheet.center(); sheet.makeKeyAndOrderFront(nil) }
            }
            // SwiftUI lays the new state out on the next pass; fit again once it has.
            DispatchQueue.main.async { [weak sheet] in sheet?.fit() }
            return
        }
        if panel == nil {
            let large = state.fields.contains { ["multiline", "multichoice", "readonly", "image"].contains($0.kind) }
            let size = state.sections != nil ? SectionedSheetContent.defaultSize : NSSize(width: 600, height: large ? 560 : min(500, max(220, 160 + state.fields.count * 76)))
            let sheet = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            sheet.isReleasedWhenClosed = false; sheet.animationBehavior = .none
            sheet.delegate = self; sheet.tabbingMode = .disallowed
            sheet.contentMinSize = state.sections != nil ? SectionedSheetContent.minimumSize : NSSize(width: 600, height: 220)
            sheet.collectionBehavior = [.fullScreenAuxiliary]
            install(in: sheet)
            sheet.setContentSize(size)
            panel = sheet
            if let parent {
                sheet.setFrameOrigin(NSPoint(x: parent.frame.midX - sheet.frame.width / 2, y: parent.frame.midY - sheet.frame.height / 2))
            } else { sheet.center() }
            sheet.makeKeyAndOrderFront(nil)
        }
        // A sectioned window is titled by its selected section (`SheetSplit`).
        if state.sections == nil { panel?.title = state.title }
        panel?.standardWindowButton(.closeButton)?.isEnabled = state.dismissible ?? !state.actions.isEmpty
    }
    /// The window's content: the split view with a source-list sidebar for a sectioned
    /// state (Settings), otherwise the SwiftUI form.
    func install(in window: NSWindow) {
        guard model.state?.sections != nil else {
            window.contentViewController = NSHostingController(rootView: SheetContent(model: model)); return
        }
        let split = SheetSplit(model: model)
        window.contentViewController = split
        split.attach(to: window)
    }
    func close(_ id: String) {
        guard model.state?.id == id else { return }
        (panel?.contentViewController as? SheetSplit)?.detach()
        if let panel, let parent = panel.sheetParent { parent.endSheet(panel) }
        panel?.close()
        panel = nil; model.state = nil; model.values = [:]; model.filters = [:]; model.section = nil
        parent?.makeKeyAndOrderFront(nil)
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard sender.attachedSheet == nil else { return false }
        model.perform("cancel")
        return false // Bun owns dismissal, including stale-action and busy-operation guards.
    }
    func inspect() -> [String: Any] {
        let roles = SheetAlertRoles(model.state?.actions ?? [])
        return ["alert":panel is SheetAlertPanel, "titled":panel.map { $0.sheetParent == nil && $0.styleMask.contains(.titled) } ?? false, "width":panel?.frame.width ?? 0, "height":panel?.contentView?.frame.height ?? 0, "frameHeight":panel?.frame.height ?? 0, "contentHeight":(panel as? SheetAlertPanel)?.idealHeight ?? panel?.contentViewController?.view.fittingSize.height ?? 0, "defaultAction":roles.defaultAction?.id ?? "", "cancelAction":roles.escape, "detail":model.state?.detail ?? "", "message":model.state?.message ?? "", "visible":panel?.isVisible ?? false, "attached":panel?.sheetParent != nil, "closable":panel?.styleMask.contains(.closable) ?? false, "resizable":panel?.styleMask.contains(.resizable) ?? false, "id":model.state?.id ?? "", "title":model.state?.title ?? "", "windowTitle":panel?.title ?? "", "busy":model.state?.busy ?? false, "fields":model.state?.fields.map(\.id) ?? [], "section":model.section ?? "", "actions":model.state?.actions.map(\.id) ?? []]
    }
}
