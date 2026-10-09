import AppKit

/// LKM-152: the unread marker for Activity. While Activity has unread warnings or
/// needs-action lines, a small dot labelled "Activity" sits at the bottom of the
/// projects sidebar and Window → Activity carries a count badge (macOS 14+). Clicking
/// either opens Activity, which clears both.
final class ActivityIndicator: NSObject {
    let button = NSButton(title: "Activity", target: nil, action: nil)
    weak var menuItem: NSMenuItem?
    private(set) var count = 0
    private(set) var level = "info"

    func install(in container: NSView) {
        button.target = self; button.action = #selector(open)
        button.isBordered = false; button.setButtonType(.momentaryChange)
        button.imagePosition = .imageLeading; button.imageHugsTitle = true
        button.identifier = NSUserInterfaceItemIdentifier("activity-indicator")
        button.isHidden = true
        button.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(button)
        NSLayoutConstraint.activate([
            button.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 14),
            button.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -10)
        ])
    }

    func update(count: Int, level: String) {
        self.count = max(0, count); self.level = level
        button.isHidden = self.count == 0
        let color: NSColor = level == "needs-action" ? .systemRed : .systemOrange
        button.image = NSImage(systemSymbolName: "circle.fill", accessibilityDescription: nil)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 7, weight: .regular).applying(.init(paletteColors: [color])))
        button.attributedTitle = NSAttributedString(string: "Activity", attributes: [
            .font: NSFont.systemFont(ofSize: NSFont.smallSystemFontSize), .foregroundColor: NSColor.secondaryLabelColor
        ])
        let summary = "\(self.count) unread \(level == "needs-action" ? "problem" : "warning")\(self.count == 1 ? "" : "s") in Activity"
        button.toolTip = summary; button.setAccessibilityLabel(summary)
        if #available(macOS 14.0, *) { menuItem?.badge = self.count > 0 ? NSMenuItemBadge(count: self.count) : nil }
    }

    @objc func open() { emit(["event":"menu", "action":"activity"]) }

    func inspect() -> [String: Any] {
        var badge = ""
        if #available(macOS 14.0, *) { badge = menuItem?.badge?.stringValue ?? "" }
        return ["unread":count, "unreadLevel":level, "indicatorVisible":!button.isHidden && button.window != nil,
                "menuTitle":menuItem?.title ?? "", "menuKey":menuItem?.keyEquivalent ?? "", "menuParent":menuItem?.menu?.title ?? "", "menuBadge":badge]
    }
}
