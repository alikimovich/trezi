import AppKit
import SwiftUI

// LKM-383: the real ChatConversation (NativeChat) offscreen, showing one of two chats that both
// stream. Each step pushes the shown chat like the Bun controller does and records what the native
// smoke's `parallel-stream` reads from `chatInspect`, every ~100 ms, next to Bun's side of it.
// `dropped` repeats it with a Chat.swift whose frames never arrive: `messageFramesFilter` keeps none.
// test/native-chat-parallel-stream.mjs runs the smoke's own assertions over both timelines.
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

let paragraph = "This streamed answer has enough words to wrap across several lines of the chat column, so the row grows. "
func message(_ id: String, _ role: String, _ body: String) -> [String: Any] {
    ["id": id, "role": role, "text": body, "segments": body.isEmpty ? [] : [["kind": "text", "text": body]], "at": 1_760_000_000_000.0, "workedMs": 12000.0]
}
func history(_ key: String) -> [[String: Any]] {
    (0..<6).map { i in i % 2 == 0 ? message("\(key)-\(i)", "user", "Request \(i)") : message("\(key)-\(i)", "assistant", String(repeating: paragraph, count: 1 + i)) }
}

var chats: [String: [[String: Any]]] = [:]
var chunks: [String: Int] = [:]
var running: Set<String> = []
var shown = ""
func start(_ id: String) {
    chats[id, default: history(id)] += [message("\(id)-prompt", "user", "Parallel turn \(id)"), message("\(id)-reply", "assistant", "")]
    chunks[id] = 0; running.insert(id)
}
func push() {
    var state: [String: Any] = ["visible": true, "chat": shown, "messages": chats[shown] ?? [], "running": running.contains(shown), "cards": [], "questions": [], "ready": true,
                                "bounds": ["x": 0.0, "y": 0.0, "width": Double(width), "height": Double(height)], "composer": ["text": ""]]
    // A static activity: the shimmer animates without bound offscreen.
    if running.contains(shown) { state["streamingId"] = chats[shown]?.last?["id"] ?? ""; state["activity"] = ["label": "Working", "kind": "thinking", "animated": false] }
    chat.update(state, composer: composer)
}
func chunk() {
    for id in running {
        chunks[id, default: 0] += 1
        let count = chats[id]?.count ?? 1
        chats[id]?[count - 1] = message("\(id)-reply", "assistant", String(repeating: paragraph, count: chunks[id] ?? 0))
    }
    push()
}
/// Rows by id and text length: the check reads no more, and the texts would flood stdout.
func rows(_ list: [[String: Any]]?) -> [[String: Any]] {
    (list ?? []).map { ["id": $0["id"] ?? "", "length": ($0["text"] as? String)?.count ?? 0] }
}

/// Runs a step, streaming every 90 ms, until it held a row in view for `hold` seconds. With
/// `settle` false (no row will come) it runs for `hold` seconds. `cap` only stops a hung step.
func step(_ label: String, _ id: String, into timeline: inout [[String: Any]], settle: Bool = true, hold: Double = 1, cap: Double = 30) {
    if shown != id { shown = id; push() }
    let start = Date()
    var nextChunk = start, nextSample = start, heldSince: Date?
    while Date().timeIntervalSince(start) < cap {
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.016))
        let now = Date()
        if !running.isEmpty && now >= nextChunk { chunk(); nextChunk = now.addingTimeInterval(0.09) }
        guard now >= nextSample else { continue }
        nextSample = now.addingTimeInterval(0.1)
        let state = chat.inspect()
        let view: [String: Any] = ["chat": state["chat"] ?? "", "visible": state["visible"] ?? false, "visibleMessageIDs": state["visibleMessageIDs"] ?? [],
                                   "realizedRows": state["realizedRows"] ?? 0, "messageCount": state["messageCount"] ?? 0, "latestSettling": state["latestSettling"] ?? false,
                                   "messages": rows(state["messages"] as? [[String: Any]])]
        timeline.append(["label": label, "expected": id, "t": now.timeIntervalSince1970 * 1000, "chat": view, "bun": ["active": id, "messages": rows(chats[id])]])
        if !settle { if now.timeIntervalSince(start) >= hold { return } else { continue } }
        if (state["visibleMessageIDs"] as? [String])?.isEmpty == false { heldSince = heldSince ?? now } else { heldSince = nil }
        if let since = heldSince, now.timeIntervalSince(since) >= hold { return }
    }
}

func run(_ filter: (([String: CGRect]) -> [String: CGRect])?) -> [[String: Any]] {
    var timeline: [[String: Any]] = []
    let settle = filter == nil
    chats = [:]; chunks = [:]; running = []; shown = ""
    chat.model.messageFramesFilter = filter
    start("a")
    step("a-streaming", "a", into: &timeline, settle: settle)
    start("b")
    step("b-streaming", "b", into: &timeline, settle: settle)
    for i in 0..<2 {
        step("to-a-\(i)", "a", into: &timeline, settle: settle)
        step("to-b-\(i)", "b", into: &timeline, settle: settle)
    }
    running = []
    push()
    step("done-b", "b", into: &timeline, settle: settle)
    step("done-a", "a", into: &timeline, settle: settle)
    chat.model.messageFramesFilter = nil
    return timeline
}

let kept = run(nil)
let dropped = run { _ in [:] }
print(String(data: try! JSONSerialization.data(withJSONObject: ["kept": kept, "dropped": dropped], options: [.sortedKeys]), encoding: .utf8)!)
exit(0)
