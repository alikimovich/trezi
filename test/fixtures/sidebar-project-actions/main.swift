import AppKit

// LKM-388: the real project row's "…" and New chat, in a window that is never ordered in. For each
// interaction state it prints both controls' inspection and how much ink each paints outside its
// glyph's box, with the old `.inline` pop-up as the control. JSON for test/sidebar-project-actions.mjs.
_ = NSApplication.shared

final class NativeShell: NSObject {
    var rows: [ShellRow] = []
    var presses: [String] = []
    @objc func sidebarNewChat(_ sender: NSButton) { presses.append(sender.identifier?.rawValue ?? "") }
    @objc func sidebarMore(_ sender: NSButton) { presses.append(sender.identifier?.rawValue ?? "") }
}
func emit(_ value: [String: Any]) {}

let shell = NativeShell()
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 260, height: 28), styleMask: [.titled], backing: .buffered, defer: true)
window.appearance = NSAppearance(named: .aqua)
let cell = ProjectCell(frame: window.contentLayoutRect)
cell.installActions(title: "lkmv.ch", project: "p", target: shell, newChatAction: #selector(NativeShell.sidebarNewChat(_:)),
                    moreAction: #selector(NativeShell.sidebarMore(_:)))
cell.installTitle("lkmv.ch", image: NSImage(systemSymbolName: "folder", accessibilityDescription: nil)!)
window.contentView = cell
window.layoutIfNeeded()
cell.selected = false
cell.layoutSubtreeIfNeeded()

/// Non-transparent pixels in the ring outside the middle 20 × 20 points: a bezel's, never a glyph's.
func ringInk(_ view: NSView) -> Int {
    guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return -1 }
    view.cacheDisplay(in: view.bounds, to: bitmap)
    let scale = CGFloat(bitmap.pixelsWide) / view.bounds.width
    let middle = NSRect(x: 0, y: 0, width: 20, height: 20).offsetBy(dx: (view.bounds.width - 20) / 2, dy: (view.bounds.height - 20) / 2)
    var ink = 0
    for y in 0..<bitmap.pixelsHigh {
        for x in 0..<bitmap.pixelsWide where !middle.contains(NSPoint(x: CGFloat(x) / scale, y: CGFloat(y) / scale)) {
            if (bitmap.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.02 { ink += 1 }
        }
    }
    return ink
}
func snapshot() -> [String: Any] {
    ["more": cell.actionInspect(cell.more), "newChat": cell.actionInspect(cell.newChat),
     "moreInk": ringInk(cell.more), "newChatInk": ringInk(cell.newChat),
     "titleWidth": cell.title!.bounds.width, "titleX": cell.title!.frame.minX,
     "rowWidth": cell.bounds.width, "travel": cell.title!.travel]
}
func event(_ type: NSEvent.EventType) -> NSEvent {
    NSEvent.enterExitEvent(with: type, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0, trackingNumber: 0, userData: nil)!
}

var report: [String: Any] = ["rest": snapshot()]
cell.pointer(at: NSPoint(x: 1, y: 14))
report["background"] = snapshot()
cell.pointer(at: NSPoint(x: cell.title!.frame.minX + 2, y: cell.title!.frame.midY))
report["hover"] = snapshot()
cell.pointer(at: NSPoint(x: cell.more.frame.minX - 2, y: cell.more.frame.midY))
report["bridge"] = snapshot()
cell.pointer(at: NSPoint(x: cell.more.frame.midX, y: cell.more.frame.midY))
report["crossed"] = snapshot()
cell.pointer(at: NSPoint(x: cell.bounds.maxX - 1, y: cell.bounds.midY))
report["otherRowSpace"] = snapshot()
cell.pointer(at: NSPoint(x: cell.title!.frame.minX + 2, y: cell.title!.frame.midY))
cell.more.highlight(true); cell.newChat.highlight(true)
report["pressed"] = snapshot()
cell.more.highlight(false); cell.newChat.highlight(false)
cell.mouseExited(with: event(.mouseExited))
report["exit"] = snapshot()
cell.selected = true
report["selected"] = snapshot()
cell.backgroundStyle = .emphasized
report["emphasized"] = snapshot()
cell.backgroundStyle = .normal
cell.more.isEnabled = false; cell.newChat.isEnabled = false
report["disabled"] = snapshot()
cell.more.isEnabled = true; cell.newChat.isEnabled = true

// Keyboard focus: AppKit decides from Full Keyboard Access, which this test only reads.
let tookMore = window.makeFirstResponder(cell.more), moreFocused = window.firstResponder === cell.more
let moreVisibleOnFocus = cell.more.alphaValue == 1
let tookNew = window.makeFirstResponder(cell.newChat), newFocused = window.firstResponder === cell.newChat
let newVisibleOnFocus = cell.newChat.alphaValue == 1
report["focus"] = ["more": moreFocused, "newChat": newFocused, "moreTook": tookMore, "newChatTook": tookNew,
                   "moreAccepts": cell.more.acceptsFirstResponder, "newChatAccepts": cell.newChat.acceptsFirstResponder,
                   "moreVisible": moreVisibleOnFocus, "newVisible": newVisibleOnFocus]
_ = window.makeFirstResponder(nil)
cell.focusChanged(true)
let focusReveal = cell.more.alphaValue == 1 && cell.newChat.alphaValue == 1
cell.focusChanged(false)
report["focusReveal"] = focusReveal && cell.more.alphaValue == 0

// The hit target, by asking AppKit which view takes each point of the row in a button's column.
cell.pointer(at: NSPoint(x: cell.title!.frame.minX + 2, y: cell.title!.frame.midY))
func hits(_ button: NSButton) -> Int {
    (0..<Int(cell.bounds.height)).filter { cell.hitTest(NSPoint(x: button.frame.midX, y: CGFloat($0) + 0.5)) === button }.count
}
report["hit"] = ["more": hits(cell.more), "newChat": hits(cell.newChat), "row": cell.bounds.height]

// A longer label uses the restored width at rest and retargets the marquee when actions appear.
cell.mouseExited(with: event(.mouseExited))
let fullWidth = cell.title!.bounds.width
cell.pointer(at: NSPoint(x: cell.title!.frame.minX + 2, y: cell.title!.frame.midY))
let actionWidth = cell.title!.bounds.width
cell.mouseExited(with: event(.mouseExited))
report["widths"] = ["rest": fullWidth, "actions": actionWidth, "restored": cell.title!.bounds.width]

// The press VoiceOver sends runs each control's action.
for button in [cell.more, cell.newChat] { _ = AccessibilityElementInspect.element(of: button)?.accessibilityPerformPress() }
report["presses"] = shell.presses
report["order"] = cell.subviews.compactMap { $0.identifier?.rawValue }

let long = ProjectCell(frame: NSRect(x: 0, y: 0, width: 260, height: 28))
long.installActions(title: "A long project title that overflows the sidebar", project: "q", target: shell,
                    newChatAction: #selector(NativeShell.sidebarNewChat(_:)), moreAction: #selector(NativeShell.sidebarMore(_:)))
long.installTitle("A long project title that overflows the sidebar", image: NSImage(systemSymbolName: "folder", accessibilityDescription: nil)!)
window.contentView = long
long.layoutSubtreeIfNeeded()
let longRest = long.title!.travel
long.pointer(at: NSPoint(x: long.title!.frame.minX + 2, y: long.title!.frame.midY))
let longHover = long.title!.travel
let scrolling = long.title!.running
long.setFrameSize(NSSize(width: 220, height: 28))
long.layoutSubtreeIfNeeded()
let narrowTravel = long.title!.travel
long.mouseExited(with: event(.mouseExited))
report["long"] = ["restTravel": longRest, "hoverTravel": longHover,
                  "narrowTravel": narrowTravel,
                  "running": scrolling, "stopped": !long.title!.running,
                  "offset": long.title!.offset, "restoredWidth": long.title!.bounds.width]
long.pointer(at: NSPoint(x: long.title!.frame.minX + 2, y: long.title!.frame.midY))
window.contentView = cell
report["longDetachedStopped"] = !long.title!.running && long.title!.offset == 0

// A reload replaces the row without a new mouse-enter. Keep the pointer fixed in window space.
cell.pointer(at: NSPoint(x: cell.title!.frame.minX + 2, y: cell.title!.frame.midY))
let stationary = cell.convert(NSPoint(x: cell.title!.frame.minX + 2, y: cell.title!.frame.midY), to: nil)
let previousScrollStart = cell.scrollStart
let replacement = ProjectCell(frame: cell.frame)
replacement.installActions(title: "lkmv.ch", project: "p", target: shell,
                           newChatAction: #selector(NativeShell.sidebarNewChat(_:)), moreAction: #selector(NativeShell.sidebarMore(_:)))
replacement.installTitle("lkmv.ch", image: NSImage(systemSymbolName: "folder", accessibilityDescription: nil)!)
let priorActive = cell.showingActions
window.contentView = replacement
replacement.restorePointer(at: stationary, wasActive: priorActive, scrollingSince: previousScrollStart)
report["stationaryReload"] = ["visible": replacement.more.alphaValue == 1,
                              "constrained": replacement.title!.bounds.width < cell.bounds.width - 8,
                              "selected": replacement.selected]
replacement.mouseExited(with: event(.mouseExited))
report["stationaryReloadExit"] = replacement.more.alphaValue == 0 && replacement.title!.bounds.width > 200

// The persistent pill as it was: the check above must see it.
let pill = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 28, height: 24), pullsDown: true)
pill.bezelStyle = .inline
(pill.cell as? NSPopUpButtonCell)?.arrowPosition = .noArrow
let trigger = NSMenuItem(title: "", action: nil, keyEquivalent: "")
trigger.image = NSImage(systemSymbolName: "ellipsis", accessibilityDescription: nil)
pill.menu = NSMenu(); pill.menu?.addItem(trigger)
pill.appearance = NSAppearance(named: .aqua)
report["pillInk"] = ringInk(pill)

let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
