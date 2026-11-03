import AppKit

/// The code editor's pop-out window (LKM-444). Ordering a full-screen window out leaves its
/// Space behind, black and empty, with the main window on another Space. So a hide or dock
/// while the pop-out is in full screen, or on its way in or out, first leaves full screen
/// and orders the window out only once AppKit's `didExitFullScreen` arrives (or its enter
/// failed). AppKit ignores a toggle during a transition, so an entering window is let finish
/// first. The main window is then made key again. Full screen itself stays available.
@MainActor final class SourcePopout: NSObject {
    enum Phase: String { case windowed, entering, full, exiting }
    let window: NSWindow
    /// The window to hand focus back to once the pop-out is gone.
    let main: () -> NSWindow?
    private(set) var phase: Phase = .windowed
    /// A hide waiting for full screen to end; `leaving` once the exit toggle was sent.
    private(set) var pendingHide = false, leaving = false
    /// Every step taken, oldest first, for the tests (bounded).
    private(set) var steps: [String] = []

    init(window: NSWindow, main: @escaping () -> NSWindow?) {
        self.window = window; self.main = main
        super.init()
        // A failed transition has no notification: the window's delegate forwards it (`failed`).
        for name in [NSWindow.willEnterFullScreenNotification, NSWindow.didEnterFullScreenNotification,
                     NSWindow.willExitFullScreenNotification, NSWindow.didExitFullScreenNotification] {
            NotificationCenter.default.addObserver(self, selector: #selector(transition(_:)), name: name, object: window)
        }
    }

    var isFullScreen: Bool { phase != .windowed || window.styleMask.contains(.fullScreen) }

    func show() {
        if pendingHide { note("show-cancels-hide") }
        pendingHide = false
        if !window.isVisible { note("show"); window.makeKeyAndOrderFront(nil) }
    }

    func hide() {
        guard window.isVisible || pendingHide else { return }
        guard isFullScreen else { finish(); return }
        pendingHide = true
        // An entering or exiting window finishes its transition first (`transition`).
        if phase == .full || phase == .windowed { leave() } else { note("hide-waits-\(phase.rawValue)") }
    }

    private func leave() {
        guard !leaving else { return }
        leaving = true; note("exit-full-screen")
        window.toggleFullScreen(nil)
    }

    private func finish() {
        let wasKey = window.isKeyWindow
        pendingHide = false; leaving = false; note("order-out")
        window.orderOut(nil)
        guard wasKey || NSApp.keyWindow == nil || NSApp.keyWindow === window, let main = main(), main.isVisible, !main.isMiniaturized else { return }
        note("main-key"); main.makeKeyAndOrderFront(nil)
    }

    @objc private func transition(_ notification: Notification) {
        switch notification.name {
        case NSWindow.willEnterFullScreenNotification: phase = .entering
        case NSWindow.didEnterFullScreenNotification: phase = .full
        case NSWindow.willExitFullScreenNotification: phase = .exiting
        case NSWindow.didExitFullScreenNotification: phase = .windowed; leaving = false
        default: return
        }
        note(phase.rawValue)
        guard pendingHide else { return }
        if phase == .windowed { finish() }
        // Toggling inside the notification can be ignored as part of the same transition.
        else if phase == .full { DispatchQueue.main.async { [weak self] in if let self, self.phase == .full, self.pendingHide { self.leave() } } }
    }

    /// `windowDidFailToEnterFullScreen` / `windowDidFailToExitFullScreen`.
    func failed(entering: Bool) {
        leaving = false
        if entering { phase = .windowed; note("enter-failed"); if pendingHide { finish() }; return }
        // Still full screen: ordering out now would strand its Space. Keep it shown; the next close retries.
        phase = .full; note("exit-failed"); pendingHide = false
    }

    private func note(_ step: String) { steps.append(step); if steps.count > 64 { steps.removeFirst(steps.count - 64) } }

    /// Test-profile state: the pop-out, its pending hide and the main window it returns to.
    func inspect() -> [String: Any] {
        let main = main()
        let others = NSApp.windows.filter { $0 !== main && $0.isVisible && $0.styleMask.contains(.fullScreen) }
        return ["phase": phase.rawValue, "pendingHide": pendingHide, "leaving": leaving, "fullScreen": window.styleMask.contains(.fullScreen),
                "visible": window.isVisible, "key": window.isKeyWindow, "onActiveSpace": window.isOnActiveSpace, "steps": steps,
                "mainVisible": main?.isVisible ?? false, "mainKey": main?.isKeyWindow ?? false, "mainOnActiveSpace": main?.isOnActiveSpace ?? false,
                "mainFullScreen": main?.styleMask.contains(.fullScreen) ?? false, "mainOccluded": !(main?.occlusionState.contains(.visible) ?? false),
                "appActive": NSApp.isActive, "keyIsMain": NSApp.keyWindow === main, "strayFullScreenWindows": others.count]
    }
}
