import AppKit

// LKM-379: the real "View all chats" button in a view-based outline row, as the sidebar
// hosts it, in a window that is never ordered in (no focus or GUI side effects). Prints the
// seam's inspection and the press result as JSON for test/sidebar-chats-accessibility.mjs.
_ = NSApplication.shared

final class Target: NSObject {
    var presses = 0
    @objc func viewAllChats(_ sender: NSButton) { presses += 1 }
}

final class Source: NSObject, NSOutlineViewDataSource, NSOutlineViewDelegate {
    let target = Target()
    var button: NSButton?
    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int { item == nil ? 1 : 0 }
    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any { "all-chats" }
    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool { false }
    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        let cell = NSTableCellView()
        let button = SidebarAllChatsButton.make(title: "View all chats", font: .systemFont(ofSize: 13), target: target,
                                                action: #selector(Target.viewAllChats(_:)))
        button.translatesAutoresizingMaskIntoConstraints = false
        cell.addSubview(button)
        NSLayoutConstraint.activate([button.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 8),
                                     button.centerYAnchor.constraint(equalTo: cell.centerYAnchor)])
        self.button = button
        return cell
    }
}

let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 260, height: 200), styleMask: [.titled], backing: .buffered, defer: true)
let scroll = NSScrollView(frame: window.contentLayoutRect)
let outline = NSOutlineView(frame: scroll.bounds)
let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("main"))
outline.addTableColumn(column); outline.outlineTableColumn = column
let source = Source()
outline.dataSource = source; outline.delegate = source
scroll.documentView = outline
window.contentView = scroll
outline.reloadData()
_ = outline.view(atColumn: 0, row: 0, makeIfNecessary: true)
window.contentView?.layoutSubtreeIfNeeded()

guard let button = source.button else { fatalError("the outline made no row") }
var report = AccessibilityElementInspect.inspect(button)
guard let element = AccessibilityElementInspect.element(of: button) else { fatalError("no accessibility element") }
// A hit test at the button's centre (VoiceOver's mouse and touch routes) finds the same element.
let frame = window.convertToScreen(button.convert(button.bounds, to: nil))
report["hit"] = (window.accessibilityHitTest(NSPoint(x: frame.midX, y: frame.midY)) as AnyObject?) === (element as AnyObject)
// Pressing the element VoiceOver gets runs the button's action.
_ = element.accessibilityPerformPress()
report["presses"] = source.target.presses
let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
