import AppKit

/// LKM-197: the preview toolbar's "…" menu. LKM-213: just before Publish, which stays the
/// last item at the trailing edge. Its actions go to Bun as shell actions (`src/native/preview-refresh.ts`).
extension NativeShell {
    static let moreActions = [("Reload Without Cache", "reload-hard"), ("Restart Dev Server (clean cache)", "restart-clean")]
    func configureMore(_ item: NSMenuToolbarItem) {
        item.showsIndicator = false
        // Secondary to Publish: when the toolbar cannot fit everything (a minimum-width window)
        // AppKit moves this into its overflow menu first; Publish (high priority) never goes there.
        item.visibilityPriority = .low
        item.image = toolbarSymbol("ellipsis.circle", item.label)
        let menu = NSMenu(); menu.autoenablesItems = false
        for (title, action) in Self.moreActions {
            let entry = NSMenuItem(title: title, action: #selector(previewMenuAction(_:)), keyEquivalent: ""); entry.target = self
            entry.representedObject = ["event":"shell-action", "action":action]
            menu.addItem(entry)
        }
        item.menu = menu
    }
    /// Below this window width the "…" item and the slow-motion segment (LKM-206) leave the
    /// toolbar: the minimum-width window already has no room for the right groups, and they
    /// would widen them further. Their actions stay with the menu bar, the agent tools and wider
    /// windows. Publish stays, the last item at the trailing edge.
    static let moreMinimumWindow: CGFloat = 1000
    func fitMore(windowWidth: CGFloat) {
        guard #available(macOS 15, *), let item = toolbarItems["more"] else { return }
        let hidden = windowWidth < Self.moreMinimumWindow
        guard item.isHidden != hidden else { return }
        // The right groups are pinned to the trailing edge. "…" moves the groups before it by its
        // width plus the spacing to Publish (the distance between their leading edges while it
        // shows); the segment moves the interaction group's leading edge by its width. Apply that to
        // the reserved inset now: the address block is sized in this same pass, before the
        // toolbar's next layout can be measured.
        let frames = hidden ? toolbarItemFrames(window) : [:]
        if let more = frames["more"], let publish = frames["publish"], publish.minX > more.minX { moreShift = publish.minX - more.minX }
        let group = toolbar.items.first { $0.itemIdentifier.rawValue == "interaction" } as? MomentaryToolbarGroup
        let segment = abs(group?.setSegment("speed", hidden: hidden) ?? 0)
        addressLayout.moveRightGroups(hiding: hidden, by: moreShift + segment)
        item.isHidden = hidden
    }
    /// Pipe checks pick an entry the way a click on it would. (LKM-220: the workbenches
    /// moved from here to the States menu, `ToolbarStates.swift`.)
    func performMore(_ item: NSMenuToolbarItem?, _ action: String) -> Bool {
        guard let item, item.isEnabled,
              let entry = item.menu.items.first(where: { ($0.representedObject as? [String: String])?["action"] == action }) else { return false }
        previewMenuAction(entry); return true
    }
    func moreInspect(_ item: NSMenuToolbarItem?) -> [String: Any] {
        ["moreMenu":item?.menu.items.filter { !$0.isSeparatorItem }.map(\.title) ?? [], "moreEnabled":item?.isEnabled ?? false,
         "moreVisible":toolbar.visibleItems?.contains { $0.itemIdentifier.rawValue == "more" } ?? false,
         "interactionSegments":(toolbar.items.first { $0.itemIdentifier.rawValue == "interaction" } as? MomentaryToolbarGroup)?.shown.map(\.itemIdentifier.rawValue) ?? []]
    }
}
