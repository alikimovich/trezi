import AppKit

// Windowless: no window is ordered in and the app is never activated, so this
// cannot take focus from a desktop session. The foreground step is injected.
final class HoverCell: NSView {
    var exits = 0
    override func mouseExited(with event: NSEvent) { exits += 1 }
}

let center = NotificationCenter()
let monitor = SidebarMenuMonitor()
monitor.install(center: center)
let main = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300), styleMask: [.titled], backing: .buffered, defer: true)
main.title = "Trezi"
let problems = { (sidebarFocusReport(main: main, monitor: monitor)["problems"] as? [String]) ?? [] }

// A leftover context menu is named, and cleared once its tracking ends.
let menu = NSMenu(title: "Project Memory…")
center.post(name: NSMenu.didBeginTrackingNotification, object: menu)
precondition(problems().contains { $0.hasPrefix("menu still tracking: Project Memory…") }, "\(problems())")
center.post(name: NSMenu.didEndTrackingNotification, object: menu)
precondition(!problems().contains { $0.hasPrefix("menu still tracking") }, "\(problems())")

// A window that is not key/main is reported with the window holding the foreground.
precondition(problems().contains { $0.hasPrefix("main window is not key (key window: ") }, "\(problems())")
precondition(problems().contains { $0.hasPrefix("main window is not main (main window: ") }, "\(problems())")

// Cleanup cancels a still-tracking menu, dismisses the auxiliary sheet, ends
// hover on every row and only then hands the foreground back to the main window.
center.post(name: NSMenu.didBeginTrackingNotification, object: NSMenu(title: "Leftover"))
let cells = [HoverCell(), HoverCell()]
var steps: [String] = []
sidebarFocusCleanup(main: main, cells: cells, monitor: monitor,
                    dismissAuxiliary: { steps.append("sheet \(monitor.menus.count)") },
                    foreground: { steps.append("foreground \(cells.map(\.exits))") })
precondition(monitor.menus.isEmpty, "Cleanup left a tracking menu")
precondition(steps == ["sheet 0", "foreground [1, 1]"], "Cleanup order: \(steps)")
precondition(!problems().contains { $0.hasPrefix("menu still tracking") })
print("SIDEBAR FOCUS PASS — leftover menus/windows are named; cleanup cancels menus, dismisses sheets and hover before restoring the foreground")
