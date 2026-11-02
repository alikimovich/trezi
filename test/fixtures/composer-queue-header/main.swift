import AppKit
import SwiftUI

// LKM-436: the queue header's inspect keeps one shape for a measured and an unmeasured control.
// A real `ComposerQueueHost` is laid out in an offscreen window, paused (Send now shown) and with
// only a note (no Send now), and its `inspect` is reported as JSON. Each header value also says
// whether Swift holds it as an Optional, which JSON alone cannot show. One JSON report on stdout.
@discardableResult func copyChatText(_ text: String) -> Bool { false } // ChatRichText.swift; no row is clicked here.
_ = NSApplication.shared
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 240), styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = NSView(frame: window.contentRect(forFrameRect: window.frame))
let queue = ComposerQueueHost()
queue.reduceMotionOverride = true
queue.frame = NSRect(x: 20, y: 20, width: 420, height: 200)
window.contentView?.addSubview(queue)
func measure(paused: Bool, note: String) -> [String: Any] {
    queue.update([["id": "m0", "text": "queued", "attachments": 0]], paused: paused, note: note, chat: "a")
    let deadline = Date().addingTimeInterval(5)
    repeat {
        queue.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    } while (queue.frames["resume"] != nil) != paused && Date() < deadline
    let inspect = queue.inspect(composerTop: 180)
    let header = inspect["header"] as? [String: Any] ?? [:]
    let boxed = header.filter { Mirror(reflecting: $0.value).displayStyle == .optional }.keys.sorted()
    return ["inspect": inspect, "optionals": boxed, "isDictionary": inspect["header"] is [String: Any]]
}
let out: [String: Any] = ["present": measure(paused: true, note: ""), "absent": measure(paused: false, note: "Waiting for Resolve")]
print(String(data: try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
