import AppKit

// LKM-431: one click on a code snippet copies it. The real text view in a real window:
// every click, double click and drag below goes through hit-testing and NSTextView's own
// tracking loop, at the glyphs' actual geometry.
func require(_ condition: Bool, _ message: String) {
    if !condition { fputs("FAIL: \(message)\n", stderr); exit(1) }
}
final class KeyWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var isKeyWindow: Bool { true }
}
_ = NSApplication.shared
NSApp.setActivationPolicy(.accessory)
let width: CGFloat = 320
let window = KeyWindow(contentRect: NSRect(x: -4000, y: -4000, width: width, height: 900), styleMask: [.titled], backing: .buffered, defer: false)
let root = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 900))
window.contentView = root
let view = ChatTextView.make()
root.addSubview(view)
window.orderFront(nil)
window.makeFirstResponder(view)

// A sandboxed run has no pasteboard server, so the write itself is recorded here. The real
// pasteboard write is covered by the native chat-text check.
var writes: [String] = [], writable = true
ChatTextView.write = { writes.append($0); return writable }

let block = "  func caf\u{E9}() {\n\treturn \"\u{65E5}\u{672C}\u{8A9E} \u{1F680}\"   \n\n  }"
let longCode = "packages/some-long-folder/another-long-folder/yet-another-long-folder/file-name.test.ts"
let markdown = """
Prose before `inline  code` and after, see [a link](trezi-code:src/a.ts#L1) and `https://example.com/x` too.

Then **`rm -rf ./nothing`** and `caf\u{E9} \u{1F680}` and `\(longCode)` end.

| Name | Value |
| --- | --- |
| cell | `in table` |

```swift
\(block)
```

Between.

```

```

Last words.
"""
func load(_ source: String) {
    view.show(source, streaming: false)
    let size = view.fittingSize(width: width)
    view.frame = NSRect(x: 0, y: 0, width: width, height: size.height)
    view.layout()
}
load(markdown)
var text: NSString { view.string as NSString }
var manager: NSLayoutManager { view.layoutManager! }
/// The glyphs of `range` per line, in view coordinates.
func lines(_ range: NSRange) -> [NSRect] {
    var result: [NSRect] = []
    let glyphs = manager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
    manager.enumerateLineFragments(forGlyphRange: glyphs) { _, _, container, line, _ in
        result.append(manager.boundingRect(forGlyphRange: NSIntersectionRange(glyphs, line), in: container).offsetBy(dx: view.textContainerOrigin.x, dy: view.textContainerOrigin.y))
    }
    return result
}
/// Per line, the band of the glyphs' x-height on their baseline: where a pointer lands on
/// visible letters, whatever the line spacing or the font's own metrics.
func body(_ range: NSRange) -> [NSRect] {
    var result: [NSRect] = []
    let glyphs = manager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
    manager.enumerateLineFragments(forGlyphRange: glyphs) { line, _, container, lineGlyphs, _ in
        let part = NSIntersectionRange(glyphs, lineGlyphs)
        let box = manager.boundingRect(forGlyphRange: part, in: container)
        let font = view.textStorage!.attribute(.font, at: manager.characterIndexForGlyph(at: part.location), effectiveRange: nil) as! NSFont
        let baseline = line.minY + manager.location(forGlyphAt: part.location).y
        result.append(NSRect(x: box.minX + view.textContainerOrigin.x, y: baseline - font.xHeight + view.textContainerOrigin.y, width: box.width, height: font.xHeight))
    }
    return result
}
func point(_ string: String, fraction: CGFloat = 0.5) -> NSPoint {
    let box = body(text.range(of: string))[0]
    return NSPoint(x: box.minX + box.width * fraction, y: box.midY)
}
func event(_ type: NSEvent.EventType, _ at: NSPoint, clicks: Int = 1, flags: NSEvent.ModifierFlags = []) -> NSEvent {
    NSEvent.mouseEvent(with: type, location: view.convert(at, to: nil), modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: clicks, pressure: type == .leftMouseUp ? 0 : 1)!
}
/// As `ScrollerDrag`: what follows the press is queued for NSTextView's tracking loop.
func press(_ at: NSPoint, clicks: Int = 1, flags: NSEvent.ModifierFlags = [], path: [NSPoint] = []) {
    for spot in path { NSApp.postEvent(event(.leftMouseDragged, spot, clicks: clicks, flags: flags), atStart: false) }
    NSApp.postEvent(event(.leftMouseUp, path.last ?? at, clicks: clicks, flags: flags), atStart: false)
    // This process is inactive, so `NSWindow.sendEvent` would drop the press as an activation
    // click. The native chat-text check posts through the app's queue in the foreground.
    let down = event(.leftMouseDown, at, clicks: clicks, flags: flags)
    root.hitTest(down.locationInWindow)?.mouseDown(with: down)
    // A link click can return with its mouse-up unread; the app would deliver it as usual.
    while NSApp.nextEvent(matching: [.leftMouseUp, .leftMouseDragged], until: .distantPast, inMode: .default, dequeue: true) != nil {}
}
func spin(_ seconds: Double) {
    let end = Date(timeIntervalSinceNow: seconds)
    while Date() < end { RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.01)) }
}
/// Until the click has proved to be single. A timer in a process in the background can
/// fire well after its time, so this waits on the click itself.
func settle() {
    let start = Date()
    while view.clickTimer != nil, Date().timeIntervalSince(start) < 5 { spin(0.01) }
    require(view.clickTimer == nil, "The click settles")
}
func reset() { writes = []; view.setSelectedRange(NSRange(location: 0, length: 0)) }
/// A single click, after the double-click interval has passed.
func click(_ at: NSPoint, flags: NSEvent.ModifierFlags = []) -> String? {
    reset(); press(at, flags: flags); settle()
    require(writes.count <= 1, "One click is one write: \(writes)")
    return writes.first
}
require(window.contentView?.hitTest(view.convert(point("inline  code"), to: nil)) === view, "The click lands on the text view")

// Inline code: the whole payload from anywhere on it, whitespace and Unicode exact.
let first = click(point("inline  code"))
require(first == "inline  code", "Inline click: \(writes), timer \(view.clickTimer != nil), selection \(view.selectedRange()), snippet \(String(describing: view.snippet(at: point("inline  code")))), chips \(view.rich.snippets.map { view.inlineFrames($0) }.prefix(2)), at \(point("inline  code"))")
require(click(point("inline  code", fraction: 0.05)) == "inline  code", "Its first letter")
require(click(point("inline  code", fraction: 0.97)) == "inline  code", "Its last letter")
require(click(point("rm -rf ./nothing")) == "rm -rf ./nothing", "Code inside strong text copies, and runs nothing")
require(click(point("caf\u{E9} \u{1F680}")) == "caf\u{E9} \u{1F680}", "Unicode stays exact")
require(click(point("https://example.com/x")) == "https://example.com/x", "A URL in code copies and opens nothing")
require(click(point("in table")) == "in table", "Inline code in a table cell")
let wrapped = body(text.range(of: longCode))
require(wrapped.count >= 2, "The long snippet wraps: \(wrapped)")
for line in wrapped {
    require(click(NSPoint(x: line.midX, y: line.midY)) == longCode, "Every wrapped line copies the whole snippet: \(line)")
}

// A fenced block: only the code, from anywhere inside its background.
let codeLine = lines(text.range(of: "func caf"))[0]
require(click(NSPoint(x: codeLine.midX, y: codeLine.midY)) == block, "Block click: \(writes)")
require(click(NSPoint(x: width - 4, y: codeLine.midY)) == block, "Right of the code, inside the block")
require(click(NSPoint(x: width - 60, y: codeLine.minY - 16)) == block, "In the padding above the code")

// Not code: prose, the space beside a snippet, an empty block's filler.
require(click(point("Prose before")) == nil, "Prose does not copy")
require(click(point("Between.")) == nil, "Prose between blocks does not copy")
require(click(NSPoint(x: width - 3, y: lines(text.range(of: "Last words."))[0].midY)) == nil, "Space after a line does not copy")
let between = lines(text.range(of: "Between."))[0]
require(click(NSPoint(x: width / 2, y: between.minY - 6)) == nil, "The gap under a block does not copy the nearest code")
let filler = lines(NSRange(location: text.range(of: "Last words.").location - 2, length: 1))[0]
require(click(NSPoint(x: width / 2, y: filler.midY)) == nil, "An empty block's filler is not content")

// Modifiers, double and triple click, and a drag.
require(click(point("inline  code"), flags: .command) == nil, "Command-click does not copy")
require(click(point("inline  code"), flags: .shift) == nil, "Shift-click extends a selection only")
reset()
press(point("inline  code", fraction: 0.2)); press(point("inline  code", fraction: 0.2), clicks: 2); settle()
require(writes.isEmpty, "A double click does not copy")
require(view.selectedRange().length > 0 && text.substring(with: view.selectedRange()).contains("inline"), "A double click selects a word: \(view.selectedRange())")
reset()
press(point("inline  code")); press(point("inline  code"), clicks: 2); press(point("inline  code"), clicks: 3); settle()
require(writes.isEmpty, "A triple click does not copy")
require(view.selectedRange().length > 12, "A triple click selects the paragraph: \(view.selectedRange())")
reset()
press(point("inline  code", fraction: 0.1), path: [point("inline  code", fraction: 0.4), point("inline  code", fraction: 0.8)]); settle()
let dragged = view.selectedRange()
require(dragged.length > 0, "A drag inside the snippet selects: \(dragged)")
require(writes.isEmpty, "A drag does not copy")
require(view.selectionText == text.substring(with: dragged), "Copy gives the dragged part")
// Up and down one glyph there is nothing to select: only the distance tells it from a click.
let glyph = point("inline  code", fraction: 0.1)
reset()
press(NSPoint(x: glyph.x, y: glyph.y - 5), path: [NSPoint(x: glyph.x, y: glyph.y + 5)]); settle()
require(view.selectedRange().length == 0 && writes.isEmpty, "A drag that selects nothing does not copy: \(view.selectedRange()) \(writes)")
reset()
press(glyph, path: [NSPoint(x: glyph.x, y: glyph.y + 2)]); settle()
require(writes == ["inline  code"], "A hand's slight movement during a click still copies: \(writes)")
reset()
press(glyph, path: [point("and after"), glyph]); settle()
require(view.selectedRange().length == 0 && writes.isEmpty, "A drag back to its start is still a drag: \(view.selectedRange()) \(writes)")
reset()
press(point("Prose before"), path: [point("inline  code"), point("and after")]); settle()
require(view.selectedRange().length > 0 && writes.isEmpty, "A drag out of prose over code does not copy")
press(point("inline  code")); settle()
require(writes.isEmpty && view.selectedRange().length == 0, "A click that clears a selection only clears it, so it keeps what was copied: \(writes)")
require(click(point("inline  code")) == "inline  code", "The next click copies again")

// Links: an explicit link keeps priority, even when its text is code.
var routed: [String] = []
view.onLink = { routed.append($0) }
reset()
press(point("a link")); settle()
require(writes.isEmpty && routed == ["trezi-code:src/a.ts#L1"], "A link opens and does not copy: \(writes) \(routed)")
load("See [`linked`](trezi-code:src/b.ts#L2) and `plain`.")
routed = []
require(click(point("linked")) == nil && routed == ["trezi-code:src/b.ts#L2"], "Code in a link is the link: \(writes) \(routed)")
require(view.rich.snippets.map(\.text) == ["plain"], "Only real code outside links is a snippet: \(view.rich.snippets)")
view.onLink = nil

// Chips: only on code, one rect per wrapped line, around the glyphs and clear of the
// neighbours and of each other. A separator newline inherits no code identity.
load(markdown)
require(view.rich.snippets.map(\.block) == [false, false, false, false, false, false, true], "Inline and fenced snippets; the empty block is none: \(view.rich.snippets.map(\.text))")
require(view.rich.snippets.allSatisfy { text.substring(with: $0.range).contains($0.text) || $0.block }, "Snippets hold their shown text")
load("Ends in `code`\n\nNext `one`")
require(view.rich.snippets.map(\.text) == ["code", "one"] && view.rich.snippets[0].range.upperBound == text.range(of: "\n").location, "The newline after a snippet is not part of it")
load(markdown)
for snippet in view.rich.snippets where !snippet.block {
    let frames = view.inlineFrames(snippet), shown = lines(snippet.range)
    require(frames.count == shown.count, "One chip per line: \(snippet.text) \(frames) \(shown)")
    for (frame, glyphs) in zip(frames, shown) {
        require(frame.minX >= 0 && frame.maxX <= width + 0.5, "The chip stays in the view: \(frame)")
        require(frame.minY <= glyphs.minY + 4 && frame.maxY >= glyphs.minY + 12, "The chip holds the line's glyphs: \(frame) \(glyphs)")
        require(frame.minX <= glyphs.minX && frame.maxX >= glyphs.maxX - 0.5, "The chip spans the glyphs: \(frame) \(glyphs)")
    }
    require(zip(frames, frames.dropFirst()).allSatisfy { $0.maxY <= $1.minY }, "Wrapped chips do not overlap: \(frames)")
    // The neighbours on the same line: the width kerned onto the one before is the chip's.
    let before = lines(NSRange(location: snippet.range.location - 1, length: 1))[0]
    if abs(before.midY - shown[0].midY) < 4 {
        require(frames[0].minX >= before.maxX - ChatRichText.inlinePadding - 0.5, "The chip stops short of the text before it: \(frames[0]) \(before)")
    }
    let after = NSRange(location: snippet.range.upperBound, length: 1)
    if after.upperBound <= text.length, abs(lines(after)[0].midY - shown.last!.midY) < 4 {
        require(frames.last!.maxX <= lines(after)[0].minX + 0.5, "The chip stops short of the text after it: \(frames.last!) \(lines(after)[0])")
    }
}
require(view.snippet(at: point("Prose before")) == nil, "Prose has no chip")
require(view.snippet(at: point("cell")) == nil, "A table's own cells have no chip")
require(view.snippet(at: point("a link")) == nil, "A link has no chip")

// Copied: only after a write that worked, beside the click, passing clicks through.
func toast() -> ChatCopiedToast? { root.subviews.compactMap { $0 as? ChatCopiedToast }.first }
let spot = point("inline  code")
spin(ChatCopiedToast.lifetime + 0.1)
reset(); press(spot)
require(toast() == nil, "Nothing shows before the click has proved to be single")
settle()
guard let shown = toast() else { require(false, "Copied shows after the write: \(writes)"); exit(1) }
let click1 = view.convert(spot, to: nil)
require(ChatCopiedToast.current === shown && shown.frame.height <= 24 && shown.frame.width <= 70, "Small: \(shown.frame)")
require(hypot(shown.frame.midX - click1.x, shown.frame.midY - click1.y) < 70 && !shown.frame.contains(click1), "Beside the click, not under it: \(shown.frame) \(click1)")
require(root.frame.contains(shown.frame), "Inside the window: \(shown.frame)")
require(root.hitTest(NSPoint(x: shown.frame.midX, y: shown.frame.midY)) !== shown, "Clicks pass through it")
require(!shown.acceptsFirstResponder && window.firstResponder === view, "It takes no focus")
let frameKept = view.frame
reset(); press(point("rm -rf ./nothing")); settle()
let toasts = root.subviews.compactMap { $0 as? ChatCopiedToast }
require(toasts.count == 1 && toasts[0] !== shown && shown.superview == nil, "A repeated click replaces it: \(toasts)")
require(view.frame == frameKept, "Nothing moved")
let settled = Date()
while toast() != nil, Date().timeIntervalSince(settled) < 3 { spin(0.02) }
require(toast() == nil, "It dismisses itself")
writable = false
require(click(spot) == "inline  code", "The failed write was tried")
require(toast() == nil && ChatCopiedToast.current == nil, "A failed write shows nothing")
writable = true
reset(); view.copyButtons[0].performClick(nil)
require(writes == [block] && toast() != nil, "The Copy button writes the raw code and uses the same feedback: \(writes)")
let button = view.copyButtons[0].convert(NSPoint(x: 9, y: 9), to: nil)
require(hypot(toast()!.frame.midX - button.x, toast()!.frame.midY - button.y) < 70, "Beside the button: \(toast()!.frame)")
reset(); press(spot); view.copyButtons[0].performClick(nil); settle()
require(writes == [block], "A waiting click does not overwrite the Copy button's text: \(writes)")
let emptyButton = view.rich.blocks.filter { $0.kind == .code }.count - 1
require(view.code(at: emptyButton) == "", "An empty block has no code to copy")
reset(); view.copyButtons[emptyButton].performClick(nil)
require(writes.isEmpty, "Its Copy button writes nothing")

// Placement: flips and stays inside the visible area in each corner.
let area = NSRect(x: 100, y: 100, width: 300, height: 200), toastSize = NSSize(width: 54, height: 22)
for near in [NSPoint(x: 105, y: 105), NSPoint(x: 395, y: 105), NSPoint(x: 105, y: 295), NSPoint(x: 395, y: 295), NSPoint(x: 250, y: 200)] {
    let placed = ChatCopiedToast.place(toastSize, near: near, in: area)
    require(area.contains(placed), "Kept inside: \(placed) for \(near)")
    require(!placed.contains(near), "Not under the cursor: \(placed) for \(near)")
    require(hypot(placed.midX - near.x, placed.midY - near.y) < 70, "Still beside the cursor: \(placed) for \(near)")
}

// Stale work: a reparse, a reuse and a close each drop a waiting click and the feedback.
reset(); press(spot)
load("Something else `entirely` now.")
settle()
require(writes.isEmpty, "A reparse that moved the snippet drops the click: \(writes)")
load(markdown)
reset(); press(spot)
view.show(markdown + "\n\nMore streamed words.", streaming: true); view.layout()
settle()
require(writes == ["inline  code"], "Text streaming on after the snippet keeps the click: \(writes)")
let drag = "```\nfirst\n"
load(drag)
reset(); press(lines(text.range(of: "first"))[0].origin)
view.show(drag + "second\n", streaming: true); view.layout()
settle()
require(writes.isEmpty, "A block that grew is not what was clicked: \(writes)")
load(markdown)
reset(); press(spot); view.identity = "reused#0"; settle()
require(writes.isEmpty, "Reuse for another message drops the click")
reset(); press(spot); settle()
require(toast() != nil, "Feedback before the reuse")
view.identity = "next#0"
require(toast() == nil, "Reuse removes the feedback")
reset(); press(spot); settle()
require(toast() != nil, "Feedback before the close")
reset(); press(spot); view.removeFromSuperview(); settle()
require(writes.isEmpty && toast() == nil, "Leaving the window drops the click and the feedback")
print("CHAT-CODE-CLICK PASS — single clicks copy raw inline and fenced code; drags, double clicks, links, prose and filler do not; chips, Copied feedback and cleanup")
