import AppKit

/// LKM-226: the build badge in the projects sidebar's footer, before the Activity
/// indicator: a small dot and short text. Bun derives the state (`build-status-controller.ts`)
/// and sends `buildStatus`; the tooltip lists version, build, commit, branch, tree, release
/// tag, build time and the check time. A click opens the details (with update steps when
/// behind); the context menu copies the commit. About Trezi shows the same details.
///
/// LKM-301: the text is the build's identity ("0.1.0 (1234, 1a2b3c4)") and, when there is
/// one, its context ("· candidate · modified"; the branch is left out only on main). The
/// dot was the button's symbol image, centred in the cell apart from the title's baseline;
/// now it is drawn and its centre sits half the cap height above the identity's baseline.
/// When the sidebar is narrow the context truncates first (in the middle, so a long branch
/// keeps both ends), then the identity; nothing overlaps Activity or leaves the sidebar.
final class BuildBadge: NSObject {
    static let footerHeight: CGFloat = 32
    static let dotSize: CGFloat = 7, dotGap: CGFloat = 4
    let button = BuildBadgeButton()
    private let dot = BuildBadgeDot()
    private let identity = NSTextField(labelWithString: "")
    private let context = NSTextField(labelWithString: "")
    private lazy var contextCollapsed = context.widthAnchor.constraint(equalToConstant: 0)
    private(set) var status: [String: Any] = [:]
    private let copyItem = NSMenuItem(title: "Copy Commit", action: #selector(copyCommit), keyEquivalent: "")
    private let font = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)

    func install(in container: NSView, activity: ActivityIndicator) {
        button.target = self; button.action = #selector(open); button.title = ""
        button.isBordered = false; button.setButtonType(.momentaryChange); button.imagePosition = .noImage
        button.identifier = NSUserInterfaceItemIdentifier("build-badge")
        // LKM-325: with no title or image, macOS 27 reports the cell as AXUnknown.
        button.setAccessibilityRole(.button)
        button.setAccessibilityHelp("Shows this build's details")
        dot.translatesAutoresizingMaskIntoConstraints = false
        dot.setAccessibilityElement(false)
        button.addSubview(dot)
        // The context gives way before the identity; both before Activity (required) and
        // the sidebar's width: above `.defaultLow` the text would widen the sidebar.
        for (label, priority) in [(identity, NSLayoutConstraint.Priority.defaultLow), (context, NSLayoutConstraint.Priority(249))] {
            label.font = font; label.textColor = .secondaryLabelColor
            label.maximumNumberOfLines = 1; label.cell?.truncatesLastVisibleLine = true
            label.translatesAutoresizingMaskIntoConstraints = false
            label.setContentCompressionResistancePriority(priority, for: .horizontal)
            label.setContentHuggingPriority(.defaultHigh, for: .horizontal)
            label.setAccessibilityElement(false)
            button.addSubview(label)
        }
        identity.lineBreakMode = .byTruncatingTail; context.lineBreakMode = .byTruncatingMiddle
        identity.identifier = NSUserInterfaceItemIdentifier("build-badge-identity")
        context.identifier = NSUserInterfaceItemIdentifier("build-badge-context")
        // LKM-330: on macOS 27 a label's alignment rect leaves out its 2 pt text padding, so
        // chained alignment rects overlapped the frames and ran the two texts together. Space
        // the frames as on earlier systems (zero insets there).
        let identityInsets = identity.alignmentRectInsets, contextInsets = context.alignmentRectInsets
        NSLayoutConstraint.activate([
            dot.leadingAnchor.constraint(equalTo: button.leadingAnchor),
            dot.widthAnchor.constraint(equalToConstant: Self.dotSize), dot.heightAnchor.constraint(equalToConstant: Self.dotSize),
            // The digits' optical centre: half the cap height above the baseline.
            dot.centerYAnchor.constraint(equalTo: identity.firstBaselineAnchor, constant: -font.capHeight / 2),
            identity.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: Self.dotGap + identityInsets.left),
            identity.topAnchor.constraint(equalTo: button.topAnchor), identity.bottomAnchor.constraint(equalTo: button.bottomAnchor),
            context.leadingAnchor.constraint(equalTo: identity.trailingAnchor, constant: identityInsets.right + contextInsets.left),
            context.firstBaselineAnchor.constraint(equalTo: identity.firstBaselineAnchor),
            context.trailingAnchor.constraint(equalTo: button.trailingAnchor, constant: -contextInsets.right)
        ])
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
        // Until Bun's first state: the stamped version, build and commit, grey.
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "dev"
        let build = info["CFBundleVersion"] as? String ?? "", commit = info["TreziCommit"] as? String ?? ""
        let stamped = !build.isEmpty && commit.range(of: "^[0-9a-f]{7,40}$", options: .regularExpression) != nil
        update(["identity":stamped ? "\(version) (\(build), \(commit))" : version, "context":"", "tone":"gray", "state":"unknown",
                "label":"Checking whether this build is on main…", "details":[String]()])
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
        let contextText = c["context"] as? String ?? ""
        dot.color = Self.color(tone)
        identity.stringValue = c["identity"] as? String ?? text
        context.stringValue = contextText.isEmpty ? "" : "· \(contextText)"
        contextCollapsed.isActive = contextText.isEmpty
        let details = c["details"] as? [String] ?? []
        let label = c["label"] as? String ?? text
        button.toolTip = details.isEmpty ? label : details.joined(separator: "\n")
        button.setAccessibilityLabel("Build: \(c["spoken"] as? String ?? "\(identity.stringValue). \(label)")")
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

    /// Text, state and geometry in window coordinates (y up). `dotCapOffset` is the dot's
    /// centre minus the identity's cap-height centre, `dotCenterOffset` minus its frame's centre.
    func inspect() -> [String: Any] {
        let placed = button.window != nil
        let rect = { (view: NSView) in placed && !view.isHidden ? view.convert(view.bounds, to: nil) : NSRect.zero }
        let frame = rect(button), dotFrame = rect(dot), identityFrame = rect(identity), contextFrame = rect(context)
        let baseline = identityFrame.maxY - identity.firstBaselineOffsetFromTop
        // The intrinsic width is the alignment rect's (without macOS 27's text padding).
        let truncated = { (label: NSTextField) in !label.stringValue.isEmpty && label.intrinsicContentSize.width > label.alignmentRect(forFrame: label.frame).width + 0.5 }
        let shown = contextCollapsed.isActive ? identity.stringValue : "\(identity.stringValue) \(context.stringValue)"
        return ["badgeText":shown, "badgeIdentity":identity.stringValue, "badgeContext":context.stringValue,
                "badgeTone":status["tone"] as? String ?? "", "badgeState":status["state"] as? String ?? "",
                "badgeTooltip":button.toolTip ?? "", "badgeVisible":!button.isHidden && placed && frame.width > 0,
                "badgeFrame":NSStringFromRect(frame), "dotFrame":NSStringFromRect(dotFrame),
                "identityFrame":NSStringFromRect(identityFrame), "contextFrame":NSStringFromRect(contextFrame),
                "identityBaseline":baseline, "contextBaseline":contextFrame.maxY - context.firstBaselineOffsetFromTop,
                "capHeight":font.capHeight, "dotCapOffset":dotFrame.midY - (baseline + font.capHeight / 2),
                "dotCenterOffset":dotFrame.midY - identityFrame.midY,
                "identityTruncated":truncated(identity), "contextTruncated":!contextCollapsed.isActive && truncated(context),
                "badgeTruncated":truncated(identity) || (!contextCollapsed.isActive && truncated(context)),
                "badgeAccessibilityLabel":button.accessibilityLabel() ?? "", "badgeAccessibilityRole":button.accessibilityRole()?.rawValue ?? "",
                "badgeMenu":button.menu?.items.filter { !$0.isHidden }.map(\.title) ?? [], "aboutCredits":aboutCredits.string]
    }
}

/// The badge's one control: clicks and the context menu on the dot or the text reach it.
final class BuildBadgeButton: NSButton {
    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric) }
    override func hitTest(_ point: NSPoint) -> NSView? { super.hitTest(point) == nil ? nil : self }
}

/// The state dot, drawn so its colour follows the appearance.
final class BuildBadgeDot: NSView {
    var color: NSColor = .tertiaryLabelColor { didSet { needsDisplay = true } }
    override func draw(_ dirtyRect: NSRect) { color.setFill(); NSBezierPath(ovalIn: bounds).fill() }
}
