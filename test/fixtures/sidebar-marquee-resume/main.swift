import AppKit

// LKM-433: a reload builds a new title for every sidebar row. The real `SidebarMarqueeTitle`
// scrolls in an offscreen window, then a new title takes over from it with `start(since:)`, the
// way `restoreSidebarHover` hands the scroll over, beside one started afresh; a last title is
// hovered before it has a window. One JSON report on stdout.
_ = NSApplication.shared
let longTitle = "A sidebar chat whose title is much too long to fit in the sidebar row"
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 120), styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = NSView(frame: window.contentRect(forFrameRect: window.frame))
func place(_ title: SidebarMarqueeTitle, y: CGFloat) {
    title.frame = NSRect(x: 10, y: y, width: 120, height: 16)
    window.contentView?.addSubview(title)
    title.layoutSubtreeIfNeeded()
}
func pump(_ seconds: TimeInterval) { RunLoop.main.run(until: Date(timeIntervalSinceNow: seconds)) }

let first = SidebarMarqueeTitle(title: longTitle)
place(first, y: 10)
first.start()
pump(SidebarMarqueeTitle.delay + 0.5)
let handed = first.scrollStart, before = first.offset
first.stop()
first.removeFromSuperview()

let resumed = SidebarMarqueeTitle(title: longTitle)
place(resumed, y: 10)
resumed.start(since: handed)
let afresh = SidebarMarqueeTitle(title: longTitle)
place(afresh, y: 40)
afresh.start()
let carried = resumed.offset, restarted = afresh.offset
pump(0.3)

let late = SidebarMarqueeTitle(title: longTitle)
late.frame = NSRect(x: 10, y: 70, width: 120, height: 16)
late.start()
let beforeWindow = late.running
window.contentView?.addSubview(late)
late.layoutSubtreeIfNeeded()
pump(0.2)

let report: [String: Any] = [
    "scrolled": before, "handed": handed != nil, "stoppedStart": first.scrollStart == nil,
    "carried": carried, "afresh": restarted, "resumedNow": resumed.offset, "resumedRunning": resumed.running,
    "lateBeforeWindow": beforeWindow, "lateRunning": late.running, "lateOffset": late.offset
]
print(String(data: try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), encoding: .utf8)!)
