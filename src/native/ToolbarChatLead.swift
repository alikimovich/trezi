import CoreGraphics

/// LKM-356: where the chat header starts with the sidebar open and at rest. The split lays out
/// before the toolbar: right after a sidebar width set without animation, the detail column has
/// moved and the header's frame is still the old one until AppKit lays the toolbar out again. A
/// header sized from that frame ran 50 pt past the column (sidebar 180 → 230 pt) and pushed the
/// address block into the overflow menu for a frame. The header follows the column, so while its
/// frame has not moved with it, it starts at the column plus the offset learned at rest.
struct ToolbarChatLead {
    /// The measured address offset already includes New Chat and the viewport.
    /// Reserve New Chat only against the column edge, not again against the address limit.
    /// LKM-559: NSToolbar's item slots abut and each draws its glass a few points inside its
    /// slot, so New Chat's slot ends exactly on the column edge: the chat/preview rule then
    /// runs through the gap between New Chat's glass and the viewport island's, clear of both.
    /// (It ended 4 pt short, which put the viewport's glass on the rule.)
    /// LKM-588: the title gives way before New Chat. The header shrinks to this, never New Chat's
    /// slot: at a 100 pt floor a narrowed chat pane hid New Chat with the title, and the viewport
    /// island then slid left across the chat/preview rule into the hidden button's slot.
    static let minimumWidth: CGFloat = 16
    /// Below this the title hides entirely; wider, it truncates at its tail.
    static let titleMinimumWidth: CGFloat = 64
    /// Where the address block's room caps the header (narrow windows): the former 100 pt floor
    /// less New Chat's 44 pt slot, which now shows there too. The chat side then takes the
    /// same width as before, and the measured inset's small corrections (a few points after a
    /// resize or appearance change) stay absorbed by the floor instead of moving the block.
    static let addressLimitedWidth: CGFloat = 56
    static func width(target: CGFloat, leading: CGFloat, newChatAdvance: CGFloat, addressLimit: CGFloat) -> CGFloat {
        let reserve = max(32, min(60, newChatAdvance))
        return min(max(minimumWidth, target - leading - reserve), max(addressLimitedWidth, addressLimit))
    }
    /// Whether the chat column itself has room for New Chat beside the narrowest header. Only a
    /// column still animating in from a hidden chat (under 100 pt, below the 320 pt minimum)
    /// lacks it; shown there, AppKit put New Chat in its overflow menu for a frame.
    static func newChatFits(target: CGFloat, leading: CGFloat, newChatAdvance: CGFloat) -> Bool {
        target - leading - max(32, min(60, newChatAdvance)) >= minimumWidth
    }
    /// Whether a header `width` wide shows the title. New Chat's visibility never depends on it.
    static func titleVisible(width: CGFloat) -> Bool { width >= titleMinimumWidth }
    /// The chat header's leading edge minus the detail column's, at rest.
    private(set) var offset: CGFloat = 0
    /// The detail column's and the header's leading edges when `offset` was last learned.
    private var seen: (detail: CGFloat, header: CGFloat)?

    /// The header's leading edge for a header laid out at `header` and a column at `detail`.
    mutating func leading(header: CGFloat, detail: CGFloat) -> CGFloat {
        if let seen, abs(detail - seen.detail) > 0.5, abs(header - seen.header) < 0.5 { return detail + offset }
        offset = min(16, max(0, header - detail)); seen = (detail, header)
        return header
    }
}
