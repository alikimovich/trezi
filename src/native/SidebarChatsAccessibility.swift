import AppKit

/// LKM-379: on macOS 27 an `NSButton` view is not an accessibility element: it is ignored and
/// its own `accessibilityRole()` is AXUnknown. VoiceOver gets its `NSButtonCell` (AXButton),
/// and a label set on the view blanks the cell's description. The label therefore goes on the
/// cell, and the checks read the element VoiceOver gets, not the view. The sidebar's text
/// buttons (the History toggle, "Show N more") are built here.
enum SidebarRowButton {
    static func make(title: String, font: NSFont, target: AnyObject?, action: Selector?) -> NSButton {
        let button = NSButton(title: title, target: target, action: action)
        button.isBordered = false; button.setButtonType(.momentaryChange)
        button.alignment = .left
        button.attributedTitle = NSAttributedString(string: title, attributes: [.font: font, .foregroundColor: NSColor.secondaryLabelColor])
        button.cell?.setAccessibilityRole(.button)
        button.cell?.setAccessibilityLabel(title)
        return button
    }
}

enum AccessibilityElementInspect {
    /// The element assistive apps get for `view`: the view itself, or its first unignored
    /// descendant (a control's cell).
    static func element(of view: NSView) -> NSAccessibilityProtocol? {
        NSAccessibility.unignoredDescendant(of: view) as? NSAccessibilityProtocol
    }
    /// An attribute as assistive apps read it. The table's row and cell proxies answer only
    /// this (deprecated) entry point, so it is called by selector.
    private static func attribute(_ object: AnyObject, _ name: NSAccessibility.Attribute) -> Any? {
        let read = NSSelectorFromString("accessibilityAttributeValue:")
        guard let object = object as? NSObject, object.responds(to: read) else { return nil }
        return object.perform(read, with: name.rawValue)?.takeUnretainedValue()
    }
    /// The AX path from the window down to the element ("Window > … > Button"), or nil when an
    /// ancestor does not list it among its children: VoiceOver could not navigate to it.
    static func path(to element: NSAccessibilityProtocol) -> [String]? {
        var child = element as AnyObject, path = [attribute(child, .role) as? String ?? ""]
        for _ in 0..<32 {
            guard let parent = attribute(child, .parent) as AnyObject?,
                  let kids = attribute(parent, .children) as? [Any],
                  kids.contains(where: { ($0 as? NSObject)?.isEqual(child) == true }) else { return nil }
            path.insert(attribute(parent, .role) as? String ?? "", at: 0)
            if parent is NSWindow { return path }
            child = parent
        }
        return nil
    }
    static func inspect(_ view: NSView) -> [String: Any] {
        guard let element = element(of: view) else { return ["role": "", "label": "", "element": false, "axPath": [String](), "press": false] }
        return ["role": element.accessibilityRole()?.rawValue ?? "", "label": element.accessibilityLabel() ?? "",
                "axTitle": element.accessibilityTitle() ?? "", "element": element.isAccessibilityElement(),
                "axPath": path(to: element) ?? [],
                "press": (element as? NSObject)?.responds(to: #selector(NSAccessibilityButton.accessibilityPerformPress)) ?? false,
                "viewRole": view.accessibilityRole()?.rawValue ?? ""]
    }
}
