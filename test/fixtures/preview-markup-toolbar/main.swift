import AppKit

// LKM-647: the compact, contextual Mark up island and single-mark selection. Real views in a
// window that is never ordered in. With MARKUP_TOOLBAR_SHOTS set, each state is also written
// there as a PNG (offscreen: Liquid Glass is not painted, the opaque face is).
func check(_ condition: @autoclosure () -> Bool, _ label: String, line: Int = #line) {
    if !condition() { FileHandle.standardError.write(Data("FAIL \(label) (line \(line))\n".utf8)); exit(1) }
}
func near(_ a: CGFloat, _ b: CGFloat, _ tolerance: CGFloat = 0.5) -> Bool { abs(a - b) <= tolerance }
func solid(_ width: Int, _ height: Int, _ color: CGColor) -> CGImage {
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    context.setFillColor(color); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    return context.makeImage()!
}
final class Pixels {
    let width: Int, height: Int, bytes: [UInt8]
    init(_ image: CGImage) {
        let width = image.width, height = image.height
        self.width = width; self.height = height
        var data = [UInt8](repeating: 0, count: width * height * 4)
        data.withUnsafeMutableBytes { raw in
            CGContext(data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        bytes = data
    }
    func rgb(_ x: Int, _ y: Int) -> (r: Int, g: Int, b: Int) {
        let i = (y * width + x) * 4
        return (Int(bytes[i]), Int(bytes[i + 1]), Int(bytes[i + 2]))
    }
    func count(_ test: ((r: Int, g: Int, b: Int)) -> Bool) -> Int {
        var n = 0
        for y in 0..<height { for x in 0..<width where test(rgb(x, y)) { n += 1 } }
        return n
    }
}
func decode(_ data: Data) -> CGImage { NSBitmapImageRep(data: data)!.cgImage! }
func key(_ characters: String, _ code: UInt16, _ modifiers: NSEvent.ModifierFlags = [], window: NSWindow) -> NSEvent {
    NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: 0, windowNumber: window.windowNumber, context: nil,
                     characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code)!
}

_ = NSApplication.shared
let shots = ProcessInfo.processInfo.environment["MARKUP_TOOLBAR_SHOTS"]
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800), styleMask: [.titled], backing: .buffered, defer: true)
window.isReleasedWhenClosed = false
let white = CGColor(srgbRed: 0.98, green: 0.98, blue: 0.98, alpha: 1)
let image = solid(1600, 1000, white)
let overlay = PreviewMarkupOverlay(image: image)
overlay.frame = NSRect(x: 0, y: 0, width: 800, height: 500)
window.contentView!.addSubview(overlay)
overlay.layoutSubtreeIfNeeded(); overlay.layout()
window.makeFirstResponder(overlay)
let canvas = overlay.canvas
let pageFrame = canvas.frame
func control(_ label: String) -> NSButton { overlay.controls.first { $0.cell?.accessibilityLabel() == label }! }
func shown() -> [String] {
    var names = overlay.controls.filter { !$0.isHidden }.map { $0.cell?.accessibilityLabel() ?? "" }
    if !overlay.colorWell.isHidden { names.insert("Color", at: names.firstIndex(of: "Stroke width") ?? names.firstIndex(of: "Undo") ?? names.count - 1) }
    return names
}
func shot(_ name: String) {
    guard let shots else { return }
    overlay.layoutSubtreeIfNeeded(); overlay.display()
    let rep = overlay.bitmapImageRepForCachingDisplay(in: overlay.bounds)!
    overlay.cacheDisplay(in: overlay.bounds, to: rep)
    try? rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: shots).appendingPathComponent("\(name).png"))
}
/// The island stays inside the page at its bottom, Close at its right edge, nothing overlaps,
/// and the snapshot never moves.
func placed(_ label: String) {
    let island = overlay.barFrame, page = canvas.frame
    check(canvas.frame == pageFrame || label.hasPrefix("narrow"), "\(label): the snapshot never moves for the toolbar")
    check(page.contains(island) && near(island.maxY, page.maxY - PreviewMarkupOverlay.inset, 1), "\(label): at the bottom, inside the page: \(island) in \(page)")
    let close = control("Close annotation tools").convert(control("Close annotation tools").bounds, to: overlay)
    check(!control("Close annotation tools").isHidden && near(close.maxX, island.maxX - 8, 1), "\(label): Close at the right edge")
    let views: [NSView] = overlay.controls.filter { !$0.isHidden } + (overlay.colorWell.isHidden ? [] : [overlay.colorWell])
    let frames = views.map { $0.convert($0.bounds, to: overlay) }
    for (i, a) in frames.enumerated() {
        check(island.contains(a), "\(label): \(i) inside the island")
        for b in frames[(i + 1)...] { check(!a.intersects(b), "\(label): controls overlap") }
    }
}

// MARK: idle: compact, no filler, Close at the right
check(shown() == ["Select", "Pen", "Rectangle", "Shapes", "Text", "Close annotation tools"], "idle is compact: \(shown())")
check(overlay.statusText.isEmpty && !overlay.addEnabled && !overlay.undoEnabled, "no filler text, no disabled Add or Undo on show")
let close = control("Close annotation tools")
check(close.image?.accessibilityDescription == "Close annotation tools" && close.title.isEmpty && close.toolTip == "Close annotation tools (Esc)", "an icon-only X with its label and tooltip")
placed("idle"); let idleWidth = overlay.barFrame.width
shot("1-idle")

// MARK: a drawing tool: its colour and stroke, nothing else yet
overlay.keyDown(with: key("p", 35, window: window))
check(shown() == ["Select", "Pen", "Rectangle", "Shapes", "Text", "Color", "Stroke width", "Close annotation tools"], "the pen adds colour and stroke: \(shown())")
check(overlay.barFrame.width > idleWidth, "the island widens with the context")
placed("pen")
overlay.keyDown(with: key("t", 17, window: window))
check(!overlay.colorWell.isHidden && overlay.strokePopUp.isHidden, "Text: colour, no stroke width")
overlay.select(.select)
check(shown().count == 6, "Select with nothing picked: compact again")
// The shapes menu holds every shape.
check(overlay.shapeMenu.items.map(\.title) == ["Rectangle", "Circle", "Arrow"], "the shapes menu")
overlay.shapeMenu.performActionForItem(at: 1)
check(overlay.tool == .circle && control("Circle").state == .on && overlay.shapeMenu.items[1].state == .on, "a menu choice picks that shape in the slot")
overlay.select(.rectangle)
check(control("Rectangle").state == .on, "R or the menu: Rectangle")

// MARK: drawing: per-mark stroke and colour; history, Delete and Add appear
let map = canvas.mapping
func drag(_ from: CGPoint, _ to: CGPoint, tool: MarkupTool? = nil) {
    canvas.pointerDown(map.toView(from), tool: tool ?? overlay.tool)
    canvas.pointerDragged(map.toView(CGPoint(x: (from.x + to.x) / 2, y: (from.y + to.y) / 2)))
    canvas.pointerDragged(map.toView(to)); canvas.pointerUp()
}
overlay.strokePopUp.selectItem(at: 2)
_ = overlay.strokePopUp.sendAction(overlay.strokePopUp.action, to: overlay.strokePopUp.target)
check(canvas.stroke == .thick, "the stroke menu sets the next mark's weight")
drag(CGPoint(x: 200, y: 200), CGPoint(x: 600, y: 500))
overlay.strokePopUp.selectItem(at: 0)
_ = overlay.strokePopUp.sendAction(overlay.strokePopUp.action, to: overlay.strokePopUp.target)
overlay.keyDown(with: key("a", 0, window: window))
drag(CGPoint(x: 900, y: 200), CGPoint(x: 1300, y: 500))
check(canvas.document.marks.map(\.stroke) == [.thick, .thin], "each mark keeps its own weight")
check(shown() == ["Select", "Pen", "Arrow", "Shapes", "Text", "Color", "Stroke width", "Undo", "Redo", "Delete", "Add to chat", "Close annotation tools"], "content: history, Delete and Add: \(shown())")
check(overlay.addEnabled && overlay.undoEnabled && !overlay.redoEnabled && !overlay.deleteEnabled, "Add and Undo on; Redo and Delete off with nothing to redo or selected")
check(close.toolTip?.contains("discard") == true, "Close says it discards unsent marks")
placed("drawn")
shot("2-drawn")
// The thick mark really is thicker in what is sent.
let base = MarkupRenderer.lineWidth(for: canvas.document.size)
let flat = Pixels(MarkupRenderer.composite(image, marks: canvas.document.marks, maxPixels: 2048)!)
let redInk: ((r: Int, g: Int, b: Int)) -> Bool = { $0.r > 140 && $0.g < 90 && $0.b < 90 }
let thick = (150..<250).filter { redInk(flat.rgb(400, $0)) }.count
check(abs(CGFloat(thick) - base * 2) <= 2, "a thick mark is twice the base width: \(thick) vs \(base * 2)")

// MARK: select a mark: its own colour and weight, decoration only
overlay.select(.select)
canvas.pointerDown(map.toView(CGPoint(x: 400, y: 200)), tool: .select); canvas.pointerUp()
check(canvas.selection == 0 && canvas.selectedMark?.tool == .rectangle, "a click on its stroke selects the rectangle")
check(!overlay.colorWell.isHidden && !overlay.strokePopUp.isHidden && overlay.deleteEnabled, "a selected shape shows colour, stroke and Delete")
check(overlay.strokePopUp.titleOfSelectedItem == "Thick", "the stroke menu shows its weight")
check(overlay.colorWell.toolTip == "Color for the selected rectangle", "and says what it targets")
canvas.pointerDown(map.toView(CGPoint(x: 400, y: 350)), tool: .select); canvas.pointerUp()
check(canvas.selection == nil && canvas.region.rect == nil, "a click inside an unfilled shape selects nothing and makes no region")
canvas.pointerDown(map.toView(CGPoint(x: 400, y: 200)), tool: .select); canvas.pointerUp()
let beforeSelect = MarkupEncoder.encode(image, marks: canvas.document.marks)!.data
let painted = { () -> Pixels in
    let rep = canvas.bitmapImageRepForCachingDisplay(in: canvas.bounds)!; canvas.cacheDisplay(in: canvas.bounds, to: rep); return Pixels(rep.cgImage!)
}()
let corner = map.toView(CGPoint(x: 600, y: 500)), scale = CGFloat(painted.width) / canvas.bounds.width
let handle = painted.rgb(Int(corner.x * scale), Int(corner.y * scale))
check(handle.b > handle.r + 40, "the canvas shows an accent handle on the corner: \(handle)")
check(MarkupEncoder.encode(image, marks: canvas.document.marks)!.data == beforeSelect, "selection outline and handles never reach the image")
shot("3-selected")
// Colour from the standard panel: only the selected mark, one Undo step for a live drag.
overlay.colorWell.activate(true)
check(NSColorPanel.shared.isVisible && overlay.colorWell.isActive, "the swatch opens the standard color panel")
let thinInk = canvas.document.marks[1].ink, defaultInk = canvas.ink
for blue in [0.5, 0.7, 0.9] { NSColorPanel.shared.color = NSColor(srgbRed: 0.1, green: 0.3, blue: blue, alpha: 1) }
check(canvas.document.marks[0].ink.hex == MarkupInk(red: 0.1, green: 0.3, blue: 0.9).hex, "the selected rectangle takes the colour")
check(canvas.document.marks[1].ink == thinInk && canvas.ink == defaultInk, "no other mark, and not the next marks")
overlay.strokePopUp.selectItem(at: 1)
_ = overlay.strokePopUp.sendAction(overlay.strokePopUp.action, to: overlay.strokePopUp.target)
check(canvas.document.marks.map(\.stroke) == [.medium, .thin] && canvas.stroke == .thin, "stroke: the selected mark only")
overlay.undo()
check(canvas.document.marks[0].stroke == .thick && canvas.document.marks[0].ink.hex == MarkupInk(red: 0.1, green: 0.3, blue: 0.9).hex, "Undo takes the stroke change")
overlay.undo()
check(canvas.document.marks[0].ink == thinInk && canvas.selection == 0, "and the whole colour drag in one step, the mark still selected")
check(overlay.redoEnabled, "Redo is on")
check(overlay.performKeyEquivalent(with: key("z", 6, [.command, .shift], window: window)), "⇧⌘Z belongs to the overlay")
check(canvas.document.marks[0].ink.hex == MarkupInk(red: 0.1, green: 0.3, blue: 0.9).hex && overlay.redoEnabled, "Redo replays the colour")
overlay.releaseColorPanel()
// Move by its stroke and resize by a handle: one step each, captured pixels.
drag(CGPoint(x: 300, y: 200), CGPoint(x: 350, y: 260), tool: .select)
check(canvas.document.marks[0].points == [CGPoint(x: 250, y: 260), CGPoint(x: 650, y: 560)], "dragging the stroke moves it: \(canvas.document.marks[0].points)")
check(!overlay.redoEnabled, "a new edit drops the redo branch")
drag(CGPoint(x: 650, y: 560), CGPoint(x: 800, y: 700), tool: .select)
check(canvas.document.marks[0].points == [CGPoint(x: 250, y: 260), CGPoint(x: 800, y: 700)] && canvas.selection == 0, "the corner handle resizes")
overlay.undo(); check(canvas.document.marks[0].points[1] == CGPoint(x: 650, y: 560), "Undo takes the resize")
overlay.undo(); check(canvas.document.marks[0].points[0] == CGPoint(x: 200, y: 200), "then the move")
// An arrow's ends.
canvas.pointerDown(map.toView(CGPoint(x: 1100, y: 350)), tool: .select); canvas.pointerUp()
check(canvas.selectedMark?.tool == .arrow, "the arrow selects by its shaft")
drag(CGPoint(x: 1300, y: 500), CGPoint(x: 1400, y: 300), tool: .select)
check(canvas.document.marks[1].points == [CGPoint(x: 900, y: 200), CGPoint(x: 1400, y: 300)], "its head end moves alone")

// MARK: Delete, Clear All, Escape
let count = canvas.document.marks.count
overlay.keyDown(with: key("\u{7f}", 51, window: window))
check(canvas.document.marks.count == count - 1 && canvas.document.marks[0].tool == .rectangle && canvas.selection == nil, "⌫ deletes only the selected arrow")
check(!overlay.deleteEnabled, "nothing selected: Delete is off")
overlay.undo(); check(canvas.document.marks.count == count, "Undo brings it back")
drag(CGPoint(x: 100, y: 100), CGPoint(x: 1500, y: 900), tool: .select)
check(canvas.region.valid != nil && canvas.selection == nil && overlay.deleteEnabled, "a drag off the marks selects a region; Delete can remove it")
shot("4-marks-and-region")
canvas.pointerDown(map.toView(CGPoint(x: 400, y: 200)), tool: .select); canvas.pointerUp()
check(canvas.selection == 0 && canvas.region.valid != nil, "a mark selects inside a region, the region stays")
overlay.deleteSelection()
check(canvas.document.marks.count == count - 1 && canvas.region.valid != nil, "Delete takes the selected mark first, not the region")
overlay.undo()
var cancelled = 0
overlay.onCancel = { cancelled += 1 }
canvas.pointerDown(map.toView(CGPoint(x: 400, y: 200)), tool: .select); canvas.pointerUp()
overlay.keyDown(with: key("\u{1b}", 53, window: window))
check(canvas.selection == nil && canvas.region.valid != nil && cancelled == 0, "Escape lets go of the mark first")
overlay.deleteSelection()
check(canvas.region.rect == nil && canvas.document.marks.count == count, "Delete with only a region removes the region, no mark")
canvas.clearFromMenu()
check(canvas.document.marks.isEmpty && overlay.undoEnabled, "Clear All is its own action, one step")
check(shown() == ["Select", "Pen", "Arrow", "Shapes", "Text", "Undo", "Redo", "Close annotation tools"] && overlay.undoEnabled && !overlay.redoEnabled, "after Clear All: \(shown())")
check(overlay.controls.first { $0.cell?.accessibilityLabel() == "Add to chat" }!.isHidden && !shown().contains("Delete"), "nothing to send: Add and Delete go")
overlay.undo(); check(canvas.document.marks.count == count && overlay.addEnabled, "Undo of Clear All brings them back")
while overlay.undoEnabled { overlay.undo() }
check(canvas.document.marks.isEmpty && shown() == ["Select", "Pen", "Arrow", "Shapes", "Text", "Undo", "Redo", "Close annotation tools"], "undone to nothing: compact, Redo kept: \(shown())")
check(!overlay.undoEnabled && overlay.redoEnabled, "only Redo is live")
shot("5-undone")
overlay.keyDown(with: key("\u{1b}", 53, window: window)); check(cancelled == 1, "then Escape closes")
overlay.redo(); check(canvas.document.marks.count == 1, "Redo replays the first mark")
// Crop only.
let region = PreviewMarkupOverlay(image: image)
region.frame = overlay.frame; window.contentView!.addSubview(region); region.layoutSubtreeIfNeeded(); region.layout()
let regionMap = region.canvas.mapping
region.canvas.pointerDown(regionMap.toView(CGPoint(x: 300, y: 300)), tool: .select)
region.canvas.pointerDragged(regionMap.toView(CGPoint(x: 900, y: 700))); region.canvas.pointerUp()
check(region.addEnabled && region.deleteEnabled && !region.undoEnabled && region.colorWell.isHidden && region.strokePopUp.isHidden, "a region alone: Add and Delete, no colour or stroke")
region.removeFromSuperview()

// MARK: text editing keeps its own Undo
overlay.select(.text)
canvas.pointerDown(map.toView(CGPoint(x: 300, y: 700)), tool: .text)
check(window.firstResponder is NSText, "typing on the canvas")
check(!overlay.performKeyEquivalent(with: key("z", 6, .command, window: window)), "⌘Z in the text field is the text field's")
canvas.commitText()
window.makeFirstResponder(overlay)

// MARK: busy and failure stay discoverable
overlay.select(.pen)
drag(CGPoint(x: 100, y: 800), CGPoint(x: 500, y: 850))
overlay.adding = true
check(overlay.statusText == "Adding…" && !overlay.addEnabled && control("Add to chat").title == "Adding…" && !control("Add to chat").isHidden, "Adding shows on the button")
overlay.adding = false
overlay.show(error: "The image could not be added to the chat.")
check(overlay.statusText.hasPrefix("The image") && overlay.errorShown, "a failure is on screen")
placed("error")
shot("6-error")
overlay.show(error: nil)

// MARK: a constrained pane: Close and Add reachable, nothing clipped
for width in [CGFloat(360), 300] {
    overlay.frame = NSRect(x: 0, y: 0, width: width, height: 500); overlay.layout()
    placed("narrow \(width)")
    let add = control("Add to chat").convert(control("Add to chat").bounds, to: overlay)
    check(!control("Add to chat").isHidden && overlay.canvas.frame.contains(add) && overlay.addEnabled, "\(width): Add is visible")
    let host = overlay.superview!
    for label in ["Add to chat", "Close annotation tools"] {
        let frame = control(label).convert(control(label).bounds, to: overlay)
        check(overlay.hitTest(host.convert(NSPoint(x: frame.midX, y: frame.midY), from: overlay)) === control(label), "\(width): \(label) takes its click")
    }
    shot("7-narrow-\(Int(width))")
}
print("{\"ok\":true}")
