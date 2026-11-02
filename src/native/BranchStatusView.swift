import AppKit

/// LKM-184: the branch pull-down under the address. The borderless cell starts its title
/// 3 pt inside the control's alignment edge (less, by a varying amount, when squeezed),
/// while the address text starts on that edge. `BranchPopUpCell` draws the title from the
/// alignment edge, and the control gives up those 3 pt so the chevron still follows it.
final class BranchPopUpButton: NSPopUpButton {
    /// The stock cell's title inset beyond the alignment edge (macOS 26).
    static let titleInset: CGFloat = 3
    static let spinnerSize: CGFloat = 12
    /// LKM-432: where the busy spinner sits against the title. `inline` is its slot in the text.
    /// A truncated title can end before, or under, that slot, so the spinner takes the trailing
    /// room instead and the cell gives up that width: `clipped` cuts the text there with no
    /// ellipsis while the CI dot's slot still fits, `trailing` truncates it with an ellipsis and
    /// hides the dot.
    enum SpinnerMode: String { case inline, clipped, trailing }
    /// Internal for `test/branch-spinner.mjs`, which moves it over the text to see the fit check fail.
    let progress = NSProgressIndicator()
    private var progressPrefix = ""
    private(set) var spinnerMode = SpinnerMode.inline { didSet { if spinnerMode != oldValue { needsDisplay = true } } }
    let dot = BranchStatusDot()
    private var dotPrefix = ""
    override init(frame: NSRect, pullsDown: Bool) {
        super.init(frame: frame, pullsDown: pullsDown)
        cell = BranchPopUpCell(textCell: "", pullsDown: pullsDown)
        progress.style = .spinning
        progress.controlSize = .small
        progress.isIndeterminate = true
        progress.isHidden = true
        progress.setAccessibilityLabel("Branch status in progress")
        addSubview(dot)
        addSubview(progress)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
    func setProgress(_ busy: Bool, after prefix: String, description: String) {
        progressPrefix = prefix
        if busy { progress.startAnimation(nil) } else { progress.stopAnimation(nil) }
        progress.isHidden = !busy
        let value = busy ? "Busy: \(description)" : description
        if accessibilityValue() as? String != value { setAccessibilityValue(value) }
        needsLayout = true
    }
    /// The CI dot sits in `BranchStatusDot.slot`, right after `prefix` in the title.
    func setDot(_ ci: String, after prefix: String) {
        dotPrefix = prefix; dot.state = ci
        needsLayout = true
    }
    private func width(_ text: String) -> CGFloat {
        NSAttributedString(string: text, attributes: [.font:font ?? NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)]).size().width
    }
    /// The title as the cell lays it out with no spinner room taken.
    private var fullTitle: NSRect { (cell as? BranchPopUpCell)?.titleRect(forBounds: bounds, reserving: 0) ?? bounds }
    /// The dot's slot in the title: the same rect in every CI state, busy or not.
    private var dotSlot: NSRect {
        let title = fullTitle
        return NSRect(x: title.minX + width(dotPrefix), y: title.minY, width: width(BranchStatusDot.slot), height: title.height)
    }
    override func layout() {
        super.layout()
        let full = fullTitle, slot = dotSlot, size = BranchStatusDot.diameter, side = Self.spinnerSize
        let natural = full.minX + width(progressPrefix)
        // The slot in the text is only the spinner's room while the text around it is not cut:
        // the ellipsis of a truncated title would otherwise sit under it.
        if progress.isHidden || width(itemTitle(at: 0)) <= full.width || natural + side + width("…") <= full.maxX { spinnerMode = .inline }
        else if slot.maxX <= full.maxX - side + 0.5 { spinnerMode = .clipped }
        else { spinnerMode = .trailing }
        let x = spinnerMode == .inline ? max(full.minX, min(natural, full.maxX - side)) : full.maxX - side
        progress.frame = NSRect(x: x, y: full.midY - side / 2, width: side, height: side)
        dot.frame = backingAlignedRect(NSRect(x: slot.midX - size / 2, y: slot.midY - size / 2, width: size, height: size), options: .alignAllEdgesNearest)
        // Tail truncation keeps the slot only while it and the ellipsis still fit; clipping has none.
        let title = cell?.titleRect(forBounds: bounds) ?? bounds
        dot.isHidden = spinnerMode != .clipped && width(itemTitle(at: 0)) > title.width && slot.maxX + width("…") > title.maxX
    }
    /// LKM-432: the spinner meets neither text, chevron nor dot. The pop-up is drawn at 8x
    /// without the spinner and the dot, and no inked run of it (title glyphs, ellipsis, chevron)
    /// may reach into the spinner's window frame. Fails closed when nothing could be drawn.
    private func spinnerClear() -> Bool {
        guard !progress.isHidden else { return true }
        let dotHidden = dot.isHidden, dotFrame = dot.convert(dot.bounds, to: nil), spinner = progress.convert(progress.bounds, to: nil)
        progress.isHidden = true; dot.isHidden = true
        defer { progress.isHidden = false; dot.isHidden = dotHidden }
        guard let ink = renderedText(self, text: itemTitle(at: 0), font: font) else { return false }
        let inked = ink.runs.contains { $0.0 < spinner.maxX - 0.5 && $0.1 > spinner.minX + 0.5 }
        return !inked && (dotHidden || !dotFrame.insetBy(dx: 0.5, dy: 0.5).intersects(spinner))
    }
    var progressInspect: [String: Any] {
        let frame = progress.convert(progress.bounds, to: nil)
        return ["branchBusy":!progress.isHidden, "branchProgressNative":progress.style == .spinning && progress.isIndeterminate,
                "branchProgressFrame":NSStringFromRect(frame), "branchProgressMode":spinnerMode.rawValue,
                "branchProgressFits":fullTitle.contains(progress.frame) && spinnerClear(),
                "branchAccessibilityValue":accessibilityValue() as? String ?? ""]
            .merging(dot.inspect(slot: dotSlot, in: self)) { _, new in new }
    }
    override var intrinsicContentSize: NSSize {
        let size = super.intrinsicContentSize
        return NSSize(width: max(0, size.width - Self.titleInset), height: size.height)
    }
}

final class BranchPopUpCell: NSPopUpButtonCell {
    /// What the stock cell keeps after the title for the chevron, which it draws 13 pt before the trailing edge.
    static let chevronRoom: CGFloat = 16
    override func titleRect(forBounds rect: NSRect) -> NSRect {
        let mode = (controlView as? BranchPopUpButton)?.spinnerMode ?? .inline
        return titleRect(forBounds: rect, reserving: mode == .inline ? 0 : BranchPopUpButton.spinnerSize)
    }
    /// The title's room minus `reserving` pt at its trailing edge, which the busy spinner takes.
    func titleRect(forBounds rect: NSRect, reserving: CGFloat) -> NSRect {
        let stock = super.titleRect(forBounds: rect), leading = controlView?.alignmentRectInsets.left ?? 0
        return NSRect(x: rect.minX + leading, y: stock.minY, width: max(0, rect.width - leading - Self.chevronRoom - reserving), height: stock.height)
    }
    override func drawTitle(_ title: NSAttributedString, withFrame frame: NSRect, in controlView: NSView) -> NSRect {
        let rect = titleRect(forBounds: controlView.bounds)
        guard (controlView as? BranchPopUpButton)?.spinnerMode == .clipped else {
            return super.drawTitle(title, withFrame: NSRect(x: rect.minX, y: frame.minY, width: rect.width, height: frame.height), in: controlView)
        }
        // Laid out wide enough to need no ellipsis, then cut at the spinner's room.
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        NSBezierPath(rect: NSRect(x: rect.minX, y: controlView.bounds.minY, width: rect.width, height: controlView.bounds.height)).addClip()
        return super.drawTitle(title, withFrame: NSRect(x: rect.minX, y: frame.minY, width: title.size().width.rounded(.up) + 2, height: frame.height), in: controlView)
    }
}

/// The CI status dot (LKM-245): one drawn circle of fixed diameter, so no state swaps in
/// a glyph with other metrics. Passed and failed fill it; running (dashed), no checks
/// and unknown stroke it inside the same outer edge. Colours are the glyphs' old ones:
/// red failed, green passed, orange running, the title text colour otherwise. The
/// spinner stays a separate view.
final class BranchStatusDot: NSView {
    static let diameter: CGFloat = 7
    /// Two en spaces reserve the dot's room in the title text.
    static let slot = "\u{2002}\u{2002}"
    var state = "unknown" { didSet { if state != oldValue { needsDisplay = true } } }
    /// The title's text colour, which follows the preview header (`NativeShell.previewTextColor`).
    var textColor = NSColor.labelColor { didSet { needsDisplay = true } }
    var filled: Bool { state == "passed" || state == "failed" }
    var colorRole: String { state == "failed" ? "red" : state == "passed" ? "green" : state == "running" ? "orange" : "text" }
    private var color: NSColor {
        switch colorRole { case "red": return .systemRed; case "green": return .systemGreen; case "orange": return .systemOrange; default: return textColor }
    }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func isAccessibilityElement() -> Bool { false }
    override func viewDidChangeEffectiveAppearance() { needsDisplay = true }
    override func draw(_ dirtyRect: NSRect) {
        color.set()
        if filled { NSBezierPath(ovalIn: bounds).fill(); return }
        let line: CGFloat = 1.25, ring = NSBezierPath(ovalIn: bounds.insetBy(dx: line / 2, dy: line / 2))
        ring.lineWidth = line
        if state == "running" { ring.setLineDash([1.6, 1.2], count: 2, phase: 0) }
        ring.stroke()
    }
    func inspect(slot: NSRect, in button: NSView) -> [String: Any] {
        let frame = convert(bounds, to: nil), title = button.convert(slot, to: nil)
        return ["branchDotState":state, "branchDotFilled":filled, "branchDotColor":colorRole, "branchDotVisible":!isHidden && window != nil,
                "branchDotFrame":NSStringFromRect(frame), "branchDotLocalFrame":NSStringFromRect(self.frame), "branchDotDiameter":[frame.width, frame.height],
                "branchDotSlot":NSStringFromRect(title), "branchDotFits":slot.contains(self.frame),
                "branchDotBaseline":frame.midY - title.midY]
    }
}

/// Where a control's rendered text starts and its ink runs (window x): the view is drawn
/// at 8x, its first inked column found and the first glyph's left side bearing subtracted,
/// so a bold "h" and a regular "t" compare by text origin rather than by ink.
func renderedText(_ view: NSView, text: String, font: NSFont?) -> (origin: CGFloat, runs: [(CGFloat, CGFloat)])? {
    let scale: CGFloat = 8, bounds = view.bounds
    guard view.window != nil, bounds.width > 0, bounds.height > 0, let first = text.first,
          let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int((bounds.width * scale).rounded(.up)), pixelsHigh: Int((bounds.height * scale).rounded(.up)),
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 32),
          let data = rep.bitmapData else { return nil }
    rep.size = bounds.size
    view.cacheDisplay(in: bounds, to: rep)
    let x0 = view.convert(bounds, to: nil).minX
    func inked(_ x: Int) -> Bool { (0..<rep.pixelsHigh).contains { data[$0 * rep.bytesPerRow + x * 4 + 3] > 25 } }
    var runs: [(CGFloat, CGFloat)] = [], start: Int?
    for x in 0...rep.pixelsWide {
        let ink = x < rep.pixelsWide && inked(x)
        if ink, start == nil { start = x }
        if !ink, let begin = start { runs.append((x0 + CGFloat(begin) / scale, x0 + CGFloat(x) / scale)); start = nil }
    }
    guard let ink = runs.first?.0 else { return nil }
    let glyph = NSAttributedString(string: String(first), attributes: [.font:font ?? NSFont.systemFont(ofSize: NSFont.systemFontSize)])
    return (ink - glyph.boundingRect(with: .zero, options: [.usesLineFragmentOrigin, .usesDeviceMetrics]).minX, runs)
}
