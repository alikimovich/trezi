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
    /// LKM-207: the project's states workbenches, as a Workbenches submenu after the actions.
    /// Absent when there are none. Open and Remove go to Bun (`src/native/states-controller.ts`);
    /// Remove asks first there.
    func updateWorkbenches(_ items: [[String: Any]]) {
        guard let more = toolbarItems["more"] as? NSMenuToolbarItem else { return }
        let menu = more.menu
        let entries = items.compactMap { item -> (String, String)? in
            guard let folder = item["folder"] as? String else { return nil }
            return (folder, item["component"] as? String ?? folder)
        }
        let current = menu.items.first(where: { $0.title == "Workbenches" })?.submenu?.items.map { $0.toolTip ?? "" } ?? []
        guard current != entries.map(\.0) else { return }
        while menu.items.count > Self.moreActions.count { menu.removeItem(at: menu.items.count - 1) }
        guard !entries.isEmpty else { return }
        let list = NSMenu(); list.autoenablesItems = false
        for (folder, component) in entries {
            let bench = NSMenuItem(title: component, action: nil, keyEquivalent: ""); bench.toolTip = folder
            let actions = NSMenu(); actions.autoenablesItems = false
            for (title, action) in [("Open", "open"), ("Remove Workbench…", "remove")] {
                let entry = NSMenuItem(title: title, action: #selector(previewMenuAction(_:)), keyEquivalent: ""); entry.target = self
                entry.representedObject = ["event":"states-action", "action":action, "id":folder]
                actions.addItem(entry)
            }
            bench.submenu = actions
            list.addItem(bench)
        }
        let title = NSMenuItem(title: "Workbenches", action: nil, keyEquivalent: ""); title.submenu = list
        menu.addItem(.separator()); menu.addItem(title)
    }
    /// Pipe checks pick an entry the way a click on it would; a workbench entry is
    /// `workbench-open:<folder>` or `workbench-remove:<folder>`.
    func performMore(_ item: NSMenuToolbarItem?, _ action: String) -> Bool {
        guard let item, item.isEnabled else { return false }
        func payload(_ entry: NSMenuItem) -> [String: String] { entry.representedObject as? [String: String] ?? [:] }
        let benches = item.menu.items.first(where: { $0.title == "Workbenches" })?.submenu?.items.flatMap { $0.submenu?.items ?? [] } ?? []
        let entry = item.menu.items.first(where: { payload($0)["action"] == action })
            ?? benches.first(where: { "workbench-\(payload($0)["action"] ?? ""):\(payload($0)["id"] ?? "")" == action })
        guard let entry else { return false }
        previewMenuAction(entry); return true
    }
    func moreInspect(_ item: NSMenuToolbarItem?) -> [String: Any] {
        ["moreMenu":item?.menu.items.filter { !$0.isSeparatorItem }.map(\.title) ?? [], "moreEnabled":item?.isEnabled ?? false,
         "moreVisible":toolbar.visibleItems?.contains { $0.itemIdentifier.rawValue == "more" } ?? false,
         "interactionSegments":(toolbar.items.first { $0.itemIdentifier.rawValue == "interaction" } as? MomentaryToolbarGroup)?.shown.map(\.itemIdentifier.rawValue) ?? []]
    }
    func workbenchesInspect() -> [[String: Any]] {
        let menu = (toolbarItems["more"] as? NSMenuToolbarItem)?.menu
        return (menu?.items.first(where: { $0.title == "Workbenches" })?.submenu?.items ?? []).map {
            ["component":$0.title, "folder":$0.toolTip ?? "", "actions":$0.submenu?.items.map(\.title) ?? []]
        }
    }
}
