import AppKit

/// The preview address/branch block. Re-measures the toolbar after each of its layouts.
final class ToolbarAddressView: NSStackView {
    var measure: (() -> Void)?
    override func layout() {
        super.layout()
        DispatchQueue.main.async { [weak self] in self?.measure?() }
    }
}

/// LKM-184: the branch pull-down under the address. The borderless cell starts its title
/// 3 pt inside the control's alignment edge (less, by a varying amount, when squeezed),
/// while the address text starts on that edge. `BranchPopUpCell` draws the title from the
/// alignment edge, and the control gives up those 3 pt so the chevron still follows it.
final class BranchPopUpButton: NSPopUpButton {
    /// The stock cell's title inset beyond the alignment edge (macOS 26).
    static let titleInset: CGFloat = 3
    override init(frame: NSRect, pullsDown: Bool) {
        super.init(frame: frame, pullsDown: pullsDown)
        cell = BranchPopUpCell(textCell: "", pullsDown: pullsDown)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
    override var intrinsicContentSize: NSSize {
        let size = super.intrinsicContentSize
        return NSSize(width: max(0, size.width - Self.titleInset), height: size.height)
    }
}

final class BranchPopUpCell: NSPopUpButtonCell {
    /// What the stock cell keeps after the title for the chevron, which it draws 13 pt before the trailing edge.
    static let chevronRoom: CGFloat = 16
    override func titleRect(forBounds rect: NSRect) -> NSRect {
        let stock = super.titleRect(forBounds: rect), leading = controlView?.alignmentRectInsets.left ?? 0
        return NSRect(x: rect.minX + leading, y: stock.minY, width: max(0, rect.width - leading - Self.chevronRoom), height: stock.height)
    }
    override func drawTitle(_ title: NSAttributedString, withFrame frame: NSRect, in controlView: NSView) -> NSRect {
        let rect = titleRect(forBounds: controlView.bounds)
        return super.drawTitle(title, withFrame: NSRect(x: rect.minX, y: frame.minY, width: rect.width, height: frame.height), in: controlView)
    }
}

/// Where a control's rendered text starts and its ink runs (window x): the view is drawn
/// at 8x, its first inked column found and the first glyph's left side bearing subtracted,
/// so a bold "h" and a regular "t" compare by text origin rather than by ink.
private func renderedText(_ view: NSView, text: String, font: NSFont?) -> (origin: CGFloat, runs: [(CGFloat, CGFloat)])? {
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

extension NativeShell {
    /// LKM-184: the rendered address and branch text origins (window x) and the gap
    /// between the branch title and its chevron (the pop-up's last ink run).
    func titleAlignment() -> [String: Any] {
        let addressText = address.stringValue.isEmpty ? address.placeholderString ?? "" : address.stringValue
        let branchItem = branchMenu.menu?.items.first
        let branchFont = branchItem?.attributedTitle.flatMap { $0.length > 0 ? $0.attribute(.font, at: 0, effectiveRange: nil) as? NSFont : nil } ?? branchMenu.font
        guard let addressText = renderedText(address, text: addressText, font: address.font),
              let branch = renderedText(branchMenu, text: branchItem?.title ?? "", font: branchFont), branch.runs.count >= 2 else { return ["titleAlignmentMeasured":false] }
        let titleEnd = branch.runs[branch.runs.count - 2].1, chevron = branch.runs[branch.runs.count - 1]
        return ["titleAlignmentMeasured":true, "addressTextLeading":addressText.origin, "branchTextLeading":branch.origin,
                "addressInkLeading":addressText.runs[0].0, "branchInkLeading":branch.runs[0].0,
                "branchTitleRectLeading":branchMenu.convert(branchMenu.cell?.titleRect(forBounds: branchMenu.bounds) ?? .zero, to: nil).minX,
                "branchFrameLeading":branchMenu.convert(branchMenu.bounds, to: nil).minX, "branchFrameWidth":branchMenu.bounds.width,
                "branchTitleEnd":titleEnd, "branchChevronLeading":chevron.0, "branchChevronTrailing":chevron.1,"branchChevronGap":chevron.0 - titleEnd,
                "windowAppearance":window?.effectiveAppearance.name.rawValue ?? ""]
    }
    @objc func windowResized(_ notification: Notification) { alignChatHeader() }
    /// Re-reads the toolbar offsets after a layout, then aligns. Not during a live
    /// resize: frames from the previous pass would pair with the new window width.
    func measureToolbar() {
        guard let window, !window.inLiveResize, let constant = addressWidth?.constant else { return alignChatHeader() }
        if toolbar.visibleItems?.contains(where: { $0.itemIdentifier.rawValue == "address" }) == true {
            addressLayout.measure(window: window, block: addressHeader, constant: constant, chat: chatHeader.window == nil ? nil : chatHeader, right: rightGroup)
        } else if toolbar.isVisible, addressLayout.backOff() {
            // Overflowed: the inset was underestimated. Narrow the block until the
            // toolbar shows it again, then measure the pinned position.
            DispatchQueue.main.async { [weak self] in self?.measureToolbar() }
        }
        alignChatHeader()
    }
    /// A wider Publish label moves the right groups left: make room before the toolbar
    /// lays out, then re-measure the real position.
    func republished(_ title: String) {
        let font = NSFont.systemFont(ofSize: NSFont.systemFontSize)
        func width(_ text: String) -> CGFloat { NSAttributedString(string: text, attributes: [.font:font]).size().width }
        addressLayout.rightInset += max(0, width(title) - width(publishTitle))
        publishTitle = title
        alignChatHeader()
        DispatchQueue.main.async { [weak self] in self?.window?.contentView?.superview?.layoutSubtreeIfNeeded(); self?.measureToolbar() }
    }
    /// The first right action group (select/device).
    var rightGroup: NSView? { toolbar.items.first { $0.itemIdentifier.rawValue == "interaction" }?.view }
    /// The address block's frame against the first right group, laid out now.
    func toolbarInspect() -> [String: Any] {
        window?.contentView?.superview?.layoutSubtreeIfNeeded()
        return addressLayout.inspect(block: addressHeader, right: rightGroup, address: address, branch: branchMenu)
            .merging(["windowWidth":window?.frame.width ?? 0, "addressConstant":addressWidth?.constant ?? 0,
                      "chatHeaderWidth":chatHeader.bounds.width, "chatHeaderTrailing":chatHeader.convert(NSPoint(x: chatHeader.bounds.maxX, y: 0), to: nil).x,
                      "addressVisible":toolbar.visibleItems?.contains { $0.itemIdentifier.rawValue == "address" } ?? false]) { _, new in new }
            .merging(titleAlignment()) { _, new in new }
            .merging(publishTrailingInspect()) { _, new in new }
    }
}

/// LKM-148: the address block fills the toolbar from its leading edge to `gap`
/// before the first right action group (select/device). Its width is computed from
/// the window width and offsets measured after a toolbar layout, so a window resize
/// sets the final width synchronously, in the same layout pass, instead of a frame
/// later. The right groups stay pinned to the window's trailing edge.
struct ToolbarAddressLayout {
    /// The block's former width at the default window size. The chat header gives way
    /// (down to its 100 pt floor) before the block gets narrower than this.
    static let minimum: CGFloat = 180
    /// The former layout's floor; only a minimum-width window with the sidebar open gets near it.
    static let floor: CGFloat = 80
    /// What the layout before LKM-148 gave the block at the current geometry (the
    /// test's lower bound: the block is never narrower than it used to be).
    var formerWidth: CGFloat = minimum
    /// NSToolbar keeps the right groups pinned only while at least 14–16 pt separate
    /// them from the block (measured on macOS 26, depending on the items); closer,
    /// it shifts them and drops the fixed spaces. 20 keeps a margin, and a pushed
    /// layout (gap at the toolbar's own minimum) cannot pass for a pinned one.
    static let gap: CGFloat = 20
    /// Window width minus the first right group's leading edge. Starts high: an
    /// underestimate overflows the block, and an overflowed block cannot be measured.
    var rightInset: CGFloat = 400
    /// Whether `rightInset` comes from a pinned layout rather than a guess.
    var measured = false
    /// Block leading minus the chat header's trailing edge.
    var chatOffset: CGFloat = 8
    /// Block leading without a chat header in the toolbar.
    var leading: CGFloat = 90
    /// Laid-out block width minus its width constraint.
    var extra: CGFloat = 0
    /// `rightInset` as measured while the speed and "…" items were showing (LKM-206); showing
    /// them again restores it exactly instead of adding their estimated width (it varies by 2 pt).
    var shownInset: CGFloat?

    /// The trailing items hid or showed: the pinned right groups moved by `shift`, an estimate.
    mutating func moveRightGroups(hiding: Bool, by shift: CGFloat) {
        guard measured else { return }
        if hiding { shownInset = rightInset; rightInset -= shift }
        else { rightInset = shownInset ?? rightInset + shift; shownInset = nil }
    }

    /// Reads the offsets from laid-out frames (window coordinates). While the right
    /// groups are pushed their position is not the pinned one, so the inset only
    /// grows by the missing gap until a pinned layout can be measured.
    mutating func measure(window: NSWindow, block: NSView, constant: CGFloat, chat: NSView?, right: NSView?) {
        guard block.window === window, let right, right.window === window else { return }
        let frame = block.convert(block.bounds, to: nil), rightFrame = right.convert(right.bounds, to: nil)
        guard frame.width > 0, rightFrame.width > 0 else { return }
        if abs(frame.width - constant) <= 8 { extra = frame.width - constant }
        if let chat, chat.window === window { chatOffset = frame.minX - chat.convert(chat.bounds, to: nil).maxX } else { leading = frame.minX }
        let actual = rightFrame.minX - frame.maxX
        if actual >= Self.gap - 1 { rightInset = window.frame.width - rightFrame.minX; measured = true }
        else { rightInset = min(window.frame.width, rightInset + Self.gap - actual); measured = false }
    }
    /// Widens the reserved inset after the toolbar overflowed the block; false once
    /// the inset is already larger than any right-group layout.
    mutating func backOff() -> Bool {
        guard rightInset < 600 else { return false }
        rightInset += 40; measured = false
        return true
    }
    /// The block's leading edge for a chat header ending at `chatTrailing` (nil: no chat header).
    func blockLeading(chatTrailing: CGFloat?) -> CGFloat { chatTrailing.map { $0 + chatOffset } ?? leading }
    /// The width constraint that puts the block's trailing edge `gap` before the right groups.
    func width(windowWidth: CGFloat, chatTrailing: CGFloat?) -> CGFloat {
        max(Self.floor, windowWidth - rightInset - Self.gap - extra - blockLeading(chatTrailing: chatTrailing))
    }
    /// The widest chat header starting at `chatLeading` that still leaves the block its preferred minimum.
    func chatLimit(windowWidth: CGFloat, chatLeading: CGFloat) -> CGFloat {
        windowWidth - rightInset - Self.gap - extra - Self.minimum - chatOffset - chatLeading
    }
    /// Frames and truncation state for the shell inspector (window coordinates).
    func inspect(block: NSView, right: NSView?, address: NSTextField, branch: NSPopUpButton) -> [String: Any] {
        let gap = Self.gap, minimum = Self.minimum
        let frame = block.window == nil ? .zero : block.convert(block.bounds, to: nil)
        let rightFrame = right.flatMap { $0.window == nil ? nil : $0.convert($0.bounds, to: nil) } ?? .zero
        // The field truncates when narrower than its cell's full-content size; the pop-up
        // (low compression resistance) when squeezed below its intrinsic width, since its
        // borderless cell size includes padding it never draws.
        let textWidth = address.cell?.cellSize.width ?? 0, textRoom = address.bounds.width
        let branchTitle = branch.intrinsicContentSize.width, branchRoom = branch.bounds.width
        return ["addressLeading":frame.minX, "addressTrailing":frame.maxX, "addressWidth":frame.width,
                "rightGroupLeading":rightFrame.minX, "rightGroupWidth":rightFrame.width,
                "addressGap":gap, "addressMinimum":minimum, "addressFloor":Self.floor, "addressFormerWidth":formerWidth, "rightInset":rightInset, "rightInsetMeasured":measured,
                "addressTruncation":address.lineBreakMode == .byTruncatingMiddle ? "middle" : String(describing: address.lineBreakMode.rawValue),
                "branchTruncation":branch.cell?.lineBreakMode == .byTruncatingTail ? "tail" : String(describing: branch.cell?.lineBreakMode.rawValue ?? 0),
                "addressTextWidth":textWidth, "addressTextRoom":textRoom, "addressTruncated":textWidth > textRoom + 0.5,
                "branchTitleWidth":branchTitle, "branchTitleRoom":branchRoom, "branchTruncated":branchTitle > branchRoom + 0.5]
    }
}
