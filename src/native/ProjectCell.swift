import AppKit

/// LKM-388: a plain button's alignment rect follows its symbol, which left "…" a 20-point frame
/// beside New chat's row-tall one. No insets: the constraints set the frame, the glyph stays put.
final class ProjectMoreButton: NSButton {
    override var alignmentRectInsets: NSEdgeInsets { NSEdgeInsets() }
}

/// Keep project selection on the row and its actions on separate hover controls: the "…" menu
/// and, as in the retired Electron rail, New chat at the trailing edge.
final class ProjectCell: SourceListCell {
    let more = ProjectMoreButton()
    let newChat = NSButton()
    private var tracking: NSTrackingArea?
    var selected = false { didSet { updateVisibility() } }
    private var hovered = false
    override var backgroundStyle: NSView.BackgroundStyle { didSet { updateVisibility() } }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area); tracking = area
        if let window { hovered = bounds.contains(convert(window.mouseLocationOutsideOfEventStream, from: nil)) }
        updateVisibility()
    }
    override func mouseEntered(with event: NSEvent) { hovered = true; updateVisibility() }
    override func mouseExited(with event: NSEvent) { hovered = false; updateVisibility() }
    private func updateVisibility() {
        let emphasized = backgroundStyle == .emphasized
        for control in [more, newChat] as [NSControl] {
            control.alphaValue = hovered || selected || emphasized ? 1 : 0
        }
        more.contentTintColor = emphasized ? .alternateSelectedControlTextColor : .labelColor
        newChat.contentTintColor = more.contentTintColor
    }
    /// LKM-388: "…" and New chat are one control with two icons, so every state they have matches.
    /// The label goes on the cell (LKM-379).
    func installActions(title: String, project: String, target: AnyObject?, newChatAction: Selector, moreAction: Selector) {
        let actions: [(NSButton, String, String, String, String, Selector)] = [
            (more, "ellipsis", "more:\(project)", "Project Actions", "Actions for \(title)", moreAction),
            (newChat, "square.and.pencil", "new-chat:\(project)", "New Chat", "New chat in \(title)", newChatAction)]
        for (button, symbol, id, toolTip, label, action) in actions {
            button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
            button.isBordered = false; button.imagePosition = .imageOnly
            button.target = target; button.action = action
            button.identifier = NSUserInterfaceItemIdentifier(id)
            button.toolTip = toolTip
            button.cell?.setAccessibilityLabel(label)
            button.translatesAutoresizingMaskIntoConstraints = false; addSubview(button)
            NSLayoutConstraint.activate([button.centerYAnchor.constraint(equalTo: centerYAnchor),
                                         button.widthAnchor.constraint(equalToConstant: 24)])
        }
        NSLayoutConstraint.activate([newChat.heightAnchor.constraint(equalToConstant: 24), more.heightAnchor.constraint(equalTo: heightAnchor),
                                     newChat.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -4),
                                     more.trailingAnchor.constraint(equalTo: newChat.leadingAnchor)])
    }
    /// A row action as the checks read it, through the element VoiceOver gets.
    func actionInspect(_ button: NSButton) -> [String: Any] {
        layoutSubtreeIfNeeded()
        let element = AccessibilityElementInspect.element(of: button)
        return ["class": NSStringFromClass(type(of: button)), "bordered": button.isBordered, "bezel": button.bezelStyle.rawValue,
                "imageOnly": button.imagePosition == .imageOnly, "width": button.frame.width,
                "hitHeight": button.frame.intersection(bounds).height, "alpha": button.alphaValue, "tint": button.contentTintColor?.description ?? "",
                "enabled": button.isEnabled, "focusRing": button.focusRingType.rawValue, "highlighted": button.isHighlighted,
                "role": element?.accessibilityRole()?.rawValue ?? "", "label": element?.accessibilityLabel() ?? "", "toolTip": button.toolTip ?? ""]
    }
}

/// Which projects show their History section, and which of those show every closed chat.
/// Session-only: a relaunch starts hidden, as in the Electron rail.
struct SidebarHistoryState {
    var open: Set<String> = []
    var all: Set<String> = []
    /// Hiding returns the project to the default sidebar, so the next reveal starts at the preview.
    mutating func toggle(_ project: String) {
        if open.remove(project) == nil { open.insert(project) } else { all.remove(project) }
    }
    /// LKM-388: the project menu's History item. Only a selected project's closed chats are known:
    /// Bun loads them when a project first opens, so another project's can still be coming.
    func menuItem(_ row: ShellRow, selected: Bool) -> (title: String, enabled: Bool) {
        if selected && row.past.isEmpty { return ("Show History", false) }
        return (open.contains(row.project) ? "Hide History" : "Show History", true)
    }
}

final class ShellRow: NSObject {
    let id: String, title: String, kind: String, project: String
    let running: Bool
    /// The turn's model is at work (LKM-389): a chat row's title shimmers.
    let thinking: Bool
    let unread: Bool
    /// A history row's age ("3d"); the History toggle's chat count.
    let detail: String
    /// Bun sent favicon data for this row, decodable or not.
    let offeredIcon: Bool
    /// The decoded favicon; nil keeps the folder.
    let icon: NSImage?
    let children: [ShellRow]
    /// LKM-378: the selected project's open chats, newest first. Empty for every other project.
    let recent: [ShellRow]
    /// The selected project's closed chats (its `children` of kind "history"), for its History section.
    let past: [ShellRow]
    /// The outline rows under a project (`layoutNested`): its open chats. While the project menu
    /// has revealed History, also a header that hides it again (`kind` "history-toggle"), the first
    /// `historyPreview` closed chats and "Show N more"/"Show less" (`kind` "history-more").
    private(set) var nested: [ShellRow] = []
    /// Closed chats an open History section shows before "Show N more", as the Electron rail did.
    static let historyPreview = 3
    init(_ data: [String: Any]) {
        id = data["id"] as? String ?? ""; title = data["title"] as? String ?? ""
        kind = data["kind"] as? String ?? "chat"; project = data["project"] as? String ?? ""
        running = data["running"] as? Bool ?? false
        thinking = data["thinking"] as? Bool ?? false
        unread = data["unread"] as? Bool ?? false
        detail = data["detail"] as? String ?? ""
        // Decoded from this row's own snapshot entry, never from a later load: no icon can land on another row.
        offeredIcon = data["icon"] is String
        icon = SidebarFavicon.image(dataURL: data["icon"] as? String)
        children = (data["children"] as? [[String: Any]] ?? []).map(ShellRow.init)
        let recentData = data["recent"] as? [[String: Any]]
        recent = (recentData ?? []).map(ShellRow.init)
        past = recentData == nil ? [] : children.filter { $0.kind == "history" }
        super.init()
        layoutNested(open: false, all: false)
    }
    func layoutNested(open: Bool, all: Bool) {
        guard open, !past.isEmpty else { nested = recent; return }
        let toggle = ShellRow(["id":"history-toggle:\(project)", "kind":"history-toggle", "title":"History",
                               "detail":"\(past.count)", "project":project])
        let shown = all ? past : Array(past.prefix(Self.historyPreview))
        let hidden = past.count - shown.count
        let more = past.count > Self.historyPreview
            ? [ShellRow(["id":"history-more:\(project)", "kind":"history-more", "title":hidden > 0 ? "Show \(hidden) more" : "Show less", "project":project])] : []
        nested = recent + [toggle] + shown + more
    }
}

extension NSPasteboard.PasteboardType {
    static let treziProject = NSPasteboard.PasteboardType("dev.trezi.project-row")
}

extension NativeShell {
    func outlineView(_ outlineView: NSOutlineView, pasteboardWriterForItem item: Any) -> NSPasteboardWriting? {
        guard let row = item as? ShellRow, row.kind == "project" else { return nil }
        let pasteboard = NSPasteboardItem()
        pasteboard.setString(row.project, forType: .treziProject)
        return pasteboard
    }
    func outlineView(_ outlineView: NSOutlineView, validateDrop info: NSDraggingInfo, proposedItem item: Any?, proposedChildIndex index: Int) -> NSDragOperation {
        guard let source = info.draggingSource as? NSOutlineView, source === outlineView,
              item == nil, index >= 0, index <= rows.count,
              let key = info.draggingPasteboard.string(forType: .treziProject),
              let from = rows.firstIndex(where: { $0.project == key }),
              index != from, index != from + 1 else { return [] }
        return .move
    }
    func outlineView(_ outlineView: NSOutlineView, acceptDrop info: NSDraggingInfo, item: Any?, childIndex index: Int) -> Bool {
        guard self.outlineView(outlineView, validateDrop: info, proposedItem: item, proposedChildIndex: index) == .move,
              let key = info.draggingPasteboard.string(forType: .treziProject) else { return false }
        emit(["event":"shell-action", "action":"project-reorder", "project":key,
              "value":index < rows.count ? rows[index].project : ""])
        return true
    }
}
