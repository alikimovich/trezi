import AppKit
import SwiftUI

// LKM-599: the real NativeEditingInspector in an off-screen window (x: -4000). The draft row
// (Apply, Undo draft, Revert draft) must sit pinned at the island's foot, below the
// scrolling fields, in view and hittable before and after the fields scroll, at a normal
// and a short island. SwiftUI draws these buttons itself (no NSButton): every enabled
// button keeps a key-view proxy at its frame, as ChatRecoveryAcceptance.swift relies on.
var emitted: [[String: Any]] = []
func emit(_ value: [String: Any]) { emitted.append(value) }
func fail(_ message: String) -> Never { fputs("FAIL: \(message)\n", stderr); exit(1) }
func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
func pump(_ seconds: Double = 0.15) {
    let end = Date(timeIntervalSinceNow: seconds)
    while Date() < end { RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.016)) }
}
func r(_ rect: NSRect) -> [Double] { [rect.minX, rect.minY, rect.width, rect.height].map { (Double($0) * 10).rounded() / 10 } }

_ = NSApplication.shared
NSApp.setActivationPolicy(.accessory)

func state(count: Int, submitted: Bool) -> InspectorState {
    var fields: [[String: Any]] = []
    for i in 0..<40 {
        fields.append(["id": "style:prop-\(i)", "label": "prop-\(i)", "group": i < 20 ? "typography" : "appearance", "kind": "text", "value": "\(i)px"])
    }
    let raw: [String: Any] = [
        "root": "/fixture", "generation": 1, "visible": true, "title": "span", "tab": "styles",
        "fields": fields, "actions": [], "error": "", "busy": false,
        // LKM-638: a running Apply batch is reported beside the editable draft, never as a lock.
        "draft": ["count": count, "submitted": submitted, "conflict": false, "preview": true,
                  "applying": submitted ? "Applying 1 value in the background" : ""] as [String: Any],
        // LKM-644: Undo draft is enabled when the draft has an Undo step.
        "history": ["undo": count > 0, "redo": false, "restored": 0] as [String: Any]
    ]
    return try! JSONDecoder().decode(InspectorState.self, from: JSONSerialization.data(withJSONObject: raw))
}

/// A real click at `frame`'s centre through the window; the action it sent, if any.
func click(_ window: NSWindow, _ frame: NSRect) -> String {
    emitted = []
    let point = NSPoint(x: frame.midX, y: frame.midY)
    for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
        let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0)!
        window.sendEvent(event)
        pump(0.05)
    }
    pump(0.1)
    return emitted.last?["action"] as? String ?? ""
}
var results: [[String: Any]] = []
// The island's default width (300) and its narrowest (220, WorkspaceLayout).
// "short-applying": an Apply runs and nothing new is staged; "short-applying-next": the next
// draft was staged while it runs (LKM-638), so its actions and the fields are live.
for (name, width, height, count, submitted) in [("normal", 300.0, 720.0, 1, false), ("short", 300.0, 300.0, 1, false),
                                                ("narrow-short", 220.0, 300.0, 1, false), ("short-applying", 300.0, 300.0, 0, true),
                                                ("short-applying-next", 300.0, 300.0, 1, true)] {
    let window = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: width + 40, height: height + 40), styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.orderFront(nil) // off-screen (x: -4000): events reach it, the user never sees it
    let island = NativeEditingInspector()
    window.contentView!.addSubview(island)
    island.frame = NSRect(x: 20, y: 20, width: width, height: height)
    island.model.show(state(count: count, submitted: submitted)); island.isHidden = false
    pump(0.3); island.layoutSubtreeIfNeeded(); pump(0.2)
    let face = island.face.convert(island.face.bounds, to: nil)
    let content = window.contentView!
    let proxies = descendants(island)
        .filter { String(describing: type(of: $0)) == "KeyViewProxy" && !$0.isHiddenOrHasHiddenAncestor }
    guard let scroll = descendants(island).compactMap({ $0 as? NSScrollView }).first else { fail("\(name): no scroll view for the fields") }
    let scrollFrame = scroll.convert(scroll.bounds, to: nil)
    // The footer's buttons are the proxies below the scrolling fields (window y grows upwards).
    func footer() -> [NSRect] {
        proxies.map { $0.convert($0.bounds, to: nil) }
            .filter { $0.width > 0 && $0.height > 0 && $0.maxY <= scrollFrame.minY + 0.5 }
            .sorted { $0.minX < $1.minX }
    }
    func hits(_ frames: [NSRect]) -> Bool {
        frames.allSatisfy { frame in
            let point = NSPoint(x: frame.midX, y: frame.midY)
            guard let hit = content.hitTest(content.superview?.convert(point, from: nil) ?? point) else { return false }
            return hit.isDescendant(of: island.content) && !hit.isDescendant(of: scroll)
        }
    }
    let before = footer()
    let documentHeight = scroll.documentView?.frame.height ?? 0
    let scrolls = documentHeight > scroll.contentView.bounds.height + 1
    // Scroll the fields to their end, then look again.
    if let document = scroll.documentView {
        let end = document.isFlipped ? NSPoint(x: 0, y: max(0, document.frame.height - scroll.contentView.bounds.height)) : .zero
        scroll.contentView.scroll(to: end); scroll.reflectScrolledClipView(scroll.contentView)
    }
    pump(0.2)
    let offset = scroll.contentView.bounds.minY
    let after = footer()
    let lastVisible = scroll.convert(scroll.contentView.frame, to: nil)
    results.append([
        "case": name, "face": r(face), "scroll": r(scrollFrame), "scrolls": scrolls,
        "before": before.map(r), "after": after.map(r),
        "inFace": (before + after).allSatisfy { face.insetBy(dx: -0.5, dy: -0.5).contains($0) },
        "belowFields": (before + after).allSatisfy { $0.maxY <= lastVisible.minY + 0.5 },
        "hittable": hits(before) && hits(after),
        "offset": Double(offset),
        "fieldsEnabled": descendants(island).compactMap { $0 as? NSTextField }.filter { $0.isEditable && $0.isEnabled }.count,
        "clicked": after.map { click(window, $0) },
        // Where Apply is drawn when enabled (the "short" case's frame), for a disabled row.
        "pressDisabled": count == 0 ? click(window, NSRect(x: 34, y: 34, width: 50, height: 20)) : ""
    ])
    if name.hasPrefix("short-applying") {
        // For review (gitignored): the footer while an Apply runs. Offscreen: no Liquid Glass.
        let dir = URL(fileURLWithPath: "test/artifacts/inspector-footer", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let view = window.contentView!
        if let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
            view.cacheDisplay(in: view.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("\(name).png"))
        }
    }
    window.close()
}
let data = try! JSONSerialization.data(withJSONObject: results)
print(String(data: data, encoding: .utf8)!)
