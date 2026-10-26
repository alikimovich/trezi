import AppKit
import SwiftUI

// LKM-312: the real ChatConversation (NativeChat, with its sticky-request overlay)
// offscreen. The settle reads the end marker's position through BottomPosition;
// read above the overlay it stayed 0, so no follow ever settled and each one
// relaid out the lazy stack for all its attempts. Prints one JSON summary of the
// marker and the settle after a load, while streaming and after the turn.
func emit(_ value: [String: Any]) {}
func copyChatText(_ value: String) {}
func captureVisibleRegion(window: NSWindow, view: NSView, region: NSRect, recognize: Bool = true) async throws -> [String: Any] { [:] }
final class Host { var window: NSWindow!; let chat = NativeChat() }

_ = NSApplication.shared
NSApp.setActivationPolicy(.accessory)
let width: CGFloat = 440, height: CGFloat = 776
let window = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: width, height: height), styleMask: [.titled], backing: .buffered, defer: false)
let root = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
window.contentView = root
let chat = NativeChat()
let composer = NativeComposer(frame: .zero)
root.addSubview(chat); root.addSubview(composer)
window.orderFront(nil)
func spin(_ seconds: Double) {
    let end = Date(timeIntervalSinceNow: seconds)
    while Date() < end { RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.016)) }
}
func probe() -> ChatScrollStyleProbe? {
    func find(_ view: NSView) -> ChatScrollStyleProbe? { (view as? ChatScrollStyleProbe) ?? view.subviews.lazy.compactMap(find).first }
    return find(chat)
}
let paragraph = "This answer explains the change in some detail so it wraps across several lines of the conversation column. "
func message(_ i: Int, text: String? = nil) -> [String: Any] {
    let role = i % 2 == 0 ? "user" : "assistant"
    let body = text ?? (role == "user" ? "Request \(i)" : String(repeating: paragraph, count: 1 + (i * 7) % 9))
    return ["id": "m\(i)", "role": role, "text": body, "segments": [["kind": "text", "text": body]], "at": 1_760_000_000_000.0 + Double(i), "workedMs": 12000.0]
}
var messages = (0..<40).map { message($0) }
func state(running: Bool = false) -> [String: Any] {
    var value: [String: Any] = ["visible": true, "chat": "c1", "messages": messages, "running": running, "cards": [], "questions": [], "ready": true,
                                "bounds": ["x": 0.0, "y": 0.0, "width": Double(width), "height": Double(height)], "composer": ["text": ""]]
    // A static activity: the shimmer animates without bound offscreen.
    if running { value["streamingId"] = messages.last?["id"] ?? ""; value["activity"] = ["label": "Working", "kind": "thinking", "animated": false] }
    return value
}
var samples: [[String: Any]] = []
// The checks stay in the test. A sample waits for the settle's own end signals, not for a
// time (LKM-355: a fixed 1.5 s wait, then up to 10 s for an attempt sum under 20, failed on
// loaded CI runners): a settle started for this phase has ended (`latestSettles` grew) and
// no settle ran and no pin moved for 30 run-loop turns and 0.5 s. `ended` is false when that
// never happened within 60 s; a pre-fix chat is recorded as is.
func sample(_ phase: String, settlesBefore: Int) {
    let model = chat.model
    let deadline = Date(timeIntervalSinceNow: 60)
    var quietTurns = 0, quietSince = Date(), pins = probe()?.pinCount ?? 0, ended = false
    while Date() < deadline {
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.016))
        let now = probe()?.pinCount ?? 0
        if model.latestSettling || now != pins || model.latestSettles <= settlesBefore {
            quietTurns = 0; quietSince = Date(); pins = now
        } else {
            quietTurns += 1
        }
        if quietTurns >= 30 && Date().timeIntervalSince(quietSince) >= 0.5 { ended = true; break }
    }
    samples.append(["phase": phase, "ended": ended, "settling": model.latestSettling, "settles": model.latestSettles - settlesBefore,
                    "settled": model.latestSettled, "bottom": model.bottomPosition, "reading": max(1, chat.bounds.height - model.bottomInset),
                    "settleAttempts": model.latestSettleAttempts, "pins": probe()?.pinCount ?? 0])
}
var settles = chat.model.latestSettles
chat.update(state(), composer: composer)
sample("load", settlesBefore: settles)
settles = chat.model.latestSettles
messages.append(message(40, text: "Next request")); messages.append(message(41, text: "Starting"))
chat.update(state(running: true), composer: composer)
for chunk in 1...20 {
    messages[messages.count - 1] = message(41, text: String(repeating: paragraph, count: chunk))
    chat.update(state(running: true), composer: composer); spin(0.033)
}
sample("streamed", settlesBefore: settles)
settles = chat.model.latestSettles
chat.update(state(), composer: composer)
sample("completed", settlesBefore: settles)
print(String(data: try! JSONSerialization.data(withJSONObject: ["samples": samples], options: [.sortedKeys]), encoding: .utf8)!)
