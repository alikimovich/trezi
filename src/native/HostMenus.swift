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
        let redo = NSMenuItem(title: "Redo", action: #selector(menuAction(_:)), keyEquivalent: "z"); redo.target = self; redo.representedObject = "redo"; redo.keyEquivalentModifierMask = [.command, .shift]; edit.addItem(redo)
        for (label, key, selector) in [("Cut", "x", "cut:"), ("Copy", "c", "copy:"), ("Paste", "v", "paste:"), ("Select All", "a", "selectAll:")] {
            edit.addItem(withTitle: label, action: Selector(selector), keyEquivalent: key)
        }
        let find = NSMenuItem(title: "Find…", action: #selector(NSTextView.performFindPanelAction(_:)), keyEquivalent: "f"); find.tag = NSTextFinder.Action.showFindInterface.rawValue; edit.addItem(find)
        let actions = submenu("Actions")
        for (label, key, action) in [("Reload Preview", "r", "reload"), ("Toggle UI", ".", "toggle-chat"),("Check for Updates…", "", "updates"), ("Diagnose Preview…", "", "diagnose"), ("Running Servers…", "", "servers"), ("Send Feedback…", "", "feedback")] {
            let item = NSMenuItem(title: label, action: #selector(menuAction(_:)), keyEquivalent: key); item.target = self; item.representedObject = action; actions.addItem(item)
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
    @objc func showAbout(_ sender: Any?) {
        let info = Bundle.main.infoDictionary ?? [:]
        let build = info["CFBundleVersion"] as? String ?? "", commit = info["TreziCommit"] as? String ?? ""
        NSApp.orderFrontStandardAboutPanel(options: [.applicationVersion: commit.isEmpty ? build : "build \(build), \(commit)"])
    }
    @objc func menuAction(_ item: NSMenuItem) {
        let action = item.representedObject as? String ?? ""
        if ["undo", "redo"].contains(action), let text = NSApp.keyWindow?.firstResponder as? NSTextView {
            if action == "undo" { text.undoManager?.undo() } else { text.undoManager?.redo() }; return
        }
        emit(["event":"menu", "action":action])
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
