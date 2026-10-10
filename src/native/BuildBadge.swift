import AppKit

/// LKM-226: the build badge in the projects sidebar's footer, before the Activity
/// indicator: a small dot and short text ("0.1.0 · main ✓", "0.1.0 · 3 behind",
/// "candidate · not on main"). Bun derives the state (`build-status-controller.ts`) and
/// sends `buildStatus`; the tooltip lists version, build, commit, branch, release tag and
/// the check time. A click opens the details (with update steps when behind); the
/// context menu copies the commit. About Trezi shows the same details.
final class BuildBadge: NSObject {
    static let footerHeight: CGFloat = 32
    let button = NSButton(title: "", target: nil, action: nil)
    private(set) var status: [String: Any] = [:]
    private let copyItem = NSMenuItem(title: "Copy Commit", action: #selector(copyCommit), keyEquivalent: "")

    func install(in container: NSView, activity: ActivityIndicator) {
        button.target = self; button.action = #selector(open)
        button.isBordered = false; button.setButtonType(.momentaryChange)
        button.imagePosition = .imageLeading; button.imageHugsTitle = true
        button.lineBreakMode = .byTruncatingTail
        button.identifier = NSUserInterfaceItemIdentifier("build-badge")
        button.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let menu = NSMenu()
        copyItem.target = self; menu.addItem(copyItem)
        let details = NSMenuItem(title: "Show Build Details…", action: #selector(open), keyEquivalent: ""); details.target = self; menu.addItem(details)
        button.menu = menu
        // One footer row: the badge, then Activity while it has unread lines.
        let footer = NSStackView(views: [button])
        footer.orientation = .horizontal; footer.alignment = .centerY; footer.spacing = 10
        footer.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(footer)
        activity.install(in: footer)
        NSLayoutConstraint.activate([
            footer.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 14),
            footer.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -10),
            footer.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -14)
        ])
        // Until Bun's first state: the stamped version, grey.
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
        update(["text":version, "tone":"gray", "state":"unknown", "label":"Checking whether this build is on main…", "details":[String]()])
    }

    static func color(_ tone: String) -> NSColor {
        switch tone {
        case "green": return .systemGreen
        case "yellow": return .systemYellow
        case "orange": return .systemOrange
        case "blue": return .systemBlue
        default: return .tertiaryLabelColor
        }
    }

    func update(_ c: [String: Any]) {
        status = c
        let text = c["text"] as? String ?? "", tone = c["tone"] as? String ?? "gray"
        button.image = NSImage(systemSymbolName: "circle.fill", accessibilityDescription: nil)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 7, weight: .regular).applying(.init(paletteColors: [Self.color(tone)])))
        button.attributedTitle = NSAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: NSFont.smallSystemFontSize), .foregroundColor: NSColor.secondaryLabelColor
        ])
        let details = c["details"] as? [String] ?? []
        button.toolTip = details.isEmpty ? c["label"] as? String : details.joined(separator: "\n")
        button.setAccessibilityLabel("Build: \(c["label"] as? String ?? text)")
        let commit = c["commit"] as? String ?? ""
        copyItem.isHidden = commit.isEmpty
        copyItem.title = commit.isEmpty ? "Copy Commit" : "Copy Commit \(commit)"
    }

    /// About Trezi's credits: the same lines as the tooltip.
    var aboutCredits: NSAttributedString {
        let details = status["details"] as? [String] ?? []
        let paragraph = NSMutableParagraphStyle(); paragraph.alignment = .center
        return NSAttributedString(string: details.joined(separator: "\n"), attributes: [
            .font: NSFont.systemFont(ofSize: NSFont.smallSystemFontSize), .foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: paragraph
        ])
    }

    @objc func open() { emit(["event":"menu", "action":"build-status"]) }

    @objc func copyCommit() {
        guard let commit = status["commit"] as? String, !commit.isEmpty else { return }
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(commit, forType: .string)
    }

    func inspect() -> [String: Any] {
        let frame = button.window == nil ? NSRect.zero : button.convert(button.bounds, to: nil)
        return ["badgeText":button.attributedTitle.string, "badgeTone":status["tone"] as? String ?? "", "badgeState":status["state"] as? String ?? "",
                "badgeTooltip":button.toolTip ?? "", "badgeVisible":!button.isHidden && button.window != nil && frame.width > 0,
                "badgeFrame":NSStringFromRect(frame), "badgeTruncated":button.fittingSize.width > button.bounds.width + 0.5,
                "badgeMenu":button.menu?.items.filter { !$0.isHidden }.map(\.title) ?? [], "aboutCredits":aboutCredits.string]
    }
}
