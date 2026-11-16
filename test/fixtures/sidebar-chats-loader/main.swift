import AppKit

// LKM-618: the real `SidebarChatsLoaderCell` and the real `ShellRow` nesting, in a window that is
// never ordered in. The cat's frames are the build's own `cat.json` (argv[1]). Prints JSON for
// test/sidebar-chats-loader.mjs.
_ = NSApplication.shared

final class NativeShell: NSObject {
    var rows: [ShellRow] = []
    var sidebarDecipherStarts: [String: CFTimeInterval] = [:]
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

let assets = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
CatArtwork.frames = try JSONDecoder().decode([String: [CatFrame]].self, from: assets)
// Never nil: the run must not depend on the host's Reduce Motion setting.
SidebarChatsLoaderCell.reduceMotionOverride = false

let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 200), styleMask: [.borderless], backing: .buffered, defer: false)
let root = NSView(frame: window.contentLayoutRect)
root.wantsLayer = true
window.contentView = root
var report: [String: Any] = [:]

// Nesting: one line after the known chats, before History; none without `chatsLoading`.
let project = ShellRow(["id":"project:p", "kind":"project", "project":"p", "title":"P", "chatsLoading":true,
                        "recent":[["id":"chat:a", "kind":"chat", "project":"p", "title":"Cached"]],
                        "children":[["id":"chat:a", "kind":"chat", "project":"p", "title":"Cached"],
                                    ["id":"history:h", "kind":"history", "project":"p", "title":"Old", "detail":"3d"]]])
let shell = NativeShell()
shell.rows = [project]; shell.currentProject = "p"; shell.selectedID = "chat:a"
report["nested"] = project.nested.map(\.id)
project.layoutNested(open: true, all: false)
report["nestedHistory"] = project.nested.map(\.id)
report["plain"] = ShellRow(["id":"project:q", "kind":"project", "project":"q", "title":"Q", "recent":[[String: Any]]()]).nested.map(\.id)
let line = project.nested.first { $0.kind == "chats-loading" }!
report["interaction"] = ["selectable": shell.outlineView(shell.outline, shouldSelectItem: line), "menu": shell.sidebarRowMenu(line).map(\.title),
                         "archive": shell.canArchive(line), "target": shell.sidebarTarget()?.id ?? ""]

func make(width: CGFloat) -> SidebarChatsLoaderCell {
    let cell = SidebarChatsLoaderCell(row: line)
    cell.frame = NSRect(x: 0, y: 0, width: width, height: SidebarRowStyle.height)
    root.addSubview(cell)
    cell.layoutSubtreeIfNeeded()
    return cell
}
let cell = make(width: 200)
report["wide"] = cell.inspect()
cell.frame.size.width = 120; cell.layoutSubtreeIfNeeded()
report["resized"] = cell.inspect()
cell.frame.size.width = 20; cell.layoutSubtreeIfNeeded()
report["cramped"] = cell.inspect()
cell.frame.size.width = 200; cell.layoutSubtreeIfNeeded()
let firstOffset = (cell.cat.animation(forKey: "travel") as? CAKeyframeAnimation)?.timeOffset ?? -1
let rebuilt = make(width: 200)
report["offsets"] = [firstOffset, (rebuilt.cat.animation(forKey: "travel") as? CAKeyframeAnimation)?.timeOffset ?? -1]
rebuilt.removeFromSuperview()
SidebarChatsLoaderCell.reduceMotionOverride = true
cell.restart(force: true)
report["reduced"] = cell.inspect()
SidebarChatsLoaderCell.reduceMotionOverride = false
cell.restart(force: true)
report["restored"] = cell.inspect()
cell.isHidden = true
report["hidden"] = cell.inspect()
cell.isHidden = false
report["unhidden"] = cell.inspect()
// LKM-705: what the cat actually shows, sampled from its presentation layer on both legs. A short
// row (one-second legs) keeps the run quick. Each sample rasterizes the shown frame with the shown
// mirroring and measures where the head sits against the body (`lead` > 0: head to the right).
func lead(_ path: CGPath, scaleX: CGFloat, strip: CGContext? = nil, at slot: Int = 0) -> Double {
    let scale: CGFloat = 4, side = Int(SidebarChatsLoaderCell.catSize * scale), half = SidebarChatsLoaderCell.catSize / 2
    let ctx = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side, space: CGColorSpaceCreateDeviceGray(),
                        bitmapInfo: CGImageAlphaInfo.none.rawValue)!
    ctx.scaleBy(x: scale, y: scale)
    // The layer's transform about its centre anchor, as the compositor applies it.
    ctx.translateBy(x: half, y: 0); ctx.scaleBy(x: scaleX, y: 1); ctx.translateBy(x: -half, y: 0)
    ctx.setFillColor(gray: 1, alpha: 1); ctx.addPath(path); ctx.fillPath()
    if let strip, let image = ctx.makeImage() { strip.draw(image, in: CGRect(x: slot * (side + 4), y: 0, width: side, height: side)) }
    let bytes = ctx.data!.assumingMemoryBound(to: UInt8.self)
    var sums = [0.0, 0.0, 0.0, 0.0] // head x, head count, body x, body count (row 0 is the top)
    for row in 0..<side { for column in 0..<side where bytes[row * side + column] > 127 {
        let k = row < side / 2 ? 0 : 2; sums[k] += Double(column) + 0.5; sums[k + 1] += 1
    } }
    return (sums[0] / max(1, sums[1]) - sums[2] / max(1, sums[3])) / Double(scale)
}
let runner = make(width: SourceList.iconLeading + 8 + SidebarChatsLoaderCell.catSize + 44)
RunLoop.current.run(until: Date().addingTimeInterval(0.05))
let runMove = runner.cat.animation(forKey: "travel") as! CAKeyframeAnimation
let period = runMove.duration
func sample(_ slot: Int? = nil, strip: CGContext? = nil) -> [String: Double]? {
    // The time the cat's layer is at: the media clock while it runs, the scrubbed time while held.
    let t = runner.cat.convertTime(CACurrentMediaTime(), from: nil)
    guard let shown = runner.cat.presentation(), let path = shown.path else { return nil }
    return ["t": t, "phase": t.truncatingRemainder(dividingBy: period) / period, "x": Double(shown.position.x),
            "scaleX": Double(shown.transform.m11), "lead": lead(path, scaleX: shown.transform.m11, strip: slot == nil ? nil : strip, at: slot ?? 0)]
}
// Live: a few samples as it runs, read at the media clock.
var live: [[String: Double]] = []
for _ in 0..<8 {
    RunLoop.current.run(until: Date().addingTimeInterval(0.25))
    if let value = sample() { live.append(value) }
}
// Held: the layer's clock (the media clock while running; nothing above it is retimed) is
// stopped and set to known times, along both legs and 10 ms either side of each turn.
let phases = [0.04, 0.15, 0.25, 0.35, 0.45, 0.495, 0.505, 0.55, 0.65, 0.75, 0.85, 0.95, 0.995, 1.005, 1.05]
let stripSide = Int(SidebarChatsLoaderCell.catSize * 4)
let strip = CommandLine.arguments.count > 2
    ? CGContext(data: nil, width: phases.count * (stripSide + 4), height: stripSide, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) : nil
let cycle = (CACurrentMediaTime() / period).rounded(.down) * period + period
var samples: [[String: Double]] = []
runner.cat.speed = 0
for (slot, phase) in phases.enumerated() {
    runner.cat.timeOffset = cycle + phase * period
    CATransaction.flush()
    if let value = sample(slot, strip: strip) { samples.append(value) }
}
runner.cat.speed = 1; runner.cat.timeOffset = 0
if let strip, let image = strip.makeImage(),
   let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) {
    try png.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
}
// The bare art, unmirrored, for the same measure.
let artLead = (CatArtwork.frames["run"] ?? []).map { lead(SidebarChatsLoaderCell.path($0.pixels), scaleX: 1) }
// Rehosted mid-run: the new row shows the same place and facing at the same moment.
let rehost = make(width: runner.frame.width)
RunLoop.current.run(until: Date().addingTimeInterval(0.05))
let pair = [runner.cat.presentation(), rehost.cat.presentation()]
report["legs"] = ["period": period, "from": (runMove.values?.first as? NSNumber)?.doubleValue ?? -1, "travel": Double(runner.travel),
                  "samples": samples, "live": live, "artLead": artLead,
                  "rehost": pair.map { ["x": Double($0?.position.x ?? -1), "scaleX": Double($0?.transform.m11 ?? 0)] }]
rehost.removeFromSuperview(); runner.removeFromSuperview()

// The list loaded: the row is discarded. Nothing runs on, nothing keeps the cell.
weak var gone: SidebarChatsLoaderCell?
var detached: [String: Any] = [:]
autoreleasepool {
    let transient = make(width: 200)
    gone = transient
    transient.removeFromSuperview()
    detached = transient.inspect()
}
report["detached"] = detached
report["released"] = gone == nil
cell.removeFromSuperview()

print(String(data: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), encoding: .utf8)!)
