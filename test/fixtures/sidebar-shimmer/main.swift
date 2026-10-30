import AppKit

// LKM-389: the real `SidebarChatCell` and `SidebarTitleShimmer`, in a window that is never ordered
// in. There is no window server's composite here, so the band's position is taken from its real
// animation and the real mask is rendered at that position; contrast comes from the system's own
// colours. Prints JSON for test/sidebar-shimmer.mjs.
_ = NSApplication.shared

final class NativeShell: NSObject {
    var rows: [ShellRow] = []
    var currentProject: String?
    var selectedID: String?
    var sidebarHistory = SidebarHistoryState()
    var applying = false
    let outline = NSOutlineView()
    let sidebar = NSViewController()
    func projectMenu(_ row: ShellRow) -> NSMenu { NSMenu() }
    @objc func contextAction(_ sender: Any?) {}
}
func emit(_ value: [String: Any]) {}

let long = "can you prune the branches that were merged into main last week"
let shell = NativeShell()
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 400), styleMask: [.borderless], backing: .buffered, defer: false)
let root = NSView(frame: window.contentLayoutRect)
root.wantsLayer = true
window.contentView = root

func make(_ data: [String: Any], title: String = long, width: CGFloat = 200, archive: Bool = true) -> SidebarChatCell {
    var fields: [String: Any] = ["id": "chat:a", "kind": "chat", "project": "p", "title": title]
    fields.merge(data) { $1 }
    let cell = SidebarChatCell(row: ShellRow(fields), canArchive: archive, target: shell)
    cell.frame = NSRect(x: 0, y: 0, width: width, height: SidebarRowStyle.height)
    root.addSubview(cell)
    cell.layoutSubtreeIfNeeded()
    return cell
}
func spinners(_ view: NSView) -> Int { (view is NSProgressIndicator ? 1 : 0) + view.subviews.map(spinners).reduce(0, +) }
func describe(_ cell: SidebarChatCell) -> [String: Any] {
    let title = cell.title!, label = title.label
    return ["titleX": title.frame.minX, "titleWidth": title.frame.width, "labelX": label.frame.minX, "labelWidth": label.frame.width,
            "mode": cell.shimmer?.mode ?? "none", "shimmer": cell.shimmer?.inspect() ?? [:], "spinners": spinners(cell),
            "label": cell.accessibilityLabel() ?? "", "alpha": label.alphaValue, "dot": !cell.dot.isHidden,
            "truncates": label.lineBreakMode == .byTruncatingTail, "text": label.stringValue, "archive": cell.archive != nil]
}
func animation(_ shimmer: SidebarTitleShimmer) -> [String: Any] {
    guard let move = shimmer.band.animation(forKey: "shimmer") as? CABasicAnimation else { return [:] }
    return ["keyPath": move.keyPath ?? "", "from": move.fromValue as? CGFloat ?? .nan, "to": move.toValue as? CGFloat ?? .nan,
            "duration": move.duration, "repeats": move.repeatCount == .infinity, "offset": move.timeOffset, "removed": move.isRemovedOnCompletion,
            "linear": move.timingFunction == CAMediaTimingFunction(name: .linear), "band": shimmer.band.frame.width,
            "maskWidth": shimmer.mask.frame.width, "width": shimmer.label.bounds.width]
}
/// The real mask's opacity across the label, with the band where the animation has it at `phase`.
func opacity(_ shimmer: SidebarTitleShimmer, phase: CGFloat) -> [CGFloat] {
    guard let move = shimmer.band.animation(forKey: "shimmer") as? CABasicAnimation, let from = move.fromValue as? CGFloat, let to = move.toValue as? CGFloat else { return [] }
    let saved = shimmer.band.position
    CATransaction.begin(); CATransaction.setDisableActions(true)
    shimmer.band.position.x = from + (to - from) * phase
    CATransaction.commit()
    defer { CATransaction.begin(); CATransaction.setDisableActions(true); shimmer.band.position = saved; CATransaction.commit() }
    let width = Int(shimmer.mask.bounds.width), height = Int(shimmer.mask.bounds.height)
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceGray(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return [] }
    shimmer.mask.render(in: context)
    guard let pixels = context.data?.assumingMemoryBound(to: UInt8.self) else { return [] }
    let row = height / 2 * context.bytesPerRow
    return (0..<width).map { CGFloat(pixels[row + $0 * 2 + 1]) / 255 }
}

/// WCAG contrast of `text`, at `alpha` on top of its own, over an opaque `back`.
func contrast(_ text: NSColor, alpha: CGFloat, over back: NSColor, appearance: NSAppearance) -> CGFloat {
    var ratio: CGFloat = 0
    appearance.performAsCurrentDrawingAppearance {
        let t = text.usingColorSpace(.sRGB)!, b = back.usingColorSpace(.sRGB)!
        let a = t.alphaComponent * alpha
        func luminance(_ r: CGFloat, _ g: CGFloat, _ bl: CGFloat) -> CGFloat {
            let line = { (v: CGFloat) in v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
            return 0.2126 * line(r) + 0.7152 * line(g) + 0.0722 * line(bl)
        }
        let mix = { (fore: CGFloat, base: CGFloat) in fore * a + base * (1 - a) }
        let fore = luminance(mix(t.redComponent, b.redComponent), mix(t.greenComponent, b.greenComponent), mix(t.blueComponent, b.blueComponent))
        let base = luminance(b.redComponent, b.greenComponent, b.blueComponent)
        ratio = (max(fore, base) + 0.05) / (min(fore, base) + 0.05)
    }
    return ratio
}

var report: [String: Any] = [:]
let idle = make([:]), thinking = make(["running": true, "thinking": true]), waiting = make(["running": true])
let unread = make(["unread": true]), history = make(["kind": "history", "detail": "3d", "thinking": false])
report["idle"] = describe(idle); report["thinking"] = describe(thinking); report["waiting"] = describe(waiting)
report["unread"] = describe(unread); report["history"] = describe(history)

// The sweep, its mask at several phases, and on a selected row.
let shimmer = thinking.shimmer!
report["sweep"] = animation(shimmer)
report["phases"] = [0, 0.2, 0.4, 0.6, 1].map { ["phase": $0, "opacity": opacity(shimmer, phase: $0)] as [String: Any] }
thinking.backgroundStyle = .emphasized
report["emphasized"] = ["inspect": shimmer.inspect(), "phase": opacity(shimmer, phase: 0.4), "sweep": animation(shimmer)]
thinking.backgroundStyle = .normal
report["normal"] = shimmer.inspect()

// Reduce Motion, turned on and off under a shimmering row.
SidebarMarqueeTitle.reduceMotionOverride = true
shimmer.refresh()
report["reduced"] = describe(thinking)
thinking.backgroundStyle = .emphasized
report["reducedEmphasized"] = describe(thinking)
thinking.backgroundStyle = .normal
report["reducedStart"] = describe(make(["running": true, "thinking": true]))
SidebarMarqueeTitle.reduceMotionOverride = false
shimmer.refresh()
report["restored"] = describe(thinking)

// A narrow row, and the hover: Archive takes width, the marquee widens the label, the band follows.
let narrow = make(["running": true, "thinking": true], width: 90)
report["narrow"] = ["cell": describe(narrow), "sweep": animation(narrow.shimmer!)]
let wide = make(["running": true, "thinking": true], width: 200)
let rest = animation(wide.shimmer!)
wide.setHovered(true)
wide.layoutSubtreeIfNeeded(); wide.title?.layoutSubtreeIfNeeded()
report["hover"] = ["rest": rest, "marquee": wide.title?.running ?? false, "hovered": animation(wide.shimmer!), "cell": describe(wide), "archive": (wide.archive?.alphaValue ?? 0) > 0]
wide.setHovered(false)
wide.layoutSubtreeIfNeeded(); wide.title?.layoutSubtreeIfNeeded()
report["unhover"] = ["marquee": wide.title?.running ?? false, "sweep": animation(wide.shimmer!), "cell": describe(wide)]

// Leaving the window ends the animation, the mask and the dimming; coming back restores them.
thinking.removeFromSuperview()
report["detached"] = describe(thinking)
root.addSubview(thinking)
report["attached"] = describe(thinking)
SidebarMarqueeTitle.reduceMotionOverride = true
thinking.removeFromSuperview()
shimmer.refresh()
report["detachedReduced"] = describe(thinking)
SidebarMarqueeTitle.reduceMotionOverride = false

// A row rebuilt by a state change: the old cell's shimmer is gone with it, and nothing keeps it.
weak var gone: SidebarTitleShimmer?
autoreleasepool {
    let old = make(["running": true, "thinking": true])
    gone = old.shimmer
    old.removeFromSuperview()
}
report["released"] = gone == nil
// The phase comes from the clock, so a rebuilt row carries on where it was.
root.addSubview(thinking)
let before = (thinking.shimmer?.band.animation(forKey: "shimmer") as? CABasicAnimation)?.timeOffset ?? -1
let rebuilt = make(["running": true, "thinking": true])
let offsets = [before, (rebuilt.shimmer?.band.animation(forKey: "shimmer") as? CABasicAnimation)?.timeOffset ?? -1]
report["offsets"] = offsets

// Contrast of the dimmed title (the band only raises it).
var ratios: [String: CGFloat] = [:]
for (name, appearance) in [("light", NSAppearance(named: .aqua)!), ("dark", NSAppearance(named: .darkAqua)!)] {
    let resting = SidebarTitleShimmer.resting(emphasized: false), strong = SidebarTitleShimmer.resting(emphasized: true)
    ratios["\(name).unselected"] = contrast(.labelColor, alpha: resting, over: .windowBackgroundColor, appearance: appearance)
    ratios["\(name).selected"] = contrast(.labelColor, alpha: resting, over: .unemphasizedSelectedContentBackgroundColor, appearance: appearance)
    ratios["\(name).emphasized"] = contrast(.alternateSelectedControlTextColor, alpha: strong, over: .selectedContentBackgroundColor, appearance: appearance)
}
report["contrast"] = ratios

print(String(data: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), encoding: .utf8)!)
