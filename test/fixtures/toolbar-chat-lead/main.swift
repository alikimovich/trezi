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
// LKM-588: the chat pane narrowed with the split's divider, sidebar collapsed (the header
// starts after the traffic lights and the sidebar toggle). At the 320 pt minimum pane the
// header fell under the old 150 pt threshold, which hid New Chat with the title; the
// viewport island then took New Chat's slot, left of the rule. Now the title gives way and
// New Chat's slot still ends on the column edge.
let narrowPane = ToolbarChatLead.width(target: 320, leading: 130, newChatAdvance: 48, addressLimit: 600)
expect(narrowPane, 142, "narrow pane: the header, not New Chat, gives way")
expect(130 + narrowPane + 48, 320, "narrow pane: New Chat's slot ends on the column edge")
precondition(ToolbarChatLead.titleVisible(width: narrowPane), "narrow pane: the title truncates, still shown")
// Narrower still (a wider leading, e.g. a larger titlebar inset): the title hides before New Chat moves.
let tightPane = ToolbarChatLead.width(target: 320, leading: 230, newChatAdvance: 48, addressLimit: 600)
expect(tightPane, 42, "tight pane: the header shrinks below the title's minimum")
expect(230 + tightPane + 48, 320, "tight pane: New Chat's slot still ends on the column edge")
precondition(!ToolbarChatLead.titleVisible(width: tightPane), "tight pane: the title hides first")
// The header never collapses to nothing (its item keeps New Chat beside it).
expect(ToolbarChatLead.width(target: 320, leading: 300, newChatAdvance: 48, addressLimit: 600), ToolbarChatLead.minimumWidth, "header floor")
// Widening the pane again restores the title.
let widened = ToolbarChatLead.width(target: 520, leading: 130, newChatAdvance: 48, addressLimit: 600)
precondition(ToolbarChatLead.titleVisible(width: widened), "wider pane: the title returns")
expect(130 + widened + 48, 520, "wider pane: New Chat follows the column edge")
precondition(ToolbarChatLead.titleVisible(width: ToolbarChatLead.titleMinimumWidth), "title threshold inclusive")
precondition(!ToolbarChatLead.titleVisible(width: ToolbarChatLead.titleMinimumWidth - 1), "title hides below threshold")
// A minimum-width window caps the header by the address's room: it keeps the former chat-side
// width (56 + New Chat's 44 = the old 100 pt floor), title hidden, New Chat shown.
let capped = ToolbarChatLead.width(target: 550, leading: 238, newChatAdvance: 44, addressLimit: 30)
expect(capped, 56, "address-limited header keeps the former chat-side width")
precondition(!ToolbarChatLead.titleVisible(width: capped), "address-limited: the title hides, New Chat stays")
// New Chat fits beside the narrowest header at every supported pane width; only a column
// still animating in from a hidden chat lacks room for it.
precondition(ToolbarChatLead.newChatFits(target: 320, leading: 130, newChatAdvance: 48), "minimum pane, sidebar collapsed")
precondition(ToolbarChatLead.newChatFits(target: 550, leading: 238, newChatAdvance: 44), "minimum pane, sidebar open")
precondition(!ToolbarChatLead.newChatFits(target: 180, leading: 136, newChatAdvance: 44), "column animating in")
print("TOOLBAR CHAT LEAD PASS — a header frame that has not moved with the split is not used")
