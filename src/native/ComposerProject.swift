import AppKit

/// LKM-232: the centered start composer chooses where its message goes. A pull-down beside
/// Send names the project (or "Choose Project") and offers recents, Open Project… and New
/// Project…; each item is a start action, answered by the chat controller.
extension NativeComposer {
    func configureProject() {
        project.isBordered = false; project.controlSize = .small; project.font = .systemFont(ofSize: 11)
        project.cell?.lineBreakMode = .byTruncatingMiddle
        project.setAccessibilityLabel("Project")
        project.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        project.setContentHuggingPriority(.required, for: .horizontal)
        project.widthAnchor.constraint(lessThanOrEqualToConstant: 180).isActive = true
        project.target = self; project.action = #selector(chooseProject(_:))
        project.isHidden = true
    }
    func updateProject(_ start: [String: Any]?) {
        let shown = start?["centered"] as? Bool == true
        project.isHidden = !shown
        guard shown, let start else { return }
        let info = start["project"] as? [String: Any] ?? [:]
        let title = info["title"] as? String ?? "Choose Project"
        let recents = info["recents"] as? [[String: Any]] ?? []
        let signature = title + "|" + recents.compactMap { $0["root"] as? String }.joined(separator: "|")
        guard signature != projectSignature else { return }
        projectSignature = signature
        project.removeAllItems(); project.addItem(withTitle: title)
        project.item(at: 0)?.image = NSImage(systemSymbolName: "folder", accessibilityDescription: nil)
        project.toolTip = info["title"] is String ? "Project: " + title : "Choose where this message goes"
        func add(_ label: String, _ action: String, _ value: String? = nil) {
            let item = NSMenuItem(title: label, action: nil, keyEquivalent: "")
            var payload: [String: Any] = ["action":action]
            if let value { payload["value"] = value; item.toolTip = value }
            item.representedObject = payload; project.menu?.addItem(item)
        }
        for recent in recents {
            guard let root = recent["root"] as? String, let name = recent["name"] as? String else { continue }
            add(name, "start-recent", root)
        }
        if !recents.isEmpty { project.menu?.addItem(.separator()) }
        add("Open Project…", "start-open")
        add("New Project…", "start-new")
    }
    @objc func chooseProject(_ sender: NSPopUpButton) {
        guard let payload = sender.selectedItem?.representedObject as? [String: Any], let action = payload["action"] as? String else { return }
        var event: [String: Any] = ["event":"chat-action", "chat":chat, "action":action]
        if let value = payload["value"] { event["value"] = value }
        emit(event)
    }
}
