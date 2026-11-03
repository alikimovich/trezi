import AppKit

// LKM-444: the real `SourcePopout` against a window that records toggles and order-outs, with
// AppKit's full-screen notifications posted in the order a real transition sends them (a failed
// transition is the delegate's `failed`). An order-out while the window is in full screen, or on
// its way in or out, is what left the black, empty Space behind. One JSON report on stdout.
final class ScriptedWindow: NSWindow {
    var toggles = 0, orderOuts = 0, stranded = 0, shown = true
    var inFullScreen: () -> Bool = { false }
    override var isVisible: Bool { shown }
    override var isKeyWindow: Bool { shown }
    override func toggleFullScreen(_ sender: Any?) { toggles += 1 }
    override func orderOut(_ sender: Any?) { orderOuts += 1; if inFullScreen() { stranded += 1 }; shown = false }
    override func makeKeyAndOrderFront(_ sender: Any?) { shown = true }
}
final class MainWindow: NSWindow {
    var keyed = 0
    override var isVisible: Bool { true }
    override func makeKeyAndOrderFront(_ sender: Any?) { keyed += 1 }
}

let willEnter = NSWindow.willEnterFullScreenNotification, didEnter = NSWindow.didEnterFullScreenNotification
let willExit = NSWindow.willExitFullScreenNotification, didExit = NSWindow.didExitFullScreenNotification
func spin() { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }

@MainActor func run() -> [String: Any] {
    _ = NSApplication.shared
    let main = MainWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600), styleMask: [.titled], backing: .buffered, defer: true)
    var out: [String: Any] = [:]
    typealias Post = (NSNotification.Name) -> Void
    func scenario(_ script: (SourcePopout, ScriptedWindow, Post) -> Void) -> [String: Any] {
        let window = ScriptedWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 700), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        let popout = SourcePopout(window: window) { main }
        window.inFullScreen = { [unowned popout] in popout.phase != .windowed }
        let before = main.keyed
        script(popout, window) { name in NotificationCenter.default.post(name: name, object: window); spin() }
        spin()
        return ["toggles": window.toggles, "orderOuts": window.orderOuts, "stranded": window.stranded, "visible": window.isVisible,
                "phase": popout.phase.rawValue, "pendingHide": popout.pendingHide, "mainKeyed": main.keyed - before, "steps": popout.steps]
    }
    /// AppKit answers an exit toggle with will/did exit.
    func exitAnswered(_ window: ScriptedWindow, _ post: Post, after toggles: Int) {
        if window.toggles > toggles { post(willExit); post(didExit) }
    }

    out["windowed"] = scenario { popout, _, _ in popout.show(); popout.hide() }
    out["hidden"] = scenario { popout, window, _ in window.shown = false; popout.hide() }
    out["full"] = scenario { popout, window, post in
        popout.show(); post(willEnter); post(didEnter)
        popout.hide(); popout.hide()
        out["fullWaiting"] = ["toggles": window.toggles, "orderOuts": window.orderOuts, "visible": window.isVisible]
        exitAnswered(window, post, after: 0)
    }
    out["entering"] = scenario { popout, window, post in
        popout.show(); post(willEnter)
        popout.hide()
        out["enteringWaiting"] = ["toggles": window.toggles, "orderOuts": window.orderOuts]
        post(didEnter)
        exitAnswered(window, post, after: 0)
    }
    out["exiting"] = scenario { popout, window, post in
        popout.show(); post(willEnter); post(didEnter); post(willExit)
        popout.hide()
        out["exitingWaiting"] = ["toggles": window.toggles, "orderOuts": window.orderOuts]
        post(didExit)
    }
    out["reshown"] = scenario { popout, _, post in
        popout.show(); post(willEnter); post(didEnter)
        popout.hide(); post(willExit); popout.show(); post(didExit)
    }
    out["exitFailed"] = scenario { popout, window, post in
        popout.show(); post(willEnter); post(didEnter)
        popout.hide(); post(willExit); popout.failed(entering: false)
        out["exitFailedFirst"] = ["toggles": window.toggles, "orderOuts": window.orderOuts, "visible": window.isVisible, "pendingHide": popout.pendingHide]
        popout.hide(); exitAnswered(window, post, after: 1)
    }
    out["enterFailed"] = scenario { popout, _, post in
        popout.show(); post(willEnter); popout.hide(); popout.failed(entering: true)
    }
    out["repeated"] = scenario { popout, window, post in
        for round in 0..<5 {
            popout.show(); post(willEnter); post(didEnter)
            popout.hide(); exitAnswered(window, post, after: round)
        }
    }
    return out
}

let report = MainActor.assumeIsolated { run() }
print(String(data: try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), encoding: .utf8)!)
