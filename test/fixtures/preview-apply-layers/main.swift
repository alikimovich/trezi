import AppKit
import WebKit

// LKM-638: the preview side of a submitted Apply's layer. The real bundled `preview.js` runs
// in a real WKWebView in its own `TreziPreview` world, as Host.swift installs it, over a
// neutral synthetic page: a card (padding animated by a CSS transition) above a row whose
// top moves with the card's height. A real click selects the card. Then, as the inspector
// sends them: A's override, B's override on the same property, a styles:read while A has
// not rendered (its lifted `base` must be the authored value with no observable intermediate
// layout or started transition), the "HMR" rendering A then B, and the clear that retires the layers
// (`keep`). A timer loop logs the row's top between tasks; WebKit's own snapshot is compared
// before and after the retire. Prints one JSON report; PNGs go to the directory in argv[2].

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
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 360), styleMask: [.borderless], backing: .buffered, defer: false)
let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 480, height: 360), configuration: config)
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
func mouse(_ type: NSEvent.EventType, _ x: Double, _ y: Double) -> NSEvent {
    NSEvent.mouseEvent(with: type, location: view.convert(NSPoint(x: x, y: y), to: nil), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                       windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1)!
}
/// Delivers a host → preload message exactly as Host.swift does.
func toPage(_ channel: String, _ payload: String) {
    _ = js("globalThis.__treziNativeDispatch({ type: 'event', channel: '\(channel)', args: [\(payload)] }); return true")
}
func snapshot(_ name: String) -> NSBitmapImageRep {
    var image: NSImage?
    view.takeSnapshot(with: nil) { img, _ in image = img ?? NSImage() }
    until("snapshot") { image != nil }
    let rep = NSBitmapImageRep(data: image!.tiffRepresentation!)!
    try! rep.representation(using: .png, properties: [:])!.write(to: artifacts.appendingPathComponent("\(name).png"))
    return rep
}
func same(_ a: NSBitmapImageRep, _ b: NSBitmapImageRep) -> Int {
    var differ = 0
    for y in stride(from: 0, to: min(a.pixelsHigh, b.pixelsHigh), by: 2) {
        for x in stride(from: 0, to: min(a.pixelsWide, b.pixelsWide), by: 2) where a.colorAt(x: x, y: y) != b.colorAt(x: x, y: y) { differ += 1 }
    }
    return differ
}

let page = """
<!doctype html><html><head><style id="authored">
html,body{margin:0;background:#fafafa;font:14px -apple-system,system-ui,sans-serif}
.card{margin:40px;padding:4px 16px;background:#dde4f3;transition:padding 400ms linear}
.card{padding-top:4px}
.row{margin:0 40px;height:40px;background:#c9d3e8}
</style></head><body><div class="card" data-trezi-source="src/card.tsx:3:1">Card</div><div class="row"></div><div class="jsx" style="margin:40px;padding-top:6px;background:#e4e9f5" data-trezi-source="src/card.tsx:9:1">Inline</div></body></html>
"""
view.loadHTMLString(page, baseURL: URL(string: "http://127.0.0.1/")!)
until("page load") { inbox.loaded }
spin(0.3)
toPage("trezi:preview:set-select-mode", "true")
spin(0.1)
let card = js("const r = document.querySelector('.card').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]") as! [Double]
view.mouseDown(with: mouse(.leftMouseDown, card[0], card[1]))
view.mouseUp(with: mouse(.leftMouseUp, card[0], card[1]))
spin(0.3)
require(inbox.sends.contains { $0.0 == "trezi:preview:element-picked" || $0.0 == "preview:element-picked" }, "the card was picked: \(inbox.sends.map { $0.0 })")

// Layout log: the row's top between tasks, and every transition the card starts.
_ = js("""
  const row = document.querySelector('.row'), card = document.querySelector('.card')
  globalThis.__frames = []; globalThis.__transitions = []
  card.addEventListener('transitionrun', (e) => __transitions.push(e.propertyName))
  // Between every task: an off-screen view gets no animation frames, and the state any frame
  // could paint is exactly what a task boundary can observe.
  const tick = () => { __frames.push(row.getBoundingClientRect().top); setTimeout(tick, 2) }
  setTimeout(tick, 2)
  return true
""")
func rowTop() -> Double { js("return document.querySelector('.row').getBoundingClientRect().top") as! Double }
func frames(from: Int) -> [Double] { Array((js("return __frames") as! [Double]).dropFirst(from)) }
func frameCount() -> Int { (js("return __frames.length") as! Int) }
func transitions() -> [String] { js("return __transitions") as! [String] }
func read() -> [String: Any] {
    let id = "r\(inbox.sends.count)"
    toPage("styles:read", "{ id: '\(id)', props: ['padding-top', 'opacity'] }")
    var reply: [String: Any]?
    until("styles:read reply") {
        reply = inbox.sends.last { $0.0 == "styles:read-reply" && ($0.1.first as? [String: Any])?["id"] as? String == id }?.1.first as? [String: Any]
        return reply != nil
    }
    return reply!
}
func settle() { spin(0.6) }

var report: [String: Any] = [:]
let authored = rowTop()
// Instant overrides: the inspector's preview has no transition of its own; a scrub is instant.
_ = js("document.querySelector('.card').style.setProperty('transition', 'none'); return true")
toPage("styles:preview", "{ prop: 'padding-top', value: '10px' }")   // A
settle()
let withA = rowTop()
require(withA - authored == 6, "A's override moves the row by 6 px: \(authored) → \(withA)")
toPage("styles:preview", "{ prop: 'padding-top', value: '12px' }")   // B, same property
toPage("styles:preview", "{ prop: 'opacity', value: '0.5' }")        // B, another property
settle()
let withB = rowTop()
require(withB - authored == 8, "B composes above A: \(withB - authored)")
// Back to the page's own transition so a lifted read would animate if it leaked.
_ = js("document.querySelector('.card').style.removeProperty('transition'); return true")
settle()

// A landed, preview not yet updated: the lifted read reports the authored 4px, the override
// stays, and no frame or transition shows anything but B.
var mark = frameCount()
let before = transitions().count
let pending = read()
settle()
let base = pending["base"] as? [String: String] ?? [:]
let values = pending["values"] as? [String: String] ?? [:]
require(base["padding-top"] == "4px", "lifted base is the authored value: \(pending)")
require(values["padding-top"] == "12px", "the read still shows B: \(pending)")
// Task-boundary samples: the lift is one task, so this guards a regression to an async lift.
require(frames(from: mark).allSatisfy { $0 == withB }, "no task saw the row without the override: \(frames(from: mark))")
require(transitions().count == before, "the lifted read started no transition: \(transitions())")
require(js("return document.querySelector('.card').style.getPropertyValue('transition-property')") as? String == "", "the card's inline transition is restored")
report["pending"] = ["base": base, "values": values, "frames": frames(from: mark).count]

// The dev server renders A (HMR): base 10px; the inspector keeps B over it.
_ = js("document.getElementById('authored').textContent = document.getElementById('authored').textContent.replace('padding-top:4px', 'padding-top:10px'); return true")
settle()
require(rowTop() == withB, "B still shows after A renders")
require((read()["base"] as? [String: String])?["padding-top"] == "10px", "base follows the served source")
// B lands and renders: the retire keeps nothing; the clear is visually neutral.
_ = js("document.getElementById('authored').textContent = document.getElementById('authored').textContent.replace('padding-top:10px', 'padding-top:12px').replace('.row{', '.card{opacity:0.5}.row{'); return true")
// Trezi's selection outline follows layout on its own 600 ms cadence: let it catch up.
spin(1.3)
let beforeRetire = snapshot("before-retire")
mark = frameCount()
let beforeClear = transitions().count
// First a partial retire (opacity kept), then the full one, as the controller would send them.
toPage("styles:clear-preview", "{ keep: ['opacity'] }")
settle()
require(js("return document.querySelector('.card').style.getPropertyValue('opacity')") as? String == "0.5", "keep leaves that override in place")
require(js("return document.querySelector('.card').style.getPropertyValue('padding-top')") as? String == "", "the retired override is gone")
toPage("styles:clear-preview", "{}")
spin(1.3)
let afterRetire = snapshot("after-retire")
let changed = same(beforeRetire, afterRetire)
require(frames(from: mark).allSatisfy { $0 == withB }, "the retire moved nothing: \(frames(from: mark))")
require(transitions().count == beforeClear, "the retire started no transition")
require(changed == 0, "the retire is pixel-identical: \(changed) samples differ")
report["retire"] = ["frames": frames(from: mark).count, "pixelsChanged": changed, "rowTop": withB - authored]
report["authoredTop"] = authored

// A JSX `style={}` value: after A's hot reload React writes the inline property itself, here
// the same value as the override, which leaves no trace in the DOM (no mutation record). The
// inspector retires such a property by adopting it: the stash is dropped without restoring
// the value stashed before, so the element keeps the page's 12px instead of snapping to 6px.
// A page rewrite to a different value is noticed and becomes the original.
let jsx = js("const r = document.querySelector('.jsx').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]") as! [Double]
view.mouseDown(with: mouse(.leftMouseDown, jsx[0], jsx[1]))
view.mouseUp(with: mouse(.leftMouseUp, jsx[0], jsx[1]))
spin(0.3)
toPage("styles:preview", "{ prop: 'padding-top', value: '12px' }")
settle()
_ = js("document.querySelector('.jsx').style.paddingTop = '12px'; return true")
toPage("styles:clear-preview", "{ adopt: ['padding-top'] }")
settle()
let adopted = js("return document.querySelector('.jsx').style.paddingTop") as? String
require(adopted == "12px", "an adopted inline value stays the page's: \(adopted ?? "")")
toPage("styles:preview", "{ prop: 'padding-top', value: '20px' }")
settle()
_ = js("document.querySelector('.jsx').style.paddingTop = '14px'; return true")
let rewritten = read()
require((rewritten["base"] as? [String: String])?["padding-top"] == "14px", "a page rewrite to another value is the base: \(rewritten)")
toPage("styles:clear-preview", "{}")
settle()
let restored = js("return document.querySelector('.jsx').style.paddingTop") as? String
require(restored == "14px", "a clear restores the page's rewrite, not the stale 12px: \(restored ?? "")")
report["jsx"] = ["adopted": adopted ?? "", "rewriteBase": (rewritten["base"] as? [String: String])?["padding-top"] ?? "", "afterClear": restored ?? ""]
let data = try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
