import AppKit
import WebKit

// LKM-637: spacing/distance number badges paint above Trezi's other floating preview UI.
// The real bundled `preview.js` runs in a real WKWebView in its own `TreziPreview` world, as
// Host.swift installs it, over a neutral synthetic page. Real AppKit mouse events select an
// element and Option-hover another; WebKit's own rendered snapshot is then sampled where a
// red badge crosses the dark selection toolbar and the blue title chips. Pointer pass-through
// is checked by a real click on the toolbar button under a badge. Scroll and resize redraw.
// Prints one JSON report; PNGs go to the directory in argv[2].

let args = CommandLine.arguments
let script = try! String(contentsOfFile: args[1], encoding: .utf8)
let artifacts = URL(fileURLWithPath: args[2], isDirectory: true)
try? FileManager.default.createDirectory(at: artifacts, withIntermediateDirectories: true)

func require(_ ok: Bool, _ what: String) {
    if !ok { FileHandle.standardError.write("FAIL: \(what)\n".data(using: .utf8)!); exit(1) }
}

final class Inbox: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    var sends: [(String, [Any])] = []
    var loaded = false
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let body = m.body as? [String: Any], body["type"] as? String == "send",
              let channel = body["channel"] as? String else { return }
        sends.append((channel, body["args"] as? [Any] ?? []))
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let world = WKContentWorld.world(name: "TreziPreview")
let inbox = Inbox()
let config = WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
config.userContentController.add(inbox, contentWorld: world, name: "trezi")
config.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: world))
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 520), styleMask: [.borderless], backing: .buffered, defer: false)
let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 760, height: 520), configuration: config)
view.navigationDelegate = inbox
window.contentView = view

func spin(_ seconds: Double) {
    let end = Date(timeIntervalSinceNow: seconds)
    while Date() < end { RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.01)) }
}
func until(_ what: String, _ done: () -> Bool) {
    let deadline = Date(timeIntervalSinceNow: 20)
    while !done() {
        require(Date() < deadline, "timed out waiting for \(what)")
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.01))
    }
}
/// Runs `body` in the preview's world and returns its JSON-decoded result.
func js(_ body: String) -> Any? {
    var out: Any?, done = false, failure: Error?
    view.callAsyncJavaScript("return JSON.stringify(await (async () => { \(body) })())", arguments: [:], in: nil, in: world) { result in
        switch result {
        case .success(let value): out = value
        case .failure(let error): failure = error
        }
        done = true
    }
    until("script") { done }
    if let failure { require(false, "script failed: \(failure)") }
    guard let text = out as? String, let data = text.data(using: .utf8) else { return nil }
    return try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
}
/// Viewport (CSS px, top-left origin) to window coordinates.
func windowPoint(_ x: Double, _ y: Double) -> NSPoint { view.convert(NSPoint(x: x, y: y), to: nil) }
func mouse(_ type: NSEvent.EventType, _ x: Double, _ y: Double, flags: NSEvent.ModifierFlags = []) -> NSEvent {
    NSEvent.mouseEvent(with: type, location: windowPoint(x, y), modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                       windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1)!
}
func move(_ x: Double, _ y: Double, option: Bool) {
    // This background fixture's window is never key, and WebKit drops a mouseMoved for a window
    // that is not key. A drag-move reaches the page as the same trusted mousemove (button held),
    // which is all the preview's hover/Option handler reads (target, altKey).
    view.mouseDragged(with: mouse(.leftMouseDragged, x, y, flags: option ? .option : []))
    spin(0.15)
}
func click(_ x: Double, _ y: Double) {
    view.mouseDown(with: mouse(.leftMouseDown, x, y))
    view.mouseUp(with: mouse(.leftMouseUp, x, y))
    spin(0.25)
}

// The overlay's paint state: every badge, the toolbar and the title chips, in viewport px.
let probe = """
  const host = document.querySelector('[data-trezi-overlay]')
  const root = host && host.shadowRoot
  if (!root) return null
  const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom } }
  const shown = (el) => el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0
  const layer = root.querySelector('[data-trezi-measure-badges]')
  const badges = [...root.querySelectorAll('[data-trezi-measure-label]')].map((el) => ({
    text: el.textContent, ...box(el), inTop: !!layer && layer.contains(el),
    pointer: getComputedStyle(el).pointerEvents }))
  const toolbar = root.querySelector('[data-trezi-toolbar]')
  // The title chips: the selection's badge and the hover label (the overlay's top-level blue chip).
  const hoverLabel = [...root.children].find((el) => getComputedStyle(el).backgroundColor === 'rgb(37, 99, 235)')
  const chips = [['selection', root.querySelector('[data-trezi-selbadge]')], ['hover', hoverLabel]]
    .filter(([, el]) => shown(el)).map(([kind, el]) => ({ kind, text: el.textContent, ...box(el) }))
  const order = [...root.children].map((el) => el.getAttribute('data-trezi-measure-badges') !== null ? 'badges' : el.getAttribute('data-trezi-toolbar') !== null ? 'toolbar' : el.tagName)
  return { badges, toolbar: shown(toolbar) ? box(toolbar) : null, chips, order,
    layerPointer: layer ? getComputedStyle(layer).pointerEvents : null,
    layerZ: layer ? getComputedStyle(layer).zIndex : null,
    toolbarZ: toolbar ? getComputedStyle(toolbar).zIndex : null,
    scrollY: window.scrollY, width: window.innerWidth }
"""
func state() -> [String: Any] {
    guard let s = js(probe) as? [String: Any] else { require(false, "overlay missing"); return [:] }
    return s
}
func rect(_ any: Any?) -> CGRect {
    let d = any as? [String: Any] ?? [:]
    let l = d["left"] as? Double ?? 0, t = d["top"] as? Double ?? 0
    return CGRect(x: l, y: t, width: (d["right"] as? Double ?? 0) - l, height: (d["bottom"] as? Double ?? 0) - t)
}

/// WebKit's own rendered snapshot of the page, as RGBA8 pixels with a CSS-px scale.
struct Shot {
    let rep: NSBitmapImageRep
    let scale: Double
    func pixel(_ x: Double, _ y: Double) -> (Int, Int, Int) {
        let c = rep.colorAt(x: Int(x * scale), y: Int(y * scale))?.usingColorSpace(.sRGB)
        return (Int((c?.redComponent ?? 0) * 255), Int((c?.greenComponent ?? 0) * 255), Int((c?.blueComponent ?? 0) * 255))
    }
}
func snapshot(_ name: String) -> Shot {
    var image: NSImage?
    view.takeSnapshot(with: nil) { img, _ in image = img ?? NSImage() }
    until("snapshot") { image != nil }
    let rep = NSBitmapImageRep(data: image!.tiffRepresentation!)!
    try! rep.representation(using: .png, properties: [:])!.write(to: artifacts.appendingPathComponent("\(name).png"))
    return Shot(rep: rep, scale: Double(rep.pixelsWide) / Double(view.bounds.width))
}
/// Pixels of a badge, where it crosses `under`: measurement red, white glyph ink, and colours of
/// the UI below (the toolbar's near-black, the chips' blue). Inset 2 px from the badge's edge.
func sample(_ shot: Shot, badge: CGRect, under: CGRect) -> [String: Int] {
    let area = badge.insetBy(dx: 2, dy: 2).intersection(under)
    var counts = ["red": 0, "glyph": 0, "dark": 0, "blue": 0, "total": 0]
    guard !area.isNull, area.width >= 2, area.height >= 2 else { return counts }
    var y = area.minY
    while y < area.maxY {
        var x = area.minX
        while x < area.maxX {
            let (r, g, b) = shot.pixel(x, y)
            counts["total"]! += 1
            if abs(r - 242) < 30 && abs(g - 72) < 40 && abs(b - 34) < 40 { counts["red"]! += 1 }
            else if r > 225 && g > 200 && b > 190 { counts["glyph"]! += 1 }
            if r < 70 && g < 70 && b < 70 { counts["dark"]! += 1 }
            if b > 180 && r < 90 { counts["blue"]! += 1 }
            x += 0.5
        }
        y += 0.5
    }
    return counts
}
/// The badge's whole inset box: its number must be inked (white glyphs on red).
func ink(_ shot: Shot, badge: CGRect) -> Int { sample(shot, badge: badge, under: badge)["glyph"]! }

var report: [String: Any] = [:]
/// Every badge over the toolbar / a chip is in the top layer, painted red with its glyphs, and
/// shows none of the UI it crosses.
func checkPaint(_ name: String, needToolbar: Bool, needChip: String?) -> [String: Any] {
    let s = state()
    let badges = s["badges"] as? [[String: Any]] ?? []
    require(!badges.isEmpty, "\(name): badges drawn")
    require(badges.allSatisfy { $0["inTop"] as? Bool == true && $0["pointer"] as? String == "none" }, "\(name): every badge in the pass-through top layer")
    require((s["order"] as? [String])?.last(where: { $0 != "STYLE" }) == "badges", "\(name): badge layer is painted last \(s["order"] ?? "")")
    let shot = snapshot(name)
    var crossings: [[String: Any]] = []
    let toolbar = s["toolbar"].map(rect)
    let chips = (s["chips"] as? [[String: Any]] ?? []).map { ("\($0["kind"] ?? "")-chip", rect($0)) }
    for b in badges {
        let r = rect(b)
        let unders: [(String, CGRect)] = (toolbar.map { [("toolbar", $0)] } ?? []) + chips
        for (kind, u) in unders where r.insetBy(dx: 2, dy: 2).intersects(u) {
            let c = sample(shot, badge: r, under: u)
            require(c["total"]! > 0 && c["dark"]! == 0 && c["blue"]! == 0, "\(name): badge \(b["text"] ?? "") over the \(kind) shows no \(kind) pixels \(c)")
            require(Double(c["red"]!) >= Double(c["total"]!) * 0.5, "\(name): badge \(b["text"] ?? "") over the \(kind) is its own red \(c)")
            let glyphs = ink(shot, badge: r)
            require(glyphs > 4, "\(name): badge \(b["text"] ?? "") number is inked \(glyphs)")
            crossings.append(["badge": b["text"] ?? "", "under": kind, "pixels": c, "glyphPixels": glyphs])
        }
    }
    if needToolbar { require(crossings.contains { $0["under"] as? String == "toolbar" }, "\(name): a badge crosses the toolbar \(s)") }
    if let needChip { require(crossings.contains { $0["under"] as? String == needChip }, "\(name): a badge crosses the \(needChip) \(s)") }
    return ["crossings": crossings, "layerZ": s["layerZ"] ?? "", "toolbarZ": s["toolbarZ"] ?? ""]
}

// A neutral page: a wide panel holding one card. The card's bottom sits 50.25 px above the panel's,
// so the toolbar hung under the selected card lies across the bottom measurement; its top sits
// 24.5 px under the panel's, so the top measurement crosses the title chip above the card.
let page = """
<!doctype html><html><head><style>
html,body{margin:0;background:#fafafa;font:16px -apple-system,system-ui,sans-serif;height:1600px}
.compare-row{position:absolute;left:calc(50% - 300px);top:140px;width:560px;height:200px;background:#eef2fb}
.demo-card{position:absolute;left:60px;top:24.5px;width:220px;height:125.25px;background:#dde4f3;text-align:center;line-height:125px;color:#555}
</style></head><body><div class="compare-row"><div class="demo-card after-panel">After</div></div></body></html>
"""
view.loadHTMLString(page, baseURL: URL(string: "http://127.0.0.1/")!)
until("page load") { inbox.loaded }
spin(0.3)
_ = js("globalThis.__treziNativeDispatch({ type: 'event', channel: 'trezi:preview:set-select-mode', args: [true] }); return true")
spin(0.1)

func geometry() -> (outer: CGRect, inner: CGRect) {
    let g = js("const b = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom } }; return { outer: b('.compare-row'), inner: b('.demo-card') }") as! [String: Any]
    return (rect(g["outer"]), rect(g["inner"]))
}

// Case 1: the card selected, Option over the panel. Bottom badge crosses the toolbar; top badge
// crosses the card's selection chip.
var g = geometry()
move(g.inner.midX, g.inner.midY, option: false)
click(g.inner.midX, g.inner.midY)
require(state()["toolbar"] != nil, "selecting the card shows the toolbar")
move(g.outer.maxX - 20, g.outer.maxY - 10, option: true)
report["selectedCard"] = checkPaint("selected-card", needToolbar: true, needChip: "selection-chip")

// Pass-through: the toolbar button under the bottom badge is what WebKit hit-tests there, and a
// real click on it reaches its action.
do {
    let s = state()
    let toolbar = rect(s["toolbar"])
    let badge = (s["badges"] as! [[String: Any]]).map { rect($0) }.first { $0.intersects(toolbar) }!
    let hit = js("const r = document.querySelector('[data-trezi-overlay]').shadowRoot; const el = r.elementFromPoint(\(badge.midX), \(badge.midY)); const b = el && el.closest('button'); return b ? b.dataset.kind : (el ? el.tagName : null)") as? String
    require(hit == "delete", "the toolbar's Delete under the badge takes the pointer, got \(hit ?? "nil")")
    let before = inbox.sends.count
    click(badge.midX, badge.midY)
    let action = inbox.sends[before...].first { $0.0 == "trezi:preview:toolbar-action" }
    require(action?.1.first as? String == "delete", "a real click under the badge runs the toolbar's Delete action")
    report["passThrough"] = ["button": hit!, "action": action.map { $0.1.first as? String ?? "" } ?? ""]
}

// Case 2: the panel selected, Option over the card (the reference's shape): the top badge
// crosses the card's blue hover title chip.
g = geometry()
move(g.outer.minX + 10, g.outer.minY + 10, option: false)
click(g.outer.minX + 10, g.outer.minY + 10)
move(g.inner.midX, g.inner.midY, option: true)
report["selectedPanel"] = checkPaint("selected-panel", needToolbar: false, needChip: "hover-chip")

// Back to case 1, then scroll: the drawing ends with the hover; Option-hover again redraws the
// badges on top at the new positions.
move(g.inner.midX, g.inner.midY, option: false)
click(g.inner.midX, g.inner.midY)
_ = js("window.scrollTo(0, 60); return true")
spin(0.3)
require((state()["badges"] as? [Any])?.isEmpty == true, "scrolling clears the measurement")
g = geometry()
move(g.outer.maxX - 20, g.outer.maxY - 10, option: true)
report["scrolled"] = checkPaint("scrolled", needToolbar: true, needChip: "selection-chip")

// Resize: the centred panel moves; the drawing follows on top.
let widthBefore = state()["width"] as? Double ?? 0
window.setContentSize(NSSize(width: 680, height: 520)); view.frame = NSRect(x: 0, y: 0, width: 680, height: 520)
spin(0.4)
require((state()["width"] as? Double ?? 0) < widthBefore, "the viewport resized")
g = geometry()
move(g.outer.maxX - 20, g.outer.maxY - 10, option: true)
report["resized"] = checkPaint("resized", needToolbar: true, needChip: "selection-chip")

// Option released (the key-up WebKit makes of a flags change): nothing stays on top.
view.flagsChanged(with: NSEvent.keyEvent(with: .flagsChanged, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                         windowNumber: window.windowNumber, context: nil, characters: "", charactersIgnoringModifiers: "", isARepeat: false, keyCode: 58)!)
spin(0.3)
require((state()["badges"] as? [Any])?.isEmpty == true, "releasing Option leaves no badge")
let cleared = js("return document.querySelector('[data-trezi-overlay]').shadowRoot.querySelector('[data-trezi-measure-badges]').textContent") as? String
require(cleared == "", "the badge layer is empty after the measurement")
report["clearedAfter"] = true

let data = try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
