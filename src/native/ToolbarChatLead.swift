import CoreGraphics

/// LKM-356: where the chat header starts with the sidebar open and at rest. The split lays out
/// before the toolbar: right after a sidebar width set without animation, the detail column has
/// moved and the header's frame is still the old one until AppKit lays the toolbar out again. A
/// header sized from that frame ran 50 pt past the column (sidebar 180 → 230 pt) and pushed the
/// address block into the overflow menu for a frame. The header follows the column, so while its
/// frame has not moved with it, it starts at the column plus the offset learned at rest.
struct ToolbarChatLead {
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
