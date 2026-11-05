import AppKit

/// Disposable-profile probe of AppKit's own toolbar buttons. It invokes each native
/// control's state callbacks directly; no event is posted to the app or system.
extension NativeShell {
    @MainActor func toolbarInteractionProbe(_ stage: String) -> [String: Any] {
        guard let host = toolbarWindow, let root = host.contentView?.superview ?? host.contentView else {
            return ["error":"Toolbar window unavailable"]
        }
        let ids = ["chat-new", "more", NSToolbarItem.Identifier.toggleSidebar.rawValue]
        func nativeButton(_ id: String) -> NSButton? {
            let itemKey = NSSelectorFromString("item")
            func descendant(_ view: NSView) -> NSButton? {
                if let button = view as? NSButton { return button }
                return view.subviews.lazy.compactMap(descendant).first
            }
            func walk(_ view: NSView) -> NSButton? {
                if NSStringFromClass(type(of: view)).contains("Toolbar"), view.responds(to: itemKey),
                   let item = view.value(forKey: "item") as? NSToolbarItem,
                   item.itemIdentifier.rawValue == id { return descendant(view) }
                return view.subviews.lazy.compactMap(walk).first
            }
            return walk(root)
        }
        let found = ids.compactMap { id -> (String, NSButton)? in nativeButton(id).map { (id, $0) } }
        guard found.count == ids.count else {
            return ["error":"Native toolbar buttons missing", "found":found.map(\.0)]
        }
        let buttons = Dictionary(uniqueKeysWithValues: found)
        func hover(_ button: NSButton, enter: Bool) {
            guard let event = NSEvent.enterExitEvent(with: enter ? .mouseEntered : .mouseExited,
                  location: button.convert(NSPoint(x: button.bounds.midX, y: button.bounds.midY), to: nil),
                  modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                  windowNumber: button.window?.windowNumber ?? 0, context: nil, eventNumber: 0,
                  trackingNumber: 0, userData: nil) else { return }
            if enter { button.mouseEntered(with: event) } else { button.mouseExited(with: event) }
        }
        // Leave the preceding state before entering another one. Focus uses the actual
        // window responder chain; pressed uses NSButton's native highlight painting.
        for (_, button) in found { hover(button, enter: false); button.highlight(false) }
        if stage == "reset" { _ = host.makeFirstResponder(nil) }
        else if stage == "hover" { for (_, button) in found { hover(button, enter: true) } }
        else if stage == "pressed" { for (_, button) in found { button.highlight(true) } }
        else if stage.hasPrefix("focus-"),
                let id = ["new":"chat-new", "more":"more", "sidebar":ids[2]][String(stage.dropFirst(6))],
                let button = buttons[id] {
            guard host.makeFirstResponder(button) else { return ["error":"Toolbar button refused focus", "stage":stage] }
        } else { return ["error":"Unknown toolbar interaction stage", "stage":stage] }
        host.contentView?.displayIfNeeded()
        return ["stage":stage, "buttons":found.map { ["id":$0.0, "class":NSStringFromClass(type(of: $0.1)),
                   "focused":host.firstResponder === $0.1, "highlighted":$0.1.cell?.isHighlighted ?? false] }]
    }
}

/// Test-broker commands for where the toolbar's popover and menus open (LKM-229), in screen
/// coordinates, in a normal or a full-screen window. In full screen AppKit moves the toolbar
/// into its own window. A menu opens for real and a timer cancels it during its tracking, so
/// the pipe never waits on it (like `SidebarVerification.swift`).
extension Host {
    func toolbarAnchorInspect() -> [String: Any] {
        func box(_ r: NSRect?) -> Any { r.map { ["x":Double($0.minX), "y":Double($0.minY), "width":Double($0.width), "height":Double($0.height)] as Any } ?? NSNull() }
        func button(_ key: String) -> NSRect? {
            shell.toolbarButtonAnchor(key).flatMap { view, rect in view.window?.convertToScreen(view.convert(rect, to: nil)) }
        }
        let popover = previewOverlay.popover
        return ["fullScreen":window.styleMask.contains(.fullScreen), "transition":previewOverlay.fullScreenTransition,
                "toolbarInMainWindow":shell.toolbarButtonAnchor("overlay")?.view.window === window,
                "overlayButton":box(button("overlay")), "speedButton":box(button("speed")),
                "panelShown":popover.isShown, "panel":box(popover.isShown ? popover.contentViewController?.view.window?.frame : nil),
                "focus":["key":window.isKeyWindow, "active":NSApp.isActive, "keyWindow":NSApp.keyWindow.map { String(describing: type(of: $0)) } ?? "none"]]
    }

    /// Enters or leaves full screen and waits for the transition and the toolbar to settle.
    @MainActor func toolbarFullScreen(_ on: Bool) async throws -> [String: Any] {
        if window.styleMask.contains(.fullScreen) != on { window.toggleFullScreen(nil) }
        for _ in 0..<100 where window.styleMask.contains(.fullScreen) != on || previewOverlay.fullScreenTransition {
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        guard window.styleMask.contains(.fullScreen) == on, !previewOverlay.fullScreenTransition else {
            throw NSError(domain: "ToolbarAnchor", code: 1, userInfo: [NSLocalizedDescriptionKey: "Full screen \(on) did not finish"])
        }
        try await Task.sleep(nanoseconds: 600_000_000)
        return toolbarAnchorInspect()
    }

    /// Opens a menu-only toolbar segment's menu (slow motion) through the production path and
    /// reports the menu window's screen frame while it tracks.
    @MainActor func toolbarMenuProbe(_ key: String) -> [String: Any] {
        guard let group = shell.toolbar.items.compactMap({ $0 as? MomentaryToolbarGroup }).first(where: { $0.segmentAnchor(key) != nil }),
              let menu = (group.shown.first { $0.itemIdentifier.rawValue == key } as? NSMenuToolbarItem)?.menu else { return toolbarAnchorInspect() }
        let seen = MenuFrameProbe(menu)
        let cancel = Timer(timeInterval: 0.3, repeats: false) { _ in MainActor.assumeIsolated { seen.finish() } }
        RunLoop.main.add(cancel, forMode: .common)
        defer { cancel.invalidate() }
        group.popUpMenu(key)
        var result = toolbarAnchorInspect()
        result["menu"] = seen.frame.map { ["x":Double($0.minX), "y":Double($0.minY), "width":Double($0.width), "height":Double($0.height)] as Any } ?? NSNull()
        return result
    }
}

/// Owned by the main actor: the timer fires on the main thread during menu tracking, and
/// `MainActor.assumeIsolated` traps if it ever does not.
@MainActor private final class MenuFrameProbe {
    private let menu: NSMenu
    private(set) var frame: NSRect?
    init(_ menu: NSMenu) { self.menu = menu }
    /// Reads the open menu's frame, then closes it.
    func finish() {
        frame = Self.visibleMenu()
        menu.cancelTracking()
    }
    /// This process's open menu window: AppKit's own list first, else the window server's
    /// list of this process's on-screen windows (bounds only, flipped to screen coordinates).
    static func visibleMenu() -> NSRect? {
        if let window = NSApp.windows.first(where: { $0.isVisible && $0.level == .popUpMenu }) { return window.frame }
        let level = Int(CGWindowLevelForKey(.popUpMenuWindow)), pid = Int(getpid())
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
        guard let info = list.first(where: { $0[kCGWindowOwnerPID as String] as? Int == pid && $0[kCGWindowLayer as String] as? Int == level }),
              let bounds = info[kCGWindowBounds as String] as? NSDictionary, let rect = CGRect(dictionaryRepresentation: bounds),
              let top = NSScreen.screens.first?.frame.maxY else { return nil }
        return NSRect(x: rect.minX, y: top - rect.maxY, width: rect.width, height: rect.height)
    }
}
