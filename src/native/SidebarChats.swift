import AppKit

/// LKM-378: the selected project's chats, nested under its sidebar row, with the retired Electron
/// rail's controls (`Rail.tsx`): every open chat, an Archive button on the hovered row, and, from
/// the project's "…" menu, a History section that lists the closed chats (three, then "Show N more"). Bun picks the rows
/// (`sidebar-chats.ts`); a chat click sends the `select` shell action, with a pick generation,
/// so switching goes through the one workspace/chat path that keeps drafts, attachments and
/// running turns. A long title scrolls while its row is hovered (`SidebarMarquee.swift`).
final class SidebarChatCell: SourceListCell {
    /// Shown, and spinning, only while the chat's turn runs.
    let spinner = NSProgressIndicator()
    let slot = NSView()
    /// A finished answer the user has not opened yet (`unread`), when no turn runs.
    let dot = NSView()
    /// The History header's and "Show N more"'s in-cell button.
    private(set) var button: NSButton?
    private(set) var title: SidebarMarqueeTitle?
    /// Archive (Close chat), shown on hover; nil for the project's last open chat (closing it closes the project).
    private(set) var archive: NSButton?
    private(set) var detail: NSTextField?
    private var chevron: NSImageView?
    private(set) var spinning = false
    private(set) var hovered = false
    private var tracking: NSTrackingArea?
    private var resting: NSLayoutConstraint?, hovering: NSLayoutConstraint?

    init(row: ShellRow, canArchive: Bool, target: AnyObject?) {
        super.init(frame: .zero)
        identifier = NSUserInterfaceItemIdentifier(row.id)
        spinner.style = .spinning; spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        spinner.setAccessibilityLabel("Running")
        dot.wantsLayer = true; dot.layer?.cornerRadius = 3; dot.layer?.backgroundColor = NSColor.systemGreen.cgColor
        dot.isHidden = !(row.unread && !row.running)
        var views: [NSView] = [slot, spinner, dot]
        var constraints: [NSLayoutConstraint] = []
        let content: NSView
        if row.kind == "history-toggle" || row.kind == "history-more" {
            let button = SidebarRowButton.make(title: row.title, font: SidebarRowStyle.font, target: target,
                                               action: #selector(NativeShell.sidebarRowButton(_:)))
            button.identifier = NSUserInterfaceItemIdentifier(row.id)
            if row.kind == "history-toggle" {
                let text = NSMutableAttributedString(string: row.title, attributes: [.font: SidebarRowStyle.font, .foregroundColor: NSColor.secondaryLabelColor])
                text.append(NSAttributedString(string: "  " + row.detail, attributes: [.font: SidebarRowStyle.font, .foregroundColor: NSColor.tertiaryLabelColor]))
                button.attributedTitle = text
                button.cell?.setAccessibilityLabel("History, \(row.detail) closed chat\(row.detail == "1" ? "" : "s"), expanded")
                button.toolTip = "Hide closed chats"
                let chevron = NSImageView(image: NSImage(systemSymbolName: "chevron.down", accessibilityDescription: nil)!)
                chevron.symbolConfiguration = .init(pointSize: 9, weight: .semibold)
                chevron.contentTintColor = .secondaryLabelColor
                self.chevron = chevron; views.append(chevron)
                constraints += [chevron.centerXAnchor.constraint(equalTo: slot.centerXAnchor), chevron.centerYAnchor.constraint(equalTo: slot.centerYAnchor)]
            }
            self.button = button; content = button
            constraints.append(content.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -8))
        } else {
            let title = SidebarMarqueeTitle(title: row.title)
            self.title = title; textField = title.label; content = title
            toolTip = row.title
            if row.kind == "history" {
                let detail = NSTextField(labelWithString: row.detail)
                detail.font = .systemFont(ofSize: NSFont.smallSystemFontSize); detail.textColor = .tertiaryLabelColor
                detail.setContentHuggingPriority(.required, for: .horizontal)
                detail.setContentCompressionResistancePriority(.required, for: .horizontal)
                self.detail = detail; views.append(detail)
                constraints += [detail.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8), detail.centerYAnchor.constraint(equalTo: centerYAnchor),
                                title.trailingAnchor.constraint(lessThanOrEqualTo: detail.leadingAnchor, constant: -6)]
                setAccessibilityLabel(row.detail.isEmpty ? row.title : "\(row.title), \(row.detail)")
            } else {
                setAccessibilityLabel(row.running ? "\(row.title), Running" : row.unread ? "\(row.title), Unread answer" : row.title)
                let resting = title.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -8)
                constraints.append(resting); self.resting = resting
                if canArchive {
                    let archive = NSButton(image: NSImage(systemSymbolName: "archivebox", accessibilityDescription: nil)!, target: target,
                                           action: #selector(NativeShell.sidebarArchive(_:)))
                    archive.identifier = NSUserInterfaceItemIdentifier(row.id)
                    archive.isBordered = false; archive.imagePosition = .imageOnly
                    archive.symbolConfiguration = .init(pointSize: 11, weight: .regular)
                    archive.toolTip = "Archive Chat"
                    // LKM-379: VoiceOver gets the button's cell, so the label goes there.
                    archive.cell?.setAccessibilityLabel("Archive \(row.title)")
                    archive.alphaValue = 0
                    self.archive = archive; views.append(archive)
                    hovering = title.trailingAnchor.constraint(lessThanOrEqualTo: archive.leadingAnchor, constant: -4)
                    constraints += [archive.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6), archive.centerYAnchor.constraint(equalTo: centerYAnchor),
                                    archive.widthAnchor.constraint(equalToConstant: 20), archive.heightAnchor.constraint(equalToConstant: 20)]
                }
            }
        }
        content.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        for view in [content] + views { view.translatesAutoresizingMaskIntoConstraints = false; addSubview(view) }
        // The status slot sits under the project's icon, so chat titles line up with project titles.
        NSLayoutConstraint.activate(SidebarIconLayout.constraints(icon: slot, label: content, in: self, leading: SourceList.iconLeading) + constraints + [
            spinner.centerXAnchor.constraint(equalTo: slot.centerXAnchor), spinner.centerYAnchor.constraint(equalTo: slot.centerYAnchor),
            spinner.widthAnchor.constraint(equalToConstant: 12), spinner.heightAnchor.constraint(equalToConstant: 12),
            dot.centerXAnchor.constraint(equalTo: slot.centerXAnchor), dot.centerYAnchor.constraint(equalTo: slot.centerYAnchor),
            dot.widthAnchor.constraint(equalToConstant: 6), dot.heightAnchor.constraint(equalToConstant: 6)
        ])
        if row.running { spinner.startAnimation(nil); spinning = true }
        tint()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var backgroundStyle: NSView.BackgroundStyle { didSet { tint() } }
    private func tint() {
        let emphasized = backgroundStyle == .emphasized
        archive?.contentTintColor = emphasized ? .alternateSelectedControlTextColor : .secondaryLabelColor
        detail?.textColor = emphasized ? .alternateSelectedControlTextColor : .tertiaryLabelColor
    }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area); tracking = area
    }
    override func mouseEntered(with event: NSEvent) { setHovered(true) }
    override func mouseExited(with event: NSEvent) { setHovered(false) }
    /// Hover shows Archive (the title yields its width) and scrolls an overflowing title.
    func setHovered(_ on: Bool) {
        guard on != hovered else { return }
        hovered = on
        archive?.alphaValue = on ? 1 : 0
        if let hovering { resting?.isActive = !on; hovering.isActive = on }
        if on { title?.start() } else { title?.stop() }
    }
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
    func layoutNested() {
        for row in rows { row.layoutNested(open: sidebarHistory.open.contains(row.project), all: sidebarHistory.all.contains(row.project)) }
    }
    func sidebarChatCell(_ row: ShellRow) -> NSView {
        SidebarChatCell(row: row, canArchive: canArchive(row), target: self)
    }
    /// Closing a project's last open chat closes the project, so that chat has no Archive.
    func canArchive(_ row: ShellRow) -> Bool {
        row.kind == "chat" && (rows.first(where: { $0.project == row.project })?.recent.count ?? 0) > 1
    }
    /// Projects and open chats are selectable; History rows open from a click (`sidebarClicked`).
    func outlineView(_ outlineView: NSOutlineView, shouldSelectItem item: Any) -> Bool { ["project", "chat"].contains((item as? ShellRow)?.kind) }
    /// Nested chats are always shown: no disclosure triangle.
    func outlineView(_ outlineView: NSOutlineView, shouldShowOutlineCellForItem item: Any) -> Bool { false }
    func outlineView(_ outlineView: NSOutlineView, shouldCollapseItem item: Any) -> Bool { false }

    /// The History header and "Show N more"/"Show less".
    @objc func sidebarRowButton(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue, let row = outlineRows.first(where: { $0.id == id }) else { return }
        if row.kind == "history-toggle" { sidebarHistory.toggle(row.project) }
        else if sidebarHistory.all.remove(row.project) == nil { sidebarHistory.all.insert(row.project) }
        reloadNested(row.project)
    }
    /// The project menu's Show/Hide History.
    func sidebarHistoryItem(_ row: ShellRow) -> NSMenuItem {
        let entry = sidebarHistory.menuItem(row, selected: row.project == currentProject)
        let item = NSMenuItem(title: entry.title, action: #selector(sidebarToggleHistory(_:)), keyEquivalent: "")
        item.target = self; item.isEnabled = entry.enabled; item.representedObject = row.project
        return item
    }
    @objc func sidebarToggleHistory(_ item: NSMenuItem) {
        guard let project = item.representedObject as? String else { return }
        sidebarHistory.toggle(project)
        // Only the selected project nests rows, so revealing another's History selects it first,
        // through the usual selection path; its rows come with the state that answers.
        if project != currentProject, sidebarHistory.open.contains(project), let row = rows.first(where: { $0.project == project }) {
            outline.selectRowIndexes(IndexSet(integer: outline.row(forItem: row)), byExtendingSelection: false)
        } else { reloadNested(project) }
    }
    private func reloadNested(_ project: String) {
        guard let row = rows.first(where: { $0.project == project }) else { return }
        layoutNested()
        let wasApplying = applying
        applying = true; defer { applying = wasApplying }
        outline.reloadItem(row, reloadChildren: true)
        outline.expandItem(row)
        if let target = sidebarTarget() {
            let index = outline.row(forItem: target)
            if index >= 0 && outline.selectedRow != index { outline.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false) }
        }
    }
    @objc func sidebarArchive(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue, let row = outlineRows.first(where: { $0.id == id }), canArchive(row) else { return }
        emit(["event":"shell-action", "action":"close", "id":row.id, "project":row.project])
    }
    @objc func sidebarNewChat(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue, id.hasPrefix("new-chat:") else { return }
        emit(["event":"shell-action", "action":"new-chat", "project":String(id.dropFirst(9))])
    }
    /// A History row opens the closed chat for review, from where it can be resumed.
    @objc func sidebarClicked(_ sender: Any?) {
        guard let row = outline.item(atRow: outline.clickedRow) as? ShellRow, row.kind == "history" else { return }
        emit(["event":"shell-action", "action":"select", "id":row.id, "project":row.project])
    }
    /// The project row's "…". The menu is built on each press, so it reads the History state of now.
    @objc func sidebarMore(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue, id.hasPrefix("more:"), let row = rows.first(where: { $0.project == String(id.dropFirst(5)) }) else { return }
        projectMenu(row).popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.maxY + 4), in: sender)
    }
    /// The context menu of a nested row: Rename and Archive for an open chat, Open and Rename for a closed one.
    func sidebarRowMenu(_ row: ShellRow) -> [NSMenuItem] {
        let entries: [(String, String, Bool)] = row.kind == "chat" ? [("Rename Chat…", "rename-chat", true), ("Archive Chat", "close", canArchive(row))]
            : row.kind == "history" ? [("Open Chat", "select", true), ("Rename Chat…", "rename-chat", true)] : []
        return entries.map { title, action, enabled in
            let item = NSMenuItem(title: title, action: #selector(contextAction(_:)), keyEquivalent: "")
            item.target = self; item.isEnabled = enabled
            item.representedObject = ["event":"shell-action", "action":action, "id":row.id, "project":row.project]
            return item
        }
    }

    private func sidebarCell(_ id: String?) -> SidebarChatCell? {
        guard let index = (0..<outline.numberOfRows).first(where: { (outline.item(atRow: $0) as? ShellRow)?.id == id }) else { return nil }
        return outline.view(atColumn: 0, row: index, makeIfNecessary: true) as? SidebarChatCell
    }
    /// The pipe checks press the real controls (`performClick` runs their actions) and drive hover.
    func performSidebarChats(_ action: String, id: String?) -> Bool? {
        switch action {
        case "sidebar-new-chat":
            guard let index = (0..<outline.numberOfRows).first(where: { (outline.item(atRow: $0) as? ShellRow)?.id == "project:\(id ?? "")" }),
                  let cell = outline.view(atColumn: 0, row: index, makeIfNecessary: true) as? ProjectCell else { return false }
            cell.newChat.performClick(nil); return true
        case "sidebar-archive":
            guard let button = sidebarCell(id)?.archive else { return false }
            button.performClick(nil); return true
        case "history-toggle", "history-more":
            guard let project = currentProject, let button = sidebarCell("\(action):\(project)")?.button else { return false }
            button.performClick(nil); return true
        case "history-open":
            guard let row = outlineRows.first(where: { $0.id == id && $0.kind == "history" }) else { return false }
            emit(["event":"shell-action", "action":"select", "id":row.id, "project":row.project]); return true
        case "sidebar-hover":
            for index in 0..<outline.numberOfRows { (outline.view(atColumn: 0, row: index, makeIfNecessary: false) as? SidebarChatCell)?.setHovered(false) }
            guard let id else { return true }
            guard let cell = sidebarCell(id) else { return false }
            cell.setHovered(true); return true
        case "marquee-reduce-motion":
            SidebarMarqueeTitle.reduceMotionOverride = id == nil ? nil : id == "on"; return true
        default: return nil
        }
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
                    "running": row.running, "spinning": cell.spinning, "unread": row.unread, "unreadDot": !cell.dot.isHidden,
                    "detail": cell.detail?.stringValue ?? "", "hovered": cell.hovered,
                    "archive": cell.archive != nil, "archiveVisible": (cell.archive?.alphaValue ?? 0) > 0,
                    "marquee": cell.title?.running ?? false, "travel": cell.title?.travel ?? 0,
                    "label": cell.accessibilityLabel() ?? "", "menu": sidebarRowMenu(row).map { $0.isEnabled ? $0.title : "\($0.title) (disabled)" },
                    "role": outline.rowView(atRow: index, makeIfNecessary: true)?.accessibilityRole()?.rawValue ?? ""]
            if let title = cell.title { item["marqueeState"] = title.inspect(archive: cell.archive, in: sidebar.view) }
            // LKM-379: the button's role and label come from the element VoiceOver gets (its cell).
            if let button = cell.button { item.merge(AccessibilityElementInspect.inspect(button)) { $1 } }
            if let archive = cell.archive { item["archiveLabel"] = AccessibilityElementInspect.element(of: archive)?.accessibilityLabel() ?? "" }
            if let own = leading(cell.button ?? cell.title), let project = leading(parentText) { item["textOffset"] = own - project }
            return item
        }
        let newChat: [[String: Any]] = (0..<outline.numberOfRows).compactMap { index in
            guard let cell = outline.view(atColumn: 0, row: index, makeIfNecessary: true) as? ProjectCell,
                  let row = outline.item(atRow: index) as? ShellRow, let element = AccessibilityElementInspect.element(of: cell.newChat) else { return nil }
            return ["project": row.project, "label": element.accessibilityLabel() ?? "", "role": element.accessibilityRole()?.rawValue ?? "",
                    "visible": cell.newChat.alphaValue > 0, "trailing": cell.convert(cell.newChat.frame, from: cell.newChat.superview).maxX - cell.bounds.maxX]
        }
        return ["sidebarChats": items, "sidebarExpanded": rows.filter { outline.isItemExpanded($0) }.map(\.id),
                "sidebarNewChat": newChat, "historyOpen": sidebarHistory.open.sorted(), "historyAll": sidebarHistory.all.sorted()]
    }
}
