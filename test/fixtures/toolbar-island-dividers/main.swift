import AppKit

// LKM-319: the toolbar islands' segmented controls, rendered offscreen next to a stock
// NSSegmentedControl. For each, the divider layers that still draw and, at every segment
// boundary, how much darker the boundary is than the bezel just inside the segment.
_ = NSApplication.shared
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 60), styleMask: [.borderless], backing: .buffered, defer: true)
let canvas = NSView(frame: window.contentRect(forFrameRect: window.frame))
canvas.wantsLayer = true; canvas.layer?.backgroundColor = NSColor.white.cgColor
window.contentView = canvas; window.appearance = NSAppearance(named: .aqua)

func item(_ id: String, _ symbol: String) -> NSToolbarItem {
    let item = NSToolbarItem(itemIdentifier: NSToolbarItem.Identifier(id))
    item.image = toolbarSymbol(symbol, id); item.label = id
    return item
}
let interaction = MomentaryToolbarGroup(identifier: NSToolbarItem.Identifier("interaction"), items: [
    item("select-object", "cursorarrow"), item("device", "iphone"), item("overlay", "ruler"), item("speed", "tortoise")])
let tools = MomentaryToolbarGroup(identifier: NSToolbarItem.Identifier("tools"), items: [
    item("code", "chevron.left.forwardslash.chevron.right"), item("layers", "square.3.layers.3d"), item("expand", "arrow.up.left.and.arrow.down.right")])
let chat = ChatToolbarActions(frame: .zero)
let stock = NSSegmentedControl(images: [toolbarSymbol("cursorarrow")!, toolbarSymbol("iphone")!, toolbarSymbol("ruler")!], trackingMode: .momentary, target: nil, action: nil)
stock.segmentStyle = .texturedRounded
for index in 0..<3 { stock.setWidth(32, forSegment: index) }

for view in [interaction.view!, tools.view!, chat, stock] { view.translatesAutoresizingMaskIntoConstraints = true; canvas.addSubview(view) }
/// Lays the controls out in a row at their own sizes (again after a segment is removed).
func place() {
    var x: CGFloat = 10
    for view in [interaction.view!, tools.view!, chat, stock] {
        let size = view === chat ? NSSize(width: 64, height: chat.control.intrinsicContentSize.height) : view.intrinsicContentSize
        view.frame = NSRect(x: x, y: 18, width: size.width, height: size.height); x += size.width + 20
    }
}

func controls() -> [String: NSSegmentedControl] {
    ["interaction": interaction.view as! NSSegmentedControl, "tools": tools.view as! NSSegmentedControl, "chat": chat.control, "stock": stock]
}
func settle() {
    canvas.layoutSubtreeIfNeeded(); canvas.displayIfNeeded(); CATransaction.flush()
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    canvas.layoutSubtreeIfNeeded(); canvas.displayIfNeeded(); CATransaction.flush()
}
func thinLayers(_ control: NSSegmentedControl) -> Int {
    var count = 0
    func walk(_ layer: CALayer) {
        if !layer.isHidden, layer.opacity > 0, layer.frame.width <= 1.5, layer.frame.height >= control.bounds.height / 3 { count += 1 }
        layer.sublayers?.forEach(walk)
    }
    control.subviews.forEach { $0.layer.map(walk) }
    return count
}
func measure() -> [String: Any] {
    place(); settle()
    guard let rep = canvas.bitmapImageRepForCachingDisplay(in: canvas.bounds) else { fatalError("no bitmap") }
    canvas.cacheDisplay(in: canvas.bounds, to: rep)
    let scale = CGFloat(rep.pixelsWide) / canvas.bounds.width
    func brightness(_ point: NSPoint) -> CGFloat {
        // Bitmap rows run top-down; the canvas is not flipped.
        let px = Int(point.x * scale), py = Int((canvas.bounds.height - point.y) * scale)
        return rep.colorAt(x: px, y: py)?.usingColorSpace(.deviceRGB)?.brightnessComponent ?? 1
    }
    var report: [String: Any] = [:]
    for (name, control) in controls() {
        let frame = control.convert(control.bounds, to: canvas)
        var edge = frame.minX, contrast: [Double] = []
        for index in 0..<(control.segmentCount - 1) {
            edge += control.width(forSegment: index)
            var darkest: CGFloat = 1, bezel: CGFloat = 1
            for y in stride(from: frame.midY - 4, through: frame.midY + 4, by: 1 / scale) {
                for dx in stride(from: -1.0, through: 1.0, by: 1 / scale) { darkest = min(darkest, brightness(NSPoint(x: edge + dx, y: y))) }
                bezel = min(bezel, brightness(NSPoint(x: edge - 5, y: y)), brightness(NSPoint(x: edge + 5, y: y)))
            }
            contrast.append(Double(bezel - darkest))
        }
        report[name] = ["segments": control.segmentCount, "thinLayers": thinLayers(control), "contrast": contrast,
                        "visibleDividers": (control as? IslandSegmentedControl)?.visibleDividers ?? -1]
    }
    return report
}

var result: [String: Any] = ["hidesDividers": IslandSegmentedControl.hidesDividers, "osMajor": ProcessInfo.processInfo.operatingSystemVersion.majorVersion]
result["initial"] = measure()
// LKM-213: a narrow window removes the slow-motion segment and a wider one restores it.
_ = interaction.setSegment("speed", hidden: true); result["narrow"] = measure()
_ = interaction.setSegment("speed", hidden: false); result["restored"] = measure()
chat.updateEnabled(project: true, history: false); result["disabled"] = measure()
// Offscreen captures of the dark appearance come out blank: its check reads the layers only.
window.appearance = NSAppearance(named: .darkAqua); result["dark"] = measure()
print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
