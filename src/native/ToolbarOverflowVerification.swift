import AppKit

/// LKM-296 test seams for the toolbar's overflow. `toolbarInspect` lays the window out before
/// it reads, which can repair a stale toolbar before it is seen; these read the toolbar as
/// AppKit last laid it out, and sample it every frame across a transition.
private var overflowTrace: [[String: Any]] = []
private var overflowTraceTimer: Timer?
/// The full-screen toolbar window's origin before `toolbar-window-move` moved it (LKM-321).
private var toolbarWindowOrigin: NSPoint?

extension NativeShell {
    /// What a toolbar item list holds besides controls: system spacing and the sidebar separator.
    static func systemToolbarItem(_ id: String) -> Bool { id.hasPrefix("NSToolbar") }

    /// No layout is forced: frames are the item views' current ones (main-window coordinates,
    /// through the screen from the full-screen toolbar window).
    func toolbarPassiveInspect() -> [String: Any] {
        let items = toolbar.items.map { $0.itemIdentifier.rawValue }
        let visible = toolbar.visibleItems?.map { $0.itemIdentifier.rawValue } ?? []
        var hidden: [String] = []
        if #available(macOS 15, *) { hidden = toolbar.items.filter(\.isHidden).map { $0.itemIdentifier.rawValue } }
        let frames = toolbarFrames
        // In AppKit's overflow menu: in the toolbar, not hidden on purpose (`fitMore`), not shown.
        let overflow = items.filter { !visible.contains($0) && !hidden.contains($0) }
        let block = mainFrame(addressHeader) ?? .zero
        return toolbarWindowInspect().merging(["windowWidth":window?.frame.width ?? 0, "inLiveResize":window?.inLiveResize ?? false,
                "fullScreen":window?.styleMask.contains(.fullScreen) ?? false,
                "toolbarItems":items, "visibleItems":visible, "hiddenItems":hidden, "overflowItems":overflow,
                "actionableOverflow":overflow.filter { !Self.systemToolbarItem($0) && $0 != "more" },
                "moreOverflowed":overflow.contains("more"),
                "itemFrames":frames.mapValues { NSStringFromRect($0) },
                "addressFrame":NSStringFromRect(block), "addressConstant":addressWidth?.constant ?? 0,
                "rightGroupInWindow":rightGroup?.window === window,
                "chatHeaderAttached":chatHeader.window === window, "chatHeaderFrame":mainFrame(chatHeader).map { NSStringFromRect($0) } ?? "",
                "layout":["leading":addressLayout.leading, "rightInset":addressLayout.rightInset, "measured":addressLayout.measured,
                          "chatOffset":addressLayout.chatOffset, "extra":addressLayout.extra, "shownInset":addressLayout.shownInset ?? -1],
                "sidebarCollapsed":sidebarItem.isCollapsed, "sidebarWidth":sidebar.view.bounds.width,
                "chatHidden":chatHidden, "chatWidth":previewLeading]) { _, new in new }
    }

    /// `trace-start` samples `toolbarPassiveInspect` every frame for `ms`; `trace` returns the samples;
    /// `launch-layout` puts the address layout back to the values a fresh launch starts from;
    /// `narrow-width` sizes the window below the product's 850 pt minimum, where the toolbar
    /// genuinely cannot fit; without a width it restores that minimum.
    /// LKM-321, in full screen: `menu-bar` shows (`value: true`) or hides the menu bar, as the
    /// pointer at the screen's top edge does; `toolbar-window-move` moves AppKit's toolbar window
    /// down by the menu bar's height the way it slides in (`value: false` puts it back).
    func toolbarOverflowTest(_ c: [String: Any]) -> [String: Any] {
        let on = c["value"] as? Bool == true
        switch c["action"] as? String {
        case "menu-bar":
            NSMenu.setMenuBarVisible(on)
            return toolbarPassiveInspect()
        case "toolbar-window-move":
            guard let host = toolbarWindow, host !== window else { return ["moved":false] }
            if on {
                let height = max(NSApp.mainMenu?.menuBarHeight ?? 0, NSStatusBar.system.thickness)
                if toolbarWindowOrigin == nil { toolbarWindowOrigin = host.frame.origin }
                host.setFrameOrigin(NSPoint(x: host.frame.minX, y: (toolbarWindowOrigin?.y ?? host.frame.minY) - height))
            } else if let origin = toolbarWindowOrigin {
                host.setFrameOrigin(origin); toolbarWindowOrigin = nil
            }
            return toolbarPassiveInspect().merging(["moved":true]) { _, new in new }
        case "narrow-width":
            guard let window else { return ["resized":false] }
            guard let width = c["width"] as? Double, (600..<850).contains(width) else {
                window.minSize = NSSize(width: 850, height: 550); return ["resized":false]
            }
            window.minSize = NSSize(width: 600, height: 550)
            var frame = window.frame; frame.size.width = width; window.setFrame(frame, display: true)
            return ["resized":true]
        case "trace-start":
            overflowTraceTimer?.invalidate(); overflowTrace = []
            let start = Date.timeIntervalSinceReferenceDate, limit = (c["ms"] as? Double ?? 1000) / 1000
            let timer = Timer(timeInterval: 1 / 60, repeats: true) { [weak self] timer in
                let elapsed = Date.timeIntervalSinceReferenceDate - start
                guard let self, elapsed <= limit else { timer.invalidate(); return }
                overflowTrace.append(self.toolbarPassiveInspect().merging(["ms":(elapsed * 1000).rounded()]) { _, new in new })
            }
            RunLoop.main.add(timer, forMode: .common); overflowTraceTimer = timer
            return ["started":true]
        case "trace": return ["samples":overflowTrace]
        case "launch-layout":
            addressLayout = ToolbarAddressLayout(); alignChatHeader()
            DispatchQueue.main.async { [weak self] in self?.measureToolbar() }
            return toolbarPassiveInspect()
        default: return toolbarPassiveInspect()
        }
    }
}
