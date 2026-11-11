import AppKit

// LKM-457: where the pop-out acceptance's posted clicks land, on the real `NativeSourceEditor`
// laid out in a pop-out window as `sourceState` builds it (1000×700, titled). Each pointer target
// (the editor's ×, its Dock control, the red button) is located by `ControlHitPoint` and
// hit-tested by the window's frame view; the old point, the midpoint of `visibleRect`, is
// reported beside it. Then the layout guards: hidden, zero-size, clipped, off-screen and
// not-in-window controls refuse. One JSON report on stdout.

// What SourceEditor.swift and SourceWrap.swift reach outside the files compiled here.
func emit(_ value: [String: Any]) {}
func captureVisibleRegion(window: NSWindow, view: NSView, region: NSRect, recognize: Bool = true, corrected: Bool = false) async throws -> [String: Any] { [:] }
final class Host: NSObject {
    var dockedSource: NativeSourceEditor?, sourceEditors: [String: NativeSourceEditor] = [:], sourceRoot = ""
    // Host's Edit → Undo / Redo, validated beside Wrap Lines (LKM-644; not exercised here).
    @objc func menuAction(_ item: NSMenuItem) {}
    func validateEditUndo(_ item: NSMenuItem) -> Bool { true }
}

@MainActor func run() -> [String: Any] {
    _ = NSApplication.shared
    let popout = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 700), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
    popout.isReleasedWhenClosed = false
    // With a screen, the whole frame lies inside its visible frame (menu bar and Dock excluded):
    // shrunk to fit a small display, never hanging off its top, which is where the controls are.
    let visible = NSScreen.main?.visibleFrame
    if let visible {
        let size = NSSize(width: min(popout.frame.width, visible.width), height: min(popout.frame.height, visible.height))
        popout.setFrame(NSRect(x: visible.minX, y: visible.maxY - size.height, width: size.width, height: size.height), display: false)
    }
    let editor = NativeSourceEditor(), container = popout.contentView!
    editor.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(editor)
    NSLayoutConstraint.activate([editor.leadingAnchor.constraint(equalTo: container.leadingAnchor), editor.trailingAnchor.constraint(equalTo: container.trailingAnchor),
                                 editor.topAnchor.constraint(equalTo: container.topAnchor), editor.bottomAnchor.constraint(equalTo: container.bottomAnchor)])
    editor.update(["root": "/fixture", "source": "index.html", "popped": true, "visible": true, "text": "<!doctype html>\n<p>fixture</p>\n", "revision": 1])
    popout.layoutIfNeeded()

    func probe(_ view: NSView, in host: NSWindow, onScreen: Bool = true) -> [String: Any] {
        let located = ControlHitPoint.locate(view, in: host, onScreen: onScreen)
        let visible = view.visibleRect, old = view.convert(NSPoint(x: visible.midX, y: visible.midY), to: nil)
        let oldHit = (host.contentView?.superview ?? host.contentView)?.hitTest(old)
        let inWindow = view.convert(view.bounds, to: nil)
        return located.info.merging(["refused": located.refused ?? NSNull(), "located": located.point != nil,
                                     "pointInControl": located.point.map { inWindow.contains($0) } ?? false,
                                     "legacy": ["point": [Double(old.x), Double(old.y)], "hitView": oldHit.map { String(describing: type(of: $0)) } ?? "",
                                                "hitIsTarget": oldHit.map { $0 === view || $0.isDescendant(of: view) } ?? false]]) { _, new in new }
    }
    // A headless run may have no screen; there the targets are located without the on-screen rule.
    let hasScreen = NSScreen.main != nil
    func rect(_ r: NSRect?) -> [Double] { r.map { [$0.minX, $0.minY, $0.width, $0.height].map(Double.init) } ?? [] }
    var out: [String: Any] = ["hasScreen": hasScreen, "visibleFrame": rect(visible), "popoutFrame": rect(popout.frame),
                              "fits": visible.map { $0.contains(popout.frame) } ?? true]
    out["editor-close"] = probe(editor.controls["hide"]!, in: popout, onScreen: hasScreen)
    out["editor-dock"] = probe(editor.controls["popout"]!, in: popout, onScreen: hasScreen)
    out["window-close"] = probe(popout.standardWindowButton(.closeButton)!, in: popout, onScreen: hasScreen)

    // Guards: nothing is located for a control that is hidden, empty, scrolled out of view, off screen or elsewhere.
    let hidden = NSButton(title: "Hidden", target: nil, action: nil), empty = NSButton(title: "", target: nil, action: nil)
    hidden.frame = NSRect(x: 40, y: 40, width: 80, height: 24); hidden.isHidden = true
    empty.frame = NSRect(x: 40, y: 80, width: 0, height: 0)
    let scroll = NSScrollView(frame: NSRect(x: 200, y: 40, width: 200, height: 100)), document = NSView(frame: NSRect(x: 0, y: 0, width: 200, height: 1000))
    let scrolledAway = NSButton(title: "Away", target: nil, action: nil)
    scrolledAway.frame = NSRect(x: 10, y: 900, width: 80, height: 24); document.addSubview(scrolledAway); scroll.documentView = document
    scroll.contentView.scroll(to: .zero)
    for view in [hidden, empty, scroll] { container.addSubview(view) }
    popout.layoutIfNeeded()
    out["hidden"] = probe(hidden, in: popout)
    out["zero-size"] = probe(empty, in: popout)
    out["clipped"] = probe(scrolledAway, in: popout)
    let elsewhere = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 200), styleMask: [.titled], backing: .buffered, defer: false)
    elsewhere.isReleasedWhenClosed = false
    out["other-window"] = probe(editor.controls["hide"]!, in: elsewhere)
    // Off every screen: refused where the point must be on screen; only recorded for a title-bar host.
    popout.setFrameOrigin(NSPoint(x: -100_000, y: -100_000))
    out["off-screen"] = probe(editor.controls["hide"]!, in: popout)
    out["off-screen-title-bar"] = probe(editor.controls["hide"]!, in: popout, onScreen: false)
    return out
}

let report = MainActor.assumeIsolated { run() }
print(String(data: try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), encoding: .utf8)!)
