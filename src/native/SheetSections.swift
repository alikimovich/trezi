import AppKit
import SwiftUI

/// The detail pane of a sectioned app window (Settings; the sidebar is `SheetSplit`):
/// the selected section's large title and its fields as grouped form rows (label and
/// help on the left, control on the right) with the section's actions below.
struct SectionedSheetContent: View {
    static let defaultSize = NSSize(width: 780, height: 540)
    /// Full-size content: the height includes the unified toolbar over the pane. Tall
    /// enough that every General picker is visible at the minimum width (LKM-163).
    static let minimumSize = NSSize(width: 680, height: 520)
    @ObservedObject var model: SheetModel
    let state: SheetState
    let sections: [SheetSection]
    var form: SheetContent { SheetContent(model: model) }
    var current: SheetSection? { sections.first { $0.id == model.section } ?? sections.first }
    func visible(_ field: SheetField) -> Bool {
        guard let condition = field.visibleWhen else { return true }
        return model.values[condition.field] == condition.value
    }
    var body: some View {
        Group {
            if let section = current { pane(section).id(section.id) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onExitCommand { model.perform("cancel") }
    }
    func pane(_ section: SheetSection) -> some View {
        let fields = state.fields.filter { $0.section == section.id && visible($0) }
        let actions = state.actions.filter { $0.section == section.id }
        return Form {
            Section {
                ForEach(fields) { row($0) }
            } header: {
                VStack(alignment: .leading, spacing: 6) {
                    Text(section.label).font(.largeTitle.weight(.bold)).foregroundStyle(.primary)
                    if let detail = section.detail, !detail.isEmpty {
                        Text(detail).font(.body).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }.textCase(nil).padding(.bottom, 8)
            } footer: {
                VStack(alignment: .leading, spacing: 12) {
                    if !actions.isEmpty || state.busy {
                        HStack(spacing: 12) {
                            ForEach(actions.filter { $0.primary != true }) { form.button($0, busy: state.busy) }
                            Spacer(minLength: 12)
                            if state.busy { ProgressView().controlSize(.small).accessibilityLabel("Working") }
                            ForEach(actions.filter { $0.primary == true }) { form.button($0, busy: state.busy) }
                        }
                    }
                    if let message = state.message, !message.isEmpty {
                        Text(message).foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }
                }.padding(.top, 4)
            }
        }
        .formStyle(.grouped).disabled(state.busy)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    func label(_ field: SheetField) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(field.label)
            if let help = field.help, !help.isEmpty {
                Text(help).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
    @ViewBuilder func row(_ field: SheetField) -> some View {
        switch field.kind {
        case "choice":
            LabeledContent { ChoicePopUp(choices: field.choices ?? [], selection: form.binding(field), label: field.label) } label: { label(field) }
        case "readonly":
            LabeledContent { Text(field.value).foregroundStyle(.secondary).textSelection(.enabled) } label: { label(field) }
        case "secure":
            SecureField(text: form.binding(field), prompt: Text(field.placeholder ?? "")) { label(field) }
        case "multiline":
            VStack(alignment: .leading, spacing: 8) {
                label(field)
                TextEditor(text: form.binding(field)).font(.system(size: 13, design: .monospaced)).frame(minHeight: 120).accessibilityLabel(field.label)
            }
        case "multichoice":
            VStack(alignment: .leading, spacing: 8) {
                label(field)
                TextField("Filter models", text: Binding(get: { model.filters[field.id] ?? "" }, set: { model.filters[field.id] = $0 })).textFieldStyle(.roundedBorder)
                ForEach((field.choices ?? []).filter { (model.filters[field.id] ?? "").isEmpty || $0.label.localizedCaseInsensitiveContains(model.filters[field.id] ?? "") }) { choice in
                    Toggle(choice.label, isOn: Binding(get: { form.selected(field).contains(choice.value) }, set: { enabled in
                        var values = form.selected(field)
                        if enabled { values.insert(choice.value) } else { values.remove(choice.value) }
                        model.setValue(field.id, values.sorted().joined(separator: "\n"))
                    })).toggleStyle(.checkbox)
                }
            }
        default:
            TextField(text: form.binding(field), prompt: Text(field.placeholder ?? "")) { label(field) }
        }
    }
}

/// A grouped-form row's popup. SwiftUI draws a grouped Form's own Picker without an
/// NSPopUpButton; this one is a real AppKit popup whose items carry target/action, so
/// verification chooses through the rendered control like a menu choice does.
struct ChoicePopUp: NSViewRepresentable {
    let choices: [SheetChoice]
    @Binding var selection: String
    let label: String
    final class Coordinator: NSObject {
        var choose: (String) -> Void = { _ in }
        @objc func chosen(_ item: NSMenuItem) { if let value = item.representedObject as? String { choose(value) } }
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NSPopUpButton {
        let popup = NSPopUpButton(frame: .zero, pullsDown: false)
        popup.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        popup.setContentHuggingPriority(.required, for: .horizontal)
        return popup
    }
    func updateNSView(_ popup: NSPopUpButton, context: Context) {
        context.coordinator.choose = { selection = $0 }
        popup.setAccessibilityLabel(label)
        popup.isEnabled = context.environment.isEnabled
        if popup.itemArray.map(\.title) != choices.map(\.label) || popup.itemArray.map({ $0.representedObject as? String }) != choices.map({ Optional($0.value) }) {
            popup.removeAllItems()
            for choice in choices {
                let item = NSMenuItem(title: choice.label, action: #selector(Coordinator.chosen(_:)), keyEquivalent: "")
                item.target = context.coordinator; item.representedObject = choice.value
                popup.menu?.addItem(item)
            }
        }
        popup.selectItem(at: choices.firstIndex { $0.value == selection } ?? -1)
    }
}
