import AppKit

/// LKM-378: the selected project's recent chats, nested under its sidebar row. Bun picks the
/// rows (`sidebar-chats.ts`); a click sends the same `select` shell action, with a pick
/// generation, that the chat header's history menu sends, so switching goes through the one
/// workspace/chat path that keeps drafts, attachments and running turns. "View all chats"
/// opens that history menu.
final class SidebarChatCell: SourceListCell {
    /// Shown, and spinning, only while the chat's turn runs.
    let spinner = NSProgressIndicator()
    let slot = NSView()
    private(set) var button: NSButton?

    init(row: ShellRow, target: AnyObject?, action: Selector?) {
        super.init(frame: .zero)
        identifier = NSUserInterfaceItemIdentifier(row.id)
        spinner.style = .spinning; spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        spinner.setAccessibilityLabel("Running")
        let content: NSView
        if row.kind == "all-chats" {
            let button = SidebarAllChatsButton.make(title: row.title, font: SidebarRowStyle.font, target: target, action: action)
            button.toolTip = "Show every chat of this project"
            self.button = button; content = button
        } else {
            let text = NSTextField(labelWithString: row.title)
            text.font = SidebarRowStyle.font; text.lineBreakMode = .byTruncatingTail
            textField = text; content = text
            toolTip = row.title
            setAccessibilityLabel(row.running ? "\(row.title), Running" : row.title)
        }
        content.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        for view in [slot, spinner, content] { view.translatesAutoresizingMaskIntoConstraints = false; addSubview(view) }
        // The status slot sits under the project's icon, so chat titles line up with project titles.
        NSLayoutConstraint.activate(SidebarIconLayout.constraints(icon: slot, label: content, in: self, leading: SourceList.iconLeading) + [
            content.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -8),
            spinner.centerXAnchor.constraint(equalTo: slot.centerXAnchor), spinner.centerYAnchor.constraint(equalTo: slot.centerYAnchor),
            spinner.widthAnchor.constraint(equalToConstant: 12), spinner.heightAnchor.constraint(equalToConstant: 12)
        ])
        if row.running { spinner.startAnimation(nil); spinning = true }
    }
    private(set) var spinning = false
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

extension NativeShell {
    /// Every row the outline shows: each project, then its nested rows.
    var outlineRows: [ShellRow] { rows.flatMap { [$0] + $0.nested } }
    /// The row that carries the selection: the selected chat when it is nested, else its project.
    func sidebarTarget() -> ShellRow? {
        guard let project = rows.first(where: { $0.project == currentProject }) else { return nil }
        return project.nested.first(where: { $0.kind == "chat" && $0.id == selectedID }) ?? project
    }
    func expandNested() { for row in rows where !row.nested.isEmpty { outline.expandItem(row) } }
    func sidebarChatCell(_ row: ShellRow) -> NSView {
        SidebarChatCell(row: row, target: self, action: #selector(viewAllChats(_:)))
    }
    func outlineView(_ outlineView: NSOutlineView, shouldSelectItem item: Any) -> Bool { (item as? ShellRow)?.kind != "all-chats" }
    /// Nested chats are always shown: no disclosure triangle.
    func outlineView(_ outlineView: NSOutlineView, shouldShowOutlineCellForItem item: Any) -> Bool { false }
    func outlineView(_ outlineView: NSOutlineView, shouldCollapseItem item: Any) -> Bool { false }
    /// The chat header's history menu, under the "View all chats" row.
    @objc func viewAllChats(_ sender: NSButton) {
        updateHistoryMenu()
        guard let menu = chatActions.historyMenu, !menu.items.isEmpty else { return }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.isFlipped ? sender.bounds.maxY + 2 : -2), in: sender)
    }
    /// The pipe check presses the element VoiceOver gets (LKM-379), so the button's own action
    /// opens the menu. The press is deferred to a run-loop timer because `popUp` blocks (as
    /// `historyBroker` does), and a watchdog dismisses the menu.
    func performSidebarChats(_ action: String) -> Bool? {
        guard action == "view-all-chats" else { return nil }
        guard let index = (0..<outline.numberOfRows).first(where: { (outline.item(atRow: $0) as? ShellRow)?.kind == "all-chats" }),
              let button = (outline.view(atColumn: 0, row: index, makeIfNecessary: true) as? SidebarChatCell)?.button,
              let element = AccessibilityElementInspect.element(of: button) else { return false }
        updateHistoryMenu()
        guard let menu = chatActions.historyMenu, !menu.items.isEmpty else { return false }
        historyWatchdog?.invalidate()
        let opener = Timer(timeInterval: 0.05, repeats: false) { [weak self] _ in
            let watchdog = Timer(timeInterval: 45, repeats: false) { _ in menu.cancelTracking() }
            RunLoop.main.add(watchdog, forMode: .common)
            self?.historyWatchdog = watchdog
            _ = element.accessibilityPerformPress()
            watchdog.invalidate()
        }
        RunLoop.main.add(opener, forMode: .common)
        return true
    }
    /// The nested rows as the outline shows them, for the integration checks.
    func sidebarChatsInspect() -> [String: Any] {
        let items: [[String: Any]] = (0..<outline.numberOfRows).compactMap { index in
            guard let row = outline.item(atRow: index) as? ShellRow, row.kind != "project",
                  let cell = outline.view(atColumn: 0, row: index, makeIfNecessary: true) as? SidebarChatCell else { return nil }
            cell.layoutSubtreeIfNeeded()
            let parent = outline.parent(forItem: row) as? ShellRow
            let parentText = parent.flatMap { outline.view(atColumn: 0, row: outline.row(forItem: $0), makeIfNecessary: true) as? ProjectCell }?.textField
            // Window x of a view's layout rect (a label's frame adds its text inset).
            let leading = { (view: NSView?) -> CGFloat? in
                guard let view, let superview = view.superview else { return nil }
                return superview.convert(view.alignmentRect(forFrame: view.frame), to: nil).minX
            }
            var item: [String: Any] = ["id": row.id, "kind": row.kind, "title": row.title, "project": row.project, "parent": parent?.id ?? "",
                    "selected": outline.selectedRow == index, "selectable": outlineView(outline, shouldSelectItem: row),
                    "running": row.running, "spinning": cell.spinning,
                    "label": cell.accessibilityLabel() ?? "",
                    "role": outline.rowView(atRow: index, makeIfNecessary: true)?.accessibilityRole()?.rawValue ?? ""]
            // LKM-379: the button's role and label come from the element VoiceOver gets (its cell).
            if let button = cell.button { item.merge(AccessibilityElementInspect.inspect(button)) { $1 } }
            if let own = leading(cell.button ?? cell.textField), let project = leading(parentText) { item["textOffset"] = own - project }
            return item
        }
        return ["sidebarChats": items, "sidebarExpanded": rows.filter { outline.isItemExpanded($0) }.map(\.id)]
    }
}
