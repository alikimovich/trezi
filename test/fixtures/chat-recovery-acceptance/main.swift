import AppKit
import SwiftUI

// LKM-453: the chat recovery acceptance's card locator (src/native/ChatRecoveryAcceptance.swift)
// on the real NativeChat, offscreen and never activated. Each case renders a conflict card,
// measures its buttons, then sends the acceptance's own click and Space events to the window
// (`sendEvent`: the posted queue needs the app's event loop) and records the chat actions the
// card emitted. Prints one JSON line per case; test/chat-recovery-acceptance.mjs judges them.
// Its first argument (LKM-458) holds the parked and busy cards of the real chat controller.
var emitted: [String] = []
func emit(_ value: [String: Any]) {
    if value["event"] as? String == "chat-action" { emitted.append(value["action"] as? String ?? "") }
}
func copyChatText(_ value: String) {}
func captureVisibleRegion(window: NSWindow, view: NSView, region: NSRect, recognize: Bool = true) async throws -> [String: Any] { [:] }
final class Host { var window: NSWindow!; let chat = NativeChat() }

_ = NSApplication.shared
NSApp.setActivationPolicy(.accessory)
let width: CGFloat = 440, height: CGFloat = 640
let window = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: width, height: height), styleMask: [.titled], backing: .buffered, defer: false)
window.isReleasedWhenClosed = false
let root = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
window.contentView = root
let chat = NativeChat()
let composer = NativeComposer(frame: .zero)
root.addSubview(chat); root.addSubview(composer)
chat.frame = root.bounds
window.orderFront(nil)
func spin(_ seconds: Double) {
    let end = Date(timeIntervalSinceNow: seconds)
    while Date() < end { RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.016)) }
}
func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap { descendants($0) } }

/// The held card as `held-card.ts` builds it (LKM-590): `kind` "moved" offers Combine,
/// "failed" offers Try applying again; `busy` is the in-flight recovery, with no row.
func conflict(kind: String = "moved", busy: String? = nil, report: Bool = false, full: Bool = false) -> [String: Any] {
    let combine: [String: Any] = ["label": "Combine with project edits", "action": "resolve"]
    let retry: [String: Any] = ["label": "Try applying again", "action": "landing-retry"]
    var card: [String: Any] = ["id": "conflict", "busy": busy != nil]
    if let busy {
        card["title"] = busy == "retry" ? "Trying to apply again…" : "Combining with project edits…"
        card["detail"] = "Trezi is working on the held changes. Nothing is needed from you yet."
        card["actions"] = [] as [[String: Any]]
        return card
    }
    var primary = kind == "failed" ? retry : combine
    primary["role"] = "primary"
    var menu: [[String: Any]] = report ? [["label": "Copy support report", "action": "recovery-report"]] : []
    menu.append(kind == "failed" ? combine : retry)
    menu.append(["label": "Discard held changes…", "action": "discard-ask"])
    card["title"] = report ? "Problem" : kind == "failed" ? "Changes couldn’t be applied" : "This turn’s changes didn’t land"
    card["detail"] = report ? "Problem: Fixture recovery failed" : "The project changed under them, so Trezi held them instead of overwriting.\nfixture.ts"
    card["hint"] = "Combine with project edits merges them with the newer edits and applies the result."
    card["actions"] = [primary]
    card["menu"] = menu
    if full { card["fullDetail"] = "/fixture/project/fixture.ts" }
    return card
}
/// `tall`: enough turns that the conversation scrolls and the card sits at its pinned end.
func push(_ card: [String: Any]?, question: Bool = false, chatId: String = "fixture", tall: Bool = false) {
    var messages: [[String: Any]] = [["id": "m1", "role": "user", "text": "Change the heading", "segments": [["kind": "text", "text": "Change the heading"]], "at": 1_760_000_000_000.0],
                                     ["id": "m2", "role": "assistant", "text": "Done.", "segments": [["kind": "text", "text": "Done."]], "at": 1_760_000_000_000.0, "workedMs": 4000.0]]
    if tall {
        let text = "Changed the heading and the spacing around it, then checked the page again."
        messages = (0..<16).map { ["id": "t\($0)", "role": $0 % 2 == 0 ? "user" : "assistant", "text": text, "segments": [["kind": "text", "text": text]], "at": 1_760_000_000_000.0] } + messages
    }
    let questions: [[String: Any]] = question ? [["id": "q1", "sessionKey": "fixture", "questions": [["header": "Layout", "question": "Which layout?", "options": [["label": "Compact"], ["label": "Roomy"]], "multiSelect": false]]]] : []
    let state: [String: Any] = ["visible": true, "chat": chatId, "messages": messages, "running": false, "cards": card.map { [$0] } ?? [], "questions": questions, "ready": true,
                                "bounds": ["x": 0.0, "y": 0.0, "width": Double(width), "height": Double(height)], "composer": ["text": ""]]
    chat.update(state, composer: composer)
    chat.model.pressLatest()
    spin(0.6)
    if tall {
        // Switching to a tall lazy stack can finish laying out after the first
        // latest request. Re-request the pinned end once those rows exist.
        chat.model.pressLatest()
        spin(0.6)
    }
}
/// Sends the acceptance's events for `label` (a click, or focus then Space) and returns what the card emitted.
func press(_ label: String, key: Bool = false) -> [String: Any] {
    emitted = []
    guard let target = chat.recoveryCardButtons("conflict").buttons.first(where: { $0.label == label }) else { return ["found": false] }
    var result: [String: Any] = ["found": true]
    if key {
        guard let proxy = target.proxy else { return ["found": true, "focusable": false] }
        result["focused"] = window.makeFirstResponder(proxy) && window.firstResponder === proxy
        // As the host step does: SwiftUI's focus follows the first responder on later turns.
        spin(0.25)
        for event in NativeChat.recoverySpace(in: window) { window.sendEvent(event) }
    } else {
        for event in NativeChat.recoveryClick(at: target.center, in: window) { window.sendEvent(event) }
    }
    spin(0.3)
    result["emitted"] = emitted
    _ = window.makeFirstResponder(nil)
    return result
}
func report(_ name: String, _ extra: [String: Any] = [:]) {
    var line = chat.recoveryMeasure("conflict")
    line["case"] = name
    line["types"] = Dictionary(grouping: descendants(chat).map { String(describing: type(of: $0)) }, by: { $0 }).mapValues(\.count)
        .filter { $0.key.contains("Proxy") || $0.key.contains("Progress") || $0.key.contains("Button") }
    line.merge(extra) { _, new in new }
    print(String(data: try! JSONSerialization.data(withJSONObject: line), encoding: .utf8)!)
}

window.makeKey()
push(conflict())
report("idle", ["click": press("Combine with project edits"), "key": press("Combine with project edits", key: true),
                "keyboardNavigation": NSApp.isFullKeyboardAccessEnabled, "keyWindow": window.isKeyWindow])
push(conflict(kind: "failed"))
report("failed", ["click": press("Try applying again")])
push(conflict(busy: "retry"))
report("busy-retry")
push(conflict(busy: "resolve"))
report("busy-resolve")
push(conflict(report: true, full: true))
report("problem", ["click": press("Combine with project edits")])
push(conflict(), question: true)
report("question")

// The cards the real controller draws (test/chat-recovery-acceptance.mjs passes them as
// JSON): the parked card with its report, and the busy card of each held request.
let real = CommandLine.arguments.count > 1
    ? (try? JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8))) as? [String: [String: Any]] ?? [:] : [:]
for (name, key, tall) in [("real-parked", "parked", false), ("real-retry", "busyRetry", false), ("real-resolve", "busyResolve", false),
                          ("real-parked-tall", "parked", true)] {
    guard let card = real[key] else { continue }
    push(card, chatId: name, tall: tall)
    report(name)
}
window.close()
