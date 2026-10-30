import AppKit
import ObjectiveC

// LKM-387: the real `SidebarChatCell` and `SidebarMarqueeTitle`, hovered through `setHovered`, in
// a window that is never ordered in. The window server's composite is not available here, so each
// sample rebuilds it from what decides it: the rect AppKit really painted into the label (its
// `draw` dirty rect), the label's frame, any layer translation and the title's clip. Prints the
// samples as JSON for test/sidebar-marquee.mjs. It reads no API the unfixed code lacked, so the
// same fixture shows the defect against that code.
_ = NSApplication.shared

final class NativeShell: NSObject {
    var rows: [ShellRow] = []
    var currentProject: String?
    var selectedID: String?
    var sidebarHistory = SidebarHistoryState()
    var applying = false
    let outline = NSOutlineView()
    let sidebar = NSViewController()
    @objc func contextAction(_ sender: Any?) {}
    func projectMenu(_ row: ShellRow) -> NSMenu { NSMenu() }
}
func emit(_ value: [String: Any]) {}

var painted: [ObjectIdentifier: NSRect] = [:]
var recording = Set<ObjectIdentifier>()
/// Records what AppKit paints. On macOS 27 a label's text is drawn by a private subview, and a
/// subclass that overrides `draw` changes which path a view takes, so the class's own
/// `drawRect:` is wrapped in place and AppKit keeps its real path.
func record(_ type: AnyClass) {
    guard recording.insert(ObjectIdentifier(type)).inserted, let method = class_getInstanceMethod(type, NSSelectorFromString("drawRect:")) else { return }
    typealias Draw = @convention(c) (AnyObject, Selector, NSRect) -> Void
    let original = unsafeBitCast(method_getImplementation(method), to: Draw.self)
    let wrapped: @convention(block) (AnyObject, NSRect) -> Void = { view, dirty in
        painted[ObjectIdentifier(view)] = dirty
        original(view, NSSelectorFromString("drawRect:"), dirty)
    }
    method_setImplementation(method, imp_implementationWithBlock(wrapped))
}

// Long enough at the default width: AppKit paints a whole label when most of it is visible.
let long = "A sidebar chat whose title runs on far past its row"
let short = "Short title"
let shell = NativeShell()
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 400), styleMask: [.borderless], backing: .buffered, defer: false)
let root = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: 400))
root.wantsLayer = true
window.contentView = root

var slot: CGFloat = 0
func makeCell(_ text: String, width: CGFloat, archive: Bool = true, selected: Bool = false) -> SidebarChatCell {
    let row = ShellRow(["id": "chat:\(slot)", "kind": "chat", "project": "p", "title": text])
    let cell = SidebarChatCell(row: row, canArchive: archive, target: shell)
    cell.frame = NSRect(x: 0, y: slot, width: width, height: SidebarRowStyle.height)
    slot += SidebarRowStyle.height
    root.addSubview(cell)
    if selected { cell.backgroundStyle = .emphasized }
    cell.layoutSubtreeIfNeeded()
    return cell
}

/// What the row shows now, in the title's coordinates.
func sample(_ cell: SidebarChatCell, at elapsed: Double) -> [String: Any] {
    let title = cell.title!, label = title.label
    cell.layoutSubtreeIfNeeded()
    // Only the painted part reaches the screen: AppKit's real choice, never a full redraw.
    label.display()
    let painter = label.subviews.first ?? label
    record(type(of: painter))
    painter.needsDisplay = true
    painted[ObjectIdentifier(painter)] = nil
    painter.display()
    // A host whose label paints through `updateLayer` shows no `drawRect:`; its visible rect is the same limit.
    let seen = painted[ObjectIdentifier(painter)]
    let paint = seen ?? label.visibleRect
    var moved: CGFloat = 0
    if let scroll = label.layer?.animation(forKey: "marquee") as? CABasicAnimation {
        let progress = max(0, min(1, (CACurrentMediaTime() - scroll.beginTime) / scroll.duration))
        moved = CGFloat(truncating: scroll.toValue as! NSNumber) * CGFloat(progress)
    }
    let origin = label.frame.minX + moved
    let inset = label.alignmentRect(forFrame: label.frame).minX - label.frame.minX
    let rep = label.bitmapImageRepForCachingDisplay(in: label.bounds)!
    label.cacheDisplay(in: label.bounds, to: rep)
    let scale = CGFloat(rep.pixelsWide) / label.bounds.width
    let alpha = rep.bitmapFormat.contains(.alphaFirst) ? 0 : rep.samplesPerPixel - 1
    var ink: [CGFloat] = []
    for column in 0..<rep.pixelsWide {
        let x = (CGFloat(column) + 0.5) / scale
        let shown = origin + x
        guard x >= paint.minX, x < paint.maxX, shown >= 0, shown < title.bounds.width else { continue }
        let hit = (0..<rep.pixelsHigh).contains { row in
            rep.bitmapData![row * rep.bytesPerRow + column * rep.samplesPerPixel + alpha] > 60
        }
        if hit { ink.append(shown) }
    }
    let gaps = zip(ink, ink.dropFirst()).map { $1 - $0 }
    var state: [String: Any] = [
        "at": elapsed, "width": title.bounds.width, "travel": title.travel, "running": title.running,
        "natural": ceil(label.intrinsicContentSize.width), "labelWidth": label.frame.width, "offset": 0 - (origin + inset),
        "truncated": label.lineBreakMode == .byTruncatingTail, "paintSeen": seen != nil, "painter": NSStringFromClass(type(of: painter)), "paintFrom": paint.minX, "paintTo": paint.maxX,
        "inkFrom": ink.first ?? -1, "inkTo": ink.last ?? -1, "gap": gaps.max() ?? 0,
        "titleRight": title.frame.maxX, "rowWidth": cell.bounds.width
    ]
    if let archive = cell.archive { state["archiveLeft"] = archive.frame.minX; state["archiveShown"] = archive.alphaValue > 0 }
    if let mask = title.layer?.mask as? CAGradientLayer, let colors = mask.colors as! [CGColor]?, colors.count == 4 {
        state["edgeLeading"] = colors[0].alpha; state["edgeTrailing"] = colors[3].alpha
        state["maskFrom"] = mask.frame.minX; state["maskTo"] = mask.frame.maxX
    }
    return state
}

func pump(_ seconds: TimeInterval) { RunLoop.main.run(until: Date(timeIntervalSinceNow: seconds)) }

var report: [String: [String: Any]] = [:]
let delay = SidebarMarqueeTitle.delay, speed = Double(SidebarMarqueeTitle.speed)
/// What each cell does and when: a named sample, or an action on the cell.
var plan: [(at: Double, name: String, run: () -> Void)] = []
func take(_ scenario: String, _ phase: String, _ cell: SidebarChatCell, at time: Double) {
    plan.append((time, "\(scenario)/\(phase)", {
        report[scenario, default: [:]][phase] = sample(cell, at: CACurrentMediaTime() - began)
    }))
}
func resize(_ cell: SidebarChatCell, to width: CGFloat, at time: Double) {
    plan.append((time, "resize", {
        cell.setFrameSize(NSSize(width: width, height: cell.frame.height))
        cell.layoutSubtreeIfNeeded()
    }))
}
/// Start, middle and end of a title with this travel; the end is well after the text arrives.
func phases(_ scenario: String, _ cell: SidebarChatCell) {
    let travel = Double(cell.title!.travel) + 20 + 6 // the hovered title gives up the Archive width
    take(scenario, "start", cell, at: 0.3)
    take(scenario, "mid", cell, at: delay + travel / speed / 2)
    take(scenario, "end", cell, at: delay + travel / speed + 0.5)
}

let selected = makeCell(long, width: 230, selected: true)
let unselected = makeCell(long, width: 230)
let bare = makeCell(long, width: 230, archive: false)
let narrow = makeCell(long, width: 170, selected: true)
let narrowUnselected = makeCell(long, width: 170)
let narrowedInDelay = makeCell(long, width: 230, selected: true)
let narrowedMid = makeCell(long, width: 230)
let narrowedAtEnd = makeCell(long, width: 230, selected: true)
let widenedAtEnd = makeCell(long, width: 200)
let widenedToFit = makeCell(long, width: 200)
let overflowsLater = makeCell(short, width: 230)
let fits = makeCell(short, width: 230, selected: true)
let leaving = makeCell(long, width: 230, selected: true)
let still = makeCell(long, width: 230, selected: true)
report["rest"] = ["selected": sample(selected, at: 0), "still": sample(still, at: 0)]

phases("selected", selected)
phases("unselected", unselected)
phases("bare", bare)
phases("narrow", narrow)
phases("narrowUnselected", narrowUnselected)
take("timing", "before", unselected, at: delay - 0.25)
take("timing", "early", unselected, at: delay + 0.4)
take("timing", "late", unselected, at: delay + 1.1)

resize(narrowedInDelay, to: 170, at: 0.3)
take("narrowedInDelay", "mid", narrowedInDelay, at: 3.0)
take("narrowedInDelay", "end", narrowedInDelay, at: 7.8)
resize(narrowedMid, to: 170, at: 1.2)
take("narrowedMid", "after", narrowedMid, at: 1.5)
take("narrowedMid", "end", narrowedMid, at: 7.8)
take("narrowedAtEnd", "held", narrowedAtEnd, at: 5.7)
resize(narrowedAtEnd, to: 170, at: 5.8)
take("narrowedAtEnd", "end", narrowedAtEnd, at: 7.8)
take("widenedAtEnd", "held", widenedAtEnd, at: 6.7)
resize(widenedAtEnd, to: 240, at: 6.8)
take("widenedAtEnd", "end", widenedAtEnd, at: 7.0)
take("widenedToFit", "held", widenedToFit, at: 6.7)
resize(widenedToFit, to: 400, at: 6.8)
take("widenedToFit", "end", widenedToFit, at: 7.0)
resize(overflowsLater, to: 90, at: 0.9)
take("overflowsLater", "start", overflowsLater, at: 0.6)
take("overflowsLater", "end", overflowsLater, at: 3.0)
take("fits", "end", fits, at: 1.5)
take("leaving", "scrolling", leaving, at: 1.4)
plan.append((1.5, "leave", { leaving.setHovered(false) }))
take("leaving", "end", leaving, at: 1.6)
take("still", "end", still, at: 2.0)

// Never nil: nil reads the host's Reduce Motion setting (some CI runners have it on), and this
// run must not depend on it or change it. Only `still` hovers with it on.
SidebarMarqueeTitle.reduceMotionOverride = false
for cell in [selected, unselected, bare, narrow, narrowUnselected, narrowedInDelay, narrowedMid, narrowedAtEnd, widenedAtEnd,
             widenedToFit, overflowsLater, fits, leaving] { cell.setHovered(true) }
SidebarMarqueeTitle.reduceMotionOverride = true
still.setHovered(true)
SidebarMarqueeTitle.reduceMotionOverride = false
let began = CACurrentMediaTime()

for step in plan.sorted(by: { $0.at < $1.at }) {
    pump(max(0, step.at - (CACurrentMediaTime() - began)))
    step.run()
}
still.setHovered(false)
report["stillLeft"] = ["end": sample(still, at: 0)]

let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
