import AppKit

/// Windowless inspection of the native section picker and retired request field.
extension Host {
    func verifyInspectorCustom(_ c: [String: Any]) -> [String: Any] {
        editingInspector.layoutSubtreeIfNeeded()
        func all(_ view: NSView) -> [NSView] { view.subviews.flatMap { [$0] + all($0) } }
        let views = all(editingInspector)
        let request = views.compactMap { $0 as? NSTextView }.first { $0.accessibilityIdentifier() == "inspector-custom-request" }
        let segments = views.compactMap { $0 as? NSSegmentedControl }
        let picker = segments.first { control in
            (0..<control.segmentCount).contains { control.label(forSegment: $0) == "Props" }
        }
        let sections = picker.map { control in
            (0..<control.segmentCount).compactMap { control.label(forSegment: $0) }
        } ?? []
        return ["tab":editingInspector.model.state?.tab ?? "", "request":["found":request != nil], "sections":sections]
    }
}
