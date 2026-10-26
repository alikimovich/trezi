import CoreGraphics

// LKM-356: the chat header's leading edge at rest, from the core toolbar-address failure
// (sidebar 180 → 230 pt at 1320 pt: column 180 → 230, header 188 → 238, chat width 440).
func expect(_ actual: CGFloat, _ expected: CGFloat, _ label: String) {
    precondition(abs(actual - expected) < 0.01, "\(label): expected \(expected), got \(actual)")
}
var lead = ToolbarChatLead()
expect(lead.leading(header: 188, detail: 180), 188, "laid out at rest")
expect(lead.offset, 8, "offset learned at rest")
// The split moved, the toolbar has not laid the header out again: 670 - 238 = 432 pt, not 482.
expect(lead.leading(header: 188, detail: 230), 238, "wider sidebar, stale header frame")
expect(lead.leading(header: 188, detail: 230), 238, "the stale frame is never learned")
expect(lead.offset, 8, "offset kept while the frame is stale")
expect(lead.leading(header: 238, detail: 230), 238, "header moved with the column")
// Narrower sidebar: the stale frame is right of the column; the header still follows the column.
expect(lead.leading(header: 238, detail: 180), 188, "narrower sidebar, stale header frame")
expect(lead.leading(header: 188, detail: 180), 188, "header moved back")
// A window resize or relayout that leaves the column moves only the header: always learned.
expect(lead.leading(header: 192, detail: 180), 192, "same column, new header frame")
expect(lead.offset, 12, "offset relearned")
expect(lead.leading(header: 300, detail: 180), 300, "offset clamped, frame kept")
expect(lead.offset, 16, "offset clamped to 16")
print("TOOLBAR CHAT LEAD PASS — a header frame that has not moved with the split is not used")
