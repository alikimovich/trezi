import AppKit
import WebKit

// LKM-584: a hard load clears WebKit's caches before it loads. Each case replays the host's
// command order (`load` / `reload` in Host.swift) on a real WKWebView with the real
// `PreviewCache` and `PreviewLoadFence`; the order is decided by awaited WebKit events,
// never by sleeps. One line on stdout when every case passes.
final class Events: NSObject, WKNavigationDelegate {
    var finished: [String] = []
    var started: [String] = []
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { started.append(webView.url?.path ?? "") }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finished.append(webView.url?.path ?? "") }
}
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let base = CommandLine.arguments[1]
let config = WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 320, height: 240), configuration: config)
let events = Events()
view.navigationDelegate = events
let fence = PreviewLoadFence()
func url(_ path: String) -> URL { URL(string: base + path)! }
func until(_ what: String, _ done: () -> Bool) {
    let deadline = Date().addingTimeInterval(20)
    while !done() {
        precondition(Date() < deadline, "timed out waiting for \(what)")
        RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }
}
/// The host's `load` and `reload` commands (Host.swift): each takes a ticket; a hard one is fenced.
func command(_ path: String?, hard: Bool, asked: @escaping () -> Void = {}, started: @escaping () -> Void = {}) {
    if let path {
        let live = fence.begin("preview", hardLoad: hard ? url(path) : nil)
        if hard {
            PreviewCache.reload(view, url: url(path), shouldLoad: { asked(); return live() }, started: { _ in fence.started("preview"); started() })
        } else { view.load(URLRequest(url: url(path))) }
        return
    }
    let pending = fence.pending("preview")
    let live = fence.begin("preview")
    if hard { PreviewCache.reload(view, url: pending, shouldLoad: { asked(); return live() }, started: { _ in started() }) }
    else if let pending { view.load(URLRequest(url: pending)) } else { view.reload() }
}
func settle(_ path: String) { until("\(path) to finish") { events.finished.last == path } }
/// Waits for the superseded hard load's cache callback and then any finished page; a late load
/// of the old URL starts inside that callback, so `loadedOld` is already known by then.
func settleAfter(_ asked: () -> Bool) { until("the old hard load's callback and a finished page") { asked() && !events.finished.isEmpty } }

command("/first", hard: false); settle("/first")

// Control: a hard load nothing superseded still loads its URL past the caches.
do {
    var loaded = false
    command("/hard", hard: true, started: { loaded = true })
    settle("/hard")
    precondition(loaded, "an unsuperseded hard load loads")
}

// The project switches (a plain load of the new URL) while the old hard load clears caches.
do {
    var asked = false, loadedOld = false
    events.started.removeAll(); events.finished.removeAll()
    command("/old", hard: true, asked: { asked = true }, started: { loadedOld = true })
    command("/new", hard: false)
    settleAfter { asked }
    precondition(!loadedOld, "a superseded hard load must not load its old URL")
    settle("/new")
    precondition(!events.started.contains("/old") && view.url?.path == "/new", "the newer load stays: \(events.started) \(view.url?.path ?? "")")
}

// Reset to the placeholder while a hard reload (no URL) clears caches: no reload from origin.
do {
    var asked = false, reloaded = false
    command("/new", hard: false); settle("/new")
    events.started.removeAll(); events.finished.removeAll()
    command(nil, hard: true, asked: { asked = true }, started: { reloaded = true })
    command("/placeholder", hard: false)
    settleAfter { asked }
    precondition(!reloaded, "a superseded hard reload must not reload from origin")
    settle("/placeholder")
    precondition(!reloaded && events.started == ["/placeholder"], "a superseded hard reload must not reload: \(events.started)")
}

// A later hard load supersedes an earlier one: only the newer URL loads.
do {
    var firstLoaded = false, secondLoaded = false
    events.started.removeAll()
    command("/one", hard: true, started: { firstLoaded = true })
    command("/two", hard: true, started: { secondLoaded = true })
    settle("/two")
    precondition(!firstLoaded && secondLoaded && !events.started.contains("/one"), "only the newer hard load loads: \(events.started)")
}

// A clean restart hard-loads the new server's URL; a reload while the caches clear (⌘R, the
// load pill, reload_preview) goes to that URL, not the old server's page still shown.
for hardReload in [false, true] {
    command("/shown", hard: false); settle("/shown")
    events.started.removeAll(); events.finished.removeAll()
    command("/restarted", hard: true)
    command(nil, hard: hardReload)
    settle("/restarted")
    precondition(view.url?.path == "/restarted" && !events.started.contains("/shown"), "a reload during a hard load goes to its URL (hard: \(hardReload)): \(events.started)")
}
// After the hard load began, a reload reloads the page shown (nothing pending).
do {
    events.started.removeAll(); events.finished.removeAll()
    command(nil, hard: false)
    settle("/restarted")
    precondition(events.started == ["/restarted"] && fence.pending("preview") == nil, "a later reload reloads the shown page: \(events.started)")
}

print("PREVIEW-CACHE-FENCE OK — a hard load superseded while clearing caches never loads; unsuperseded hard loads still do; a reload during one goes to its URL")
exit(0)
