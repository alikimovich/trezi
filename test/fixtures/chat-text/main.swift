import AppKit

// LKM-186: one assistant segment in one text view, laid out offscreen (no window).
func require(_ condition: Bool, _ message: String) {
    if !condition { fputs("FAIL: \(message)\n", stderr); exit(1) }
}
let markdown = """
First paragraph with a [link](https://example.com) and `inline code`.
A soft line break stays in the paragraph.

- one
- two

## Heading

```swift
let first = 1
```

| Name | Value |
| --- | --- |
| a | 1 |

Between the blocks.

```js
const last = 2
```
"""
let view = ChatTextView.make()
view.show(markdown, streaming: false)
let size = view.fittingSize(width: 360)
view.frame = NSRect(x: 0, y: 0, width: 360, height: size.height)
view.layout()
let text = view.string as NSString
require(view.rich.blocks.map(\.kind.rawValue) == ["text", "text", "heading", "code", "table", "text", "code"], "Blocks: \(view.rich.blocks.map(\.kind.rawValue))")
require(text.range(of: "First paragraph").location == 0 && text.hasSuffix("const last = 2"), "One string holds the whole segment")

// Rendering: links, inline code, backgrounds and Copy buttons.
let link = text.range(of: "link")
require(view.textStorage?.attribute(.link, at: link.location, effectiveRange: nil) as? URL == URL(string: "https://example.com"), "The link keeps its URL")
let inline = view.textStorage?.attribute(.font, at: text.range(of: "inline code").location, effectiveRange: nil) as? NSFont
require(inline?.fontDescriptor.symbolicTraits.contains(.monoSpace) == true, "Inline code is monospaced")
let frames = view.blockFrames()
require(frames.map(\.block.kind.rawValue) == ["code", "table", "code"], "Code and table backgrounds: \(frames.map(\.block.kind.rawValue))")
require(zip(frames, frames.dropFirst()).allSatisfy { $0.frame.maxY < $1.frame.minY }, "Backgrounds do not overlap: \(frames.map(\.frame))")
require(frames.allSatisfy { $0.frame.minX == 0 && $0.frame.width == 360 && $0.frame.maxY <= size.height }, "Backgrounds span the width inside the height \(size.height): \(frames.map(\.frame))")
require(frames[1].rule.map { $0 > frames[1].frame.minY && $0 < frames[1].frame.maxY } == true, "The table has a header rule")
let manager = view.layoutManager!
func glyphs(_ range: NSRange) -> NSRect { manager.boundingRect(forGlyphRange: manager.glyphRange(forCharacterRange: range, actualCharacterRange: nil), in: view.textContainer!) }
let firstCode = glyphs(text.range(of: "let first = 1"))
require(frames[0].frame.contains(firstCode) && firstCode.minY - frames[0].frame.minY >= ChatRichText.codeTop - 1, "Code sits inside its padded background \(firstCode) \(frames[0].frame)")
require(view.copyButtons.count == 2 && zip(view.copyButtons, [frames[0], frames[2]]).allSatisfy { $1.frame.contains($0.frame) && !$0.frame.intersects(glyphs($1.block.range)) }, "Each code block has a Copy button clear of its code")

// A drag from the first paragraph to the end of the last code block, by point.
let pasteboard = NSPasteboard(name: NSPasteboard.Name("trezi.chat-text-fixture.\(UUID().uuidString)"))
defer { pasteboard.releaseGlobally() }
ChatTextView.pasteboard = pasteboard
// A sandboxed run has no pasteboard server: then check the text Copy writes.
pasteboard.clearContents()
let usable = pasteboard.setString("probe", forType: .string)
func copied() -> String {
    view.copy(nil)
    return usable ? pasteboard.string(forType: .string) ?? "" : view.selectionText
}
let start = glyphs(NSRange(location: 0, length: 1)), end = glyphs(text.range(of: "const last = 2"))
let from = view.characterIndexForInsertion(at: NSPoint(x: start.minX + 1, y: start.midY))
let to = view.characterIndexForInsertion(at: NSPoint(x: end.maxX + 20, y: end.midY))
require(from == 0 && to == text.length, "Points map to the segment's ends: \(from)…\(to) of \(text.length)")
view.setSelectedRange(NSRange(location: from, length: to - from))
let expected = """
First paragraph with a link and inline code.
A soft line break stays in the paragraph.

- one
- two

Heading

```swift
let first = 1
```

| Name | Value |
| --- | --- |
| a | 1 |

Between the blocks.

```js
const last = 2
```
"""
let all = copied()
require(all == expected, "Copy keeps paragraph breaks and fences:\n\(all)")

// Select All, a part of a code block and the code Copy button.
view.setSelectedRange(NSRange(location: 3, length: 0))
view.selectAll(nil)
require(view.selectedRange() == NSRange(location: 0, length: text.length), "Select All selects the whole segment")
let part = text.range(of: "first = 1")
view.setSelectedRange(part)
require(copied() == "first = 1", "A part of a code block copies without fences")
view.setSelectedRange(NSRange(location: text.range(of: "Between").location, length: text.length - text.range(of: "Between").location))
require(copied() == "Between the blocks.\n\n```js\nconst last = 2\n```", "A partial drag ending in a whole code block")
view.copyButtons[1].performClick(nil)
require(view.code(at: 1) == "const last = 2", "The code Copy button copies the code")
require(!usable || pasteboard.string(forType: .string) == "const last = 2", "The code Copy button writes the pasteboard")

// Streaming: an unfinished fence lays out as code; a reparse keeps one view.
view.show("Streaming\n\n```ts\nconst a", streaming: true)
require(view.rich.blocks.map(\.kind.rawValue) == ["text", "code"] && view.string == "Streaming\nconst a", "Unfinished fence: \(view.string)")
let wider = view.fittingSize(width: 600), narrower = view.fittingSize(width: 120)
require(narrower.height >= wider.height && wider.width == 600, "Height follows the proposed width")
print("CHAT-TEXT PASS — one view per segment: drag, Select All, Copy (fences kept), code Copy buttons and backgrounds")
