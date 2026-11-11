import AppKit

// LKM-627: Reply on selected chat text floats over the transcript, never inside the tight text
// view. A real window holds a stand-in for the chat (a flipped `ChatReplyHost` with a scroll
// view of message text views 20 pt apart, as the transcript lays them out, and a composer
// clearance at the bottom), the Reply button as a sibling above it as NativeChat adds it. The
// reported case is a wrapped two-line message between two others. Every failure is reported.
var failures = 0
func require(_ condition: Bool, _ message: String) {
    if !condition { fputs("FAIL: \(message)\n", stderr); failures += 1 }
}
final class KeyWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var isKeyWindow: Bool { true }
}
final class Flipped: NSView { override var isFlipped: Bool { true } }
final class Host: NSView, ChatReplyHost {
    let replyButton = ChatReplyButton()
    var messages: [String: ChatTextView] = [:]
    override var isFlipped: Bool { true }
    static let composer: CGFloat = 90
    var replyArea: NSRect { NSRect(x: 0, y: 0, width: bounds.width, height: bounds.height - Self.composer) }
    /// The other message rows, as NativeChat reports its message frames.
    func replyObstacles(excluding message: String) -> [NSRect] {
        messages.filter { $0.key != message }.map { convert($0.value.bounds, from: $0.value) }
    }
}
_ = NSApplication.shared
NSApp.setActivationPolicy(.accessory)
let width: CGFloat = 360, height: CGFloat = 440, column: CGFloat = 18
let window = KeyWindow(contentRect: NSRect(x: -4000, y: -4000, width: width, height: height), styleMask: [.titled], backing: .buffered, defer: false)
let stage = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
window.contentView = stage
let host = Host(frame: stage.bounds)
stage.addSubview(host)
stage.addSubview(host.replyButton, positioned: .above, relativeTo: host)
let scroll = NSScrollView(frame: host.bounds)
scroll.drawsBackground = false; scroll.hasVerticalScroller = false
let document = Flipped(frame: NSRect(x: 0, y: 0, width: width, height: 1400))
scroll.documentView = document
host.addSubview(scroll)
window.orderFront(nil)

func spin(_ seconds: Double) {
    let end = Date(timeIntervalSinceNow: seconds)
    while Date() < end { RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.01)) }
}
/// Polls `condition` for up to 2 s of run loop turns; no fixed wait decides a result.
@discardableResult func until(_ condition: () -> Bool) -> Bool {
    let start = Date()
    while !condition(), Date().timeIntervalSince(start) < 2 { spin(0.01) }
    return condition()
}
spin(0.3)

var replies: [(message: String, segment: Int?, excerpt: String)] = []
ChatTextView.reply = { replies.append(($0, $1, $2)); return true }

let tightSource = "Merged PR #182. The footer version is now **3.10.15** on `main`."
let tightText = "Merged PR #182. The footer version is now 3.10.15 on main."
var bottom: CGFloat = 18
func add(_ id: String, _ markdown: String, width: CGFloat = width - 2 * column) -> ChatTextView {
    let view = ChatTextView.make()
    view.show(markdown, streaming: false)
    let size = view.fittingSize(width: width)
    view.frame = NSRect(x: column, y: bottom, width: width, height: size.height)
    document.addSubview(view)
    view.identity = "\(id)#0"
    view.layout()
    host.messages[id] = view
    bottom = view.frame.maxY + 20
    return view
}
let previous = add("previous", "Checked the footer build on the release branch and the preview.\nDone.")
// The column narrows until the reported message wraps onto exactly two lines.
var tightWidth = width - 2 * column
while tightWidth > 120 {
    let probe = ChatTextView.make(); probe.show(tightSource, streaming: false)
    probe.frame = NSRect(x: 0, y: 0, width: tightWidth, height: probe.fittingSize(width: tightWidth).height); probe.layout()
    if probe.textLineRects().count == 2 { break }
    tightWidth -= 4
}
let tight = add("tight", tightSource, width: tightWidth)
let next = add("next", "Next I will tag the release once CI is green on every required check.")
require(tight.textLineRects().count == 2, "The reported message wraps onto two lines: \(tight.textLineRects())")
require(tight.bounds.height < 2 * 22, "The text view is exactly as tall as its two lines: \(tight.bounds)")

func topDown(_ rect: NSRect, from view: NSView) -> NSRect { host.convert(rect, from: view) }
/// Every line of text in the conversation, in the host's top-down space.
func allLines() -> [NSRect] { host.messages.values.flatMap { view in view.textLineRects().map { topDown($0, from: view) } } }
func buttonFrame() -> NSRect { topDown(host.replyButton.frame, from: stage) }
func select(_ view: ChatTextView, _ range: NSRange, stillSelecting: Bool = false) {
    window.makeFirstResponder(view)
    view.setSelectedRanges([NSValue(range: range)], affinity: .downstream, stillSelecting: stillSelecting)
}
func center() -> NSPoint { host.replyButton.convert(NSPoint(x: host.replyButton.bounds.midX, y: host.replyButton.bounds.midY), to: nil) }
/// Shown for `view`, foremost, inside the reading area and covering no line of text.
func requireClear(_ view: ChatTextView, _ what: String) {
    let button = host.replyButton, frame = buttonFrame()
    require(!button.isHidden && view.replyButton === button, "\(what): Reply shows for the selection")
    require(button.superview === stage && button.superview !== view, "\(what): Reply floats over the chat, not inside the text view")
    require(host.replyArea.contains(frame), "\(what): Reply \(frame) stays in the reading area \(host.replyArea)")
    let covered = allLines().filter { $0.intersects(frame) }
    require(covered.isEmpty, "\(what): Reply \(frame) covers no glyphs, but covers lines \(covered)")
    let hit = stage.hitTest(stage.superview?.convert(center(), from: nil) ?? center())
    require(hit === button, "\(what): the window hit-tests Reply at its centre, not \(hit.map { String(describing: type(of: $0)) } ?? "nothing")")
}

// 1. The reported case: all of the two-line message selected, as a drag ends.
let whole = NSRange(location: 0, length: (tight.string as NSString).length)
select(tight, whole, stillSelecting: true)
require(host.replyButton.isHidden, "No Reply while the drag is still selecting")
select(tight, whole)
require(tight.selectionLineRects().count == 2, "The selection spans both lines")
requireClear(tight, "Two-line message")
let selection = tight.selectionLineRects().map { topDown($0, from: tight) }
require(!selection.contains { $0.intersects(buttonFrame()) }, "Reply is not inline with the selected glyphs")
// The text view's own menu still leads with Reply.
let inside = tight.convert(NSPoint(x: selection[0].midX - column, y: tight.bounds.midY), to: nil)
let right = NSEvent.mouseEvent(with: .rightMouseDown, location: inside, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
require(tight.menu(for: right)?.items.first?.title == "Reply", "The context menu keeps Reply first")
// A real press: both events enter the app's queue and are dispatched as the run loop would
// (`NSApp.sendEvent`: the window hit-tests the press, the button's own tracking loop takes the
// release). Pumped here, since this fixture never calls `NSApp.run()`. Under load (CI runs this
// beside a heavy Swift compile) one fixed window can end before the queue hands both events
// over, so the pump runs until a local monitor has seen both posted events dequeued (by this
// loop or by the button's tracking loop) and the Reply has fired, bounded by a deadline; then
// it drains what is left so a duplicate Reply would still be counted.
func press() {
    window.makeKeyAndOrderFront(nil)
    until { window.isVisible }
    var delivered: Set<NSEvent.EventType> = []
    let monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp]) { event in
        if event.windowNumber == window.windowNumber { delivered.insert(event.type) }
        return event
    }
    defer { monitor.map(NSEvent.removeMonitor) }
    for (type, pressure) in [(NSEvent.EventType.leftMouseDown, Float(1)), (.leftMouseUp, 0)] {
        NSApp.postEvent(NSEvent.mouseEvent(with: type, location: center(), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: pressure)!, atStart: false)
    }
    let deadline = Date(timeIntervalSinceNow: 5)
    while !(delivered.count == 2 && replies.count == 1), Date() < deadline {
        if let event = NSApp.nextEvent(matching: .any, until: Date(timeIntervalSinceNow: 0.05), inMode: .default, dequeue: true) { NSApp.sendEvent(event) }
    }
    while let event = NSApp.nextEvent(matching: .any, until: Date(timeIntervalSinceNow: 0.1), inMode: .default, dequeue: true) { NSApp.sendEvent(event) }
    require(delivered.count == 2, "Both posted events reach the window: \(delivered.map(\.rawValue))")
}
press()
require(replies.count == 1, "One click, one Reply: \(replies.count)")
require(replies.first.map { $0.message == "tight" && $0.segment == 0 && $0.excerpt == tightText } == true,
        "The quote is the exact selection of the right message and segment: \(replies)")
require(tight.selectedRange().length == 0 && host.replyButton.isHidden, "Reply clears the selection and hides")

// 2. Another message's selection takes Reply over; the first selection is cleared.
select(tight, NSRange(location: 0, length: 6))
let part = (next.string as NSString).range(of: "tag the release")
select(next, part)
until { tight.selectedRange().length == 0 }
require(tight.selectedRange().length == 0 && tight.replyButton == nil, "One selection in the conversation at a time")
requireClear(next, "Another message")

// 3. Scrolling: out of view hides it, back in view shows it again, at the top edge it stays
//    in view and clear.
let clip = scroll.contentView
clip.scroll(to: NSPoint(x: 0, y: next.frame.maxY + 40)); scroll.reflectScrolledClipView(clip)
require(until { host.replyButton.isHidden }, "Scrolled out of view: Reply hides")
clip.scroll(to: .zero); scroll.reflectScrolledClipView(clip)
require(until { !host.replyButton.isHidden }, "Scrolled back: Reply shows again")
requireClear(next, "Scrolled back")
clip.scroll(to: NSPoint(x: 0, y: next.frame.minY - 2)); scroll.reflectScrolledClipView(clip)
until { !host.replyButton.isHidden && buttonFrame().minY >= 0 }
requireClear(next, "Selection at the top edge")
clip.scroll(to: .zero); scroll.reflectScrolledClipView(clip)
until { !host.replyButton.isHidden }

// 4. A cleared selection hides it; a chat switch (the view reused for another message, or
//    removed) leaves no Reply behind.
select(next, NSRange(location: 0, length: 0))
require(host.replyButton.isHidden, "A cleared selection hides Reply")
select(next, part)
require(!host.replyButton.isHidden, "Selected again")
next.identity = nil
require(host.replyButton.isHidden, "A reused view hides its Reply")
select(previous, NSRange(location: 0, length: 7))
require(!host.replyButton.isHidden, "Another selection shows Reply")
previous.removeFromSuperview()
require(host.replyButton.isHidden, "A view leaving the window hides its Reply")
replies = []
host.replyButton.refresh()
require(host.replyButton.isHidden && replies.isEmpty, "Nothing stale shows or replies after that")

if failures > 0 { exit(1) }
print("CHAT-REPLY-FLOAT PASS — Reply floats over the chat clear of every line (two-line tight message), is hit first, quotes the exact selection once, follows scrolling and leaves nothing stale")
