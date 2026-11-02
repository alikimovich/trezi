import AppKit

// LKM-441: the real `SidebarMenuRun` with a menu whose tracking is the nested `.eventTracking` run
// loop AppKit runs for a popped-up menu, and a capture that, like ScreenCaptureKit's, resumes on
// the main actor. Windowless and never activated: no screen, focus or capture permission is used.
final class FixtureMenu: NSMenu {
    var tracking = false
    var cancels = 0
    override func cancelTracking() {
        cancels += 1
        guard tracking else { return }
        tracking = false
        NotificationCenter.default.post(name: NSMenu.didEndTrackingNotification, object: self)
    }
    /// What `performClick` does for the "…": returns once the tracking ends (or after 10 s).
    func press() {
        tracking = true
        NotificationCenter.default.post(name: NSMenu.didBeginTrackingNotification, object: self)
        let limit = Date().addingTimeInterval(10)
        while tracking, Date() < limit { _ = RunLoop.current.run(mode: .eventTracking, before: Date().addingTimeInterval(0.05)) }
    }
}

@MainActor final class Case {
    let menu = FixtureMenu(title: "…")
    let run = SidebarMenuRun()
    let seconds: Double?
    var result: [String: Any]?
    init(capture seconds: Double?) { self.seconds = seconds }

    func go() {
        let began = Date()
        let seconds = seconds
        run.track(capture: seconds.map { delay in {
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            return ["shot": ["png": "fixture", "width": 1, "height": 1]]
        } }) { menu.press() }
        result = run.shot.merging(["capture": run.receipt, "opened": run.menu === menu, "closed": run.closed,
                                   "seconds": Date().timeIntervalSince(began)]) { _, new in new }
    }

    /// Runs the case the way the broker delivers a command, then checks nothing outlives it.
    func drive(outsideMainQueue: Bool) -> [String: Any] {
        if outsideMainQueue { SidebarMenuRun.outsideMainQueue { self.go() } }
        else { DispatchQueue.main.async { MainActor.assumeIsolated { self.go() } } }
        let limit = Date().addingTimeInterval(15)
        while result == nil, Date() < limit { _ = RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05)) }
        guard var result else { return ["timedOut": true] }
        let cancels = menu.cancels, keys = run.shot.keys.sorted()
        // A late task gets the main actor now; it must neither write nor close anything.
        let settle = Date().addingTimeInterval(0.5)
        while Date() < settle { _ = RunLoop.main.run(mode: .default, before: settle) }
        let other = FixtureMenu(title: "later")
        NotificationCenter.default.post(name: NSMenu.didBeginTrackingNotification, object: other)
        NotificationCenter.default.post(name: NSMenu.didEndTrackingNotification, object: other)
        result["after"] = ["sameShot": run.shot.keys.sorted() == keys, "lateCancels": menu.cancels - cancels,
                           "staleObserver": run.menu !== menu,"taskPending": run.receipt["taskPending"] as? Bool ?? true]
        return result
    }
}

MainActor.assumeIsolated {
    NSApplication.shared.setActivationPolicy(.prohibited)
    var report: [String: Any] = [:]
    for (name, capture, outside) in [("deferred", 0.05, true), ("mainQueue", 0.05, false),
                                     ("slow", 30, true), ("plain", nil, true)] as [(String, Double?, Bool)] {
        report[name] = Case(capture: capture).drive(outsideMainQueue: outside)
    }
    let data = try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
}
