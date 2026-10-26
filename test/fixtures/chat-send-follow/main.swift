import AppKit
import SwiftUI

// LKM-354: the real ChatConversation (NativeChat) offscreen. Each case loads a
// transcript, sends, streams the answer and ends the turn, sampling every ~30 ms
// without waiting for a settle: which of the sent rows are in the reading area,
// the clip offset and whether a settle runs. Then it samples the rest after the
// turn. Prints one JSON summary per case.
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
let paragraph = "This answer explains the change in some detail so it wraps across several lines of the conversation column. "
func message(_ id: String, _ role: String, _ body: String) -> [String: Any] {
    ["id": id, "role": role, "text": body, "segments": body.isEmpty ? [] : [["kind": "text", "text": body]], "at": 1_760_000_000_000.0, "workedMs": 12000.0]
}
func history(_ key: String, _ count: Int) -> [[String: Any]] {
    (0..<count).map { i in i % 2 == 0 ? message("\(key)-\(i)", "user", "Request \(i)") : message("\(key)-\(i)", "assistant", String(repeating: paragraph, count: 1 + (i * 7) % 9)) }
}
var chatID = "", messages: [[String: Any]] = [], cards: [[String: Any]] = []
var running = false
func push() {
    var state: [String: Any] = ["visible": true, "chat": chatID, "messages": messages, "running": running, "cards": cards, "questions": [], "ready": true,
                                "bounds": ["x": 0.0, "y": 0.0, "width": Double(width), "height": Double(height)], "composer": ["text": ""]]
    // A static activity: the shimmer animates without bound offscreen.
    if running { state["streamingId"] = messages.last?["id"] ?? ""; state["activity"] = ["label": "Working", "kind": "thinking", "animated": false] }
    chat.update(state, composer: composer)
}
func open(_ id: String, _ list: [[String: Any]]) { chatID = id; messages = list; cards = []; push() }
func offset() -> CGFloat { chat.conversationScroll.flatMap { ChatScrollStyleProbe.metrics($0)["offset"] as? CGFloat } ?? 0 }
var results: [[String: Any]] = []
/// Sends while `running` may still be true (the previous turn), streams `chunks`
/// every 0.1 s, then ends the turn. `cardsAt`: the chunk at which cards that fill
/// the view arrive after the reply.
func send(_ name: String, cardsAt: Int? = nil, chunks: Int = 20, end: Bool = true) {
    let prompt = "\(name)-prompt", reply = "\(name)-reply"
    messages += [message(prompt, "user", "Please review the text on the home page"), message(reply, "assistant", "")]
    running = true; push()
    let start = Date()
    var samples = 0, shownAfter = -1.0, missingAfter1s = 0, lowest = CGFloat.infinity, highest = -CGFloat.infinity, jump: CGFloat = 0, chunk = 0
    while Date().timeIntervalSince(start) < Double(chunks) * 0.1 + 1 {
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.03))
        let t = Date().timeIntervalSince(start)
        if chunk < chunks && t >= Double(chunk + 1) * 0.1 {
            chunk += 1
            messages[messages.count - 1] = message(reply, "assistant", String(repeating: paragraph, count: chunk))
            if chunk == cardsAt { cards = (0..<6).map { ["id": "\(name)-card-\($0)", "title": "Card \($0)", "detail": String(repeating: "Card detail that wraps. ", count: 12), "actions": []] } }
            push()
        }
        let reading = chat.bounds.height - chat.model.bottomInset
        let shown = [prompt, reply].contains { chat.model.messageFrames[$0].map { $0.maxY > 0 && $0.minY < reading } ?? false }
        if shown && shownAfter < 0 { shownAfter = t }
        if t > 1 && !shown { missingAfter1s += 1 }
        // Following only moves down: the largest move back up from the furthest offset so far.
        let now = offset()
        highest = max(highest, now); lowest = min(lowest, now); jump = max(jump, highest - now)
        samples += 1
    }
    if end { running = false; push() }
    spin(1.5)
    var settling = 0
    for _ in 0..<30 { spin(0.03); if chat.model.latestSettling { settling += 1 } }
    results.append(["case": name, "samples": samples, "shownAfter": shownAfter, "missingAfter1s": missingAfter1s, "lowestOffset": lowest,
                    "upJump": jump, "settlingAfterTurn": settling, "cards": cardsAt != nil])
}
/// The reporter's state (LKM-354): after a send in a long chat, no message row is measured in view
/// (no cards, questions or footer), as when the stack's frames belong to an earlier clip offset.
/// The model's frames are cleared every 4 ms, as each layout would restore them. The bounded
/// settles (3 of about 1.3 s each, jumping through the first row) must end: no settle for 0.3 s
/// within `cap` seconds (not a fixed time, so a slow runner only waits longer). For `after` more
/// seconds the settle must then stay ended and the clip put. Then the frames are released with
/// the next streamed chunk: the sent rows must be back in the reading area, the clip at the end.
var forcedResults: [[String: Any]] = []
func blankFrames(_ name: String, cap: Double = 20, after: Double = 1.5) {
    let prompt = "\(name)-prompt", reply = "\(name)-reply"
    messages += [message(prompt, "user", "Please review the text on the home page"), message(reply, "assistant", "")]
    running = true; push()
    let start = Date()
    var late = 0, settlingLate = 0, highest = -CGFloat.infinity, upJump: CGFloat = 0, upJumpAll: CGFloat = 0, highestAll = -CGFloat.infinity, next = 0.0
    var idleSince: Double?, endedAt: Double?
    while true {
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.004))
        chat.model.messageFrames = [:]
        let t = Date().timeIntervalSince(start)
        if let endedAt, t >= endedAt + after { break }
        if endedAt == nil && t >= cap { break }
        guard t >= next else { continue }
        next = t + 0.03
        let now = offset()
        if endedAt == nil {
            highestAll = max(highestAll, now); upJumpAll = max(upJumpAll, highestAll - now)
            if chat.model.latestSettling { idleSince = nil } else if let since = idleSince { if t - since >= 0.3 { endedAt = t } } else { idleSince = t }
        } else {
            late += 1
            if chat.model.latestSettling { settlingLate += 1 }
            highest = max(highest, now); upJump = max(upJump, highest - now)
        }
    }
    messages[messages.count - 1] = message(reply, "assistant", String(repeating: paragraph, count: 3))
    push(); spin(1.5)
    let reading = chat.bounds.height - chat.model.bottomInset
    let shown = [prompt, reply].contains { chat.model.messageFrames[$0].map { $0.maxY > 0 && $0.minY < reading } ?? false }
    let metrics = chat.conversationScroll.map(ChatScrollStyleProbe.metrics) ?? [:]
    let offsetNow = metrics["offset"] as? CGFloat ?? 0, maxOffset = metrics["maxOffset"] as? CGFloat ?? 0
    running = false; push(); spin(0.5)
    forcedResults.append(["case": name, "lateSamples": late, "settlingLate": settlingLate, "upJump": upJump, "upJumpDuringSettles": upJumpAll, "endedAfter": endedAt ?? -1,
                          "shownAfterRelease": shown, "offsetFromEnd": maxOffset - offsetNow])
}
open("new", []); spin(1); send("new")
open("short", history("short", 2)); spin(1); send("short")
open("long", history("long", 40)); spin(1.5); send("long")
// A chat switch, then restoring the long chat.
open("switch", history("switch", 3)); spin(0.5); send("switch")
open("long", history("long", 40)); spin(0.5); send("restore")
// Send while the previous turn still runs: the next prompt arrives mid-stream.
open("running", history("running", 6)); spin(1); send("running-first", chunks: 5, end: false); send("running")
// LKM-354: cards that fill the view after the reply report no message frame.
open("cards", history("cards", 2)); spin(1); send("cards", cardsAt: 3)
// The reporter's state: no row measured in view after a send, in a long chat and a short one.
open("blank-long", history("blank-long", 40)); spin(1.5); blankFrames("blank-long")
open("blank-short", history("blank-short", 2)); spin(1); blankFrames("blank-short")
print(String(data: try! JSONSerialization.data(withJSONObject: ["cases": results, "forced": forcedResults], options: [.sortedKeys]), encoding: .utf8)!)
exit(0)
