import AppKit

/// The preview address/branch block. Re-measures the toolbar after each of its layouts.
final class ToolbarAddressView: NSStackView {
    var measure: (() -> Void)?
    override func layout() {
        super.layout()
        DispatchQueue.main.async { [weak self] in self?.measure?() }
    }
    /// LKM-321: AppKit moved the block into or out of a window: the overflow menu, or the
    /// full-screen toolbar window. Its size did not change, so `layout` would not measure.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        DispatchQueue.main.async { [weak self] in self?.measure?() }
    }
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
                "branchTitleCut":branchMenu.titleCut, "branchKeptSlots":branchMenu.keptSlots,
                "windowAppearance":window?.effectiveAppearance.name.rawValue ?? ""]
    }
    @objc func windowResized(_ notification: Notification) { alignChatHeader() }
    /// Re-reads the toolbar offsets after a layout, then aligns. Not during a live
    /// resize: frames from the previous pass would pair with the new window width.
    func measureToolbar() {
        defer { toolbarLaidOut?() }
        guard let window, !window.inLiveResize, let constant = addressWidth?.constant else { return alignChatHeader() }
        if toolbar.visibleItems?.contains(where: { $0.itemIdentifier.rawValue == "address" }) == true {
            addressLayout.measure(windowWidth: window.frame.width, block: mainFrame(addressHeader), constant: constant, chat: mainFrame(chatHeader), right: mainFrame(rightGroup))
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
        DispatchQueue.main.async { [weak self] in self?.layoutToolbar(); self?.measureToolbar() }
    }
    /// The first right action group (the interaction island).
    var rightGroup: NSView? { toolbar.items.first { $0.itemIdentifier.rawValue == "interaction" }?.view }
    var viewportGroup: NSView? { toolbar.items.first { $0.itemIdentifier.rawValue == "viewport" }?.view }
    /// LKM-296: where the first item after the sidebar starts in the last toolbar layout. While the
    /// sidebar closes (expanding the preview) it is still right of the measured `leading`; sizing the
    /// block from `leading` overflowed it and "…" into AppKit's overflow menu until `backOff`.
    var blockSlot: CGFloat { max(addressLayout.leading, mainFrame(addressHeader)?.minX ?? 0) }
    /// LKM-296: how far an opening sidebar (restoring the preview) still moves the toolbar items
    /// after it. Their frames are read a layout behind, so the widths reserve the rest of the travel.
    /// Only while `update` animates the sidebar: at rest the frames are final, and the inset is
    /// learned then. Learned from any frame, a transient split (a sidebar resize) once kept it at
    /// 16 instead of 8 and every later layout gave the block 8 pt too little.
    func sidebarOpening() -> CGFloat {
        guard !sidebarItem.isCollapsed else { return 0 }
        let open = sidebar.view.frame.width, detail = split.splitViewItems[1].viewController.view.convert(NSPoint.zero, to: nil).x
        guard addressLayout.sidebarAnimations > 0 else {
            // The detail column settles a few points past the sidebar's width (8 on macOS 26).
            addressLayout.sidebarInset = min(16, max(0, detail - open)); return 0
        }
        return max(0, open + addressLayout.sidebarInset - detail)
    }
    /// LKM-296: where the chat header settles for a detail column settling at `detail`. While the
    /// sidebar opens the header's frame lags the split by a layout, also once the split itself has
    /// settled; sized from it, the header ran past the settled column and pushed "…" into the
    /// overflow menu. It keeps the offset seen with the sidebar open and at rest.
    func chatHeaderLeading(detail: CGFloat, opening: CGFloat) -> CGFloat {
        let laidOut = mainFrame(chatHeader)?.minX ?? 0
        guard addressLayout.sidebarAnimations > 0, !sidebarItem.isCollapsed else {
            // LKM-356: a frame not yet moved with the split is not used (`ToolbarChatLead`).
            return sidebarItem.isCollapsed ? laidOut : addressLayout.chatLead.leading(header: laidOut, detail: detail)
        }
        return max(laidOut + opening, detail + addressLayout.chatLead.offset)
    }
    /// The address block's frame against the first right group, laid out now.
    func toolbarInspect() -> [String: Any] {
        layoutToolbar()
        return addressLayout.inspect(block: mainFrame(addressHeader) ?? .zero, right: mainFrame(rightGroup) ?? .zero, address: address, branch: branchMenu)
            .merging(["windowWidth":window?.frame.width ?? 0, "addressConstant":addressWidth?.constant ?? 0,
                      "addressHostWidth":addressHostWidth,
                      "viewportLeading":mainFrame(viewportGroup)?.minX ?? 0, "viewportTrailing":mainFrame(viewportGroup)?.maxX ?? 0,
                      "toolbarItemFrames":toolbarFrames.mapValues { NSStringFromRect($0) },
                      "chatHeaderAttached":chatHeader.window === window, "addressExtra":addressLayout.extra,
                      "sidebarInset":addressLayout.sidebarInset, "chatLead":addressLayout.chatLead.offset,
                      "chatHeaderWidth":chatHeader.bounds.width, "chatHeaderTrailing":mainFrame(chatHeader)?.maxX ?? chatHeader.bounds.maxX,
                      "addressVisible":toolbar.visibleItems?.contains { $0.itemIdentifier.rawValue == "address" } ?? false]) { _, new in new }
            .merging(titleAlignment()) { _, new in new }
            .merging(publishTrailingInspect()) { _, new in new }
    }
}

/// The address block has a host-sized cap and reserves the adjacent viewport island.
/// Available width is computed from measured toolbar offsets during the resize pass.
/// The right groups stay pinned to the window's trailing edge.
struct ToolbarAddressLayout {
    /// Preferred minimum before the chat header gives way.
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
    var rightInset: CGFloat = 432
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
    /// The detail column's settled leading edge minus the sidebar's width (`sidebarOpening`).
    var sidebarInset: CGFloat = 0
    /// The chat header's leading edge against the detail column's, at rest (`chatHeaderLeading`).
    var chatLead = ToolbarChatLead()
    /// Sidebar animations `update` started and AppKit has not finished (`sidebarOpening`).
    var sidebarAnimations = 0

    /// The trailing items hid or showed: the pinned right groups moved by `shift`, an estimate.
    mutating func moveRightGroups(hiding: Bool, by shift: CGFloat) {
        guard measured else { return }
        if hiding { shownInset = rightInset; rightInset -= shift }
        else { rightInset = shownInset ?? rightInset + shift; shownInset = nil }
    }

    /// Reads the offsets from laid-out frames (main-window coordinates, nil while not in a
    /// window). While the right groups are pushed their position is not the pinned one, so
    /// the inset only grows by the missing gap until a pinned layout can be measured.
    /// LKM-321: in full screen the frames come from AppKit's toolbar window through the screen;
    /// the check for the main window skipped every measure there.
    mutating func measure(windowWidth: CGFloat, block: NSRect?, constant: CGFloat, chat: NSRect?, right: NSRect?) {
        guard let frame = block, let rightFrame = right, frame.width > 0, rightFrame.width > 0 else { return }
        // Never negative: a frame laid out before the constant last grew (mid-animation) would widen the block.
        if abs(frame.width - constant) <= 8 { extra = max(0, frame.width - constant) }
        if let chat { chatOffset = frame.minX - chat.maxX } else { leading = frame.minX }
        let actual = rightFrame.minX - frame.maxX
        if actual >= Self.gap - 1 { rightInset = windowWidth - rightFrame.minX; measured = true }
        else { rightInset = min(windowWidth, rightInset + Self.gap - actual); measured = false }
    }
    /// Widens the reserved inset after the toolbar overflowed the block; false once
    /// the inset is already larger than any right-group layout.
    mutating func backOff() -> Bool {
        guard rightInset < 600 else { return false }
        rightInset += 40; measured = false
        return true
    }
    /// The block's leading edge for a chat header ending at `chatTrailing` (nil: no chat header,
    /// the block starts at `slot`, by default the measured `leading`).
    func blockLeading(chatTrailing: CGFloat?, slot: CGFloat? = nil) -> CGFloat { chatTrailing.map { $0 + chatOffset } ?? slot ?? leading }
    /// Reserve the viewport island and cap the block to the visible host's width.
    func width(windowWidth: CGFloat, chatTrailing: CGFloat?, slot: CGFloat? = nil, preferred: CGFloat = 420) -> CGFloat {
        min(preferred, max(Self.floor, windowWidth - rightInset - Self.gap - 100 - extra - blockLeading(chatTrailing: chatTrailing, slot: slot)))
    }
    /// The widest chat header starting at `chatLeading` that still leaves the block its preferred minimum.
    func chatLimit(windowWidth: CGFloat, chatLeading: CGFloat, addressPreferred: CGFloat = Self.minimum) -> CGFloat {
        windowWidth - rightInset - Self.gap - 100 - extra - addressPreferred - chatOffset - chatLeading
    }
    /// Frames (main-window coordinates, zero outside a window) and truncation state for the shell inspector.
    func inspect(block frame: NSRect, right rightFrame: NSRect, address: NSTextField, branch: NSPopUpButton) -> [String: Any] {
        let gap = Self.gap, minimum = Self.minimum
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
