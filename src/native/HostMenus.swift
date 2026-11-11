import AppKit

/// The main menu bar Host builds, its actions, and Open Recent (LKM-160 split from Host.swift).
extension Host {
    func installMenus() {
        let menu = NSMenu()
        func submenu(_ title: String) -> NSMenu {
            let item = NSMenuItem(); item.title = title; let sub = NSMenu(title: title); item.submenu = sub; menu.addItem(item); return sub
        }
        let appMenu = submenu("Trezi")
        let about = NSMenuItem(title: "About Trezi", action: #selector(showAbout(_:)), keyEquivalent: ""); about.target = self; appMenu.addItem(about)
        appMenu.addItem(.separator())
        let settings = NSMenuItem(title: "Settings…", action: #selector(menuAction(_:)), keyEquivalent: ","); settings.representedObject = "settings"; settings.target = self; appMenu.addItem(settings)
        // LKM-202: the Dreamer's run, its proposals and the report export.
        appMenu.addItem(.separator())
        for (label, action) in [("Run Dreamer…", "dreamer-run"), ("Dreamer Proposals…", "dreamer-review"), ("Export Dreamer Report…", "dreamer-export")] {
            let item = NSMenuItem(title: label, action: #selector(menuAction(_:)), keyEquivalent: ""); item.target = self; item.representedObject = action; appMenu.addItem(item)
        }
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Trezi", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let file = submenu("File")
        for (label, key, action) in [("New Project…", "n", "new-project"), ("Open Project…", "o", "open-project")] {
            let item = NSMenuItem(title: label, action: #selector(menuAction(_:)), keyEquivalent: key); item.target = self; item.representedObject = action; file.addItem(item)
        }
        let recent = NSMenuItem(title: "Open Recent", action: nil, keyEquivalent: ""); recent.submenu = recentMenu; file.addItem(recent)
        file.addItem(.separator())
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let edit = submenu("Edit")
        let undo = NSMenuItem(title: "Undo", action: #selector(menuAction(_:)), keyEquivalent: "z"); undo.target = self; undo.representedObject = "undo"; edit.addItem(undo)
        // LKM-644: "Z" (Shift implied), the form a ⇧⌘Z event matches; "z" with ⇧ does not.
        let redo = NSMenuItem(title: "Redo", action: #selector(menuAction(_:)), keyEquivalent: "Z"); redo.target = self; redo.representedObject = "redo"; redo.keyEquivalentModifierMask = [.command]; edit.addItem(redo)
        for (label, key, selector) in [("Cut", "x", "cut:"), ("Copy", "c", "copy:"), ("Paste", "v", "paste:"), ("Select All", "a", "selectAll:")] {
            edit.addItem(withTitle: label, action: Selector(selector), keyEquivalent: key)
        }
        let find = NSMenuItem(title: "Find…", action: #selector(NSTextView.performFindPanelAction(_:)), keyEquivalent: "f"); find.tag = NSTextFinder.Action.showFindInterface.rawValue; edit.addItem(find)
        // LKM-192: the code editor's soft wrap; the focused editor, else Host, answers it.
        let view = submenu("View")
        // LKM-219: the preview's Back (⌘[) and Forward (⌘]), enabled only when a step exists.
        for item in previewHistory.menuItems() { view.addItem(item) }
        view.addItem(.separator())
        view.addItem(withTitle: "Wrap Lines", action: #selector(NativeSourceEditor.toggleWrapLines(_:)), keyEquivalent: "")
        // LKM-205: rulers (⇧⌘R) and the layout grid (⌃G) over the preview.
        view.addItem(.separator())
        for item in previewOverlay?.menuItems() ?? [] { view.addItem(item) }
        let actions = submenu("Actions")
        for (label, key, action) in [("Reload Preview", "r", "reload"), ("Mark up", "", "markup"), ("Toggle UI", ".", "toggle-chat"),("Check for Updates…", "", "updates"), ("Diagnose Preview…", "", "diagnose"), ("Running Servers…", "", "servers"), ("Send Feedback…", MenuFirstShortcut.feedback.key, "feedback")] {
            let item = NSMenuItem(title: label, action: #selector(menuAction(_:)), keyEquivalent: key); item.target = self; item.representedObject = action
            if action == "feedback" { item.keyEquivalentModifierMask = MenuFirstShortcut.feedback.modifiers }; actions.addItem(item)
        }
        // LKM-206: Control-Shift-S switches between 1× and the last slow speed.
        actions.addItem(.separator())
        for (label, key, action) in [("Toggle Slow Motion", "s", "slow-motion"), ("Step Preview Frame", "", "slow-motion-step")] {
            let item = NSMenuItem(title: label, action: #selector(menuAction(_:)), keyEquivalent: key); item.target = self; item.representedObject = action
            if !key.isEmpty { item.keyEquivalentModifierMask = [.control, .shift] }; actions.addItem(item)
        }
        let develop = submenu("Develop")
        for (title, key, action) in [("Show Preview Web Inspector", "i", "show"), ("Show Preview JavaScript Console", "c", "showConsole")] {
            let item = NSMenuItem(title: title, action: #selector(showPreviewInspector(_:)), keyEquivalent: key)
            item.target = self; item.representedObject = action; item.keyEquivalentModifierMask = [.command, .option]; develop.addItem(item)
        }
        // LKM-152: Window → Activity (Command-L) shows the Activity window; it carries the unread badge.
        let windows = submenu("Window")
        windows.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windows.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windows.addItem(.separator())
        let activityItem = NSMenuItem(title: "Activity", action: #selector(menuAction(_:)), keyEquivalent: "l"); activityItem.target = self; activityItem.representedObject = "activity"; windows.addItem(activityItem)
        activityIndicator.menuItem = activityItem
        NSApp.windowsMenu = windows
        installHelpMenu(menu)
        NSApp.mainMenu = menu
    }
    /// The standard panel reads "Version 0.1.0 (build N, <short sha>)" from the Info.plist the build stamps (LKM-143).
    /// LKM-226: its credits are the build badge's details (on main or not, branch, tag, check time).
    @objc func showAbout(_ sender: Any?) {
        let info = Bundle.main.infoDictionary ?? [:]
        let build = info["CFBundleVersion"] as? String ?? "", commit = info["TreziCommit"] as? String ?? ""
        NSApp.orderFrontStandardAboutPanel(options: [.applicationVersion: commit.isEmpty ? build : "build \(build), \(commit)", .credits: buildBadge.aboutCredits])
    }
    @objc func menuAction(_ item: NSMenuItem) {
        let action = item.representedObject as? String ?? ""
        if ["undo", "redo"].contains(action) { editUndo(action == "undo"); return }
        emit(["event":"menu", "action":action])
    }
    /// LKM-644: Edit → Undo / Redo (⌘Z / ⇧⌘Z), from the menu, its key equivalent or the
    /// preview page (`fromPage`: the page found no field of its own focused). A text view
    /// that is editing keeps its typing Undo; else Mark up, else Bun steps the visual draft
    /// and only falls back to the project's source history when no visual edit is in play.
    func editUndo(_ undo: Bool, fromPage: Bool = false) {
        let responder = NSApp.keyWindow?.firstResponder
        if !fromPage, let responder {
            switch EditUndo.route(responder, island: editingInspector, preview: views["preview"], key: NSApp.currentEvent?.type == .keyDown) {
            case .text, .page: EditUndo.perform(responder, undo: undo); return
            case .visual: break
            }
        }
        if undo, markup?.undo() == true { return }
        // The field shows the restored value at once; nothing typed is pending in it.
        InspectorTyping.dirty = false
        // From the page, only the visual draft may answer: a page with its own ⌘Z never
        // also reverts a project source edit.
        emit(["event":"menu", "action":undo ? "undo" : "redo", "visualOnly":fromPage])
    }
    @objc func recentAction(_ item: NSMenuItem) { emit(["event":"recent", "root":item.representedObject as? String ?? ""]) }
    /// File → Open Recent, rebuilt from the backend's `recents` command.
    func updateRecents(_ entries: [[String: String]]) {
        recentMenu.removeAllItems()
        for entry in entries.prefix(8) {
            guard let root = entry["root"], let title = entry["name"] else { continue }
            let item = NSMenuItem(title: title, action: #selector(recentAction(_:)), keyEquivalent: ""); item.representedObject = root; item.target = self; recentMenu.addItem(item)
        }
    }
}

/// LKM-644: Edit → Undo / Redo name what they would undo, and a text view's own state
/// decides while it is editing. Host's other menu items stay enabled as before.
extension Host {
    /// Called from Host's `validateMenuItem` (`SourceWrap.swift`).
    func validateEditUndo(_ item: NSMenuItem) -> Bool {
        guard item.action == #selector(menuAction(_:)), let action = item.representedObject as? String, ["undo", "redo"].contains(action) else { return true }
        let undo = action == "undo", history = editingInspector.model.state?.history
        return EditUndo.validate(item, undo: undo, responder: NSApp.keyWindow?.firstResponder, island: editingInspector,
                                 visual: (undo ? history?.undo : history?.redo) == true)
    }
}
