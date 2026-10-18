import AppKit
import SwiftUI

/// The detail pane of a sectioned app window (Settings; the sidebar is `SheetSplit`):
/// the selected section's large title and its fields as grouped form rows (label and
/// help on the left, control on the right) with the section's actions below.
struct SectionedSheetContent: View {
    static let defaultSize = NSSize(width: 780, height: 760)
    /// Full-size content: the height includes the unified toolbar over the pane. Tall
    /// enough that every General picker is visible at the minimum width (LKM-163; LKM-221 added a row).
    static let minimumSize = NSSize(width: 680, height: 760)
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
        // Ungrouped rows first, then each titled group in order (Skills); the section's
        // title heads the first group and its actions follow the last.
        var named: [String] = []
        for case let group? in fields.map(\.group) where !named.contains(group) { named.append(group) }
        let groups: [String?] = (named.isEmpty || fields.contains { $0.group == nil } ? [nil] : []) + named
        return Form {
            ForEach(Array(groups.enumerated()), id: \.offset) { index, group in
                Section {
                    ForEach(fields.filter { $0.group == group }) { row($0) }
                } header: {
                    VStack(alignment: .leading, spacing: 6) {
                        if index == 0 {
                            Text(section.label).font(.largeTitle.weight(.bold)).foregroundStyle(.primary)
                            if let detail = section.detail, !detail.isEmpty {
                                Text(detail).font(.body).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        if let group {
                            Text(group).font(.headline).foregroundStyle(.primary).padding(.top, index == 0 ? 10 : 0)
                        }
                    }.textCase(nil).padding(.bottom, index == 0 ? 8 : 2)
                } footer: {
                    if index == groups.count - 1 { footer(actions) }
                }
            }
        }
        .formStyle(.grouped).disabled(state.busy)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    func footer(_ actions: [SheetAction]) -> some View {
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
    func label(_ field: SheetField) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(field.label)
            if let help = field.help, !help.isEmpty {
                Text(help).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
    @ViewBuilder func row(_ field: SheetField) -> some View {
        if let action = field.action {
            // A navigation row (Skills): label and help, its status, and a button that opens it.
            LabeledContent {
                HStack(spacing: 10) {
                    if !field.value.isEmpty { Text(field.value).foregroundStyle(.secondary).lineLimit(1) }
                    RowButton(title: field.actionLabel ?? "Open…", label: "\((field.actionLabel ?? "Open").replacingOccurrences(of: "…", with: "")) \(field.label)",
                              action: action, perform: { model.perform($0) }).fixedSize()
                }
            } label: { label(field) }
        } else {
            control(field)
        }
    }
    @ViewBuilder func control(_ field: SheetField) -> some View {
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
                if field.section == "skills" {
                    SkillSourceEditor(text: form.binding(field), label: field.label)
                        .frame(minHeight: field.height ?? 120)
                } else {
                    TextEditor(text: form.binding(field)).font(.system(size: 13, design: .monospaced)).frame(minHeight: field.height ?? 120).accessibilityLabel(field.label)
                }
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

/// SKILL.md is source text. System smart substitutions must never rewrite its YAML
/// delimiters or quoted examples. Configure only this editor, not user preferences.
struct SkillSourceEditor: NSViewRepresentable {
    @Binding var text: String
    let label: String
    final class Coordinator: NSObject, NSTextViewDelegate {
        var text: Binding<String>
        init(_ text: Binding<String>) { self.text = text }
        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            text.wrappedValue = view.string
        }
    }
    func makeCoordinator() -> Coordinator { Coordinator($text) }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .bezelBorder
        let editor = NSTextView(frame: NSRect(origin: .zero, size: scroll.contentSize))
        editor.isRichText = false
        editor.importsGraphics = false
        editor.allowsUndo = true
        editor.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        editor.textContainerInset = NSSize(width: 8, height: 8)
        editor.isAutomaticQuoteSubstitutionEnabled = false
        editor.isAutomaticDashSubstitutionEnabled = false
        editor.isAutomaticTextReplacementEnabled = false
        editor.smartInsertDeleteEnabled = false
        editor.isAutomaticSpellingCorrectionEnabled = false
        editor.isContinuousSpellCheckingEnabled = false
        editor.isGrammarCheckingEnabled = false
        editor.isAutomaticDataDetectionEnabled = false
        editor.isVerticallyResizable = true
        editor.isHorizontallyResizable = false
        editor.autoresizingMask = [.width]
        editor.minSize = .zero
        editor.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        editor.textContainer?.containerSize = NSSize(width: scroll.contentSize.width, height: CGFloat.greatestFiniteMagnitude)
        editor.textContainer?.widthTracksTextView = true
        editor.delegate = context.coordinator
        scroll.documentView = editor
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let editor = scroll.documentView as? NSTextView else { return }
        context.coordinator.text = $text
        editor.setAccessibilityLabel(label)
        editor.isEditable = context.environment.isEnabled
        if editor.string != text { editor.string = text }
    }
}

/// A navigation row's button. Like `ChoicePopUp`, a real AppKit button with target/action
/// and an accessibility label naming its row ("Edit frontend-notes"), so verification
/// presses the rendered control and VoiceOver reads which row it opens.
struct RowButton: NSViewRepresentable {
    let title: String
    let label: String
    let action: String
    let perform: (String) -> Void
    final class Coordinator: NSObject {
        var press: () -> Void = {}
        @objc func pressed(_ sender: NSButton) { press() }
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NSButton {
        let button = NSButton(title: title, target: context.coordinator, action: #selector(Coordinator.pressed(_:)))
        button.setContentHuggingPriority(.required, for: .horizontal)
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
        return button
    }
    func updateNSView(_ button: NSButton, context: Context) {
        context.coordinator.press = { [perform, action] in perform(action) }
        button.title = title
        button.identifier = NSUserInterfaceItemIdentifier("sheet-row:\(action)")
        button.setAccessibilityLabel(label)
        button.isEnabled = context.environment.isEnabled
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
