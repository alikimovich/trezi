import AppKit

// LKM-391: real views in a window that is never ordered in, so no focus or screen changes.
func check(_ condition: @autoclosure () -> Bool, _ label: String, line: Int = #line) {
    if !condition() { FileHandle.standardError.write(Data("FAIL \(label) (line \(line))\n".utf8)); exit(1) }
}
func near(_ a: CGFloat, _ b: CGFloat, _ tolerance: CGFloat = 0.01) -> Bool { abs(a - b) <= tolerance }
func solid(_ width: Int, _ height: Int, _ color: NSColor) -> CGImage {
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    context.setFillColor(color.cgColor); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    return context.makeImage()!
}
/// RGB bytes in sRGB, top-left origin.
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
    func rgb(_ x: Int, _ y: Int) -> (r: Int, g: Int, b: Int) {
        let i = y * width * 4
        return (Int(bytes[i + x * 4]), Int(bytes[i + x * 4 + 1]), Int(bytes[i + x * 4 + 2]))
    }
    func marked(_ x: Int, _ y: Int) -> Bool { let c = rgb(x, y); return c.r > 180 && c.g < 90 && c.b < 90 }
    var redCount: Int { var n = 0; for y in 0..<height { for x in 0..<width where marked(x, y) { n += 1 } }; return n }
}
func decode(_ data: Data) -> CGImage { NSBitmapImageRep(data: data)!.cgImage! }
func key(_ characters: String, _ code: UInt16, _ modifiers: NSEvent.ModifierFlags = [], window: NSWindow) -> NSEvent {
    NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: 0, windowNumber: window.windowNumber, context: nil,
                     characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code)!
}

_ = NSApplication.shared
let size = CGSize(width: 800, height: 400)

// MARK: document
var document = MarkupDocument(size: size)
check(document.marks.isEmpty && !document.canUndo, "starts empty")
document.begin(.rectangle, at: CGPoint(x: 100, y: 100)); document.extend(to: CGPoint(x: 300, y: 200)); document.finish()
document.begin(.pen, at: CGPoint(x: 10, y: 10)); document.extend(to: CGPoint(x: 20, y: 30)); document.extend(to: CGPoint(x: 40, y: 12)); document.finish()
document.begin(.circle, at: CGPoint(x: 500, y: 100)); document.extend(to: CGPoint(x: 700, y: 300)); document.finish()
document.begin(.arrow, at: CGPoint(x: 400, y: 380)); document.extend(to: CGPoint(x: 600, y: 350)); document.finish()
check(document.marks.map(\.tool) == [.rectangle, .pen, .circle, .arrow], "one mark per tool")
check(document.marks[1].points.count == 3, "the pen keeps its path")
document.putText("Review this heading", at: CGPoint(x: 120, y: 70), ink: .blue)
check(document.marks.last?.text == "Review this heading" && document.marks.last?.ink == .blue, "canvas text keeps its color")
document.undo()
// A click draws no shape, and a stroke stays on the snapshot.
document.begin(.rectangle, at: CGPoint(x: 5, y: 5)); document.finish()
check(document.marks.count == 4, "a click is no rectangle")
document.begin(.arrow, at: CGPoint(x: 790, y: 390)); document.extend(to: CGPoint(x: 5000, y: -40)); document.finish()
check(document.marks.last?.points.last == CGPoint(x: 800, y: 0), "marks are clamped to the snapshot")
document.undo()
check(document.marks.count == 4, "undo removes the last mark")
let beforeClear = document.marks
document.clear()
check(document.marks.isEmpty && document.canUndo, "clear can be undone")
document.undo()
check(document.marks == beforeClear, "undo restores what clear removed")
var drawing = MarkupDocument(size: size)
drawing.begin(.pen, at: .zero)
check(drawing.marks.isEmpty && drawing.isDrawing, "a stroke in progress is not a mark yet")
drawing.undo()
check(!drawing.isDrawing, "undo cancels the stroke in progress")

// MARK: fixed captured coordinates
let fitted = MarkupMapping(image: CGSize(width: 2880, height: 1800), bounds: NSRect(x: 0, y: 0, width: 1000, height: 1000))
check(near(fitted.frame.width, 1000) && near(fitted.frame.height, 625) && near(fitted.frame.minY, 187.5), "aspect fit, centered")
let source = CGPoint(x: 1440, y: 450)
for bounds in [NSRect(x: 0, y: 0, width: 300, height: 700), NSRect(x: 0, y: 0, width: 1440, height: 900), NSRect(x: 0, y: 0, width: 2000, height: 300)] {
    let mapping = MarkupMapping(image: CGSize(width: 2880, height: 1800), bounds: bounds)
    let back = mapping.toImage(mapping.toView(source))
    check(near(back.x, source.x) && near(back.y, source.y), "the point survives a resize at \(bounds.size)")
}

// MARK: composite against the frozen pixels
let base = solid(800, 400, .systemBlue)
var marks = MarkupDocument(size: size)
marks.begin(.rectangle, at: CGPoint(x: 100, y: 100)); marks.extend(to: CGPoint(x: 300, y: 200)); marks.finish()
var colored = MarkupDocument(size: size)
colored.begin(.pen, at: CGPoint(x: 30, y: 40), ink: .green)
colored.extend(to: CGPoint(x: 180, y: 40)); colored.finish()
colored.putText("COLOR", at: CGPoint(x: 30, y: 70), ink: .purple)
let coloredImage = Pixels(MarkupRenderer.composite(solid(800, 400, .white), marks: colored.marks, maxPixels: 2048)!)
let greenPixel = coloredImage.rgb(100, 40)
check(greenPixel.g > greenPixel.r && greenPixel.g > greenPixel.b, "chosen drawing color reaches native composite")
let textPixelCount = (70..<110).reduce(0) { total, y in total + (30..<190).filter { x in
    let c = coloredImage.rgb(x, y); return c.b > c.g && c.r > c.g
}.count }
check(textPixelCount > 30, "chosen canvas text color reaches native composite")
let coloredAttachment = MarkupEncoder.encode(solid(800, 400, .white), marks: colored.marks)!
check(Pixels(decode(coloredAttachment.data)).rgb(100, 40).g > 70, "attachment encodes the chosen color")
for (maxPixels, ratio) in [(CGFloat(2048), CGFloat(1)), (400, 0.5)] {
    let image = MarkupRenderer.composite(base, marks: marks.marks, maxPixels: maxPixels)!
    let pixels = Pixels(image)
    check(CGFloat(pixels.width) == 800 * ratio, "never scaled up, fits the budget")
    check(pixels.marked(Int(200 * ratio), Int(100 * ratio)), "top edge at \(maxPixels)")
    check(pixels.marked(Int(100 * ratio), Int(150 * ratio)), "left edge at \(maxPixels)")
    check(!pixels.marked(Int(200 * ratio), Int(150 * ratio)) && !pixels.marked(Int(200 * ratio), Int(300 * ratio)), "the rectangle is not filled, and y runs down")
}
// Retina: a 2× snapshot shown at 1×, 0.5× and 2× keeps the mark on the same captured pixel.
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800), styleMask: [.titled], backing: .buffered, defer: true)
window.isReleasedWhenClosed = false
let retina = solid(2880, 1800, .systemBlue)
let canvas = PreviewMarkupCanvas(image: retina)
window.contentView!.addSubview(canvas)
canvas.frame = NSRect(x: 0, y: 0, width: 720, height: 450)
canvas.ink = .purple
canvas.pointerDown(canvas.mapping.toView(CGPoint(x: 200, y: 180)), tool: .text)
check(canvas.hasDraft == false, "empty canvas editor does not create a mark")
check(canvas.subviews.compactMap { $0 as? NSTextField }.count == 1, "text editor is on the canvas")
canvas.subviews.compactMap { $0 as? NSTextField }.first?.stringValue = "Editable"
canvas.commitText()
check(canvas.document.marks.last?.text == "Editable" && canvas.document.marks.last?.ink == .purple, "canvas editor commits colored text")
canvas.pointerDown(canvas.mapping.toView(CGPoint(x: 200, y: 180)), tool: .text)
check(canvas.subviews.compactMap { $0 as? NSTextField }.first?.stringValue == "Editable", "clicking text edits the existing mark")
canvas.subviews.compactMap { $0 as? NSTextField }.first?.stringValue = "Revised"
canvas.commitText()
check(canvas.document.marks.count == 1 && canvas.document.marks[0].text == "Revised", "editing replaces text in place")
let firstBounds = MarkupRenderer.textBounds(canvas.document.marks[0])
check(firstBounds.width < 150 && firstBounds.insetBy(dx: -2, dy: -2).contains(CGPoint(x: 205, y: 180)), "text hit area follows rendered width")
canvas.pointerDown(canvas.mapping.toView(CGPoint(x: 350, y: 180)), tool: .text)
check(canvas.subviews.compactMap { $0 as? NSTextField }.first?.stringValue == "", "nearby point starts a new label")
canvas.subviews.compactMap { $0 as? NSTextField }.first?.stringValue = "Nearby"
canvas.commitText()
check(canvas.document.marks.map(\.text) == ["Revised", "Nearby"], "two nearby canvas labels coexist")
canvas.undo()
canvas.undo()
canvas.undo()
canvas.ink = .red
func paint(_ view: NSView) -> Pixels {
    let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
    view.cacheDisplay(in: view.bounds, to: rep)
    return Pixels(rep.cgImage!)
}
var drawn = false
for frame in [NSRect(x: 0, y: 0, width: 720, height: 450), NSRect(x: 0, y: 0, width: 1000, height: 400), NSRect(x: 0, y: 0, width: 300, height: 600)] {
    canvas.frame = frame
    if !drawn {
        // The pointer path: view coordinates in, captured pixels stored.
        let mapping = canvas.mapping
        canvas.pointerDown(mapping.toView(CGPoint(x: 720, y: 450)), tool: .rectangle)
        canvas.pointerDragged(mapping.toView(CGPoint(x: 2160, y: 1350)))
        canvas.pointerUp()
        drawn = true
    }
    let stored = canvas.document.marks[0].points
    check(near(stored[0].x, 720, 0.5) && near(stored[0].y, 450, 0.5) && near(stored[1].x, 2160, 0.5), "stored in captured pixels")
    let pixels = paint(canvas), scale = CGFloat(pixels.width) / frame.width
    let top = canvas.mapping.toView(CGPoint(x: 1440, y: 450))
    // Under 1 pt wide at the smallest frame: within a pixel of the exact spot.
    let y = Int((top.y * scale).rounded()), x = Int(top.x * scale)
    check((y - 1...y + 1).contains { pixels.rgb(x, $0).r > 150 && pixels.rgb(x, $0).g < 120 }, "the view paints the mark on the captured pixel at \(frame.size): \((y - 3...y + 3).map { pixels.rgb(x, $0) }) of \(pixels.width)×\(pixels.height)")
    let inside = canvas.mapping.toView(CGPoint(x: 1440, y: 900))
    check(!pixels.marked(Int(inside.x * scale), Int(inside.y * scale)), "and nowhere else at \(frame.size)")
}
let composited = Pixels(MarkupRenderer.composite(retina, marks: canvas.document.marks, maxPixels: 2048)!)
check(composited.width == 2048, "Retina fits the send size")
check(composited.marked(1024, 320) && !composited.marked(1024, 640), "the composite agrees with the view")
// The frozen pixels are the captured image: nothing the page does can reach them.
check(canvas.image === retina, "the canvas keeps the captured image")
// The smoke's `frozen` fingerprint sees a single changed pixel, and ignores nothing else.
func touched(_ image: CGImage, _ x: Int, _ y: Int) -> CGImage {
    let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    context.setFillColor(NSColor(srgbRed: 0.5, green: 0.5, blue: 0.5, alpha: 1).cgColor)
    context.fill(CGRect(x: x, y: y, width: 1, height: 1))
    return context.makeImage()!
}
let digest = MarkupDigest.hex(retina)
check(digest.count == 64 && digest == MarkupDigest.hex(retina), "the fingerprint is a stable SHA-256")
check(MarkupDigest.hex(touched(retina, 7, 9)) != digest, "one changed pixel changes the fingerprint")
check(MarkupDigest.hex(touched(retina, 7, 9)) != MarkupDigest.hex(touched(retina, 8, 9)), "and so does which pixel it is")
check(MarkupDigest.hex(solid(4, 2, .white)) != MarkupDigest.hex(solid(2, 4, .white)), "and the shape of the image")

// MARK: PNG against JPEG on fine lines and text
func page() -> CGImage {
    let width = 2880, height = 1800
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    context.setFillColor(NSColor.white.cgColor); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let graphics = NSGraphicsContext(cgContext: context, flipped: false)
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = graphics
    let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 28), .foregroundColor: NSColor.darkGray]
    for row in 0..<34 { ("The quick brown fox jumps over the lazy dog 0123456789 — pricing, plans and checkout " as NSString).draw(at: NSPoint(x: 60, y: 40 + row * 50), withAttributes: attributes) }
    NSGraphicsContext.restoreGraphicsState()
    context.setStrokeColor(NSColor.systemGray.cgColor); context.setLineWidth(1)
    for x in stride(from: 2, to: width, by: 96) { context.move(to: CGPoint(x: x, y: 0)); context.addLine(to: CGPoint(x: x, y: height)) }
    context.strokePath()
    return context.makeImage()!
}
let site = page()
var fine = MarkupDocument(size: CGSize(width: 2880, height: 1800))
fine.begin(.rectangle, at: CGPoint(x: 300, y: 300)); fine.extend(to: CGPoint(x: 1500, y: 900)); fine.finish()
fine.begin(.pen, at: CGPoint(x: 1600, y: 400)); for step in 1...60 { fine.extend(to: CGPoint(x: 1600 + step * 10, y: 400 + Int(sin(Double(step) / 4) * 120))) }; fine.finish()
let lossless = MarkupRenderer.composite(site, marks: fine.marks, maxPixels: 2048)!
let reference = Pixels(lossless)
func jpeg(_ image: CGImage, _ quality: Double) -> Data { NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: quality])! }
func report(_ data: Data, against: Pixels) -> [String: Any] {
    let decoded = Pixels(decode(data))
    var error = 0
    for i in stride(from: 0, to: against.bytes.count, by: 4) { error += abs(Int(against.bytes[i]) - Int(decoded.bytes[i])) }
    return ["kib": data.count / 1024, "width": decoded.width, "meanError": Double(error) / Double(against.bytes.count / 4), "markPixels": decoded.redCount]
}
let png2048 = NSBitmapImageRep(cgImage: lossless).representation(using: .png, properties: [:])!
let agent = MarkupRenderer.composite(site, marks: fine.marks, maxPixels: 1280)!
let evaluation: [String: Any] = [
    "png2048": report(png2048, against: reference), "jpeg90at2048": report(jpeg(lossless, 0.9), against: reference),
    "jpeg80at2048": report(jpeg(lossless, 0.8), against: reference), "referenceMarkPixels": reference.redCount,
    "jpeg80at1280": report(jpeg(agent, 0.8), against: Pixels(agent)), "png1280Kib": NSBitmapImageRep(cgImage: agent).representation(using: .png, properties: [:])!.count / 1024
]
check(report(png2048, against: reference)["meanError"] as? Double == 0, "PNG keeps every pixel")
check((report(jpeg(lossless, 0.8), against: reference)["meanError"] as? Double ?? 0) > 0, "JPEG 0.8 does not")

// MARK: encoding budget
let encoded = MarkupEncoder.encode(site, marks: fine.marks)!
check(encoded.type == "image/png" && encoded.name == "Mark up.png" && encoded.width == 2048, "a typical page stays PNG at 2048")
check(encoded.data.count <= MarkupEncoder.budget, "within the budget")
check(MarkupEncoder.budget * 4 / 3 < 5_000_000, "its base64 fits one image of the strictest provider")
func noise() -> CGImage {
    var state: UInt64 = 88172645463325252
    let width = 2048, height = 1280
    var bytes = [UInt8](repeating: 255, count: width * height * 4)
    for i in stride(from: 0, to: bytes.count, by: 4) { for c in 0..<3 { state ^= state << 13; state ^= state >> 7; state ^= state << 17; bytes[i + c] = UInt8(state & 255) } }
    let provider = CGDataProvider(data: Data(bytes) as CFData)!
    return CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
}
let loud = MarkupEncoder.encode(noise(), marks: fine.marks)!
check(loud.type == "image/jpeg" && loud.name == "Mark up.jpg" && loud.data.count <= MarkupEncoder.budget, "a page PNG cannot hold falls back to JPEG")
check(MarkupEncoder.encode(noise(), marks: fine.marks, budget: 100) == nil, "no encoding fits: a failure, never an oversize image")

// MARK: overlay
let overlay = PreviewMarkupOverlay(image: solid(1600, 1000, .systemBlue))
overlay.frame = NSRect(x: 0, y: 0, width: 1000, height: 700)
window.contentView!.addSubview(overlay)
overlay.layoutSubtreeIfNeeded(); overlay.layout()
let chooserOverlay = PreviewMarkupOverlay(image: solid(1600, 1000, .systemBlue))
chooserOverlay.frame = overlay.frame
chooserOverlay.layoutSubtreeIfNeeded(); chooserOverlay.layout()
let colorPopup = chooserOverlay.island.face.subviews.compactMap { $0 as? NSPopUpButton }.first!
check(colorPopup.accessibilityLabel() == "Annotation color", "color chooser has an accessible label")
colorPopup.selectItem(withTitle: "Green")
check(NSApp.sendAction(colorPopup.action!, to: colorPopup.target, from: colorPopup), "popup selection reaches its action")
check(chooserOverlay.canvas.ink == .green && colorPopup.accessibilityValue() as? String == "Green", "popup chooses and exposes green")
let colorMapping = chooserOverlay.canvas.mapping
chooserOverlay.canvas.pointerDown(colorMapping.toView(CGPoint(x: 80, y: 90)), tool: .pen)
chooserOverlay.canvas.pointerDragged(colorMapping.toView(CGPoint(x: 180, y: 90)))
chooserOverlay.canvas.pointerUp()
check(chooserOverlay.canvas.document.marks.last?.ink == .green, "popup color reaches the canvas mark")
let popupAttachment = MarkupEncoder.encode(chooserOverlay.canvas.image, marks: chooserOverlay.canvas.document.marks)!
let popupPixel = Pixels(decode(popupAttachment.data)).rgb(130, 90)
check(popupPixel.g > 70 && popupPixel.b < 130 && popupPixel.r < 70, "popup color reaches the encoded attachment")
let names = overlay.controls.map { $0.cell?.accessibilityLabel() ?? "" }
for name in ["Pen", "Rectangle", "Circle", "Arrow", "Undo", "Clear", "Cancel", "Add to chat"] { check(names.contains(name), "VoiceOver reads \(name)") }
check(overlay.controls.allSatisfy { $0.cell?.accessibilityRole() == .button || $0.cell?.accessibilityRole() == .radioButton }, "control roles")
check(!overlay.statusText.lowercased().contains("pause") && !overlay.statusText.lowercased().contains("frozen page"), "it never claims the page is paused")
check(overlay.statusText == "Snapshot of the preview", "it says what is shown")
check(overlay.layer?.backgroundColor?.alpha == 1, "opaque: the live page never shows through")
check(!overlay.addEnabled, "Add is off with no marks: no unmarked original can leave")
check(!overlay.undoEnabled, "nothing to undo")
check(overlay.animates == false, "no motion to reduce")
window.makeFirstResponder(overlay)
check(window.firstResponder === overlay, "native focus takes the keys")
func down(_ event: NSEvent) -> Bool { overlay.performKeyEquivalent(with: event) }
overlay.keyDown(with: key("r", 15, window: window)); check(overlay.tool == .rectangle, "R picks the rectangle")
overlay.keyDown(with: key("c", 8, window: window)); check(overlay.tool == .circle, "C picks the circle")
overlay.keyDown(with: key("a", 0, window: window)); check(overlay.tool == .arrow, "A picks the arrow")
overlay.keyDown(with: key("p", 35, window: window)); check(overlay.tool == .pen, "P picks the pen")
overlay.keyDown(with: key("t", 17, window: window)); check(overlay.tool == .text, "T picks canvas text")
let textButton = overlay.controls.first { $0.cell?.accessibilityLabel() == "Text" }!
let focusedColor = overlay.island.face.subviews.compactMap { $0 as? NSPopUpButton }.first!
check(window.makeFirstResponder(focusedColor) && window.firstResponder === focusedColor, "focus moves to the color chooser")
check(textButton.state == .on && textButton.contentTintColor == .controlAccentColor &&
      textButton.cell?.accessibilityValue() as? String == "selected", "Text stays tinted and accessibly selected after focus moves")
for name in ["Pen", "Rectangle", "Circle", "Arrow"] {
    let peer = overlay.controls.first { $0.cell?.accessibilityLabel() == name }!
    check(peer.state == .off && peer.contentTintColor == nil && peer.cell?.accessibilityValue() as? String != "selected", "\(name) stays unselected after Text loses focus")
}
overlay.keyDown(with: key("p", 35, window: window))
overlay.keyDown(with: key("x", 7, window: window)); check(overlay.tool == .pen, "another key does nothing and goes nowhere")
let mapping = overlay.canvas.mapping
overlay.canvas.pointerDown(mapping.toView(CGPoint(x: 100, y: 100)), tool: overlay.tool)
overlay.canvas.pointerDragged(mapping.toView(CGPoint(x: 500, y: 500)))
overlay.canvas.pointerUp()
check(overlay.addEnabled && overlay.undoEnabled, "a mark turns Add and Undo on")
check(overlay.canvas.accessibilityLabel()?.contains("1 mark") == true, "VoiceOver counts the marks")
check(down(key("z", 6, .command, window: window)), "⌘Z belongs to the overlay")
check(overlay.canvas.document.marks.isEmpty && !overlay.addEnabled, "⌘Z undoes")
check(down(key("z", 6, .command, window: window)) == true, "and does not fall through to the page or a menu")
var cancelled = 0
overlay.onCancel = { cancelled += 1 }
overlay.keyDown(with: key("\u{1b}", 53, window: window)); check(cancelled == 1, "Escape cancels")
overlay.cancelOperation(nil); check(cancelled == 2, "cancelOperation cancels")
// Tab walks every enabled control and stays in the overlay.
overlay.canvas.pointerDown(mapping.toView(CGPoint(x: 100, y: 100)), tool: .rectangle)
overlay.canvas.pointerDragged(mapping.toView(CGPoint(x: 500, y: 500)))
overlay.canvas.pointerUp()
var seen: [NSView] = [], next: NSView? = overlay
for _ in 0..<(overlay.controls.count + 1) {
    next = next?.nextValidKeyView ?? next?.nextKeyView
    if let view = next { seen.append(view) }
}
for control in overlay.controls { check(seen.contains(control), "Tab reaches \(control.cell?.accessibilityLabel() ?? "")"); check(control.canBecomeKeyView, "without Full Keyboard Access") }
check(seen.allSatisfy { $0 === overlay || overlay.controls.contains($0 as? NSButton ?? NSButton()) }, "Tab stays in the overlay")
// ⌘Z with the composer's focus is the composer's.
let elsewhere = NSTextView(frame: NSRect(x: 0, y: 0, width: 10, height: 10)); window.contentView!.addSubview(elsewhere)
window.makeFirstResponder(elsewhere)
check(!down(key("z", 6, .command, window: window)), "⌘Z in another view is not taken")
elsewhere.removeFromSuperview()
// Layout (LKM-448): the snapshot keeps the page's whole frame and the controls float over it in
// an island at its top: one row when wide, wrapped when narrow, nothing clipped or overlapping.
func noOverlap(_ label: String) {
    let island = overlay.barFrame, shown = overlay.canvas.frame
    let frames = overlay.controls.map { $0.convert($0.bounds, to: overlay) }
    for (i, a) in frames.enumerated() {
        check(island.contains(a), "\(label): control \(i) inside the island \(a) \(island)")
        for b in frames[(i + 1)...] { check(!a.intersects(b), "\(label): controls overlap") }
    }
    check(shown.contains(island), "\(label): the island floats inside the snapshot")
    check(near(island.minY, shown.minY + PreviewMarkupOverlay.inset, 1), "\(label): at its top")
    check(near(island.midX, shown.midX, 1), "\(label): centred")
    check(island.minX >= shown.minX + PreviewMarkupOverlay.inset - 1 && island.maxX <= shown.maxX - PreviewMarkupOverlay.inset + 1, "\(label): inset from its sides")
    // Over the snapshot, not beside it: no row, so the snapshot loses no height.
    check(overlay.subviews.last === overlay.island, "\(label): drawn above the snapshot")
}
func hits(_ label: String) {
    let island = overlay.barFrame, shown = overlay.canvas.frame
    let host = overlay.superview!
    func hit(_ x: CGFloat, _ y: CGFloat) -> NSView? { overlay.hitTest(host.convert(NSPoint(x: x, y: y), from: overlay)) }
    let center = hit(island.midX, island.midY)
    check(center === overlay.island || center?.isDescendant(of: overlay.island) == true, "\(label): the island takes its own points")
    // Its padding too: a press between two buttons never starts a mark.
    check(hit(island.minX + 3, island.midY) === overlay.island, "\(label): its padding is the island's")
    for control in overlay.controls where !control.isHidden {
        let frame = control.convert(control.bounds, to: overlay)
        check(hit(frame.midX, frame.midY) === control, "\(label): a press on \(control.cell?.accessibilityLabel() ?? "") is that button's")
    }
    // Right beside it, and everywhere else on the page, the pen draws.
    for (x, y) in [(island.midX, island.maxY + 4), (island.minX - 4, island.midY), (island.maxX + 4, island.midY), (shown.minX + 2, shown.maxY - 2), (shown.midX, shown.midY)] {
        check(hit(x, y) === overlay.canvas, "\(label): (\(x), \(y)) beside the island draws")
    }
}
overlay.layout(); noOverlap("wide"); hits("wide"); let wideBar = overlay.barFrame.height
check(overlay.canvas.frame == overlay.bounds, "with no page frame the snapshot fills the overlay")
for (width, height) in [(CGFloat(420), CGFloat(600)), (300, 500), (240, 300)] {
    overlay.frame = NSRect(x: 0, y: 0, width: width, height: height); overlay.layout(); noOverlap("\(width)"); hits("\(width)")
    check(overlay.barFrame.height > wideBar, "narrow wraps")
    check(overlay.canvas.frame == overlay.bounds, "the snapshot keeps the whole height at \(width)")
}
overlay.frame = NSRect(x: 0, y: 0, width: 300, height: 500); overlay.layout()
let beforeError = overlay.canvas.frame, plainIsland = overlay.barFrame
overlay.show(error: "That went wrong")
check(overlay.statusText == "That went wrong" && overlay.errorShown, "the failure is on screen")
check(overlay.canvas.frame == beforeError, "an error grows the island, never moves the snapshot")
check(overlay.barFrame.height > plainIsland.height, "it shows in the island")
noOverlap("error")
overlay.show(error: nil)
check(!overlay.errorShown, "and clears")
// The island in dark and light appearances: an opaque face drawn in each.
for name in [NSAppearance.Name.darkAqua, .aqua] {
    overlay.appearance = NSAppearance(named: name)
    let face = paint(overlay.island.face)
    let c = face.rgb(face.width / 2, 2), dark = name == .darkAqua
    check(dark ? c.r < 90 : c.r > 180, "the island's face follows \(name.rawValue): \(c)")
}
overlay.appearance = nil
// The page's own frame: the snapshot sits exactly on it, wherever it is in the preview area.
let holder = NSView(frame: NSRect(x: 0, y: 0, width: 1100, height: 760))
window.contentView!.addSubview(holder)
overlay.removeFromSuperview(); holder.addSubview(overlay)
overlay.frame = NSRect(x: 40, y: 20, width: 1000, height: 700)
overlay.page = NSRect(x: 190, y: 70, width: 700, height: 600)
overlay.layout()
check(overlay.canvas.convert(overlay.canvas.bounds, to: holder) == overlay.page, "the snapshot takes the page's frame: \(overlay.canvas.convert(overlay.canvas.bounds, to: holder))")
noOverlap("page"); hits("page")
overlay.page = NSRect(x: 0, y: 0, width: 2000, height: 2000); overlay.layout()
check(overlay.canvas.frame == overlay.bounds, "a page past the area is clipped to it")
overlay.page = nil; overlay.layout()
overlay.removeFromSuperview(); holder.removeFromSuperview(); window.contentView!.addSubview(overlay)

// LKM-451: the Host's window (resizable, with a minSize) hit-tested from its theme frame, as the
// smoke does. The page's bottom edge is the window's, so a probe 2 pt inside the snapshot's
// corner lands in the band the window claims for resizing: the raw probe is RED, the overlay's
// corner probe GREEN. Without `.resizable` the raw point is the canvas: that is the control.
func hostWindow(resizable: Bool) -> (NSWindow, PreviewMarkupOverlay) {
    var mask: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .fullSizeContentView]
    if resizable { mask.insert(.resizable) }
    let host = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1320, height: 860), styleMask: mask, backing: .buffered, defer: true)
    host.isReleasedWhenClosed = false
    if resizable { host.minSize = NSSize(width: 850, height: 550) }
    let page = PreviewMarkupOverlay(image: solid(1600, 1000, .systemBlue))
    page.frame = NSRect(x: 456, y: 0, width: 634, height: 760)
    host.contentView!.addSubview(page)
    page.layoutSubtreeIfNeeded(); page.layout()
    return (host, page)
}
for resizable in [true, false] {
    let (host, page) = hostWindow(resizable: resizable)
    let root = host.contentView!.superview!, snapshot = page.convert(page.canvas.frame, to: nil)
    let edges = root.convert(root.bounds, to: nil), label = resizable ? "Host window" : "control (not resizable)"
    check(near(snapshot.minY, edges.minY) && near(snapshot.minX, 456), "\(label): the page's bottom edge is the window's: \(snapshot) in \(edges)")
    let raw = NSPoint(x: snapshot.minX + 2, y: snapshot.minY + 2), corner = page.cornerProbe()
    check(root.hitTest(raw) === (resizable ? root : page.canvas), "\(label): the raw corner point hits \(root.hitTest(raw).map { "\(type(of: $0))" } ?? "nil")")
    check(root.hitTest(corner) === page.canvas, "\(label): the corner probe \(corner) draws: \(root.hitTest(corner).map { "\(type(of: $0))" } ?? "nil")")
    check(snapshot.contains(corner) && corner.x >= edges.minX + PreviewMarkupOverlay.edgeClear && corner.y >= edges.minY + PreviewMarkupOverlay.edgeClear, "\(label): the corner probe is on the page, clear of the edges")
    let island = page.convert(page.barFrame, to: nil)
    for (x, y) in [(snapshot.midX, min(snapshot.maxY - 2, island.maxY + 4)), (snapshot.midX, island.minY - 4), (island.minX - 4, island.midY), (island.maxX + 4, island.midY)] {
        check(root.hitTest(NSPoint(x: x, y: y)) === page.canvas, "\(label): (\(x), \(y)) beside the island draws")
    }
    let center = root.hitTest(NSPoint(x: island.midX, y: island.midY))
    check(center === page.island || center?.isDescendant(of: page.island) == true, "\(label): the island takes its own points")
}
// A page that does not touch the window's edges keeps its corner 2 pt in; one too small stays inside.
do {
    let (host, page) = hostWindow(resizable: true)
    page.frame = NSRect(x: 456, y: 100, width: 634, height: 600); page.layout()
    let snapshot = page.convert(page.canvas.frame, to: nil)
    check(page.cornerProbe() == NSPoint(x: snapshot.minX + 2, y: snapshot.minY + 2), "a page clear of the band keeps its corner probe 2 pt in: \(page.cornerProbe())")
    page.frame = NSRect(x: 456, y: 0, width: 20, height: 20); page.layout()
    check(page.convert(page.canvas.frame, to: nil).contains(page.cornerProbe()), "a page smaller than the band still gets a probe on it")
    _ = host
}

// MARK: session
let parent = NSView(frame: NSRect(x: 0, y: 0, width: 900, height: 600))
window.contentView!.addSubview(parent)
var events: [[String: Any]] = []
var pendingCapture: ((Result<PreviewMarkup.Captured, PreviewMarkup.Failure>) -> Void)?
var focused = 0, refusal: String?, pageIdentity = "page-a"
let session = PreviewMarkup(parent: parent, emit: { events.append($0) }, refusal: { refusal }, capture: { pendingCapture = $0 }, restoreFocus: { if $0 != nil { focused += 1 } }, changed: {}, currentPageIdentity: { pageIdentity })
func captured(_ image: CGImage) -> PreviewMarkup.Captured {
    PreviewMarkup.Captured(image: image, context: ["url":"http://localhost:5173/a?b=1", "viewportWidth":640, "viewportHeight":400, "zoom":1, "scrollX":0, "scrollY":12], pageIdentity: pageIdentity)
}
let temporary = Set((try? FileManager.default.contentsOfDirectory(atPath: NSTemporaryDirectory())) ?? [])
func state() -> String? { events.last(where: { $0["event"] as? String == "markup-state" })?["state"] as? String }

refusal = "Open the preview to mark it up."
session.begin("s0")
check(state() == "failed" && events.last?["message"] as? String == refusal, "refused out loud")
check(pendingCapture == nil && session.overlay == nil, "and nothing is captured")
refusal = nil

// Selection during capture holds the snapshot; ending still rejects late capture callbacks.
session.begin("s1"); check(pendingCapture != nil && session.overlay == nil, "capture first")
let lateCapture = pendingCapture
session.suspend(); pendingCapture?(.success(captured(solid(400, 300, .white)))); pendingCapture = nil
check(session.overlay?.isHidden == true, "Select during capture never opens an active overlay")
session.resume(); check(session.overlay?.isHidden == false, "a pending snapshot can resume")
session.end("s1"); lateCapture?(.success(captured(solid(400, 300, .white))))
check(session.overlay == nil && session.session == nil, "a late capture is dropped")

// A failed capture is said, never an empty overlay.
session.begin("s2"); pendingCapture?(.failure(.init(message: "Snapshot unavailable"))); pendingCapture = nil
check(state() == "failed" && session.overlay == nil, "capture failure is reported")
check(events.last?["message"] as? String == "Snapshot unavailable", "with its reason")

// Cancel: everything goes, the pixels included.
weak var released: PreviewMarkupOverlay?
autoreleasepool {
    session.begin("s3"); pendingCapture?(.success(captured(solid(400, 300, .white)))); pendingCapture = nil
    check(state() == "open" && session.overlay != nil && session.overlay?.superview === parent, "the overlay opens")
    check(session.overlay?.ownsFocus == true, "and takes the keys")
    released = session.overlay
    session.overlay?.canvas.pointerDown(CGPoint(x: 100, y: 100), tool: .pen)
    session.overlay?.canvas.pointerDragged(CGPoint(x: 140, y: 120)); session.overlay?.canvas.pointerUp()
    check(session.undo(), "the menu's Undo reaches the marks")
    check(session.overlay?.canvas.document.marks.isEmpty == true, "and removes the mark")
    session.cancel()
}
check(state() == "cancelled" && session.overlay == nil && session.session == nil, "cancel closes")
check(released == nil, "the frozen snapshot, which only the overlay holds, is released")
check(focused == 1, "focus goes back")
check(events.allSatisfy { $0["event"] as? String != "markup-add" }, "cancel attaches nothing")

// LKM-448: the top bar button's Cancel goes by token through the same path, and opening and
// closing moves nothing else in the preview area.
let livePage = NSView(frame: NSRect(x: 60, y: 20, width: 700, height: 540)); parent.addSubview(livePage)
let sibling = NSView(frame: NSRect(x: 0, y: 560, width: 900, height: 40)); parent.addSubview(sibling)
func frames() -> [NSRect] { [livePage.frame, sibling.frame, parent.frame] }
let closedFrames = frames()
let pageArea = NSRect(x: 0, y: 0, width: 900, height: 560)
session.place(area: pageArea, page: livePage.frame)
session.begin("t1"); pendingCapture?(.success(captured(solid(1400, 1080, .white)))); pendingCapture = nil
check(state() == "open" && session.overlay?.frame == pageArea, "it opens over the area placed before it")
check(session.overlay?.canvas.convert(session.overlay!.canvas.bounds, to: parent) == livePage.frame, "the snapshot sits on the page")
check(frames() == closedFrames, "opening moves and resizes nothing")
session.overlay?.canvas.pointerDown(CGPoint(x: 100, y: 100), tool: .pen)
session.overlay?.canvas.pointerDragged(CGPoint(x: 140, y: 120)); session.overlay?.canvas.pointerUp()
let retained = session.overlay?.canvas.document.marks
let retainedComposite = MarkupEncoder.encode(session.overlay!.canvas.image, marks: retained!)!.data.base64EncodedString()
let inputPoint = NSPoint(x: 500, y: 350)
check(parent.hitTest(inputPoint) === session.overlay?.canvas, "active annotation owns preview input")
session.suspend()
check(session.overlay?.isHidden == true && session.overlay?.canvas.document.marks == retained, "Select suspends the snapshot without losing edits")
check(parent.hitTest(inputPoint) === livePage, "suspended annotation returns preview input to Select")
check(!session.undo(), "Select keeps Undo with the active mode")
pageIdentity = "page-b"
session.resume()
check(session.overlay?.isHidden == true && session.overlay?.canvas.document.marks == retained && state() == "suspended", "a changed page cannot display the retained snapshot")
let recovery = session.recovery!
check(recovery.superview === parent && recovery.saveButton.isEnabled && recovery.discardButton.isEnabled, "changed-page recovery offers Save and Discard")
check(parent.hitTest(inputPoint) === livePage, "recovery never puts the old snapshot over the new page")
recovery.saveButton.performClick(nil)
let recoveredAdd = events.last { $0["event"] as? String == "markup-add" }
check(recoveredAdd?["session"] as? String == "t1" && recoveredAdd?["type"] as? String == "image/png" && recoveredAdd?["data"] as? String == retainedComposite, "Save sends the exact retained native composite through Add")
check(session.overlay?.isHidden == true && recovery.saveButton.isEnabled == false, "Save keeps the stale canvas hidden while Add is pending")
session.finished("t1", ok: false, message: "Attachment unavailable")
check(recovery.message.stringValue == "Attachment unavailable" && recovery.saveButton.isEnabled, "failed Save remains recoverable")
recovery.saveButton.performClick(nil)
session.finished("t1", ok: true, message: nil)
check(session.overlay == nil && session.recovery == nil && session.session == nil, "successful recovery releases the snapshot")
pageIdentity = "page-c"
session.begin("t1-discard"); pendingCapture?(.success(captured(solid(800, 400, .white)))); pendingCapture = nil
session.overlay?.canvas.pointerDown(CGPoint(x: 100, y: 100), tool: .pen)
session.overlay?.canvas.pointerDragged(CGPoint(x: 140, y: 120)); session.overlay?.canvas.pointerUp()
session.suspend(); pageIdentity = "page-d"; session.resume()
check(session.recovery != nil && session.overlay?.isHidden == true, "later navigation also offers recovery")
session.recovery?.discardButton.performClick(nil)
check(session.overlay == nil && session.recovery == nil && session.session == nil && state() == "cancelled", "explicit Discard releases marks")
events.removeAll()
pageIdentity = "page-e"
session.begin("t1-resume"); pendingCapture?(.success(captured(solid(800, 400, .white)))); pendingCapture = nil
session.overlay?.canvas.pointerDown(CGPoint(x: 100, y: 100), tool: .pen)
session.overlay?.canvas.pointerDragged(CGPoint(x: 140, y: 120)); session.overlay?.canvas.pointerUp()
let resumedMarks = session.overlay?.canvas.document.marks
session.suspend(); session.resume()
check(session.overlay?.isHidden == false && session.overlay?.canvas.document.marks == resumedMarks, "same-page resume keeps the marks")
check(parent.hitTest(inputPoint) === session.overlay?.canvas, "resumed annotation owns preview input again")
let beforeStale = events.count
session.cancel("t0")
check(session.overlay != nil && session.session == "t1-resume", "a stale token closes nothing")
check(events.count == beforeStale + 1 && state() == "cancelled" && events.last?["session"] as? String == "t0", "but is answered, so Bun never waits")
let focusBefore = focused
session.cancel("t1-resume")
check(state() == "cancelled" && events.last?["session"] as? String == "t1-resume", "the button cancels its session")
check(session.overlay == nil && session.session == nil, "and closes it, marks and all")
check(focused == focusBefore + 1, "focus goes back")
check(frames() == closedFrames, "closing moves and resizes nothing")
check(events.allSatisfy { $0["event"] as? String != "markup-add" }, "the button's Cancel attaches nothing")
// A press while the snapshot is still being taken cancels too, and the late capture opens nothing.
session.begin("t2"); check(pendingCapture != nil, "capturing")
session.cancel("t2")
check(state() == "cancelled" && session.session == nil, "cancel during the capture")
check(focused == focusBefore + 1, "with no overlay, focus never moved")
pendingCapture?(.success(captured(solid(400, 300, .white)))); pendingCapture = nil
check(session.overlay == nil, "a late capture opens nothing")
// And it opens again.
session.begin("t3"); pendingCapture?(.success(captured(solid(1400, 1080, .white)))); pendingCapture = nil
check(state() == "open" && session.session == "t3" && session.overlay != nil, "re-entering opens")
check(session.overlay?.canvas.document.marks.isEmpty == true, "with none of the cancelled marks")
session.cancel("t3"); check(session.overlay == nil && frames() == closedFrames, "and closes again")
livePage.removeFromSuperview(); sibling.removeFromSuperview()
session.place(area: .zero)

// Add: the composite with its context; closes only on Bun's word; keeps marks on a refusal.
session.begin("s4"); pendingCapture?(.success(captured(solid(800, 400, .systemGreen)))); pendingCapture = nil
session.place(area: NSRect(x: 40, y: 0, width: 700, height: 500))
check(session.overlay?.frame == NSRect(x: 40, y: 0, width: 700, height: 500), "the overlay covers the preview area")
session.add(); check(!events.contains { $0["event"] as? String == "markup-add" }, "Add with no marks does nothing")
let sessionMapping = session.overlay!.canvas.mapping
session.overlay!.canvas.pointerDown(sessionMapping.toView(CGPoint(x: 100, y: 100)), tool: .rectangle)
session.overlay!.canvas.pointerDragged(sessionMapping.toView(CGPoint(x: 500, y: 300))); session.overlay!.canvas.pointerUp()
session.add()
let adds = events.filter { $0["event"] as? String == "markup-add" }
check(adds.count == 1, "Add emits one image")
let add = adds[0]
check(add["session"] as? String == "s4" && add["type"] as? String == "image/png" && add["name"] as? String == "Mark up.png", "bound to the session")
let sent = Pixels(decode(Data(base64Encoded: add["data"] as! String)!))
check(sent.marked(300, 100) && sent.rgb(300, 200).g > 100, "what leaves is the composite, not the snapshot")
let context = add["capture"] as! [String: Any]
check(context["imageWidth"] as? Int == 800 && context["imageHeight"] as? Int == 400 && context["scrollY"] as? Int == 12, "with its capture context")
check(session.overlay?.adding == true && session.overlay?.addEnabled == false, "busy until Bun answers")
session.add(); check(events.filter { $0["event"] as? String == "markup-add" }.count == 1, "no double add")
session.finished("other", ok: true, message: nil); check(session.overlay != nil, "another session's answer is ignored")
session.finished("s4", ok: false, message: "This chat is busy")
check(session.overlay?.errorShown == true && session.overlay?.statusText == "This chat is busy", "a refusal is on screen")
check(session.overlay?.canvas.document.marks.count == 1 && session.overlay?.addEnabled == true, "and the marks survive")
session.add(); session.finished("s4", ok: true, message: nil)
check(session.overlay == nil && session.session == nil, "done closes")
check(state() == "open", "no cancel event on success")
check(events.filter { $0["event"] as? String == "markup-add" }.count == 2, "the retry went out")
check(!session.escape(), "Escape is free again")
check(!session.undo(), "Undo is free again")
let after = Set((try? FileManager.default.contentsOfDirectory(atPath: NSTemporaryDirectory())) ?? [])
check(after.subtracting(temporary).filter { $0.lowercased().contains("mark") }.isEmpty, "no temp file was written")

// An encoding failure stays on screen with the marks.
let failing = PreviewMarkup(parent: parent, emit: { events.append($0) }, refusal: { nil }, capture: { $0(.success(captured(solid(800, 400, .white)))) }, restoreFocus: { _ in }, changed: {}, budget: 10)
failing.begin("s5")
let failingMapping = failing.overlay!.canvas.mapping
failing.overlay!.canvas.pointerDown(failingMapping.toView(CGPoint(x: 100, y: 100)), tool: .arrow)
failing.overlay!.canvas.pointerDragged(failingMapping.toView(CGPoint(x: 500, y: 300))); failing.overlay!.canvas.pointerUp()
let beforeAdd = events.count
failing.add()
check(events.count == beforeAdd && failing.overlay?.errorShown == true, "no image, no event, and the user sees why")
check(failing.overlay?.canvas.document.marks.count == 1, "the marks are kept")
failing.cancel()

// A capture that never answers (a page stuck in a loop) ends out loud and frees the session.
var stalled: ((Result<PreviewMarkup.Captured, PreviewMarkup.Failure>) -> Void)?
let stalling = PreviewMarkup(parent: parent, emit: { events.append($0) }, refusal: { nil }, capture: { stalled = $0 }, restoreFocus: { _ in }, changed: {}, captureTimeout: 0.2)
stalling.begin("s6")
check(stalling.session == "s6" && stalling.overlay == nil, "a stalled capture is waited for")
RunLoop.main.run(until: Date().addingTimeInterval(0.6))
check(state() == "failed" && stalling.session == nil, "it times out and releases the session")
check((events.last?["message"] as? String)?.contains("did not answer") == true, "with a message the user reads")
check(events.last?["session"] as? String == "s6", "for its own session")
let late = stalled; stalled = nil
late?(.success(captured(solid(400, 300, .white))))
check(stalling.overlay == nil && stalling.session == nil, "a late answer opens nothing")
stalling.begin("s7")
check(stalling.session == "s7", "and the next press starts a new session")
stalled?(.success(captured(solid(400, 300, .white)))); stalled = nil
RunLoop.main.run(until: Date().addingTimeInterval(0.5))
check(stalling.overlay != nil && state() == "open", "a capture that answered in time is not timed out")
stalling.cancel()

let output: [String: Any] = ["selectors":PreviewMarkupScript.selectors, "script":PreviewMarkupScript.hide, "restore":PreviewMarkupScript.restore, "evaluation":evaluation]
print(String(data: try! JSONSerialization.data(withJSONObject: output), encoding: .utf8)!)
