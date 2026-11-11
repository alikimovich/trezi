import AppKit

// LKM-646: Mark up's Select region tool. Real views in a window that is never ordered in.
var failures = 0
func check(_ condition: @autoclosure () -> Bool, _ label: String, line: Int = #line) {
    if !condition() { FileHandle.standardError.write(Data("FAIL \(label) (line \(line))\n".utf8)); exit(1) }
}
func srgb(_ hex: Int) -> CGColor {
    CGColor(srgbRed: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
}
/// Four flat quadrants (top-left origin): TL red, TR green, BL blue, BR yellow.
let quadrantColors = [0xd02020, 0x20a040, 0x2040d0, 0xe0c020]
func quadrants(_ width: Int, _ height: Int) -> CGImage {
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    // Core Graphics runs up: y = height / 2 ..< height is the top half.
    let w = CGFloat(width) / 2, h = CGFloat(height) / 2
    for (index, rect) in [CGRect(x: 0, y: h, width: w, height: h), CGRect(x: w, y: h, width: w, height: h), CGRect(x: 0, y: 0, width: w, height: h), CGRect(x: w, y: 0, width: w, height: h)].enumerated() {
        context.setFillColor(srgb(quadrantColors[index])); context.fill(rect)
    }
    return context.makeImage()!
}
final class Pixels {
    let width: Int, height: Int, bytes: [UInt8]
    init(_ image: CGImage) {
        width = image.width; height = image.height
        var data = [UInt8](repeating: 0, count: width * height * 4)
        data.withUnsafeMutableBytes { raw in
            let context = CGContext(data: raw.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }
        bytes = data
    }
    func rgb(_ x: Int, _ y: Int) -> Int {
        let i = (y * width + x) * 4
        return Int(bytes[i]) << 16 | Int(bytes[i + 1]) << 8 | Int(bytes[i + 2])
    }
    func near(_ x: Int, _ y: Int, _ hex: Int, _ tolerance: Int = 3) -> Bool {
        let c = rgb(x, y)
        return [16, 8, 0].allSatisfy { abs((c >> $0 & 0xff) - (hex >> $0 & 0xff)) <= tolerance }
    }
    /// Pixels not within `tolerance` of `hex`.
    func other(than hex: Int, tolerance: Int = 3) -> Int {
        var count = 0
        for y in 0..<height { for x in 0..<width where !near(x, y, hex, tolerance) { count += 1 } }
        return count
    }
}
func decode(_ data: Data) -> CGImage { NSBitmapImageRep(data: data)!.cgImage! }
func key(_ characters: String, _ code: UInt16, window: NSWindow) -> NSEvent {
    NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil,
                     characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code)!
}

_ = NSApplication.shared
let size = CGSize(width: 800, height: 400)

// MARK: the region model
var region = MarkupRegion(size: size)
check(region.rect == nil && region.valid == nil, "starts with none")
region.begin(at: CGPoint(x: 100.4, y: 50.6)); region.extend(to: CGPoint(x: 300.2, y: 150.5))
check(region.isDragging && region.valid == nil, "a region in progress is not sendable")
region.finish()
check(region.valid == CGRect(x: 100, y: 51, width: 200, height: 100), "whole captured pixels: \(String(describing: region.valid))")
var reverse = MarkupRegion(size: size)
reverse.begin(at: CGPoint(x: 300, y: 151)); reverse.extend(to: CGPoint(x: 100, y: 51)); reverse.finish()
check(reverse.valid == region.valid, "a drag in the other direction makes the same region")
var outside = MarkupRegion(size: size)
outside.begin(at: CGPoint(x: 700, y: 300)); outside.extend(to: CGPoint(x: 5000, y: -90)); outside.finish()
check(outside.valid == CGRect(x: 700, y: 0, width: 100, height: 300), "clamped to the snapshot: \(String(describing: outside.valid))")
var tiny = MarkupRegion(size: size)
tiny.begin(at: CGPoint(x: 10, y: 10)); tiny.extend(to: CGPoint(x: 12, y: 300)); tiny.finish()
check(tiny.rect == nil && tiny.valid == nil, "a sliver is no region")
tiny.begin(at: CGPoint(x: 10, y: 10)); tiny.finish()
check(tiny.rect == nil, "a click is no region")
var wide = MarkupRegion(size: size)
wide.begin(at: CGPoint(x: -50, y: -50)); wide.extend(to: CGPoint(x: -10, y: 900)); wide.finish()
check(wide.valid == nil, "entirely outside the snapshot is no region")
// Move: dragged from inside, it keeps its size and stays inside the snapshot.
region.begin(at: CGPoint(x: 150, y: 100)); region.extend(to: CGPoint(x: 200, y: 120)); region.finish()
check(region.valid == CGRect(x: 150, y: 71, width: 200, height: 100), "moves by the drag: \(String(describing: region.valid))")
region.begin(at: CGPoint(x: 200, y: 100)); region.extend(to: CGPoint(x: 2000, y: 2000)); region.finish()
check(region.valid == CGRect(x: 600, y: 300, width: 200, height: 100), "a move stops at the edges: \(String(describing: region.valid))")
// Resize from handles, with a grab tolerance; the opposite edge stays put; past it, it flips.
region.begin(at: CGPoint(x: 603, y: 303), tolerance: 6); region.extend(to: CGPoint(x: 500, y: 250)); region.finish()
check(region.valid == CGRect(x: 500, y: 250, width: 300, height: 150), "top-left corner resizes: \(String(describing: region.valid))")
region.begin(at: CGPoint(x: 799, y: 325), tolerance: 6); region.extend(to: CGPoint(x: 450, y: 10)); region.finish()
check(region.valid == CGRect(x: 450, y: 250, width: 50, height: 150), "the right edge moves x only, and past the left edge flips: \(String(describing: region.valid))")
let beforeShrink = region.valid
region.begin(at: CGPoint(x: 475, y: 400), tolerance: 6); region.extend(to: CGPoint(x: 475, y: 251)); region.finish()
check(region.valid == beforeShrink, "a resize too small keeps the region it started from")
// A press outside starts again: a click there clears it.
region.begin(at: CGPoint(x: 20, y: 20), tolerance: 6); region.finish()
check(region.rect == nil, "a click outside clears the region")
region.begin(at: CGPoint(x: 20, y: 20)); region.extend(to: CGPoint(x: 120, y: 80)); region.finish()
check(region.clear() && region.rect == nil && !region.clear(), "clear says whether there was one")

// MARK: crop through the existing renderer and encoder
// A Retina snapshot: 2× pixels of a 800×400 CSS viewport.
let retina = quadrants(1600, 800)
let tl = MarkupRenderer.composite(retina, marks: [], maxPixels: 2048, crop: CGRect(x: 100, y: 60, width: 500, height: 300))!
check(tl.width == 500 && tl.height == 300, "the crop is the region's size in captured pixels")
check(Pixels(tl).other(than: quadrantColors[0]) == 0, "and only its pixels: the top-left quadrant, so y runs down")
let straddle = Pixels(MarkupRenderer.composite(retina, marks: [], maxPixels: 2048, crop: CGRect(x: 700, y: 300, width: 200, height: 200))!)
check(straddle.width == 200 && straddle.near(0, 0, quadrantColors[0]) && straddle.near(199, 0, quadrantColors[1]) &&
      straddle.near(0, 199, quadrantColors[2]) && straddle.near(199, 199, quadrantColors[3]), "the region's corners are the snapshot's at its position")
check(straddle.near(99, 99, quadrantColors[0]) && straddle.near(100, 100, quadrantColors[3]), "pixel-exact at the seam")
check(MarkupRenderer.composite(retina, marks: [], maxPixels: 2048, crop: CGRect(x: 1700, y: 0, width: 50, height: 50)) == nil, "a crop outside the image is nothing, never the whole image")
check(MarkupRenderer.composite(retina, marks: [], maxPixels: 2048, crop: .zero) == nil, "and so is an empty one")
let clipped = MarkupRenderer.composite(retina, marks: [], maxPixels: 2048, crop: CGRect(x: 1500, y: 700, width: 400, height: 400))!
check(clipped.width == 100 && clipped.height == 100, "a crop past the edge is clipped to the image")
let big = MarkupRenderer.composite(quadrants(4000, 2400), marks: [], maxPixels: 2048, crop: CGRect(x: 0, y: 0, width: 3000, height: 1000))!
check(big.width == 2048 && big.height == 683, "a big region fits the send size, undistorted: \(big.width)×\(big.height)")
// Marks: the part inside the region, where it is in the region, at the snapshot's line width.
var marked = MarkupDocument(size: CGSize(width: 1600, height: 800))
marked.begin(.rectangle, at: CGPoint(x: 200, y: 100), ink: .black); marked.extend(to: CGPoint(x: 1000, y: 500)); marked.finish()
let markedCrop = Pixels(MarkupRenderer.composite(retina, marks: marked.marks, maxPixels: 2048, crop: CGRect(x: 100, y: 50, width: 400, height: 200))!)
let black = 0x0f1729
check(markedCrop.near(250, 50, black, 12) && markedCrop.near(100, 150, black, 12), "the mark's top and left edges land 100, 50 px in")
check(markedCrop.near(250, 120, quadrantColors[0]), "and the rectangle stays unfilled")
let width = MarkupRenderer.lineWidth(for: CGSize(width: 1600, height: 800))
let inked = (0..<200).filter { markedCrop.near(250, $0, black, 12) }.count
check(abs(CGFloat(inked) - width) <= 2, "at the full snapshot's line width: \(inked) vs \(width)")
let full = Pixels(MarkupRenderer.composite(retina, marks: marked.marks, maxPixels: 2048)!)
check(full.width == 1600 && full.near(600, 100, black, 12), "no region: the whole annotated snapshot, as before")
let encoded = MarkupEncoder.encode(retina, marks: [], crop: CGRect(x: 820, y: 420, width: 300, height: 200))!
check(encoded.type == "image/png" && encoded.width == 300 && encoded.height == 200, "the encoder sends the region")
check(Pixels(decode(encoded.data)).other(than: quadrantColors[3]) == 0, "lossless, exactly the region")
check(MarkupEncoder.encode(retina, marks: [], crop: CGRect(x: 9000, y: 0, width: 10, height: 10)) == nil, "no fallback to the whole image")
let stats = MarkupImageStats.measure(encoded.data, expect: "#e0c020", ink: nil, tolerance: 0.02)
check(stats["width"] as? Int == 300 && stats["height"] as? Int == 200 && stats["other"] as? Int == 0, "the smoke's stats read it: \(stats)")

// MARK: the canvas: pointer in view points, region in captured pixels, guides on screen only
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800), styleMask: [.titled], backing: .buffered, defer: true)
window.isReleasedWhenClosed = false
let canvas = PreviewMarkupCanvas(image: retina)
window.contentView!.addSubview(canvas)
func paint(_ view: NSView) -> Pixels {
    let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
    view.cacheDisplay(in: view.bounds, to: rep)
    return Pixels(rep.cgImage!)
}
// Shown at 0.5× (a Retina snapshot on a 1× preview), 0.25× (zoomed out / narrow) and 1.5×.
for frame in [NSRect(x: 0, y: 0, width: 800, height: 400), NSRect(x: 0, y: 0, width: 400, height: 700), NSRect(x: 0, y: 0, width: 1240, height: 780)] {
    canvas.frame = frame
    _ = canvas.clearRegion()
    let mapping = canvas.mapping
    // Bottom-right to top-left.
    canvas.pointerDown(mapping.toView(CGPoint(x: 1200, y: 600)), tool: .select)
    canvas.pointerDragged(mapping.toView(CGPoint(x: 900, y: 500)))
    canvas.pointerDragged(mapping.toView(CGPoint(x: 820, y: 420)))
    canvas.pointerUp()
    let rect = canvas.region.valid ?? .zero
    check(abs(rect.minX - 820) <= 1 && abs(rect.minY - 420) <= 1 && abs(rect.maxX - 1200) <= 1 && abs(rect.maxY - 600) <= 1, "\(frame.size): the region is where it was dragged, in captured pixels: \(rect)")
    check(canvas.document.marks.isEmpty && !canvas.document.canUndo, "\(frame.size): selecting draws no mark and adds no Undo step")
    canvas.tool = .select
    let pixels = paint(canvas), scale = CGFloat(pixels.width) / frame.width
    let inside = mapping.toView(CGPoint(x: 1000, y: 500)), out = mapping.toView(CGPoint(x: 1400, y: 700))
    check(pixels.near(Int(inside.x * scale), Int(inside.y * scale), quadrantColors[3], 4), "\(frame.size): the region shows undimmed")
    let dimmed = pixels.rgb(Int(out.x * scale), Int(out.y * scale))
    check(!pixels.near(Int(out.x * scale), Int(out.y * scale), quadrantColors[3], 20) && (dimmed >> 16 & 0xff) > 60, "\(frame.size): outside is dimmed, not blacked out: \(String(dimmed, radix: 16))")
}
check(canvas.accessibilityLabel()?.contains("region") == true, "VoiceOver hears the region")
let guided = canvas.region.valid!
let sent = Pixels(MarkupRenderer.composite(canvas.image, marks: canvas.document.marks, maxPixels: 2048, crop: guided)!)
check(sent.width == Int(guided.width) && sent.other(than: quadrantColors[3]) == 0, "no outline, handles or dimming in what is sent")
// A press on a handle resizes; in the region it moves; the pointer says which.
let mapping = canvas.mapping
let corner = mapping.toView(CGPoint(x: guided.maxX, y: guided.maxY))
check(MarkupRegionChrome.cursor(at: corner, region: canvas.region, mapping: mapping) != .openHand, "a handle shows a resize pointer")
check(MarkupRegionChrome.cursor(at: mapping.toView(CGPoint(x: guided.midX, y: guided.midY)), region: canvas.region, mapping: mapping) == .openHand, "inside shows a hand")
check(MarkupRegionChrome.cursor(at: mapping.toView(CGPoint(x: 100, y: 100)), region: canvas.region, mapping: mapping) == .crosshair, "elsewhere a crosshair")
canvas.pointerDown(NSPoint(x: corner.x + 3, y: corner.y - 3), tool: .select)
canvas.pointerDragged(mapping.toView(CGPoint(x: 1300, y: 700))); canvas.pointerUp()
check(canvas.region.valid == CGRect(x: guided.minX, y: guided.minY, width: 1300 - guided.minX, height: 700 - guided.minY), "dragging the corner handle resizes: \(String(describing: canvas.region.valid))")

// MARK: the overlay: tool, Add without marks, Escape, Undo/Clear leave the region alone
let overlay = PreviewMarkupOverlay(image: retina)
overlay.frame = NSRect(x: 0, y: 0, width: 1000, height: 700)
window.contentView!.addSubview(overlay)
overlay.layoutSubtreeIfNeeded(); overlay.layout()
// LKM-647: Select (the pointer) picks a mark or drags a region; it is the tool Mark up opens with.
let selectButton = overlay.controls.first { $0.cell?.accessibilityLabel() == "Select" }
check(selectButton != nil && selectButton?.cell?.accessibilityRole() == .radioButton, "Select is a labelled tool")
check(selectButton?.image?.accessibilityDescription == "Select" && selectButton?.toolTip?.hasSuffix("(S)") == true && selectButton?.toolTip?.contains("drag") == true, "with a system symbol, what it does and its key")
check(MarkupTool.select.symbol == "cursorarrow" && NSImage(systemSymbolName: MarkupTool.select.symbol, accessibilityDescription: nil) != nil, "a real SF Symbol")
check(overlay.tool == .select && overlay.canvas.tool == .select, "Mark up opens on Select")
window.makeFirstResponder(overlay)
overlay.keyDown(with: key("p", 35, window: window)); check(overlay.tool == .pen, "P picks the pen")
overlay.keyDown(with: key("s", 1, window: window)); check(overlay.tool == .select && overlay.canvas.tool == .select, "S picks Select")
check(!overlay.addEnabled, "no region, no marks: Add stays off")
var cancelled = 0
overlay.onCancel = { cancelled += 1 }
let view = overlay.canvas.mapping
overlay.canvas.pointerDown(view.toView(CGPoint(x: 400, y: 300)), tool: overlay.tool)
overlay.canvas.pointerDragged(view.toView(CGPoint(x: 600, y: 420)))
check(!overlay.addEnabled, "not while the region is being dragged")
overlay.canvas.pointerUp()
check(overlay.addEnabled && overlay.canvas.document.marks.isEmpty, "a region alone turns Add on")
check(overlay.statusText.isEmpty, "no filler text: \(overlay.statusText)")
check(overlay.controls.first { $0.cell?.accessibilityLabel() == "Add to chat" }?.toolTip?.contains("200 × 120 px") == true, "Add says what it will send")
check(overlay.deleteEnabled, "Delete removes the region")
check(!overlay.undoEnabled, "and leaves Undo off: it is no mark")
overlay.keyDown(with: key("\u{1b}", 53, window: window))
check(cancelled == 0 && overlay.canvas.region.rect == nil && !overlay.addEnabled, "Escape clears the region first")
overlay.keyDown(with: key("\u{1b}", 53, window: window))
check(cancelled == 1, "then cancels")
overlay.canvas.pointerDown(view.toView(CGPoint(x: 400, y: 300)), tool: .select)
overlay.canvas.pointerDragged(view.toView(CGPoint(x: 402, y: 302))); overlay.canvas.pointerUp()
check(!overlay.addEnabled, "a zero-area drag adds nothing")
overlay.canvas.pointerDown(view.toView(CGPoint(x: 400, y: 300)), tool: .select)
overlay.canvas.pointerDragged(view.toView(CGPoint(x: 900, y: 600))); overlay.canvas.pointerUp()
let picked = overlay.canvas.region.valid
// Annotating inside: the region stays; Undo and Clear take only marks.
overlay.keyDown(with: key("p", 35, window: window))
overlay.canvas.pointerDown(view.toView(CGPoint(x: 500, y: 400)), tool: overlay.tool)
overlay.canvas.pointerDragged(view.toView(CGPoint(x: 700, y: 400))); overlay.canvas.pointerUp()
check(overlay.canvas.document.marks.count == 1 && overlay.canvas.region.valid == picked, "a mark inside keeps the region")
overlay.undo(); check(overlay.canvas.document.marks.isEmpty && overlay.canvas.region.valid == picked, "Undo takes the mark, not the region")
overlay.undo(); check(overlay.canvas.region.valid == picked, "and never the region")
overlay.canvas.pointerDown(view.toView(CGPoint(x: 500, y: 400)), tool: .pen)
overlay.canvas.pointerDragged(view.toView(CGPoint(x: 700, y: 400))); overlay.canvas.pointerUp()
overlay.clear(); check(overlay.canvas.document.marks.isEmpty && overlay.canvas.region.valid == picked && overlay.addEnabled, "Clear takes the marks, the region still sends")
overlay.cancelOperation(nil); check(overlay.canvas.region.rect == nil && cancelled == 1, "cancelOperation clears the region first too")
overlay.removeFromSuperview()

// MARK: the session: Add sends the region; nothing on cancel, empty or failed crops
let parent = NSView(frame: NSRect(x: 0, y: 0, width: 900, height: 600))
window.contentView!.addSubview(parent)
var events: [[String: Any]] = []
func adds() -> [[String: Any]] { events.filter { $0["event"] as? String == "markup-add" } }
func state() -> String? { events.last(where: { $0["event"] as? String == "markup-state" })?["state"] as? String }
let context: [String: Any] = ["url":"http://localhost:5173/", "viewportWidth":800, "viewportHeight":400, "zoom":1, "scrollX":0, "scrollY":40]
let session = PreviewMarkup(parent: parent, emit: { events.append($0) }, refusal: { nil },
                            capture: { $0(.success(PreviewMarkup.Captured(image: retina, context: context))) }, restoreFocus: { _ in }, changed: {})
session.begin("r1")
func drag(_ overlay: PreviewMarkupOverlay, _ from: CGPoint, _ to: CGPoint, tool: MarkupTool = .select) {
    let mapping = overlay.canvas.mapping
    overlay.canvas.pointerDown(mapping.toView(from), tool: tool)
    overlay.canvas.pointerDragged(mapping.toView(to)); overlay.canvas.pointerUp()
}
drag(session.overlay!, CGPoint(x: 900, y: 500), CGPoint(x: 900.4, y: 500.4))
session.add()
check(adds().isEmpty, "a zero-area region adds nothing")
drag(session.overlay!, CGPoint(x: 1300, y: 700), CGPoint(x: 900, y: 450))
session.overlay!.canvas.tool = .pen
session.add()
check(adds().count == 1 && session.overlay?.adding == true, "Add sends with no marks")
let add = adds()[0]
let image = Pixels(decode(Data(base64Encoded: add["data"] as! String)!))
check(add["session"] as? String == "r1" && add["type"] as? String == "image/png", "bound to its session")
check(image.width == 400 && image.height == 250 && image.other(than: quadrantColors[3]) == 0, "exactly the region's pixels: \(image.width)×\(image.height)")
let capture = add["capture"] as! [String: Any]
check(capture["imageWidth"] as? Int == 400 && capture["regionX"] as? Int == 900 && capture["regionY"] as? Int == 450 &&
      capture["regionWidth"] as? Int == 400 && capture["regionHeight"] as? Int == 250 && capture["snapshotWidth"] as? Int == 1600 &&
      capture["marks"] as? Int == 0 && capture["scrollY"] as? Int == 40, "with the region in its context: \(capture)")
session.finished("r1", ok: false, message: "This chat is busy")
check(session.overlay?.canvas.region.valid != nil && session.overlay?.addEnabled == true && session.overlay?.errorShown == true, "a refusal keeps the region to retry")
session.finished("r1", ok: true, message: nil)
check(session.overlay == nil && session.session == nil, "done closes")
// Cancel with a region attaches nothing.
session.begin("r2")
drag(session.overlay!, CGPoint(x: 100, y: 100), CGPoint(x: 500, y: 300))
session.cancel()
check(state() == "cancelled" && adds().count == 1, "Cancel attaches nothing")
// An annotated region: the marks inside it, cropped with it.
session.begin("r3")
drag(session.overlay!, CGPoint(x: 100, y: 100), CGPoint(x: 500, y: 300))
session.overlay!.canvas.ink = .black
drag(session.overlay!, CGPoint(x: 200, y: 200), CGPoint(x: 1200, y: 200), tool: .pen)
session.add()
let annotated = Pixels(decode(Data(base64Encoded: adds()[1]["data"] as! String)!))
check(annotated.width == 400 && annotated.height == 200, "the annotated region is the region's size")
check(annotated.near(250, 100, black, 12) && annotated.near(50, 50, quadrantColors[0]), "with the mark where it was drawn, and the page around it")
check((adds()[1]["capture"] as? [String: Any])?["marks"] as? Int == 1, "the context counts the marks")
session.finished("r3", ok: true, message: nil)
// A crop the encoder cannot make fails out loud: no event, no whole-image fallback.
let failing = PreviewMarkup(parent: parent, emit: { events.append($0) }, refusal: { nil },
                            capture: { $0(.success(PreviewMarkup.Captured(image: retina, context: context))) }, restoreFocus: { _ in }, changed: {}, budget: 10)
failing.begin("r4")
drag(failing.overlay!, CGPoint(x: 100, y: 100), CGPoint(x: 500, y: 300))
failing.add()
check(adds().count == 2 && failing.overlay?.errorShown == true && failing.overlay?.canvas.region.valid != nil, "a failed region Add keeps the region, says why and sends nothing")
failing.cancel()
print("{\"ok\":true}")
