import AppKit
import SwiftUI

// LKM-453: the chat recovery acceptance's card locator (src/native/ChatRecoveryAcceptance.swift)
// on the real NativeChat, offscreen and never activated. Each case renders a conflict card,
// measures its buttons, then sends the acceptance's own click and Space events to the window
// (`sendEvent`: the posted queue needs the app's event loop) and records the chat actions the
// card emitted. Prints one JSON line per case; test/chat-recovery-acceptance.mjs judges them.
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

/// The conflict card as `chat-snapshot.ts` builds it; `busy` is the in-flight recovery.
/// `enabled` draws the busy card with its buttons enabled: the same layout, with every
/// button's real frame, to check the frames the locator derives for disabled ones.
func conflict(busy: String?, report: Bool = false, full: Bool = false, enabled: Bool = false) -> [String: Any] {
    let disabled = busy != nil && !enabled
    var actions: [[String: Any]] = [
        ["label": "Discard", "action": "discard", "disabled": disabled],
        ["label": busy == "retry" ? "Retrying…" : "Retry", "action": "landing-retry", "disabled": disabled],
        ["label": busy == "resolve" ? "Resolving…" : "Resolve", "action": "resolve", "disabled": disabled]
    ]
    if report { actions.append(["label": "Copy support report", "action": "recovery-report"]) }
    var card: [String: Any] = ["id": "conflict", "title": report ? "Problem" : "This turn’s changes didn’t land",
                               "detail": report ? "Problem: Fixture recovery failed" : "The project changed under them, so Trezi held them instead of overwriting.\nfixture.ts",
                               "busy": busy != nil, "actions": actions]
    if full { card["fullDetail"] = "/fixture/project/fixture.ts" }
    return card
}
func push(_ card: [String: Any]?, question: Bool = false) {
    let messages: [[String: Any]] = [["id": "m1", "role": "user", "text": "Change the heading", "segments": [["kind": "text", "text": "Change the heading"]], "at": 1_760_000_000_000.0],
                                     ["id": "m2", "role": "assistant", "text": "Done.", "segments": [["kind": "text", "text": "Done."]], "at": 1_760_000_000_000.0, "workedMs": 4000.0]]
    let questions: [[String: Any]] = question ? [["id": "q1", "sessionKey": "fixture", "questions": [["header": "Layout", "question": "Which layout?", "options": [["label": "Compact"], ["label": "Roomy"]], "multiSelect": false]]]] : []
    let state: [String: Any] = ["visible": true, "chat": "fixture", "messages": messages, "running": false, "cards": card.map { [$0] } ?? [], "questions": questions, "ready": true,
                                "bounds": ["x": 0.0, "y": 0.0, "width": Double(width), "height": Double(height)], "composer": ["text": ""]]
    chat.update(state, composer: composer)
    chat.model.pressLatest()
    spin(0.6)
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
push(conflict(busy: nil))
report("idle", ["click": press("Retry"), "key": press("Resolve", key: true),
                "keyboardNavigation": NSApp.isFullKeyboardAccessEnabled, "keyWindow": window.isKeyWindow])
// Each busy card follows the idle row it is derived from, then is drawn enabled for its real frames.
push(conflict(busy: "retry"))
report("busy-retry", ["click": press("Retrying…"), "discard": press("Discard"), "resolve": press("Resolve"), "key": press("Retrying…", key: true)])
push(nil)
push(conflict(busy: "retry", enabled: true))
report("busy-retry-drawn")
push(conflict(busy: nil))
_ = chat.recoveryCardButtons("conflict")
push(conflict(busy: "resolve"))
report("busy-resolve", ["click": press("Resolving…")])
push(nil)
push(conflict(busy: "resolve", enabled: true))
report("busy-resolve-drawn")
push(conflict(busy: nil, report: true, full: true))
report("problem", ["click": press("Retry")])
push(conflict(busy: "retry", report: true, full: true))
report("problem-busy", ["copy": press("Copy support report"), "click": press("Retrying…")])
push(nil)
push(conflict(busy: "retry", report: true, full: true, enabled: true))
report("problem-busy-drawn")
push(conflict(busy: nil), question: true)
report("question")
window.close()
