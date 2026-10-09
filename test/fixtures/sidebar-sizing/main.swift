import AppKit

// No window, application activation, or desktop input is needed for split layout.
let split = NSSplitViewController()
let sidebar = NSViewController(); sidebar.view = NSView()
let item = NSSplitViewItem(sidebarWithViewController: sidebar)
item.minimumThickness = 180; item.maximumThickness = 340
item.allowsFullHeightLayout = true
split.addSplitViewItem(item)
let detail = NSViewController(); detail.view = NSView()
let detailItem = NSSplitViewItem(viewController: detail)
detailItem.minimumThickness = 500
split.addSplitViewItem(detailItem)
split.view.frame = NSRect(x: 0, y: 0, width: 1098, height: 828)
split.view.layoutSubtreeIfNeeded()

// Exercise collapse/reveal, both capture widths and restoring the initial width.
let original = sidebar.view.bounds.width
item.isCollapsed = true
split.view.layoutSubtreeIfNeeded()
item.isCollapsed = false
split.view.layoutSubtreeIfNeeded()
for width in [260, 180, 260, original] {
    setSidebarContentWidth(width, in: split)
    let actual = sidebar.view.bounds.width
    precondition(abs(actual - width) < 2, "Requested sidebar content width \(width), got \(actual)")
    precondition(!item.isCollapsed)
}
print("SIDEBAR SIZING PASS — visible content widths survive AppKit wrapper insets and collapse/reveal")
