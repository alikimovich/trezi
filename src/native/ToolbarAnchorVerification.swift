import AppKit

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
        let seen = MenuFrameProbe()
        let cancel = Timer(timeInterval: 0.3, repeats: false) { _ in seen.frame = MenuFrameProbe.visibleMenu(); menu.cancelTracking() }
        RunLoop.main.add(cancel, forMode: .common)
        defer { cancel.invalidate() }
        group.popUpMenu(key)
        var result = toolbarAnchorInspect()
        result["menu"] = seen.frame.map { ["x":Double($0.minX), "y":Double($0.minY), "width":Double($0.width), "height":Double($0.height)] as Any } ?? NSNull()
        return result
    }
}

/// Written and read on the main thread only (the timer fires there during menu tracking).
private final class MenuFrameProbe: @unchecked Sendable {
    var frame: NSRect?
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
