import AppKit

// LKM-432: the branch pop-up's busy spinner against its truncated text. The real
// `BranchPopUpButton` is laid out in an offscreen window the way the shell fills its title
// ("Branch · [dot][spinner] · Changes 2↑"), at widths that fit it, that cut it after the dot and
// that cut it inside the branch name. Each case reports the spinner's mode and fit and the dot;
// a last case moves the spinner over the text by hand, which the fit check must refuse. One
// JSON report on stdout.
_ = NSApplication.shared
let small = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)
func scene(width: CGFloat, branch: String, busy: Bool = true, rest: String = " · Changes 2↑", ci: String = "running") -> (BranchPopUpButton, NSWindow) {
    let button = BranchPopUpButton(frame: NSRect(x: 20, y: 20, width: width, height: 20), pullsDown: true)
    button.isBordered = false; button.font = small
    button.cell?.lineBreakMode = .byTruncatingTail
    let prefix = "\(branch) · ", dotted = prefix + BranchStatusDot.slot
    let display = dotted + (busy ? " " + BranchStatusDot.slot : "") + rest
    button.addItem(withTitle: display)
    let style = NSMutableParagraphStyle(); style.lineBreakMode = .byTruncatingTail
    button.item(at: 0)?.attributedTitle = NSAttributedString(string: display, attributes: [.foregroundColor:NSColor.black, .font:small, .paragraphStyle:style])
    button.setDot(ci, after: prefix)
    button.setProgress(busy, after: dotted + " ", description: display)
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width + 40, height: 60), styleMask: [.borderless], backing: .buffered, defer: false)
    window.appearance = NSAppearance(named: .aqua)
    window.contentView = NSView(frame: window.contentRect(forFrameRect: window.frame))
    window.contentView?.addSubview(button)
    button.layoutSubtreeIfNeeded()
    return (button, window)
}
func report(_ button: BranchPopUpButton) -> [String: Any] {
    let state = button.progressInspect
    return ["mode": state["branchProgressMode"] ?? "", "fits": state["branchProgressFits"] ?? false, "busy": state["branchBusy"] ?? false,
            "dotVisible": state["branchDotVisible"] ?? false, "dotFits": state["branchDotFits"] ?? false,
            "spinner": state["branchProgressFrame"] ?? "", "dot": state["branchDotFrame"] ?? ""]
}
var out: [String: Any] = [:]
let long = "trezi/chat-0123456789abcdef-long-branch-name"
var keep: [NSWindow] = []
let (wide, w1) = scene(width: 320, branch: "Branch"); keep.append(w1)
out["wide"] = report(wide)
let (cut, w2) = scene(width: 92, branch: "Branch"); keep.append(w2)
out["cutAfterDot"] = report(cut)
let (name, w3) = scene(width: 92, branch: long); keep.append(w3)
out["cutInName"] = report(name)
let (idle, w4) = scene(width: 92, branch: long, busy: false); keep.append(w4)
out["idle"] = report(idle)
// The old placement: the spinner at the end of its slot in the text, over the ellipsis.
let (over, w5) = scene(width: 92, branch: long); keep.append(w5)
over.progress.frame.origin.x = over.bounds.width - 16 - 12 - 14
out["spinnerOverText"] = report(over)
// LKM-440: the 850 pt toolbar's idle placeholder title, cut one glyph short (91.5 pt frame).
// Ink runs (window x) with the dot shown: the ellipsis follows the dot, the chevron follows it.
for (key, width) in [("cutAfterSlot", CGFloat(91.5)), ("fitsWhole", CGFloat(94.5))] {
    let (idle, window) = scene(width: width, branch: "Branch", busy: false, rest: " · ?", ci: "unknown"); keep.append(window)
    let ink = renderedText(idle, text: idle.itemTitle(at: 0), font: small)?.runs ?? []
    let dot = idle.dot.convert(idle.dot.bounds, to: nil)
    out[key] = report(idle).merging(["cut": idle.titleCut, "kept": idle.keptSlots, "dotFrame": [dot.minX, dot.maxX],
                                     "runs": ink.map { [$0.0, $0.1] }]) { _, new in new }
}
print(String(data: try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
