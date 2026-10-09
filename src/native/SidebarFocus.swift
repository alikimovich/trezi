import AppKit

/// Ephemeral-fixture focus hygiene for the sidebar checks. Menu, sheet, popover
/// and hover steps must hand the foreground back before the next visible capture,
/// whose own foreground guard is deliberately left untouched.
final class SidebarMenuMonitor {
    static let shared = SidebarMenuMonitor()
    private var tracking: [ObjectIdentifier: NSMenu] = [:]
    private var observers: [NSObjectProtocol] = []

    func install(center: NotificationCenter = .default) {
        guard observers.isEmpty else { return }
        observers = [
            center.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: nil) { [weak self] note in
                if let menu = note.object as? NSMenu { self?.tracking[ObjectIdentifier(menu)] = menu }
            },
            center.addObserver(forName: NSMenu.didEndTrackingNotification, object: nil, queue: nil) { [weak self] note in
                if let menu = note.object as? NSMenu { self?.tracking[ObjectIdentifier(menu)] = nil }
            }]
    }
    var menus: [NSMenu] { Array(tracking.values) }
    func cancelAll() {
        for menu in menus { menu.cancelTrackingWithoutAnimation() }
        tracking.removeAll()
    }
}

private func describe(_ window: NSWindow?) -> String {
    guard let window else { return "none" }
    return "\(type(of: window)) '\(window.title)'"
}

/// Everything that can keep `main` from being the key/main window of an active app.
func sidebarFocusReport(main: NSWindow, app: NSApplication = .shared,
                        monitor: SidebarMenuMonitor = .shared, auxiliary: NSWindow? = nil) -> [String: Any] {
    var problems: [String] = []
    let menus = monitor.menus.map { $0.title.isEmpty ? "untitled menu (\($0.items.map(\.title).joined(separator: ", ")))" : $0.title }
    if !menus.isEmpty { problems.append("menu still tracking: \(menus.joined(separator: "; "))") }
    if RunLoop.current.currentMode == .eventTracking { problems.append("run loop is in event tracking mode") }
    if let sheet = main.attachedSheet { problems.append("sheet attached to main window: \(describe(sheet))") }
    if let modal = app.modalWindow { problems.append("modal window running: \(describe(modal))") }
    if let auxiliary, auxiliary.isVisible { problems.append("Trezi sheet window still open: \(describe(auxiliary))") }
    let others = app.windows.filter { $0 !== main && $0.isVisible }
    for popover in others where String(describing: type(of: popover)).contains("Popover") {
        problems.append("popover still open: \(describe(popover))")
    }
    if !main.isKeyWindow { problems.append("main window is not key (key window: \(describe(app.keyWindow)))") }
    if !main.isMainWindow { problems.append("main window is not main (main window: \(describe(app.mainWindow)))") }
    if !app.isActive {
        let front = NSWorkspace.shared.frontmostApplication
        problems.append("app is not active (frontmost: \(front?.localizedName ?? front?.bundleIdentifier ?? "unknown"))")
    }
    return ["problems": problems, "key": main.isKeyWindow, "main": main.isMainWindow, "active": app.isActive,
            "keyWindow": describe(app.keyWindow), "visibleWindows": others.map(describe)]
}

/// Dismiss what the sidebar checks may leave behind, then return the foreground
/// to `main`. `dismissAuxiliary` routes Trezi's own sheet window through Bun;
/// `foreground` is injectable so the windowless regression never takes focus.
func sidebarFocusCleanup(main: NSWindow, cells: [NSView], app: NSApplication = .shared,
                         monitor: SidebarMenuMonitor = .shared, dismissAuxiliary: () -> Void = {},
                         foreground: (() -> Void)? = nil) {
    monitor.cancelAll()
    if let sheet = main.attachedSheet { main.endSheet(sheet, returnCode: .cancel) }
    if app.modalWindow != nil { app.abortModal() }
    dismissAuxiliary()
    for popover in app.windows where popover !== main && popover.isVisible && String(describing: type(of: popover)).contains("Popover") {
        // Escape is the native popover dismissal; it also resets the owning NSPopover.
        _ = popover.firstResponder?.tryToPerform(#selector(NSResponder.cancelOperation(_:)), with: nil)
    }
    let exit = NSEvent.enterExitEvent(with: .mouseExited, location: .zero, modifierFlags: [], timestamp: 0,
                                      windowNumber: main.windowNumber, context: nil, eventNumber: 0, trackingNumber: 0, userData: nil)
    if let exit { for cell in cells { cell.mouseExited(with: exit) } }
    if let foreground { foreground(); return }
    app.activate(ignoringOtherApps: true)
    main.makeKeyAndOrderFront(nil)
    main.makeMain()
}
