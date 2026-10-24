import AppKit

// Windowless: no window is ordered in and the app is never activated, so this cannot take
// focus from a desktop session. AppKit's crossing is replaced by the same call the native
// smoke seam makes: `mouseEntered` on the owner of the island's own tracking area.
func require(_ condition: Bool, _ message: String) {
    if !condition { fputs("FAIL: \(message)\n", stderr); exit(1) }
}

let island = FloatingIsland(title: "Layers")
island.frame = NSRect(x: 100, y: 20, width: 300, height: 400)
island.updateTrackingAreas()

let areas = island.trackingAreas.filter { $0.options.contains(.mouseEnteredAndExited) }
require(areas.count == 1, "The island has one enter/exit tracking area of its own (\(areas.count))")
require(areas[0].owner === island, "The island owns its tracking area")
require(areas[0].options.contains(.inVisibleRect), "It follows the island's visible rect")
require(areas[0].options.contains(.activeInKeyWindow), "It tracks in the key window, like the page's own")

var entries = 0
island.entered = { entries += 1 }
func enter() {
    for area in island.trackingAreas where area.options.contains(.mouseEnteredAndExited) {
        guard let owner = area.owner as? NSResponder,
              let event = NSEvent.enterExitEvent(with: .mouseEntered, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0,
                                                 context: nil, eventNumber: 0, trackingNumber: 0, userData: nil) else { continue }
        owner.mouseEntered(with: event)
    }
}
enter()
require(entries == 1, "Entering the island runs `entered` once (\(entries))")
// A relayout rebuilds the area, never doubles it.
island.updateTrackingAreas()
require(island.trackingAreas.filter { $0.options.contains(.mouseEnteredAndExited) }.count == 1, "updateTrackingAreas replaces the area")
enter()
require(entries == 2, "The rebuilt area still reports entry (\(entries))")

// An exit alone is not an entry.
if let exit = NSEvent.enterExitEvent(with: .mouseExited, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0,
                                     context: nil, eventNumber: 0, trackingNumber: 0, userData: nil) {
    island.mouseExited(with: exit)
}
require(entries == 2, "Leaving the island does not drop the page's hover")
print("ISLAND POINTER FIXTURE OK — the island's own tracking area reports entry, once per crossing")
