import AppKit

// LKM-319: the toolbar islands' segmented controls, rendered offscreen next to a stock
// NSSegmentedControl. For each, the divider layers that still draw and, at every segment
// boundary, how much darker the boundary is than the bezel just inside the segment.
_ = NSApplication.shared
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 60), styleMask: [.borderless], backing: .buffered, defer: true)
let canvas = NSView(frame: window.contentRect(forFrameRect: window.frame))
canvas.wantsLayer = true; canvas.layer?.backgroundColor = NSColor.white.cgColor
window.contentView = canvas; window.appearance = NSAppearance(named: .aqua)

final class Target: NSObject {
    var clicks: [String] = []
    @objc func clicked(_ item: NSToolbarItem) { clicks.append(item.itemIdentifier.rawValue) }
}
let target = Target()
// LKM-430: the groups are the product's lists, so moving a button is seen here.
let symbols = ["select-object": "cursorarrow", "device": "iphone", "overlay": "ruler", "speed": "tortoise", "markup": ToolbarIslands.markupSymbol,
               "code": "chevron.left.forwardslash.chevron.right", "layers": "square.3.layers.3d", "expand": "arrow.up.left.and.arrow.down.right"]
func item(_ id: String) -> NSToolbarItem {
    let item = NSToolbarItem(itemIdentifier: NSToolbarItem.Identifier(id))
    item.image = id == "markup" ? ToolbarIslands.markupImage(active: false) : toolbarSymbol(symbols[id]!, id); item.label = id
    item.target = target; item.action = #selector(Target.clicked(_:))
    return item
}
let interactionItems = ToolbarIslands.interaction.map(item), viewportItems = ToolbarIslands.viewport.map(item), toolItems = ToolbarIslands.tools.map(item)
let interaction = MomentaryToolbarGroup(identifier: NSToolbarItem.Identifier("interaction"), items: interactionItems)
let viewport = MomentaryToolbarGroup(identifier: NSToolbarItem.Identifier("viewport"), items: viewportItems)
let tools = MomentaryToolbarGroup(identifier: NSToolbarItem.Identifier("tools"), items: toolItems)
let stock = NSSegmentedControl(images: [toolbarSymbol("cursorarrow")!, toolbarSymbol("iphone")!, toolbarSymbol("ruler")!], trackingMode: .momentary, target: nil, action: nil)
stock.segmentStyle = .texturedRounded
for index in 0..<3 { stock.setWidth(32, forSegment: index) }

for view in [interaction.view!, viewport.view!, tools.view!, stock] { view.translatesAutoresizingMaskIntoConstraints = true; canvas.addSubview(view) }
/// Lays the controls out in a row at their own sizes (again after a segment is removed).
func place() {
    var x: CGFloat = 10
    for view in [interaction.view!, viewport.view!, tools.view!, stock] {
        let size = view.intrinsicContentSize
        view.frame = NSRect(x: x, y: 18, width: size.width, height: size.height); x += size.width + 20
    }
}

func controls() -> [String: NSSegmentedControl] {
    ["interaction": interaction.view as! NSSegmentedControl, "viewport": viewport.view as! NSSegmentedControl, "tools": tools.view as! NSSegmentedControl, "stock": stock]
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

/// LKM-449: an island asked to fill a wider slot (below required, as the toolbar's slack is) keeps its own width.
func stretch(_ group: MomentaryToolbarGroup) -> [String: Any] {
    let control = group.view!, slot = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: 40))
    var report: [String: Any] = ["hugging": Double(control.contentHuggingPriority(for: .horizontal).rawValue),
                                 "stockHugging": Double(stock.contentHuggingPriority(for: .horizontal).rawValue)]
    let superview = control.superview, autoresizing = control.translatesAutoresizingMaskIntoConstraints, frame = control.frame
    control.removeFromSuperview(); control.translatesAutoresizingMaskIntoConstraints = false; slot.addSubview(control)
    let fill = control.widthAnchor.constraint(equalTo: slot.widthAnchor); fill.priority = .defaultHigh
    NSLayoutConstraint.activate([fill, control.leadingAnchor.constraint(equalTo: slot.leadingAnchor), control.centerYAnchor.constraint(equalTo: slot.centerYAnchor)])
    slot.layoutSubtreeIfNeeded()
    report["width"] = Double(control.frame.width); report["intrinsic"] = Double(control.intrinsicContentSize.width)
    control.removeFromSuperview(); control.translatesAutoresizingMaskIntoConstraints = autoresizing; control.frame = frame
    superview?.addSubview(control)
    return report
}

var result: [String: Any] = ["hidesDividers": IslandSegmentedControl.hidesDividers, "osMajor": ProcessInfo.processInfo.operatingSystemVersion.majorVersion]
result["stretch"] = ["interaction": stretch(interaction), "viewport": stretch(viewport), "tools": stretch(tools)]
result["initial"] = measure()
// LKM-430: the pen glyph as the toolbar draws it, plain and active, and a click on each state.
/// Opaque pixels of the image, drawn into a 40 pt bitmap.
func ink(_ image: NSImage?) -> Int {
    guard let image, let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 40, pixelsHigh: 40, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                                   colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0), let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return 0 }
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = context
    image.draw(in: NSRect(x: 0, y: 0, width: 40, height: 40))
    NSGraphicsContext.restoreGraphicsState()
    return (0..<40).reduce(0) { sum, x in sum + (0..<40).filter { (bitmap.colorAt(x: x, y: $0)?.alphaComponent ?? 0) > 0.3 }.count }
}
func glyph(_ image: NSImage?) -> [String: Any] {
    ["present": image != nil, "template": image?.isTemplate ?? false, "accessibility": image?.accessibilityDescription ?? "", "ink": ink(image)]
}
func tip(_ control: NSSegmentedControl, _ index: Int) -> String { control.toolTip(forSegment: index) ?? "" }
var markup: [String: Any] = ["plain": glyph(ToolbarIslands.markupImage(active: false)), "active": glyph(ToolbarIslands.markupImage(active: true)),
                             "label": ToolbarIslands.markupLabel, "systemSymbol": NSImage(systemSymbolName: ToolbarIslands.markupSymbol, accessibilityDescription: nil) != nil]
let interactionControl = interaction.view as! NSSegmentedControl
let markupItem = interactionItems.first { $0.itemIdentifier.rawValue == "markup" }!
let markupIndex = ToolbarIslands.interaction.firstIndex(of: "markup")!
markupItem.label = ToolbarIslands.markupLabel; markupItem.toolTip = ToolbarIslands.markupLabel; interaction.refresh()
markup["tooltip"] = tip(interactionControl, markupIndex)
markup["clicked"] = interaction.clickSegment("markup"); markup["clicks"] = target.clicks
markupItem.isEnabled = false; interaction.refresh()
markup["disabledSegment"] = !interactionControl.isEnabled(forSegment: markupIndex)
markup["disabledClicked"] = interaction.clickSegment("markup"); markup["disabledClicks"] = target.clicks
markupItem.isEnabled = true; interaction.refresh()
markupItem.image = ToolbarIslands.markupImage(active: true); interaction.refresh()
markup["activeSegmentAccent"] = interactionControl.image(forSegment: markupIndex)?.isTemplate == false
markup["activeEnabled"] = interactionControl.isEnabled(forSegment: markupIndex)
markupItem.image = ToolbarIslands.markupImage(active: false); interaction.refresh()
markup["restoredTemplate"] = interactionControl.image(forSegment: markupIndex)?.isTemplate == true
target.clicks = []
// LKM-448: Select, Slow Motion and Mark up show their on state one way. For each, idle and
// active in light and dark: the same glyph at the same size and weight (same ink, same bounds),
// template at rest, the accent colour while on.
/// Opaque pixel count and their mean colour, drawn in an appearance.
func paint(_ image: NSImage?, _ appearance: NSAppearance.Name) -> [String: Any] {
    guard let image, let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 40, pixelsHigh: 40, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                                   colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0), let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return [:] }
    var accent: [Double] = []
    NSAppearance(named: appearance)!.performAsCurrentDrawingAppearance {
        NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = context
        image.draw(in: NSRect(x: 0, y: 0, width: 40, height: 40))
        NSGraphicsContext.restoreGraphicsState()
        let a = NSColor.controlAccentColor.usingColorSpace(.deviceRGB)!
        accent = [a.redComponent, a.greenComponent, a.blueComponent].map { Double($0) }
    }
    // Ink and bounds count every opaque pixel; the colour only the solid ones, off the antialiased edge.
    var count = 0, solid = 0, sum = [0.0, 0.0, 0.0], minX = 40, maxX = -1, minY = 40, maxY = -1
    for x in 0..<40 { for y in 0..<40 {
        guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB), color.alphaComponent > 0.6 else { continue }
        count += 1; minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
        guard color.alphaComponent > 0.97 else { continue }
        solid += 1; sum[0] += color.redComponent; sum[1] += color.greenComponent; sum[2] += color.blueComponent
    } }
    let mean = sum.map { solid > 0 ? $0 / Double(solid) : 0 }
    return ["ink": count, "bounds": [minX, minY, maxX, maxY], "accentDistance": zip(mean, accent).map { abs($0 - $1) }.max() ?? 1]
}
var states: [String: Any] = [:]
for (key, _) in ToolbarIslands.stateSymbols {
    let idle = ToolbarIslands.stateImage(key, key, active: false), active = ToolbarIslands.stateImage(key, key, active: true)
    var entry: [String: Any] = ["idleTemplate": idle?.isTemplate ?? false, "activeTemplate": active?.isTemplate ?? true,
                                "idleSize": [idle?.size.width ?? 0, idle?.size.height ?? 0], "activeSize": [active?.size.width ?? 0, active?.size.height ?? 0]]
    for name in [NSAppearance.Name.aqua, .darkAqua] { entry[name == .aqua ? "light" : "dark"] = ["idle": paint(idle, name), "active": paint(active, name)] }
    states[key] = entry
}
// A neighbour that has no on state, at the same optical size.
states["neighbourSize"] = [toolbarSymbol("ruler", "overlay")?.size.width ?? 0, toolbarSymbol("ruler", "overlay")?.size.height ?? 0]
// Pressed is the control's own highlight and leaves the glyph alone; active is the glyph, with no
// highlight; and neither is left behind once it ends.
let selectIndex = ToolbarIslands.interaction.firstIndex(of: "select-object")!
let selectItem = interactionItems[selectIndex]
// Momentary tracking: the pressed fill lasts only while the pointer is down, so no segment holds a
// selection, and a state is never told by one.
states["momentary"] = interactionControl.trackingMode == .momentary
interactionControl.setSelected(true, forSegment: markupIndex)
states["pressedGlyphTemplate"] = interactionControl.image(forSegment: markupIndex)?.isTemplate == true
interactionControl.setSelected(false, forSegment: markupIndex)
let speedItem = interactionItems[ToolbarIslands.interaction.firstIndex(of: "speed")!]
for (item, key) in [(markupItem, "markup"), (selectItem, "select-object"), (speedItem, "speed")] {
    item.image = ToolbarIslands.stateImage(key, key, active: true); interaction.refresh()
    let index = interaction.shown.firstIndex { $0 === item }!
    states["\(key)ActiveHighlight"] = interactionControl.isSelected(forSegment: index)
    states["\(key)ActiveAccent"] = interaction.segmentImage(key)?.isTemplate == false
    // A click on the active segment tracks momentarily and keeps no pressed fill.
    _ = interaction.clickSegment(key)
    states["\(key)AfterClickHighlight"] = interactionControl.isSelected(forSegment: index)
    // Disabled while on: the plain glyph, like every disabled segment; enabled again, the accent.
    item.isEnabled = false; interaction.refresh()
    states["\(key)DisabledTemplate"] = interaction.segmentImage(key)?.isTemplate == true
    item.isEnabled = true; interaction.refresh()
    states["\(key)ReenabledAccent"] = interaction.segmentImage(key)?.isTemplate == false
    item.image = ToolbarIslands.stateImage(key, key, active: false); interaction.refresh()
    states["\(key)EndedTemplate"] = interaction.segmentImage(key)?.isTemplate == true
    states["\(key)EndedHighlight"] = interactionControl.isSelected(forSegment: index)
}
markupItem.image = ToolbarIslands.markupImage(active: false); selectItem.image = toolbarSymbol("cursorarrow", "select-object")
speedItem.image = toolbarSymbol("tortoise", "speed"); interaction.refresh()
markup["cancelLabel"] = ToolbarIslands.markupToolTip(active: true)
result["states"] = states
target.clicks = []
// The device button works from its island; the old one no longer has it.
result["device"] = ["viewport": viewport.clickSegment("device"), "tools": tools.clickSegment("device"), "interaction": interaction.clickSegment("device"), "clicks": target.clicks] as [String: Any]
target.clicks = []
// LKM-213: a narrow window removes the slow-motion segment and a wider one restores it.
// LKM-430: the segments after it still answer for themselves.
_ = interaction.setSegment("speed", hidden: true); result["narrow"] = measure()
markup["narrowSegments"] = interaction.shown.map(\.itemIdentifier.rawValue)
markup["narrowClicked"] = interaction.clickSegment("markup"); markup["narrowClicks"] = target.clicks
_ = interaction.setSegment("speed", hidden: false); result["restored"] = measure()
result["markup"] = markup
(tools.view as! NSSegmentedControl).setEnabled(false, forSegment: 0); result["disabled"] = measure()
(tools.view as! NSSegmentedControl).setEnabled(true, forSegment: 0)
// Offscreen captures of the dark appearance come out blank: its check reads the layers only.
window.appearance = NSAppearance(named: .darkAqua); result["dark"] = measure()
// AppKit changes the inner layers by itself, with no layout of the parent: read straight after each change.
func islands() -> [String: IslandSegmentedControl] {
    ["interaction": interaction.view as! IslandSegmentedControl, "viewport": viewport.view as! IslandSegmentedControl, "tools": tools.view as! IslandSegmentedControl]
}
func immediate() -> [String: Int] { islands().mapValues { $0.visibleDividers + thinLayers($0) } }
func thin(_ control: IslandSegmentedControl) -> [CALayer] {
    var found: [CALayer] = []
    func walk(_ layer: CALayer) {
        if layer.frame.width <= 1.5, layer.frame.height >= control.bounds.height / 3 { found.append(layer) }
        layer.sublayers?.forEach(walk)
    }
    control.subviews.forEach { $0.layer.map(walk) }
    return found
}
var interactive: [String: Any] = [:]
for control in islands().values { control.setSelected(true, forSegment: 0) }
interactive["pressed"] = immediate()
for control in islands().values { control.setSelected(false, forSegment: 0) }
_ = interaction.clickSegment("overlay"); _ = viewport.clickSegment("device")
interactive["clicked"] = immediate()
// A divider shown again by the system, and a divider layer added to the hosted view's layer.
for control in islands().values { for layer in thin(control) { layer.isHidden = false } }
interactive["revealed"] = immediate()
for control in islands().values {
    let layer = CALayer(); layer.frame = CGRect(x: control.width(forSegment: 0), y: 5, width: 1, height: control.bounds.height - 10)
    layer.backgroundColor = NSColor.black.cgColor; control.subviews[0].layer?.addSublayer(layer)
}
interactive["inserted"] = immediate()
result["interactive"] = interactive
// LKM-523: the custom chat-header segment shares the island glyph and textured cell. Its
// enclosing glass paints at rest; AppKit's cell bezel supplies the transient interaction states.
let newChat = IslandSegmentedControl(images: [toolbarSymbol("square.and.pencil", "New Chat")!], trackingMode: .momentary, target: nil, action: nil)
newChat.segmentStyle = .texturedRounded
newChat.setWidth(32, forSegment: 0)
newChat.cell?.isBordered = false
newChat.usesGlassHover = true
newChat.focusRingType = .exterior
newChat.frame = NSRect(x: 540, y: 18, width: 32, height: 32)
canvas.addSubview(newChat)
func chatState() -> [String: Any] {
    ["bordered":newChat.cell?.isBordered ?? false, "enabled":newChat.isEnabled,
     "focused":window.firstResponder === newChat,
     "textured":newChat.segmentStyle == .texturedRounded, "momentary":newChat.trackingMode == .momentary,
     "template":newChat.image(forSegment: 0)?.isTemplate ?? false,
     "glyphSize":NSStringFromSize(newChat.image(forSegment: 0)?.size ?? .zero),
     "neighborGlyphSize":NSStringFromSize((viewport.view as! IslandSegmentedControl).image(forSegment: 0)?.size ?? .zero)]
}
var glass: [String: Any] = ["idle":chatState()]
newChat.setGlassInteraction(hovered: true); glass["hover"] = chatState()
newChat.setGlassInteraction(hovered: false, pressed: true); glass["pressed"] = chatState()
newChat.setGlassInteraction(pressed: false)
_ = window.makeFirstResponder(newChat); glass["focus"] = chatState()
_ = window.makeFirstResponder(canvas)
newChat.isEnabled = false; newChat.setGlassInteraction(hovered: true); glass["disabled"] = chatState()
newChat.setGlassInteraction(hovered: false); newChat.isEnabled = true; glass["restored"] = chatState()
result["newChatGlass"] = glass
print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
