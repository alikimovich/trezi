import AppKit

/// One "…" press's menu in the sidebar verification, shared by its observers, timers and
/// capture. They all run on the main thread during the menu's tracking, and
/// `MainActor.assumeIsolated` traps if one ever does not. LKM-441: the capture is a main-actor
/// task, so the press must run outside a main-queue block (`outsideMainQueue`): a nested run loop
/// inside one never drains the main queue, and the task would wait for the fallback cancel.
@MainActor final class SidebarMenuRun {
    /// A captured menu closes itself once its picture is taken; this closes it if that never happens.
    static let fallback: TimeInterval = 3
    /// How long the menu is open before it is captured, or closed when there is no capture.
    static let settle: TimeInterval = 0.3

    private(set) var menu: NSMenu?
    private(set) var closed = false
    /// `shot` or `shotError` from the capture; after a capture request one of them is always set.
    private(set) var shot: [String: Any] = [:]
    private var capture: (@MainActor () async -> [String: Any])?
    private var task: Task<Void, Never>?
    private var timers: [Timer] = []
    private var started = false, fellBack = false, cancelledTask = false
    private var observers = 0, removed = 0

    /// Runs `press`, which returns when the menu's tracking ends, with `capture` taken while the
    /// menu is open. On return the observers are removed, the timers invalidated and no capture
    /// task is left running.
    func track(capture: (@MainActor () async -> [String: Any])?, press: () -> Void) {
        self.capture = capture
        open(press)
        guard capture != nil, shot.isEmpty else { return }
        if let task {
            task.cancel(); self.task = nil; cancelledTask = true
            shot = ["shotError": fellBack ? "the capture did not finish before the \(Int(Self.fallback)) s fallback cancel"
                                          : "the menu closed before the capture finished"]
        } else {
            shot = ["shotError": menu == nil ? "the menu did not open"
                                 : started ? "the capture ended without a result" : "the menu closed before the capture started"]
        }
    }

    /// The capture's lifecycle, read after `track` returns.
    var receipt: [String: Any] {
        ["requested": capture != nil, "started": started, "completed": shot["shot"] != nil, "error": shot["shotError"] != nil,
         "fallbackCancel": fellBack, "taskCancelled": cancelledTask, "taskPending": task != nil,
         "observers": observers, "observersRemoved": removed, "timersValid": timers.contains { $0.isValid }]
    }

    private func open(_ press: () -> Void) {
        let center = NotificationCenter.default
        let tokens = [center.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: nil) { note in
                          MainActor.assumeIsolated { self.menu = note.object as? NSMenu } },
                      center.addObserver(forName: NSMenu.didEndTrackingNotification, object: nil, queue: nil) { _ in
                          MainActor.assumeIsolated { self.closed = true } }]
        observers = tokens.count
        defer { tokens.forEach(center.removeObserver); removed = tokens.count }
        // The capture cancels when it is done; the timer closes the menu either way.
        let cancel = Timer(timeInterval: capture == nil ? Self.settle : Self.fallback, repeats: false) { _ in
            MainActor.assumeIsolated { self.fallBack() }
        }
        let shoot = Timer(timeInterval: Self.settle, repeats: false) { _ in MainActor.assumeIsolated { self.shoot() } }
        timers = capture == nil ? [cancel] : [cancel, shoot]
        timers.forEach { RunLoop.main.add($0, forMode: .common) }
        defer { timers.forEach { $0.invalidate() } }
        press()
    }

    private func fallBack() {
        if capture != nil, shot.isEmpty { fellBack = true }
        menu?.cancelTracking()
    }

    /// Captures the open menu's window, then closes the menu.
    private func shoot() {
        guard let capture, menu != nil else { return }
        started = true
        task = Task {
            let result = await capture()
            guard !Task.isCancelled else { return }
            shot = result
            task = nil
            menu?.cancelTracking()
        }
    }

    /// Runs `body` from the main run loop rather than from the main queue, as an event would.
    /// A test command arrives in a main-queue block, and a menu tracked inside one starves the
    /// main actor until it closes.
    static func outsideMainQueue(_ body: @escaping @MainActor () -> Void) {
        let main = CFRunLoopGetMain()
        CFRunLoopPerformBlock(main, CFRunLoopMode.commonModes.rawValue) { MainActor.assumeIsolated { body() } }
        CFRunLoopWakeUp(main)
    }
}
