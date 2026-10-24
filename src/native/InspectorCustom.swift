import AppKit
import SwiftUI

/// LKM-323: the Custom tab's request field, the panel being commented on, and the panel
/// and control menus (Comment…, Remove). The controller runs the request and saves the
/// panel; this only shows its state and sends the user's words.
struct InspectorCustom: Decodable { let placeholder: String; let target: String?; let pending: String?; let error: String?; let enabled: Bool; let focus: Int }

/// A multi-line request: Return sends, Shift-Return makes a new line (as in the composer).
struct CustomRequestText: NSViewRepresentable {
    @Binding var text: String
    let enabled: Bool
    let focus: Int
    @ObservedObject var model: InspectorModel
    let send: () -> Void
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: CustomRequestText
        init(_ parent: CustomRequestText) { self.parent = parent }
        func textDidChange(_ notification: Notification) { if let view = notification.object as? NSTextView { parent.text = view.string } }
        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            guard selector == #selector(NSResponder.insertNewline(_:)), !textView.hasMarkedText() else { return false }
            if NSApp.currentEvent?.modifierFlags.contains(.shift) == true { return false }
            parent.send(); return true
        }
    }
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView(), view = scroll.documentView as! NSTextView
        scroll.drawsBackground = false; scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
        view.delegate = context.coordinator; view.drawsBackground = false; view.isRichText = false; view.allowsUndo = true
        view.font = .systemFont(ofSize: 12); view.textContainerInset = NSSize(width: 2, height: 5)
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.setAccessibilityLabel("Ask for controls"); view.setAccessibilityIdentifier("inspector-custom-request")
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let view = scroll.documentView as? NSTextView else { return }
        if view.string != text { view.string = text }
        view.isEditable = enabled; view.isSelectable = true
        view.textColor = enabled ? .labelColor : .secondaryLabelColor
        // Each new focus value (Create controls…, Comment…) focuses the field once.
        if enabled, focus != model.customFocus {
            model.customFocus = focus
            DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
        }
    }
}

struct CustomRequestBar: View {
    let custom: InspectorCustom
    @ObservedObject var model: InspectorModel
    @State private var text = ""
    private func send() {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard custom.enabled, !words.isEmpty else { return }
        model.send("custom-request", value: words); text = ""
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let target = custom.target {
                HStack(spacing: 4) {
                    Image(systemName: "text.bubble").foregroundStyle(.secondary)
                    Text("Comment on \(target)").lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 0)
                    Button { model.send("custom-target") } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain).foregroundStyle(.secondary).help("Ask for new controls instead").accessibilityLabel("Stop commenting")
                }.font(.caption)
            }
            if let pending = custom.pending {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small); Text(pending).font(.caption).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    Button("Cancel") { model.send("custom-cancel") }.buttonStyle(.link).font(.caption).help("Stop waiting for the agent. A turn already running keeps going in the chat.")
                }
            }
            if let error = custom.error { Text(error).foregroundStyle(.red).font(.caption).textSelection(.enabled) }
            HStack(alignment: .bottom, spacing: 6) {
                CustomRequestText(text: $text, enabled: custom.enabled, focus: custom.focus, model: model, send: send)
                    .frame(height: 52)
                    .overlay(alignment: .topLeading) {
                        if text.isEmpty { Text(custom.placeholder).font(.system(size: 12)).foregroundStyle(.tertiary).padding(.leading, 7).padding(.top, 5).allowsHitTesting(false) }
                    }
                Button(action: send) { Image(systemName: "arrow.up.circle.fill").font(.system(size: 18)) }
                    .buttonStyle(.plain).foregroundStyle(custom.enabled && !text.isEmpty ? Color.accentColor : Color.secondary)
                    .disabled(!custom.enabled || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .help("Send (Return). Shift-Return adds a line.").accessibilityLabel("Send request")
            }
            .padding(4)
            .background(RoundedRectangle(cornerRadius: 7).fill(Color(nsColor: .textBackgroundColor).opacity(0.6)))
            .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Color(nsColor: .separatorColor)))
        }
    }
}

/// A Custom tab panel's header: its title and its Comment and Remove menu.
struct CustomPanelHeader: View {
    let title: String, panel: String
    @ObservedObject var model: InspectorModel
    var body: some View {
        HStack {
            Text(title).font(.headline)
            Spacer()
            Menu {
                Button("Comment on Panel…") { model.send("comment-panel", value: panel) }
                Button("Remove Panel") { model.send("remove:" + panel) }
            } label: { Image(systemName: "ellipsis.circle") }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().help("Panel actions").accessibilityLabel("\(title) panel actions")
        }.padding(.top, 5)
    }
}

/// One Custom tab control's Comment and Remove menu, outside its (possibly disabled) field.
struct CustomControlMenu: View {
    let field: InspectorField
    @ObservedObject var model: InspectorModel
    var body: some View {
        Menu {
            Button("Comment on Control…") { model.send("comment-control", field: field.id) }
            Button("Remove Control") { model.send("remove-control", field: field.id) }
        } label: { Image(systemName: "ellipsis") }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().help("Control actions").accessibilityLabel("\(field.label) control actions")
    }
}
