import AppKit
import Combine
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
/// LKM-357: the app's own Send moment, when `NativeChat.update` raises `sendRevision` for the new
/// message (`@Published` fires as it is set), so the harness's push and sampling are not timed.
var appSentAt: Date?
let sendWatch = chat.model.$sendRevision.dropFirst().sink { _ in appSentAt = Date() }
/// Sends while `running` may still be true (the previous turn), streams `chunks`
/// every 0.1 s, then ends the turn. `cardsAt`: the chunk at which cards that fill
/// the view arrive after the reply. Timing (LKM-357): `shownAfter` runs from the app's Send moment
/// to the first frames the conversation reports (`onPreferenceChange`, read through the
/// pass-through `messageFramesFilter`) with a sent row in the reading area, not to the harness's
/// next 30 ms sample (`sampledAfter`, from after the push). `sentAt` and `shownAt` are seconds after
/// the harness began the push. `missingTimes`: the samples, in seconds after the Send, with no sent row in view.
func send(_ name: String, cardsAt: Int? = nil, chunks: Int = 20, end: Bool = true) {
    let prompt = "\(name)-prompt", reply = "\(name)-reply"
    let reading = { chat.bounds.height - chat.model.bottomInset }
    let inView = { (frames: [String: CGRect]) in [prompt, reply].contains { frames[$0].map { $0.maxY > 0 && $0.minY < reading() } ?? false } }
    var shownAt: Date?
    chat.model.messageFramesFilter = { frames in
        if shownAt == nil && inView(frames) { shownAt = Date() }
        return frames
    }
    messages += [message(prompt, "user", "Please review the text on the home page"), message(reply, "assistant", "")]
    appSentAt = nil
    let pushedAt = Date()
    running = true; push()
    let start = Date(), sentAt = appSentAt ?? pushedAt
    var samples = 0, sampledAfter = -1.0, missingTimes: [Double] = [], lowest = CGFloat.infinity, highest = -CGFloat.infinity, jump: CGFloat = 0, chunk = 0
    while Date().timeIntervalSince(start) < Double(chunks) * 0.1 + 1 {
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.03))
        let t = Date().timeIntervalSince(start)
        if chunk < chunks && t >= Double(chunk + 1) * 0.1 {
            chunk += 1
            messages[messages.count - 1] = message(reply, "assistant", String(repeating: paragraph, count: chunk))
            if chunk == cardsAt { cards = (0..<6).map { ["id": "\(name)-card-\($0)", "title": "Card \($0)", "detail": String(repeating: "Card detail that wraps. ", count: 12), "actions": []] } }
            push()
        }
        let shown = inView(chat.model.messageFrames)
        if shown && sampledAfter < 0 { sampledAfter = t }
        if !shown { missingTimes.append(Date().timeIntervalSince(sentAt)) }
        // Following only moves down: the largest move back up from the furthest offset so far.
        let now = offset()
        highest = max(highest, now); lowest = min(lowest, now); jump = max(jump, highest - now)
        samples += 1
    }
    chat.model.messageFramesFilter = nil
    if end { running = false; push() }
    spin(1.5)
    var settling = 0
    for _ in 0..<30 { spin(0.03); if chat.model.latestSettling { settling += 1 } }
    results.append(["case": name, "samples": samples, "appSend": appSentAt != nil, "sentAt": sentAt.timeIntervalSince(pushedAt),
                    "shownAt": shownAt.map { $0.timeIntervalSince(pushedAt) } ?? -1, "shownAfter": shownAt.map { $0.timeIntervalSince(sentAt) } ?? -1,
                    "sampledAfter": sampledAfter, "missingTimes": missingTimes, "lowestOffset": lowest,
                    "upJump": jump, "settlingAfterTurn": settling, "cards": cardsAt != nil])
}
/// The reporter's state (LKM-354): after a send in a long chat, no message row is measured in view
/// (no cards, questions or footer), as when the stack's frames belong to an earlier clip offset.
/// The model drops every measured frame (`messageFramesFilter`). Clearing them from here every
/// 4 ms let a layout's frames through to a settle step now and then, a settled reading that
/// restarted the bounded settles at random (the CI failure). `leaks`: the first two frame reports
/// after each realize scroll get through, then the frames are lost again, at the latest when that
/// settle ends (LKM-365: not the 60 ms after it, a time that a stalled run stretched into the next
/// settle, whose real settled reading rightly started the count again). The bounded settles (3 of about
/// 1.3 s each, jumping through the first row) must end. Ended (LKM-365) is the app's own signal, not
/// a quiet time: more unresolved settles in a row than `ChatLatestSettle.unresolvedRestarts`
/// (`latestUnresolved`), after which no settle may realize until a request resets the count. A
/// quiet window was not enough: on the loaded 1-shard main CI, stream-long had no realize for 1.5 s
/// and 150 turns mid-bound, read as ended, and the rest of its 240 realize scrolls then counted as a
/// restart. `quietAt`: when that old window would have ended the run (diagnostics only). For
/// `after` more seconds and at least `lateMin` samples the settle must then stay ended, with no
/// realize scroll, and the clip put. Then the frames are released with the next streamed chunk: the
/// sent rows must be back in the reading area, the clip at the end.
/// `stream`: the reply also keeps streaming a chunk every 0.1 s, as `send` does, so every chunk is
/// a content request for the settle (the whole turn, in the reporter's video). Those settles only
/// pin past the bound, so `settlingLate` is not counted. Moves up are read at every turn, so a jump
/// of a few frames is not missed.
/// `bound` (LKM-359): the run stops unended once more realize scrolls than this ran, instead of at a
/// fixed time. The bound is in settle steps (3 settles of up to 80 realize), and once a turn of the
/// main thread takes longer than a step's 16 ms, every step needs a turn of its own, so a loaded
/// runner only takes longer. `cap` only stops a run that hangs.
/// Last the frames are still dropped when a second message is sent: `realizedOnSend` is the time
/// until the first realize scroll after it, -1 when its settles spent the bound again with none (or
/// a hung 20 s passed; it reads 0.01–0.2 s). Not a 1 s window (LKM-365): a stall can pass a time.
/// `timeline` (LKM-365): settle ends, realize scrolls and moves up, in seconds after the Send, so a
/// failure can be read from the CI log alone.
var forcedResults: [[String: Any]] = []
func blankFrames(_ name: String, cap: Double = 90, after: Double = 1.5, lateMin: Int = 30, stream: Bool = false, leaks: Bool = false, bound: Int = 240) {
    let prompt = "\(name)-prompt", reply = "\(name)-reply"
    var seen = chat.model.latestRealizes, leakSettle = -1, leakReports = 0
    chat.model.messageFramesFilter = { frames in
        if chat.model.latestRealizes != seen { seen = chat.model.latestRealizes; leakSettle = chat.model.latestSettles; leakReports = 0 }
        leakReports += 1
        return leaks && chat.model.latestSettling && chat.model.latestSettles == leakSettle && leakReports <= 2 ? frames : [:]
    }
    chat.model.messageFrames = [:]
    messages += [message(prompt, "user", "Please review the text on the home page"), message(reply, "assistant", "")]
    running = true; push()
    let start = Date(), realizesBefore = chat.model.latestRealizes, settlesBefore = chat.model.latestSettles
    var late = 0, settlingLate = 0, highest = -CGFloat.infinity, upJump: CGFloat = 0, upJumpAll: CGFloat = 0, highestAll = -CGFloat.infinity, next = 0.0
    var endedAt: Double?, chunk = 0, realizes = realizesBefore, realizedAt = 0.0, quietTurns = 0, settlesRun = 0, quietAt: Double?
    var seenRealizes = realizesBefore, seenSettles = settlesBefore, lastOffset: CGFloat?
    var settleEnds: [[Double]] = [], realizeTimes: [Double] = [], lateRealizes: [[Double]] = [], lateMoves: [[Double]] = []
    let spent = { chat.model.latestUnresolved > ChatLatestSettle.unresolvedRestarts }
    func round(_ value: Double) -> Double { (value * 1000).rounded() / 1000 }
    func streamChunk(_ t: Double) {
        guard stream, t >= Double(chunk + 1) * 0.1 else { return }
        chunk += 1
        messages[messages.count - 1] = message(reply, "assistant", String(repeating: paragraph, count: 1 + min(chunk, 10)) + "(\(chunk))")
        push()
    }
    while true {
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.004))
        let t = Date().timeIntervalSince(start)
        streamChunk(t)
        if let endedAt, t >= endedAt + after && late >= lateMin { break }
        if endedAt == nil && t >= cap { break }
        let now = offset()
        // Timeline: each settle's end with the realize scrolls so far and the unresolved count, each
        // realize scroll, and after the end every move back up.
        if chat.model.latestSettles != seenSettles {
            seenSettles = chat.model.latestSettles
            if leaks { chat.model.messageFrames = [:] }
            settleEnds.append([round(t), Double(chat.model.latestRealizes - realizesBefore), Double(chat.model.latestUnresolved)])
        }
        if chat.model.latestRealizes != seenRealizes {
            seenRealizes = chat.model.latestRealizes
            if endedAt == nil { realizeTimes.append(round(t)) } else { lateRealizes.append([round(t), Double(seenRealizes - realizes), Double(now)]) }
        }
        if endedAt != nil, let lastOffset, lastOffset - now > 1 { lateMoves.append([round(t), Double(lastOffset - now)]) }
        lastOffset = now
        if endedAt == nil {
            settlesRun = chat.model.latestSettles - settlesBefore
            highestAll = max(highestAll, now); upJumpAll = max(upJumpAll, highestAll - now)
            if chat.model.latestRealizes != realizes { realizes = chat.model.latestRealizes; realizedAt = t; quietTurns = 0 } else { quietTurns += 1 }
            if quietAt == nil && t - realizedAt >= 1.5 && quietTurns >= 150 { quietAt = t }
            if realizes - realizesBefore > bound { break }
            if spent() { endedAt = t; next = t }
        } else {
            highest = max(highest, now); upJump = max(upJump, highest - now)
        }
        guard endedAt != nil, t >= next else { continue }
        next = t + 0.03
        late += 1
        if chat.model.latestSettling && !stream { settlingLate += 1 }
    }
    let realizesLate = chat.model.latestRealizes - realizes
    // Send again while the frames are still dropped and the bound is spent: a new message is not a
    // streamed chunk, so the follow must be allowed to realize again (the count starts over). Until
    // a realize scroll, or the Send's own settles spent the bound again without one.
    let again = "\(name)-again", againReply = "\(name)-again-reply", realizesBeforeAgain = chat.model.latestRealizes
    messages += [message(again, "user", "Please review the text on the home page again"), message(againReply, "assistant", "")]
    push()
    var realizedOnSend = -1.0, resetOnSend = false
    let sentAt = Date()
    while Date().timeIntervalSince(sentAt) < 20 {
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.004))
        if chat.model.latestRealizes != realizesBeforeAgain { realizedOnSend = Date().timeIntervalSince(sentAt); break }
        if !spent() { resetOnSend = true } else if resetOnSend { break }
    }
    chat.model.messageFramesFilter = nil
    messages[messages.count - 1] = message(againReply, "assistant", String(repeating: paragraph, count: 3))
    push(); spin(1.5)
    let reading = chat.bounds.height - chat.model.bottomInset
    let shown = [prompt, reply, again, againReply].contains { chat.model.messageFrames[$0].map { $0.maxY > 0 && $0.minY < reading } ?? false }
    let metrics = chat.conversationScroll.map(ChatScrollStyleProbe.metrics) ?? [:]
    let offsetNow = metrics["offset"] as? CGFloat ?? 0, maxOffset = metrics["maxOffset"] as? CGFloat ?? 0
    running = false; push(); spin(0.5)
    forcedResults.append(["case": name, "lateSamples": late, "settlingLate": settlingLate, "upJump": upJump, "upJumpDuringSettles": upJumpAll, "endedAfter": endedAt ?? -1, "streamed": stream,
                          "realizes": realizes - realizesBefore, "settles": settlesRun, "realizesLate": realizesLate, "realizedOnSend": realizedOnSend,
                          "shownAfterRelease": shown, "offsetFromEnd": maxOffset - offsetNow, "quietAt": quietAt ?? -1,
                          "timeline": ["settleEnds": settleEnds, "realizeTimes": realizeTimes, "lateRealizes": lateRealizes, "lateMoves": lateMoves]])
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
// The same while the reply streams: every chunk is a content request for the settle. 240 realize scrolls
// at most (the test's bound): more stop the run unended; fewer must end however slow the runner.
open("stream-long", history("stream-long", 40)); spin(1.5); blankFrames("stream-long", after: 3, lateMin: 20, stream: true)
open("stream-short", history("stream-short", 2)); spin(1); blankFrames("stream-short", after: 3, lateMin: 20, stream: true)
// Rows measured for a moment after each realize, then lost again: those settled readings must not restart the settles.
open("leak-stream", history("leak-stream", 40)); spin(1.5); blankFrames("leak-stream", after: 3, lateMin: 20, stream: true, leaks: true)
print(String(data: try! JSONSerialization.data(withJSONObject: ["cases": results, "forced": forcedResults], options: [.sortedKeys]), encoding: .utf8)!)
exit(0)
