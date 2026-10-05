import AppKit
import SwiftUI

// No desktop input and no visible window (input routing uses one offscreen
// window that is never ordered in). These bridge/clipboard
// callbacks are irrelevant to the real composer's synchronous layout path.
func emit(_ value: [String: Any]) {}
func copyChatText(_ value: String) {}

func require(_ condition: Bool, _ message: String) {
    if !condition { fputs("FAIL: \(message)\n", stderr); exit(1) }
}
let composer = NativeComposer(frame: .zero)
let longDraft = Array(repeating: "A long draft line", count: 80).joined(separator: "\n")
let wrappedDraft = String(repeating: "wrap text ", count: 20)
for width: CGFloat in [420, 320, 520] {
    for value in ["", longDraft, wrappedDraft, longDraft, "Short", "", "Line\nLine\n"] {
        composer.perform(["text": value])
        let height = composer.preferredHeight(for: value, width: width, availableHeight: 776, hasContext: false)
        // Resolve the real viewport through Auto Layout, without a window.
        composer.setFrameSize(NSSize(width: width, height: height))
        composer.layoutSubtreeIfNeeded()
        // The smoke sequence captures the expanded draft before replacing it.
        // Resolve that preceding paint without drawing or creating a window.
        if value == longDraft { composer.text.sizeToFit() }
        let viewport = composer.scroll.contentSize.height
        let document = composer.text.frame.height
        if value == longDraft {
            require(height == 368, "Long draft reaches the cap")
            require(document > viewport + 100, "Capped draft retains scrollable content")
        } else {
            require(height < 368, "Short draft remains below the cap")
            require(document <= viewport + 1, "Replacement draft fits without waiting for paint (width \(width), document \(document), viewport \(viewport))")
            if !value.isEmpty {
                let manager = composer.text.layoutManager!
                let container = composer.text.textContainer!
                manager.ensureLayout(for: container)
                let used = max(manager.usedRect(for: container).maxY, manager.extraLineFragmentRect.maxY)
                require(used + composer.text.textContainerInset.height * 2 <= document + 1, "Document includes all lines and trailing caret")
            }
        }
    }
}
print("Composer layout: capped replacement, wrapping, width changes, empty and trailing newline passed without a window")

// Mirror the native smoke drafts so a desktop timeout cannot hide a fixture
// that no longer exceeds the minimum-height form's available text space.
let growthDraft = Array(repeating: "A line of draft text", count: 9).joined(separator: "\n") + "\n"
let smokeWrappedDraft = String(repeating: "wrap text ", count: 40)
for width: CGFloat in [320, 420, 520] {
    func height(_ value: String) -> CGFloat {
        composer.preferredHeight(for: value, width: width, availableHeight: 776, hasContext: false)
    }
    let compact = height("")
    let grown = height(growthDraft)
    let capped = height(longDraft)
    let wrapped = height(smokeWrappedDraft)
    print("Smoke draft heights at \(width): compact=\(compact), grown=\(grown), capped=\(capped), wrapped=\(wrapped)")
    require(grown > compact + 60, "Smoke multiline fixture grows by more than 60pt")
    require(capped > grown && capped <= 368, "Smoke long fixture grows further to the cap")
    require(wrapped > compact && wrapped < capped, "Smoke wrapped fixture grows but stays below the cap")
    for value in [growthDraft, longDraft, smokeWrappedDraft, ""] {
        composer.perform(["text": value])
        composer.setFrameSize(NSSize(width: width, height: height(value)))
        composer.layoutSubtreeIfNeeded()
        let viewport = composer.scroll.contentSize.height
        let document = composer.text.frame.height
        if value == longDraft {
            require(document > viewport + 100, "Smoke capped draft remains scrollable")
        } else {
            require(document <= viewport + 1, "Smoke uncapped draft fits its actual viewport")
        }
    }
}

// Start fresh and use the bridge update path, including the preceding capped paint.
for style in [NSScroller.Style.overlay, .legacy] {
    for width: Double in [320, 420, 520] {
        let live = NativeComposer(frame: .zero)
        live.scroll.scrollerStyle = style
        live.text.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        live.text.unmarkText(); live.text.string = ""
        for value in ["", growthDraft, longDraft, smokeWrappedDraft, ""] {
            let height = live.preferredHeight(for: value, width: width, availableHeight: 776, hasContext: false)
            live.update(["visible": true, "text": value, "bounds": ["x": 10.0, "y": 776 - Double(height), "width": width, "height": Double(height)]])
            live.layoutSubtreeIfNeeded()
            if value == longDraft { live.text.sizeToFit() }
            if value != longDraft {
                require(live.text.frame.height <= live.scroll.contentSize.height + 1, "Bridge uncapped document fits (style \(style.rawValue), width \(width), document \(live.text.frame.height), viewport \(live.scroll.contentSize.height))")
            }
        }
    }
}
print("Bridge sizing: overlay/legacy scrollers, IME, capped-to-wrapped replacements and empty reset passed at 320/420/520pt")

// Mirror the foreground matrix (smoke-composer.ts): its multiline draft must
// grow past the minimum form at the normal/narrow chat widths it resizes to.
let matrixMultiline = ["First", "Second", "Third", "Fourth", "Fifth"].map { "\($0) composer line" }.joined(separator: "\n")
for chatWidth: CGFloat in [440, 320] {
    let width = chatWidth - 2 * ChatLayout.composerInset
    for available: CGFloat in [500, 766] {
        let compact = composer.preferredHeight(for: "", width: width, availableHeight: available, hasContext: false)
        let multiline = composer.preferredHeight(for: matrixMultiline, width: width, availableHeight: available, hasContext: false)
        require(multiline > compact, "Matrix multiline draft grows the composer at chat width \(chatWidth): \(compact) -> \(multiline)")
        composer.perform(["text": matrixMultiline])
        composer.setFrameSize(NSSize(width: width, height: multiline))
        composer.layoutSubtreeIfNeeded()
        require(composer.text.frame.height <= composer.scroll.contentSize.height + 1, "Matrix multiline draft fits at chat width \(chatWidth)")
        require(composer.verificationLayout()["alignment"] as? Bool == true, "Matrix multiline keeps the shared row at chat width \(chatWidth)")
    }
}
composer.perform(["text": ""])
print("Foreground matrix mirror: five-line draft grows, fits and keeps the row at 440/320pt chat widths")

// Shrink after submit: the submitted draft clears, so the composer returns to its
// compact height with the shared row intact and the frame anchored to the bottom
// gap. The reading inset and pin that follow it are LKM-103's (chat follow layout, below).
for chatWidth: CGFloat in [440, 320] {
    let bounds = CGRect(x: 0, y: 0, width: chatWidth, height: 776)
    let width = chatWidth - 2 * ChatLayout.composerInset
    // 80 lines is the narrow-width foreground draft; 5 the normal-width one.
    for draft in [matrixMultiline, longDraft] {
        var heights: [CGFloat] = []
        for value in [draft, ""] {
            let height = composer.preferredHeight(for: value, width: width, availableHeight: bounds.height - ChatLayout.composerInset, hasContext: false)
            composer.update(["bounds": ChatLayout.composerBounds(in: bounds, height: height), "visible": false, "text": value])
            composer.layoutSubtreeIfNeeded()
            require(composer.frame == ChatLayout.composerFrame(in: bounds, height: height), "Composer applies the \(value.isEmpty ? "compact" : "drafted") frame at chat width \(chatWidth)")
            require(composer.verificationLayout()["alignment"] as? Bool == true, "Row stays aligned while shrinking at chat width \(chatWidth)")
            heights.append(height)
        }
        require(heights[1] < heights[0], "Composer shrinks after the draft clears at chat width \(chatWidth): \(heights)")
        require(bounds.maxY - composer.frame.maxY == ChatLayout.composerInset, "Compact composer keeps its bottom gap at chat width \(chatWidth)")
        require(composer.text.frame.height <= composer.scroll.contentSize.height + 1, "Cleared input fits its compact viewport at chat width \(chatWidth)")
    }
}
print("Shrink after submit: compact height, shared row and bottom anchor settle at 440/320pt chat widths")

// Resolve the actual Auto Layout tree without opening an application/window.
// Borderless popup frames overlap by one point at four-point stack spacing;
// their alignment rectangles remain correctly separated.
for width: CGFloat in [240, 320, 420, 520] {
    for value in ["", "First line\nSecond line\n", longDraft] {
        composer.perform(["text": value])
        let height = composer.preferredHeight(for: value, width: width, availableHeight: 776, hasContext: false)
        composer.setFrameSize(NSSize(width: width, height: height))
        composer.layoutSubtreeIfNeeded()
        let geometry = composer.verificationLayout()
        require(geometry["alignment"] as? Bool == true, "Ordered control alignment at width \(width): \(geometry)")
        require(geometry["contained"] as? Bool == true, "Input and controls inside bubble")
        require((geometry["bottomInset"] as? CGFloat ?? 0) >= 7, "Bubble extends below controls")
        require(composer.controls.arrangedSubviews.contains(composer.sendButton), "Send shares the control row")
        require(composer.pickers.values.allSatisfy { !$0.isHidden && $0.frame.width >= 35 }, "Selectors remain usable at narrow widths")
    }
}
// Send must sit on the shared row. A raised (floating) Send fails alignment.
composer.perform(["text": ""])
composer.setFrameSize(NSSize(width: 420, height: 148))
composer.layoutSubtreeIfNeeded()
require(composer.verificationLayout()["alignment"] as? Bool == true, "Send shares the centered row before it is moved")
let rowSendFrame = composer.sendButton.frame
composer.sendButton.setFrameOrigin(NSPoint(x: rowSendFrame.minX, y: rowSendFrame.minY + 18))
require(composer.verificationLayout()["alignment"] as? Bool == false, "Raised Send must fail row alignment")
composer.sendButton.frame = rowSendFrame
let model = composer.pickers["Model"]!
let permission = composer.pickers["Permission mode"]!
let oldFrame = permission.frame
permission.setFrameOrigin(model.frame.origin)
require(composer.verificationLayout()["alignment"] as? Bool == false, "Overlapping alignment rectangles must fail")
permission.frame = oldFrame
let provider = composer.pickers["Provider"]!
let oldProviderFrame = provider.frame
provider.setFrameOrigin(composer.plus.frame.origin)
require(composer.verificationLayout()["alignment"] as? Bool == false, "Attachment/provider overlap must fail")
provider.frame = oldProviderFrame
print("Composer alignment: AppKit insets, all control gaps, containment and rejected overlaps passed without a window")

// Exterior spacing and reading clearance share the same inset, including when
// TextKit expands/caps the composer at narrow widths or with attachments/queue.
for width: CGFloat in [320, 420, 520] {
    for value in ["", wrappedDraft, longDraft] {
        for available: CGFloat in [400, 776] {
            let bounds = CGRect(x: 37, y: 21, width: width, height: available)
            let height = composer.preferredHeight(for: value, width: width - 2 * ChatLayout.composerInset,
                availableHeight: available - ChatLayout.composerInset, hasContext: true,
                hasAttachments: true, queueHeight: 44)
            let frame = ChatLayout.composerFrame(in: bounds, height: height)
            // Exercise the in-process Any dictionary consumed by update. A
            // CGFloat dictionary does not cast to its required Double schema.
            composer.setFrameSize(.zero)
            composer.update(["bounds": ChatLayout.composerBounds(in: bounds, height: height),
                             "visible": false, "text": value])
            require(composer.frame == frame, "Composer update applies bounds rather than retaining a zero/stale frame")
            composer.layoutSubtreeIfNeeded()
            require(composer.content.bounds.width > 0 && composer.content.bounds.height > 0,
                "Composer bubble has nonempty capture geometry")
            let bottomGap = bounds.maxY - frame.maxY
            require(bottomGap == frame.minX - bounds.minX, "Bottom matches left exterior gap")
            require(bottomGap == bounds.maxX - frame.maxX, "Bottom matches right exterior gap")
            require(bounds.contains(frame), "Growing composer stays within chat bounds")
            let readingBottom = bounds.maxY - ChatLayout.bottomInset(composerHeight: height)
            require(readingBottom + ChatLayout.latestClearance + 40 == frame.minY,
                "Follow target clears the latest button and composer at every draft height")
        }
    }
}
// Native policy changes preserve scroll position/document and native controls.
let conversation = NSScrollView(frame: CGRect(x: 0, y: 0, width: 420, height: 600))
conversation.hasVerticalScroller = true
let document = NSView(frame: CGRect(x: 0, y: 0, width: 400, height: 2000))
conversation.documentView = document
conversation.contentView.scroll(to: NSPoint(x: 0, y: 150))
for style: NSScroller.Style in [.overlay, .legacy, .overlay] {
    let origin = conversation.contentView.bounds.origin
    ChatScrollStyleProbe.configure(conversation, style: style)
    require(conversation.scrollerStyle == style, "Uses requested system scroller style")
    require(conversation.autohidesScrollers == (style == .overlay), "Always-show remains visible")
    require(conversation.verticalScroller?.controlSize == .small, "Conversation uses small native scroller")
    require(conversation.documentView === document, "Preserves the SwiftUI document")
    require(conversation.contentView.bounds.origin == origin, "Style updates preserve scroll position")
    let size = conversation.contentSize
    ChatScrollStyleProbe.configure(conversation, style: style)
    require(conversation.contentSize == size, "Repeated configuration does not change layout")
}
print("Chat spacing and native scroller policy passed without a window")

// Replay the manager's exact one-line -> six-line document geometry without
// a window. A request against the old bounds cannot reach the new reading end.
final class FlippedDocument: NSView { override var isFlipped: Bool { true } }
/// 0.2 s of main loop, then on until `done` holds (at most 5 s): a loaded machine
/// can starve the fixed window before the main-queue pin runs (LKM-167).
func drainLayout(until done: () -> Bool = { true }) {
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.2))
    let deadline = Date(timeIntervalSinceNow: 5)
    while !done() && Date() < deadline { RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.01)) }
}
func distanceFromEnd(_ scroll: NSScrollView) -> CGFloat {
    scroll.documentView!.frame.maxY - scroll.contentView.bounds.maxY
}
let growingScroll = NSScrollView(frame: CGRect(x: 0, y: 0, width: 427, height: 776))
let growingDocument = FlippedDocument(frame: CGRect(x: 0, y: 0, width: 427, height: 7413))
growingScroll.documentView = growingDocument
let probe = ChatScrollStyleProbe(frame: .zero)
growingDocument.addSubview(probe)
ChatScrollStyleProbe.pinToEnd(growingScroll)
let oldOffset = growingScroll.contentView.bounds.minY
growingDocument.setFrameSize(NSSize(width: 427, height: 7496))
require(growingScroll.contentView.bounds.minY == oldOffset, "Document growth alone leaves the old scroll offset")
require(distanceFromEnd(growingScroll) >= 83,
    "Reproduces manager failure: 83 points of new clearance remain below the viewport")
var following = true
probe.follows = { following }
probe.scheduleConfiguration()
drainLayout(until: { distanceFromEnd(growingScroll) < 1 })
require(distanceFromEnd(growingScroll) < 1,
    "Settled layout pin reaches new bottom: pins \(probe.pinCount), clip \(growingScroll.contentView.bounds), doc \(growingDocument.frame), attached \(probe.enclosingScrollView != nil)")
for height: CGFloat in [7413, 7496, 7653, 7413] {
    let before = probe.pinCount
    let grows = height > growingDocument.frame.height
    growingDocument.setFrameSize(NSSize(width: 427, height: height))
    drainLayout()
    // AppKit clamps a shrinking document itself; growth needs the settled pin.
    if grows { require(probe.pinCount > before, "Growth pins after document bounds change") }
    require(abs(distanceFromEnd(growingScroll)) < 1, "Following uses current document bounds")
}
let settled = probe.pinCount
growingScroll.contentView.scroll(to: NSPoint(x: 0, y: 100))
drainLayout()
require(probe.pinCount == settled, "Scrolling history does not retrigger layout following")
require(growingScroll.contentView.bounds.minY == 100, "History position remains under user control")
print("Chat follow layout: reproduced stale bounds, growth/shrink correction and no history-scroll feedback passed without a window")

// Manager failure at 440pt: a capped draft, then a short window. The composer
// cap follows the viewport (368 -> 279), so the clearance changes with it. A
// fractional anchor from the tall layout stopped 31pt short. Replay both
// orders with real composer heights; the latest row must clear status+gap.
let chatWidth: CGFloat = 440
let contentEnd: CGFloat = 4700       // top padding + rows + "bottom" marker
let latestBottom = contentEnd - 21   // 20pt stack spacing + 1pt marker
let latestHeight: CGFloat = 40
func composerHeight(_ draft: String, viewport: CGFloat) -> CGFloat {
    composer.preferredHeight(for: draft, width: chatWidth - 2 * ChatLayout.composerInset,
        availableHeight: viewport - ChatLayout.composerInset, hasContext: false)
}
final class ChatReplay {
    let scroll = NSScrollView(frame: CGRect(x: 0, y: 0, width: chatWidth, height: 776))
    let document = FlippedDocument(frame: .zero)
    let probe = ChatScrollStyleProbe(frame: .zero)
    var draft = ""
    var follows = true
    var viewport: CGFloat { scroll.contentView.bounds.height }
    var composer: CGFloat { composerHeight(draft, viewport: viewport) }
    init() {
        scroll.documentView = document
        document.addSubview(probe)
        probe.follows = { [unowned self] in self.follows }
        layoutDocument()
        probe.scheduleConfiguration(); drainLayout()
    }
    // SwiftUI applies bottom padding = the composer's clearance.
    func layoutDocument() {
        document.setFrameSize(NSSize(width: chatWidth, height: contentEnd + ChatLayout.bottomInset(composerHeight: composer)))
    }
    func grow(_ value: String) { draft = value; layoutDocument() }
    func resize(_ height: CGFloat) { scroll.setFrameSize(NSSize(width: chatWidth, height: height)); layoutDocument() }
    // The SwiftUI request this replaces: marker at a fraction of the viewport
    // computed from the previous viewport and composer clearance.
    func staleAnchor(viewport old: CGFloat, composer oldComposer: CGFloat) {
        let fraction = (old - ChatLayout.bottomInset(composerHeight: oldComposer)) / old
        let clip = scroll.contentView
        clip.scroll(to: NSPoint(x: 0, y: contentEnd - 1 - fraction * viewport))
    }
    func check(_ label: String) {
        let offset = scroll.contentView.bounds.minY
        let bottom = latestBottom - offset
        let composerTop = viewport - ChatLayout.composerInset - composer
        require(bottom - latestHeight >= 0, "\(label): latest row top visible (\(bottom - latestHeight))")
        require(bottom <= composerTop - ChatLayout.latestClearance - 40 + 0.5,
            "\(label): latest bottom \(bottom) above composer top \(composerTop) with latest-button clearance")
    }
}
for order in ["grow-then-resize", "resize-then-grow"] {
    let replay = ChatReplay()
    replay.check("\(order) initial")
    let steps: [(String, () -> Void)] = order == "grow-then-resize"
        ? [("grow", { replay.grow(longDraft) }), ("resize", { replay.resize(620) })]
        : [("resize", { replay.resize(620) }), ("grow", { replay.grow(longDraft) })]
    for (name, step) in steps {
        let (viewport, height) = (replay.viewport, replay.composer)
        step()
        replay.staleAnchor(viewport: viewport, composer: height)
        drainLayout()
        replay.check("\(order) after \(name)")
    }
    require(replay.viewport == 620 && replay.composer == 305, "\(order): capped draft in the short window (\(replay.composer))")
}
// Reproduce the exact manager arithmetic, then show the settled pin wins.
let tall = ChatReplay()
tall.grow(longDraft); drainLayout()
require(tall.composer == 368, "Long draft reaches the cap at 440pt")
tall.resize(568)
tall.staleAnchor(viewport: 776, composer: 368)
let short = latestBottom - tall.scroll.contentView.bounds.minY
    - (tall.viewport - ChatLayout.bottomInset(composerHeight: tall.composer))
// Manager capture: latest bottom 220.9 vs reading height ~211.
require(short > 5, "Stale fractional anchor leaves the latest row below clearance (\(short)pt)")
drainLayout()
tall.check("stale anchor corrected after settled resize")
// A reader in history is never moved by growth or resize, in either order.
let reader = ChatReplay()
reader.follows = false
reader.scroll.contentView.scroll(to: NSPoint(x: 0, y: 1200))
reader.grow(longDraft); drainLayout()
reader.resize(620); drainLayout()
require(reader.scroll.contentView.bounds.minY == 1200, "History position survives growth and resize")
let readerPins = reader.probe.pinCount
reader.probe.requestPin(); drainLayout()
require(reader.probe.pinCount == readerPins, "Explicit pin requests respect a reader in history")
reader.follows = true
reader.probe.requestPin(); drainLayout()
reader.check("scroll-to-latest after history")
print("Chat follow resize: 440pt capped draft with grow->resize and resize->grow, stale-anchor negative control and history preservation passed without a window")

// Manager failure: a wheel scroll into history was pinned back to latest.
// User input detaches at once and drops pending pins; settles, composer growth
// and resizes then leave the reader alone until they return to the end or
// click latest. Programmatic pins never count as user scrolling.
func drainSettle() { RunLoop.main.run(until: Date(timeIntervalSinceNow: ChatScrollStyleProbe.settleDelay + 0.25)) }
func scrollHistory(_ replay: ChatReplay, by delta: CGFloat) {
    let clip = replay.scroll.contentView
    clip.scroll(to: NSPoint(x: 0, y: clip.bounds.minY - delta))
}
func liveScroll(_ replay: ChatReplay, _ move: () -> Void) {
    NotificationCenter.default.post(name: NSScrollView.willStartLiveScrollNotification, object: replay.scroll)
    move()
    NotificationCenter.default.post(name: NSScrollView.didEndLiveScrollNotification, object: replay.scroll)
}
// Negative control: the previous gate (follows only, re-derived as "true"
// after each pin) yanks the reader back on the very next document settle.
let yanked = ChatReplay()
scrollHistory(yanked, by: 700)
let yankedOffset = yanked.scroll.contentView.bounds.minY
yanked.grow(longDraft); drainLayout()
require(yanked.scroll.contentView.bounds.minY != yankedOffset,
    "Negative control: without a user-input detach, composer growth re-pins history")
for path in ["wheel", "live scroll"] {
    let replay = ChatReplay()
    var reported: [Bool] = []
    replay.probe.onPinnedChange = { reported.append($0) }
    require(replay.probe.isPinned && ChatScrollStyleProbe.distanceFromEnd(replay.scroll) < 1, "\(path): starts pinned at latest")
    let pinsBefore = replay.probe.pinCount
    replay.grow(wrappedDraft); drainLayout()
    require(replay.probe.pinCount > pinsBefore && replay.probe.userScrollCount == 0,
        "\(path): programmatic pins are not user scrolling")
    replay.probe.requestPin()   // pending before the input; must be dropped
    if path == "wheel" { replay.probe.userScrolled(); scrollHistory(replay, by: 700) }
    else { liveScroll(replay) { scrollHistory(replay, by: 700) } }
    require(!replay.probe.isPinned && reported == [false], "\(path): detaches immediately and reports it (\(reported))")
    let offset = replay.scroll.contentView.bounds.minY
    let unchanged = { (label: String) in
        require(replay.scroll.contentView.bounds.minY == offset && !replay.probe.isPinned,
            "\(path): \(label) leaves scrollY \(replay.scroll.contentView.bounds.minY) at \(offset), not pinned")
    }
    drainSettle(); unchanged("pending pin and input settle")
    replay.probe.scheduleConfiguration(); drainLayout(); unchanged("document/viewport settle")
    replay.grow(longDraft); drainLayout(); unchanged("composer growth")
    replay.probe.requestPin(); drainLayout(); unchanged("composer-height pin request")
    replay.resize(620); drainLayout(); unchanged("resize")
    replay.grow(wrappedDraft); drainLayout(); unchanged("composer shrink")
    require(reported == [false], "\(path): no re-attach without user return or latest")
    // Returning to the end by user input re-attaches after the input rests.
    liveScroll(replay) { ChatScrollStyleProbe.pinToEnd(replay.scroll) }
    require(!replay.probe.isPinned, "\(path): mid-gesture stays detached")
    drainSettle()
    require(replay.probe.isPinned && reported == [false, true], "\(path): user return to end re-attaches (\(reported))")
    replay.grow(longDraft); drainLayout(); replay.check("\(path) follows again after return")
    // Latest button: explicit attach from history.
    replay.probe.userScrolled(); scrollHistory(replay, by: 900); drainSettle()
    require(!replay.probe.isPinned, "\(path): detached again")
    replay.probe.attach(); drainLayout()
    require(replay.probe.isPinned, "\(path): latest re-attaches")
    replay.check("\(path) latest button")
}
print("Chat user scroll: wheel/live-scroll detach, dropped pending pins, settle/growth/resize preserve history, return-to-end and latest re-attach, negative control passed without a window")

// Manager failure: the pid-posted acceptance wheel had no NSEvent.window, so
// the probe dropped it (userScrollCount 0). Classify input without a desktop:
// nil-window wheels count only when the pointer is over the conversation;
// other windows never count; every drop leaves a diagnostic reason.
let chatWindowIdentity = NSObject(), otherWindowIdentity = NSObject()
let inside = NSPoint(x: 100, y: 100), bounds = NSRect(x: 0, y: 0, width: 440, height: 600)
let cases: [(String, AnyObject?, Int, AnyObject?, NSPoint?, String?)] = [
    ("chat window over conversation", chatWindowIdentity, 7, chatWindowIdentity, inside, nil),
    ("nil window, pointer over conversation", nil, 0, chatWindowIdentity, inside, nil),
    ("nil window, chat window number", nil, 7, chatWindowIdentity, inside, nil),
    ("nil window, pointer outside", nil, 0, chatWindowIdentity, NSPoint(x: 100, y: 900), "nil window: pointer outside conversation"),
    ("chat window, pointer outside", chatWindowIdentity, 7, chatWindowIdentity, NSPoint(x: -5, y: 10), "pointer outside conversation"),
    ("other window object", otherWindowIdentity, 9, chatWindowIdentity, inside, "other window"),
    ("nil window, other window number", nil, 9, chatWindowIdentity, inside, "other window number"),
    ("conversation not in a window", nil, 0, nil, inside, "conversation not in a window"),
    ("no pointer location", nil, 0, chatWindowIdentity, nil, "no pointer location"),
]
for (label, eventWindow, number, chatWindow, point, expected) in cases {
    let reason = ChatScrollStyleProbe.wheelRejection(eventWindow: eventWindow, eventWindowNumber: number,
        chatWindow: chatWindow, chatWindowNumber: 7, pointInScroll: point, scrollBounds: bounds)
    require(reason == expected, "\(label): expected \(expected ?? "accepted"), got \(reason ?? "accepted")")
}
require(ChatScrollStyleProbe.screenPoint(quartz: CGPoint(x: 200, y: 300), primaryScreenHeight: 1000) == NSPoint(x: 200, y: 700),
    "Quartz top-left location converts to AppKit screen coordinates")

// The real monitor handler on an offscreen window that is never shown: a
// pid-style (nil window) CGEvent wheel over the conversation detaches; outside
// it, for another window number, or with no delta it is dropped with a reason.
_ = NSApplication.shared
let offscreen = NSWindow(contentRect: NSRect(x: 120, y: 80, width: 440, height: 776), styleMask: [.borderless],
                         backing: .buffered, defer: true)
let windowed = ChatReplay()
offscreen.contentView = windowed.scroll
windowed.probe.scheduleConfiguration(); drainLayout()
require(windowed.probe.configuredScroll === windowed.scroll && windowed.scroll.window === offscreen, "Probe attached inside the offscreen window")
func pidWheel(at point: NSPoint, in view: NSView, delta: Int32 = 700, windowNumber: Int? = nil) -> NSEvent {
    let screen = offscreen.convertPoint(toScreen: view.convert(point, to: nil))
    let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: delta, wheel2: 0, wheel3: 0)!
    event.location = CGPoint(x: screen.x, y: (NSScreen.screens.first?.frame.maxY ?? 0) - screen.y)
    if let windowNumber { event.setIntegerValueField(CGEventField(rawValue: 51)!, value: Int64(windowNumber)) }
    return NSEvent(cgEvent: event)!
}
let probeInput = windowed.probe
func expectDrop(_ event: NSEvent, _ reason: String) {
    let (wheels, scrolls) = (probeInput.scrollWheelEventCount, probeInput.userScrollCount)
    probeInput.handleInput(event)
    require(probeInput.scrollWheelEventCount == wheels + 1, "Wheel counted before rejection")
    require(probeInput.lastInputRejection == reason && probeInput.userScrollCount == scrolls && probeInput.isPinned,
        "Dropped with '\(reason)', got '\(probeInput.lastInputRejection)'")
}
expectDrop(pidWheel(at: NSPoint(x: 100, y: 5000), in: windowed.scroll), "nil window: pointer outside conversation")
expectDrop(pidWheel(at: NSPoint(x: 100, y: 100), in: windowed.scroll, windowNumber: offscreen.windowNumber + 100_000), "other window number")
expectDrop(pidWheel(at: NSPoint(x: 100, y: 100), in: windowed.scroll, delta: 0), "no vertical delta")
let mouseMoved = NSEvent.mouseEvent(with: .mouseMoved, location: .zero, modifierFlags: [], timestamp: 0,
    windowNumber: 0, context: nil, eventNumber: 0, clickCount: 0, pressure: 0)!
let beforeMoved = probeInput.scrollWheelEventCount
probeInput.handleInput(mouseMoved)
require(probeInput.scrollWheelEventCount == beforeMoved && probeInput.isPinned, "Non-scroll input is ignored")
let accepted = pidWheel(at: NSPoint(x: 100, y: 100), in: windowed.scroll)
require(accepted.window == nil, "Replays the manager's nil-window wheel")
probeInput.handleInput(accepted)
require(probeInput.lastInputRejection == "" && probeInput.userScrollCount == 1 && !probeInput.isPinned,
    "Nil-window wheel over the conversation detaches ('\(probeInput.lastInputRejection)')")
let detachedOffset = windowed.scroll.contentView.bounds.minY
windowed.grow(longDraft); drainLayout()
require(windowed.scroll.contentView.bounds.minY == detachedOffset, "Accepted wheel keeps growth from re-pinning")
let orphan = ChatReplay().probe
orphan.handleInput(pidWheel(at: NSPoint(x: 100, y: 100), in: windowed.scroll))
require(orphan.lastInputRejection == "conversation not in a window" && orphan.isPinned, "Windowless conversation rejects with a reason")
print("Chat input routing: nil-window wheel over/outside conversation, other window, zero delta, non-scroll and windowless reasons passed with an offscreen window")

// Manager failure: the probe unpinned (pinned false, scrollY 3943 -> 3243)
// but the latest button never appeared. Its visibility now comes from the
// probe's pinned state and scroll position, not a SwiftUI flag or geometry.
let visibility: [(Bool, Bool, CGFloat, Bool)] = [
    (true, true, 0, false), (true, true, 700, false),     // following at/near the end
    (false, true, 700, true), (false, true, 0, false),   // detached: away shows, end hides
    (true, false, 400, true), (true, false, 0, false),   // reveal/control stopped following
]
for (pinned, follows, distance, expected) in visibility {
    require(ChatScrollStyleProbe.showsLatestButton(pinned: pinned, follows: follows, distanceFromEnd: distance) == expected,
        "Latest button for pinned \(pinned), follows \(follows), distance \(distance) should be \(expected)")
}
for path in ["wheel", "live scroll"] {
    let replay = ChatReplay()
    var shown: [Bool] = []
    replay.probe.onLatestButtonChange = { shown.append($0) }
    replay.grow(longDraft); drainLayout()
    require(!replay.probe.showsLatestButton && shown.isEmpty, "\(path): hidden while following at latest")
    // Detach first, then move: visibility follows the position change.
    let away = { scrollHistory(replay, by: 700) }
    if path == "wheel" { replay.probe.userScrolled(); away() } else { liveScroll(replay, away) }
    drainLayout()
    require(!replay.probe.isPinned && replay.probe.showsLatestButton && shown == [true],
        "\(path): unpinned and scrolled away shows latest (\(shown))")
    drainSettle()
    require(replay.probe.showsLatestButton && shown == [true], "\(path): stays visible in history after input rests")
    replay.grow(wrappedDraft); drainLayout()
    require(replay.probe.showsLatestButton, "\(path): composer changes keep it visible in history")
    // User scrolls back to the end: hidden immediately, re-pinned after rest.
    let back = { _ = ChatScrollStyleProbe.pinToEnd(replay.scroll) }
    if path == "wheel" { replay.probe.userScrolled(); back() } else { liveScroll(replay, back) }
    drainLayout()
    require(!replay.probe.showsLatestButton && shown == [true, false], "\(path): back at the bottom hides latest (\(shown))")
    drainSettle()
    require(replay.probe.isPinned && !replay.probe.showsLatestButton && shown == [true, false], "\(path): re-pinned stays hidden")
    // Latest button click: attach pins to the end and hides it.
    replay.probe.userScrolled(); scrollHistory(replay, by: 900); drainLayout()
    require(replay.probe.showsLatestButton && shown == [true, false, true], "\(path): visible again in history")
    replay.probe.attach(); drainLayout()
    require(!replay.probe.showsLatestButton && shown == [true, false, true, false], "\(path): latest click hides it (\(shown))")
}
// Manager failure (WhenScrolling after thumb drag): didEndLiveScroll arrived after
// the latest-button attach and called userScrolled(), clearing follows before pin.
for path in ["willStart pending", "didEnd only", "didEnd before queued pin"] {
    let replay = ChatReplay()
    replay.probe.userScrolled(); scrollHistory(replay, by: 900); drainLayout()
    require(!replay.probe.isPinned && replay.probe.showsLatestButton, "\(path): detached in history")
    if path != "didEnd only" {
        NotificationCenter.default.post(name: NSScrollView.willStartLiveScrollNotification, object: replay.scroll)
        require(replay.probe.isLiveScrolling, "\(path): live scroll started")
    }
    // attach() runs inside SwiftUI's updateNSView: no synchronous callbacks.
    var callbacks = 0
    replay.probe.onPinnedChange = { _ in callbacks += 1 }
    replay.probe.onLatestButtonChange = { _ in callbacks += 1 }
    replay.probe.attach()
    require(callbacks == 0 && replay.probe.isPinned && !replay.probe.isLiveScrolling,
        "\(path): attach pins without calling back into SwiftUI (\(callbacks) callbacks)")
    let ignoredBefore = replay.probe.ignoredLiveScrollEndCount
    if path == "didEnd before queued pin" {
        // The stale end lands before attach's queued pin has run.
        NotificationCenter.default.post(name: NSScrollView.didEndLiveScrollNotification, object: replay.scroll)
        drainLayout()
    } else {
        drainLayout()
        require(replay.probe.isPinned && ChatScrollStyleProbe.distanceFromEnd(replay.scroll) < 1, "\(path): attach pins to the end")
        NotificationCenter.default.post(name: NSScrollView.didEndLiveScrollNotification, object: replay.scroll)
        drainLayout()
    }
    drainSettle()
    require(replay.probe.isPinned && ChatScrollStyleProbe.distanceFromEnd(replay.scroll) < 1,
        "\(path): stale didEnd must not detach (\(replay.probe.isPinned), distance \(ChatScrollStyleProbe.distanceFromEnd(replay.scroll)))")
    require(replay.probe.ignoredLiveScrollEndCount == ignoredBefore + 1,
        "\(path): stale didEnd counted as ignored (\(replay.probe.ignoredLiveScrollEndCount))")
}
print("Chat latest after drag: stale didEndLiveScroll after attach does not detach or block re-pin")
// A reveal (follows false) away from the end also offers latest, without unpinning.
let revealed = ChatReplay()
revealed.follows = false
scrollHistory(revealed, by: 600); drainLayout()
require(revealed.probe.isPinned && revealed.probe.showsLatestButton, "Reveal away from the end shows latest")
print("Chat latest button: probe-driven show on unpin+scroll away, hide at bottom, re-pin, latest click and reveal passed without a window")

// Manager failure (acceptance-WhenScrolling-6-latest): the latest button was
// shown at its measured frame and the click landed on it, but its action never
// ran (buttonClickCount 0; hit target the SwiftUI hosting view). The button is
// now a native NSButton sibling above the chat. Offscreen the window is never
// visible, so NSControl.mouseDown declines; its cell's own tracking loop is what
// the visible chat window runs, and it must recognise a queued click.
final class FlippedColumn: NSView { override var isFlipped: Bool { true } }
final class FlippedChat: NSView { override var isFlipped: Bool { true } }
func latestClick(_ type: NSEvent.EventType, _ point: NSPoint) -> NSEvent {
    NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: offscreen.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0)!
}
let column = FlippedColumn(frame: NSRect(x: 0, y: 0, width: 320, height: 748))
let latestChat = FlippedChat(frame: column.bounds)
column.addSubview(latestChat)
let latest = ChatLatestButton()
column.addSubview(latest, positioned: .above, relativeTo: latestChat)
offscreen.setContentSize(column.frame.size)
offscreen.contentView = column
require(latest.place(over: latestChat, composerHeight: 128, visible: false) == .zero && latest.isHidden, "Hidden latest button reports a zero frame")
// LKM-141: centered over the column, `gap` above the composer bubble, inside the
// composer clearance (never over the reading area), at every width and draft.
for (width, composerHeight) in [(CGFloat(320), CGFloat(56)), (440, 128), (521, 400)] {
    latestChat.frame = NSRect(x: 0, y: 0, width: width, height: 748)
    let placed = latest.place(over: latestChat, composerHeight: composerHeight, visible: true)
    let composerTop = ChatLayout.composerFrame(in: latestChat.bounds, height: composerHeight).minY
    let readingBottom = 748 - ChatLayout.bottomInset(composerHeight: composerHeight)
    require(placed.width == ChatLatestButton.diameter && placed.height == ChatLatestButton.diameter, "Latest button is round (\(placed))")
    require(abs(placed.midX - width / 2) <= 0.5, "Latest button is centered over the \(width)pt column (\(placed))")
    require(abs(composerTop - placed.maxY - ChatLatestButton.gap) < 0.5, "Latest button sits gap above the composer (\(placed), composer top \(composerTop))")
    require(placed.minY >= readingBottom, "Latest button stays below the reading area (\(placed), reading bottom \(readingBottom))")
    require(latest.accessibilityLabel() == "Scroll to latest message", "Latest button keeps its accessibility label")
}
latestChat.frame = column.bounds
let shownFrame = latest.place(over: latestChat, composerHeight: 128, visible: true)
require(!latest.isHidden && shownFrame.width > 0 && shownFrame.height > 0, "Shown latest button has a real frame (\(shownFrame))")
// Same conversion as ChatAcceptance: chat top-left frame centre -> window point.
let latestPoint = latestChat.convert(NSPoint(x: shownFrame.midX, y: shownFrame.midY), to: nil)
let latestHit = column.hitTest(column.superview?.convert(latestPoint, from: nil) ?? latestPoint)
require(latestHit === latest, "A click at the reported frame hit-tests to the native button (\(String(describing: latestHit.map { type(of: $0) })))")
var presses = 0
latest.onPress = { presses += 1 }
NSApp.postEvent(latestClick(.leftMouseUp, latestPoint), atStart: false)
let tracked = latest.cell!.trackMouse(with: latestClick(.leftMouseDown, latestPoint), in: latest.bounds, of: latest, untilMouseUp: true)
let strayUp = NSApp.nextEvent(matching: .leftMouseUp, until: .distantPast, inMode: .default, dequeue: true)
require(tracked && strayUp == nil, "The button's tracking loop consumes the queued mouseUp and recognises the click")
require(presses == 1, "The queued synthetic click runs the button's action exactly once (\(presses))")
latestChat.isHidden = true
require(latest.place(over: latestChat, composerHeight: 128, visible: true) == .zero && latest.isHidden, "Hidden chat hides the latest button")
// Negative control: the SwiftUI Button this replaced. A click there hit-tests
// to the hosting view, not a control that runs its own tracking loop.
final class SwiftUIClicks { var count = 0 }
let swiftUIClicks = SwiftUIClicks()
let swiftUIHost = NSHostingView(rootView: ZStack(alignment: .bottomTrailing) {
    Color.clear
    Button { swiftUIClicks.count += 1 } label: { Image(systemName: "arrow.down") }.padding(12)
}.frame(width: 320, height: 300))
swiftUIHost.frame = NSRect(x: 0, y: 0, width: 320, height: 300)
offscreen.contentView = swiftUIHost
for _ in 0..<5 { swiftUIHost.layoutSubtreeIfNeeded(); RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05)) }
let swiftUIHit = swiftUIHost.hitTest(NSPoint(x: 320 - 12 - 10, y: 12 + 10))
require(!(swiftUIHit is NSControl), "Negative control: the SwiftUI latest button is not a native control (\(String(describing: swiftUIHit.map { type(of: $0) })))")
print("Chat latest button: round native button centered gap above the composer inside its clearance at 320/440/521pt, click hit-test and tracking loop, hidden states; SwiftUI negative control")

// Accessibility/scroller provider. With no override it must be exactly the
// real macOS values (read-only here); overrides stay in-process and flow
// through the probe's AppKit appearance/style and the SwiftUI environment.
let workspace = NSWorkspace.shared
let realSystem = ChatAccessibility(increaseContrast: workspace.accessibilityDisplayShouldIncreaseContrast,
    reduceTransparency: workspace.accessibilityDisplayShouldReduceTransparency,
    reduceMotion: workspace.accessibilityDisplayShouldReduceMotion)
for provider in [ChatSystemEnvironment.shared, ChatSystemEnvironment()] {
    require(!provider.isOverridden, "Provider starts without an override")
    require(provider.accessibility == realSystem && provider.systemAccessibility() == realSystem,
        "Default provider reports the real NSWorkspace accessibility values")
    require(provider.scrollerStyle == NSScroller.preferredScrollerStyle, "Default provider reports the real scroller style")
}
var fakeSystem = ChatAccessibility(increaseContrast: false, reduceTransparency: true, reduceMotion: false)
let injected = ChatSystemEnvironment(systemAccessibility: { fakeSystem }, systemScrollerStyle: { .overlay })
var environmentNotes = 0
let noteObserver = NotificationCenter.default.addObserver(forName: ChatSystemEnvironment.didChange, object: injected, queue: nil) { _ in environmentNotes += 1 }
let allOn = ChatAccessibility(increaseContrast: true, reduceTransparency: true, reduceMotion: true)
injected.override(accessibility: nil, scrollerStyle: .legacy)
require(injected.scrollerStyle == .legacy && injected.accessibility == fakeSystem && injected.isOverridden,
    "Scroller-only override keeps system accessibility")
injected.override(accessibility: allOn, scrollerStyle: nil)
require(injected.accessibility == allOn && injected.scrollerStyle == .overlay, "Accessibility-only override keeps system scroller style")
injected.clearOverrides()
require(!injected.isOverridden && injected.accessibility == fakeSystem && injected.scrollerStyle == .overlay, "Clearing returns to system values")
fakeSystem.reduceMotion = true
require(injected.accessibility.reduceMotion, "System values are read live, not cached")
require(environmentNotes == 3, "Each override change notifies consumers (\(environmentNotes))")
NotificationCenter.default.removeObserver(noteObserver)

// The probe applies the scroller override to the real NSScrollView the way the macOS setting does.
let styled = ChatReplay()
styled.probe.environment = injected
drainLayout()
require(styled.scroll.scrollerStyle == .overlay && styled.scroll.appearance == nil, "System values: overlay, inherited appearance")
let beforeOverride = styled.probe.configurationCount
injected.override(accessibility: allOn, scrollerStyle: .legacy); drainLayout()
require(styled.probe.configurationCount > beforeOverride, "Override change reconfigures the probe")
require(styled.scroll.scrollerStyle == .legacy && !styled.scroll.autohidesScrollers, "Always override shows the legacy scroller")
require(styled.scroll.appearance == nil, "Accessibility overrides never replace the inherited appearance (AppKit keeps macOS contrast)")
injected.clearOverrides(); drainLayout()
require(styled.scroll.scrollerStyle == .overlay && styled.scroll.autohidesScrollers && styled.scroll.appearance == nil,
    "Clearing restores system style and inherited appearance")

// SwiftUI views read the same environment keys the real settings populate.
final class EchoBox { var value: ChatAccessibility? }
struct EchoHarness: View {
    let accessibility: ChatAccessibility
    let box: EchoBox
    var body: some View {
        Color.clear.frame(width: 100, height: 100)
            .background(ChatAccessibilityEcho { box.value = $0 })
            .modifier(ChatAccessibilityEnvironment(accessibility: accessibility))
    }
}
for value in [allOn, ChatAccessibility(), ChatAccessibility(increaseContrast: true, reduceTransparency: false, reduceMotion: true)] {
    let box = EchoBox()
    let host = NSHostingView(rootView: EchoHarness(accessibility: value, box: box))
    host.frame = NSRect(x: 0, y: 0, width: 100, height: 100)
    offscreen.contentView = host
    for _ in 0..<5 { host.layoutSubtreeIfNeeded(); RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05)) }
    require(box.value == value, "SwiftUI environment receives \(value), got \(String(describing: box.value))")
}
print("Chat accessibility provider: real system defaults, in-process overrides, probe scroller style with inherited appearance, and SwiftUI environment passed without changing system settings")

// Manager failure: "Native thumb dragging moves content" (scrollY stayed 3306).
// The drag's dragged/up events reached AppKit only after the scroller's own
// tracking loop needed them. ScrollerDrag queues them first, then routes the
// mouseDown to the hit-tested scroller, whose tracking loop consumes them.
// Posting the same drag without routing the mouseDown must not move content.
final class FlippedDragDocument: NSView { override var isFlipped: Bool { true } }
func dragScroll(_ style: NSScroller.Style) -> (NSScrollView, NSScroller) {
    let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 400, height: 600))
    scroll.hasVerticalScroller = true
    ChatScrollStyleProbe.configure(scroll, style: style)
    scroll.documentView = FlippedDragDocument(frame: NSRect(x: 0, y: 0, width: 380, height: 5000))
    offscreen.setContentSize(NSSize(width: 400, height: 600))
    offscreen.contentView = scroll
    scroll.tile(); scroll.layoutSubtreeIfNeeded()
    scroll.contentView.scroll(to: NSPoint(x: 0, y: 3000)); scroll.reflectScrolledClipView(scroll.contentView)
    return (scroll, scroll.verticalScroller!)
}
for style: NSScroller.Style in [.legacy, .overlay] {
    let name = style == .legacy ? "Always" : "WhenScrolling"
    var (scroll, scroller) = dragScroll(style)
    // Routed: deliver the mouseDown to the view AppKit's hit-test picks (what
    // window.sendEvent does in the app); it must be the scroller.
    let routed = ScrollerDrag.perform(scroller: scroller, scroll: scroll, window: offscreen, dy: 96) { down in
        let content = offscreen.contentView!
        content.hitTest(content.superview?.convert(down.locationInWindow, from: nil) ?? down.locationInWindow)?.mouseDown(with: down)
    }
    require(routed.hitIsScroller, "\(name): the thumb location hit-tests to the scroller (\(routed.hitTarget))")
    require(routed.windowRouted && routed.queued == 9, "\(name): window-targeted mouse events queued (\(routed.dictionary))")
    require(routed.consumedByTracker == routed.queued && routed.leftover == 0, "\(name): scroller tracking consumed the drag (\(routed.dictionary))")
    require(routed.scrollBefore - routed.scrollAfter > 40, "\(name): thumb drag up moves content toward history (\(routed.scrollBefore) -> \(routed.scrollAfter))")
    // Negative control: the same drag posted without routing the mouseDown.
    (scroll, scroller) = dragScroll(style)
    let unrouted = ScrollerDrag.perform(scroller: scroller, scroll: scroll, window: offscreen, dy: 96) { NSApp.postEvent($0, atStart: false) }
    require(unrouted.scrollBefore == unrouted.scrollAfter && unrouted.consumedByTracker == 0,
        "\(name): an unrouted drag does not move content, so the acceptance drag check fails (\(unrouted.dictionary))")
}
print("Chat thumb drag: queued drag routed to the hit-tested scroller moves content toward history in Always and WhenScrolling; unrouted negative control does not")

// Manager failure (intermittent): the drag's hit target was NSClipView, since
// the autohiding overlay knob had faded. The drag must never reach mouseDown
// unless the knob hit-tests to NSScroller: ScrollerDrag refuses it, and the
// acceptance reveals the knob (flashScrollers) and waits, bounded, first.
// A view covering the knob stands in for the faded scroller offscreen.
final class KnobCover: NSView {}
func runAsync<T>(_ body: @escaping @MainActor () async -> T) -> T {
    var result: T?
    Task { @MainActor in result = await body() }
    while result == nil { RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.01)) }
    return result!
}
for style: NSScroller.Style in [.overlay, .legacy] {
    let name = style == .legacy ? "Always" : "WhenScrolling"
    let (scroll, scroller) = dragScroll(style)
    let knob = scroller.rect(for: .knob)
    let cover = KnobCover(frame: scroll.convert(scroller.convert(knob, to: scroll), to: offscreen.contentView).insetBy(dx: -4, dy: -4))
    offscreen.contentView!.addSubview(cover)
    let hidden = ScrollerDrag.knobHit(scroller: scroller, window: offscreen)
    require(!hidden.isScroller && hidden.target == "KnobCover", "\(name): covered knob does not hit-test to the scroller (\(hidden.target))")
    var delivered = 0
    let refused = ScrollerDrag.perform(scroller: scroller, scroll: scroll, window: offscreen, dy: 96) { _ in delivered += 1 }
    require(refused.refused && delivered == 0 && refused.queued == 0 && refused.scrollBefore == refused.scrollAfter,
        "\(name): a drag whose knob is not NSScroller is refused before mouseDown (\(refused.dictionary))")
    // Bounded wait: still hidden -> reports the hit class, knob and elapsed time.
    let timedOut = runAsync { await ScrollerDrag.revealKnob(scroller: scroller, scroll: scroll, window: offscreen, timeout: 0.2) {
        try? await Task.sleep(nanoseconds: 20_000_000) } }
    require(!timedOut.hit.isScroller && timedOut.hit.target == "KnobCover" && timedOut.elapsed >= 0.2 && timedOut.elapsed < 1,
        "\(name): reveal wait is bounded and reports the blocking hit (\(timedOut.hit.dictionary), \(timedOut.elapsed)s)")
    // Revealed during the wait (cover removed) -> hit-tests to NSScroller, drag proceeds.
    let revealed = runAsync { () -> (hit: ScrollerDrag.KnobHit, elapsed: TimeInterval) in
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { cover.removeFromSuperview() }
        return await ScrollerDrag.revealKnob(scroller: scroller, scroll: scroll, window: offscreen, timeout: 1.5) {
            try? await Task.sleep(nanoseconds: 20_000_000) }
    }
    require(revealed.hit.isScroller && revealed.elapsed < 1.5, "\(name): knob hit-tests to NSScroller once revealed (\(revealed.hit.dictionary))")
    let moved = ScrollerDrag.perform(scroller: scroller, scroll: scroll, window: offscreen, dy: 96) { down in
        let content = offscreen.contentView!
        content.hitTest(content.superview?.convert(down.locationInWindow, from: nil) ?? down.locationInWindow)?.mouseDown(with: down)
    }
    require(!moved.refused && moved.hitIsScroller && moved.scrollBefore - moved.scrollAfter > 40,
        "\(name): revealed knob drag goes through NSScroller and moves content (\(moved.dictionary))")
}
print("Chat thumb drag reveal: non-NSScroller knob hit refuses mouseDown, bounded reveal wait reports the blocker, revealed knob drags content")
