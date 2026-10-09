import AppKit

/// LKM-220: the toolbar's States indicator, a small pull-down after the branch under the
/// address ("States 2"), absent when the project has no workbench. Each workbench is a
/// submenu: where it came from, then Open (at the state last viewed), Open All States,
/// Continue in Chat, Rebuild States and Remove Workbench…. Every entry goes to Bun as a
/// `states-action` (`src/native/states-controller.ts`); Remove asks first there.
extension NativeShell {
    static let statesActions = [("Open", "open"), ("Open All States", "grid"), ("Continue in Chat", "continue"), ("Rebuild States", "rebuild")]
    /// Placed beside the branch inside the address block, not as an arranged row, so the
    /// address and branch keep their geometry (`ToolbarAddress.swift`).
    func configureStatesMenu(in header: NSView) {
        statesMenu.isBordered = false; statesMenu.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        statesMenu.setAccessibilityLabel("States workbenches"); statesMenu.toolTip = "States workbenches"
        statesMenu.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
        statesMenu.translatesAutoresizingMaskIntoConstraints = false; statesMenu.isHidden = true
        header.addSubview(statesMenu)
        statesMenuConstraints = [statesMenu.leadingAnchor.constraint(equalTo: branchMenu.trailingAnchor, constant: 6),
                                 statesMenu.centerYAnchor.constraint(equalTo: branchMenu.centerYAnchor),
                                 statesMenu.trailingAnchor.constraint(lessThanOrEqualTo: header.trailingAnchor)]
    }
    func updateWorkbenches(_ items: [[String: Any]]) {
        let benches = items.filter { $0["folder"] is String }
        let menu = NSMenu(); menu.autoenablesItems = false
        menu.addItem(withTitle: "States \(benches.count)", action: nil, keyEquivalent: "")
        for item in benches {
            let folder = item["folder"] as? String ?? ""
            let bench = NSMenuItem(title: item["component"] as? String ?? folder, action: nil, keyEquivalent: ""); bench.toolTip = folder
            let actions = NSMenu(); actions.autoenablesItems = false
            let info = [(item["from"] as? String).map { "From \($0)" }, item["chat"] as? String, (item["last"] as? String).map { "Last: \($0)" }].compactMap { $0 }
            let detail = NSMenuItem(title: info.isEmpty ? folder : info.joined(separator: " · "), action: nil, keyEquivalent: ""); detail.isEnabled = false
            actions.addItem(detail); actions.addItem(.separator())
            func add(_ title: String, _ action: String) {
                let entry = NSMenuItem(title: title, action: #selector(previewMenuAction(_:)), keyEquivalent: ""); entry.target = self
                entry.representedObject = ["event":"states-action", "action":action, "id":folder]
                actions.addItem(entry)
            }
            for (title, action) in Self.statesActions { add(title, action) }
            actions.addItem(.separator()); add("Remove Workbench…", "remove")
            bench.submenu = actions
            menu.addItem(bench)
        }
        statesMenu.menu = menu
        let hidden = benches.isEmpty
        guard statesMenu.isHidden != hidden else { return }
        statesMenu.isHidden = hidden
        if hidden { NSLayoutConstraint.deactivate(statesMenuConstraints) } else { NSLayoutConstraint.activate(statesMenuConstraints) }
    }
    /// Pipe checks pick an entry the way a click on it would: `<action>:<folder>`.
    func performStatesMenu(_ action: String) -> Bool {
        guard !statesMenu.isHidden else { return false }
        let entry = (statesMenu.menu?.items ?? []).flatMap { $0.submenu?.items ?? [] }.first {
            guard let payload = $0.representedObject as? [String: String] else { return false }
            return "\(payload["action"] ?? ""):\(payload["id"] ?? "")" == action
        }
        guard let entry else { return false }
        previewMenuAction(entry); return true
    }
    func workbenchesInspect() -> [String: Any] {
        let items = (statesMenu.menu?.items ?? []).dropFirst()
        return ["statesMenuVisible":!statesMenu.isHidden && statesMenu.window != nil, "statesMenuTitle":statesMenu.menu?.items.first?.title ?? "",
                "workbenches":items.map { ["component":$0.title, "folder":$0.toolTip ?? "", "info":$0.submenu?.items.first?.title ?? "",
                                           "actions":$0.submenu?.items.filter { !$0.isSeparatorItem && $0.isEnabled }.map(\.title) ?? []] }]
    }
}
