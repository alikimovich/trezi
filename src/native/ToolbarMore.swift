import AppKit

/// LKM-197: the preview toolbar's "…" menu, after Publish. Its actions go to Bun as
/// shell actions (`src/native/preview-refresh.ts`).
extension NativeShell {
    static let moreActions = [("Reload Without Cache", "reload-hard"), ("Restart Dev Server (clean cache)", "restart-clean")]
    func configureMore(_ item: NSMenuToolbarItem) {
        item.showsIndicator = false
        // Secondary to Publish: when the toolbar cannot fit everything (a minimum-width window)
        // AppKit moves this into its overflow menu first instead of widening the right group.
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
    /// Below this window width the slow-motion (LKM-206) and "…" items leave the toolbar: the
    /// minimum-width window already has no room for the right groups, and they would widen
    /// them further. Their actions stay with the menu bar, the agent tools and wider windows.
    static let moreMinimumWindow: CGFloat = 1000
    /// `items` follow Publish, the last one at the trailing edge.
    func fitMore(_ items: [NSToolbarItem], windowWidth: CGFloat) {
        guard #available(macOS 15, *), !items.isEmpty else { return }
        let hidden = windowWidth < Self.moreMinimumWindow
        guard items.contains(where: { $0.isHidden != hidden }) else { return }
        // The right groups are pinned to the trailing edge, so they move by the items' widths plus
        // the spaces before them. Apply that to the reserved inset now: the address block is sized in
        // this same pass, before the toolbar's next layout can be measured.
        addressLayout.moveRightGroups(hiding: hidden, by: moreShift)
        for item in items { item.isHidden = hidden }
    }
    /// Pipe checks pick an entry the way a click on it would.
    func performMore(_ item: NSMenuToolbarItem?, _ action: String) -> Bool {
        guard let item, item.isEnabled,
              let entry = item.menu.items.first(where: { ($0.representedObject as? [String: String])?["action"] == action }) else { return false }
        previewMenuAction(entry); return true
    }
    func moreInspect(_ item: NSMenuToolbarItem?) -> [String: Any] {
        ["moreMenu":item?.menu.items.map(\.title) ?? [], "moreEnabled":item?.isEnabled ?? false,
         "moreVisible":toolbar.visibleItems?.contains { $0.itemIdentifier.rawValue == "more" } ?? false]
    }
}
