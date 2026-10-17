import AppKit

/// The chat header's history menu (LKM-268): one row per chat with a fixed-width status bullet
/// (running pulses, unread is green). The stored state lives on `NativeShell`; `HistoryVerification.swift`
/// drives the menu through real tracking in tests.
extension NativeShell {
    func historyRows() -> [ShellRow] { rows.first(where: { $0.project == currentProject })?.children ?? [] }
    func updateHistoryMenu() {
        let current = historyRows()
        let menu = chatActions.historyMenu ?? NSMenu()
        let existing = menu.items.compactMap { item -> String? in
            let info = item.representedObject as? [String: String]
            return info?["action"] == "select" ? info?["id"] : nil
        }
        // AppKit tracks the highlighted item by identity. Never replace items while
        // tracking; the next opening can reconcile a changed row list.
        let menuSelection = menu.items.first(where: { ($0.representedObject as? [String: String])?["action"] == "rename-chat" })
            .flatMap { ($0.representedObject as? [String: String])?["id"] }
        if !historyTracking && (existing != current.map(\.id) || menuSelection != selectedID || chatActions.historyMenu == nil) {
            menu.removeAllItems()
            menu.autoenablesItems = false
            menu.delegate = self
            for row in current {
                let item = NSMenuItem(title: row.title, action: #selector(contextAction(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = ["event":"shell-action", "action":"select", "id":row.id, "project":row.project]
                item.image = NSImage(systemSymbolName: row.kind == "history" ? "clock" : "bubble.left", accessibilityDescription: nil)
                menu.addItem(item)
            }
            if let selectedID, currentProject != nil {
                menu.addItem(.separator())
                for (title, action) in [("Rename current chat…", "rename-chat"), ("Close current chat", "close")] {
                    let item = NSMenuItem(title: title, action: #selector(contextAction(_:)), keyEquivalent: "")
                    item.target = self
                    item.representedObject = ["event":"shell-action", "action":action, "id":selectedID]
                    menu.addItem(item)
                }
            }
        }
        for row in current {
            guard let item = menu.items.first(where: { ($0.representedObject as? [String: String])?["id"] == row.id }) else { continue }
            item.state = row.id == selectedID ? .on : .off
            item.setAccessibilityLabel("\(row.title), \(row.running ? "Running" : row.unread ? "Unread answer" : "Read")")
            // A constant-width bullet slot keeps the native row geometry fixed. A hidden bullet is a blank
            // kerned to the bullet's width, not a clear-coloured glyph (a dark menu's vibrancy still draws that faintly).
            let font = NSFont.menuFont(ofSize: 0)
            let visible = row.running ? (historyReduceMotion || historyPulse) : row.unread
            let title = NSMutableAttributedString(string: (visible ? "●" : " ") + "  " + row.title, attributes: [.font: font])
            if visible {
                // `willHighlight` runs before AppKit updates `highlightedItem`, so track it ourselves.
                let color: NSColor = historyHighlight === item ? .selectedMenuItemTextColor : row.running ? .controlAccentColor : .systemGreen
                title.addAttribute(.foregroundColor, value: color, range: NSRange(location: 0, length: 1))
            } else {
                let width = { (text: String) in (text as NSString).size(withAttributes: [.font: font]).width }
                title.addAttribute(.kern, value: width("●") - width(" "), range: NSRange(location: 0, length: 1))
            }
            item.attributedTitle = title
        }
        if historyTracking {
            let animate = current.contains(where: { $0.running }) && !historyReduceMotion
            if animate && historyTimer == nil {
                // Menu tracking runs the loop in event-tracking mode: a default-mode timer would never fire.
                let timer = Timer(timeInterval: 0.55, repeats: true) { [weak self] _ in
                    guard let self else { return }
                    self.historyPulse.toggle()
                    self.updateHistoryMenu()
                }
                RunLoop.main.add(timer, forMode: .common)
                historyTimer = timer
            } else if !animate {
                historyTimer?.invalidate()
                historyTimer = nil
                historyPulse = true
            }
        }
        chatActions.historyMenu = menu
        chatActions.updateEnabled(project: chatReady, history: chatReady && !current.isEmpty)
    }
    func menuWillOpen(_ menu: NSMenu) {
        guard menu === chatActions.historyMenu else { return }
        historyTracking = true
        historyPulse = true
        updateHistoryMenu()
    }
    func menuDidClose(_ menu: NSMenu) {
        guard menu === chatActions.historyMenu else { return }
        historyTracking = false
        historyHighlight = nil
        historyTimer?.invalidate()
        historyTimer = nil
        updateHistoryMenu()
    }
    func menu(_ menu: NSMenu, willHighlight item: NSMenuItem?) {
        guard menu === chatActions.historyMenu else { return }
        historyHighlight = item
        updateHistoryMenu()
    }
    func historyInspect() -> [String: Any] {
        let menu = chatActions.historyMenu
        return ["historyTracking":historyTracking, "historyTimer":historyTimer != nil,
                "historyAppearanceForced":menu?.appearance != nil,
                "historyReduceMotion":historyReduceMotion,
                "historyPulse":historyPulse, "historyMenuWidth":menu?.size.width ?? 0,
                "historyHighlighted":(menu?.highlightedItem?.representedObject as? [String: String])?["id"] ?? "",
                "historyRows":menu?.items.compactMap { item -> [String: Any]? in
                    guard let info = item.representedObject as? [String: String], info["action"] == "select" else { return nil }
                    let rowTitle = historyRows().first(where: { $0.id == info["id"] })?.title ?? item.title
                    return ["id":info["id"] ?? "", "title":rowTitle,
                            "label":item.accessibilityLabel() ?? "", "selected":item.state == .on,
                            "identity":ObjectIdentifier(item).hashValue,
                            "slotLength":(item.attributedTitle?.length ?? 0) - (rowTitle as NSString).length]
                } ?? []]
    }
}
