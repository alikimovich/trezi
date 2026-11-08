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
// Saved native sidebar-340 geometry: header width 283, New Chat slot maxX 679,
// column edge 696. LKM-559: the slot ends on the column edge (AppKit's slots abut and
// each draws its glass inside), so the rule falls between New Chat's glass and the
// viewport's. The 48-point advance is already in the address's measured chat offset.
let resizedWidth = ToolbarChatLead.width(target: 696, leading: 348, newChatAdvance: 48, addressLimit: 335)
expect(resizedWidth, 300, "New Chat follows resized column without double reserve")
expect(679 + resizedWidth - 283, 696, "New Chat slot ends on the column edge")
// LKM-559 native loaded/opening geometry at 1320 pt: column edge 670, New Chat slot 622–666
// before the fix (the viewport's glass then began on the rule at 670).
let loadedWidth = ToolbarChatLead.width(target: 670, leading: 234, newChatAdvance: 44, addressLimit: 600)
expect(234 + loadedWidth + 44, 670, "New Chat slot and viewport slot meet on the rule")
// At 950 pt the measured address reserve caps the chat item at 152 pt. The
// resulting New Chat edge (438) precedes the viewport (442); moving it to the
// 546 pt column edge would overlap that adjacent native toolbar item.
let compactWidth = ToolbarChatLead.width(target: 550, leading: 238, newChatAdvance: 48, addressLimit: 152)
expect(compactWidth, 152, "minimum toolbar keeps the viewport slot")
expect(238 + compactWidth + 48, 438, "New Chat stops before the viewport")
print("TOOLBAR CHAT LEAD PASS — a header frame that has not moved with the split is not used")
