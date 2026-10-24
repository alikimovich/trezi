import AppKit

/// Test-only (ephemeral profile, LKM-323): what the inspector's Custom tab shows, read
/// from the AppKit tree, and optionally a request typed into its field and sent with
/// Return. Kept out of InspectorCustom.swift so the inspector fixtures build without Host.
extension Host {
    func verifyInspectorCustom(_ c: [String: Any]) -> [String: Any] {
        editingInspector.layoutSubtreeIfNeeded()
        func all(_ view: NSView) -> [NSView] { view.subviews.flatMap { [$0] + all($0) } }
        let views = all(editingInspector), state = editingInspector.model.state
        let request = views.compactMap { $0 as? NSTextView }.first { $0.accessibilityIdentifier() == "inspector-custom-request" }
        if let words = c["submit"] as? String, let request {
            window.makeFirstResponder(request)
            request.string = words; request.didChangeText()
            request.doCommand(by: #selector(NSResponder.insertNewline(_:)))
        }
        let frame = request?.enclosingScrollView.map { $0.convert($0.bounds, to: editingInspector) } ?? .zero
        let custom = state?.custom
        return ["tab":state?.tab ?? "", "request":["found":request != nil, "visible":request.map { !$0.visibleRect.isEmpty && editingInspector.bounds.contains(frame) } ?? false,
                "editable":request?.isEditable ?? false, "text":request?.string ?? "", "height":Double(frame.height), "width":Double(frame.width)],
                "placeholder":custom?.placeholder ?? "", "target":custom?.target ?? "", "pending":custom?.pending ?? "", "error":custom?.error ?? "",
                "panels":Array(Set((state?.fields ?? []).compactMap(\.panel))).sorted(),
                "controls":(state?.fields ?? []).filter { $0.panel != nil }.map(\.id),
                "sliders":views.compactMap { $0 as? NSSlider }.filter { !$0.isHiddenOrHasHiddenAncestor }.count,
                "checkboxes":views.compactMap { $0 as? NSButton }.filter { !$0.isHiddenOrHasHiddenAncestor && $0.accessibilityRole() == .checkBox }.count]
    }
}
