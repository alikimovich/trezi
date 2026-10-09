import AppKit

// No window: a source-list outline and the Open Project button are laid out
// directly. A plain NSImageView here draws the folder in a 16×21 frame at y=3.
final class Rows: NSObject, NSOutlineViewDataSource, NSOutlineViewDelegate {
    let configuration: NSImage.SymbolConfiguration?
    init(_ configuration: NSImage.SymbolConfiguration?) { self.configuration = configuration }
    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int { item == nil ? 3 : 0 }
    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any { "Folder \(index)" }
    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool { false }
    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        // Mirrors NativeShell's project row: shared icon view, layout and 2-point cell inset.
        let cell = NSTableCellView()
        let icon = SidebarIconView(image: NSImage(systemSymbolName: "folder", accessibilityDescription: nil)!)
        icon.imageScaling = .scaleProportionallyDown
        if let configuration { icon.symbolConfiguration = configuration }
        let text = NSTextField(labelWithString: item as! String)
        text.font = SidebarRowStyle.font
        for view in [icon, text] { view.translatesAutoresizingMaskIntoConstraints = false; cell.addSubview(view) }
        cell.imageView = icon; cell.textField = text
        NSLayoutConstraint.activate(SidebarIconLayout.constraints(icon: icon, label: text, in: cell, leading: 2))
        return cell
    }
}

func checkIcon(_ icon: NSView, in root: NSView, _ label: String) -> NSRect {
    let rect = icon.convert(icon.bounds, to: root)
    precondition(rect.size == NSSize(width: 16, height: 16), "\(label): folder frame \(rect.size), expected 16×16")
    precondition(rect.origin.x == rect.origin.x.rounded() && rect.origin.y == rect.origin.y.rounded(),
                 "\(label): folder origin \(rect.origin) is not integral")
    precondition(icon.frame == icon.alignmentRect(forFrame: icon.frame), "\(label): symbol alignment insets leak into the frame")
    precondition(icon.backingAlignedRect(icon.bounds, options: .alignAllEdgesNearest) == icon.bounds, "\(label): folder is not pixel aligned")
    return rect
}

let configurations: [(String, NSImage.SymbolConfiguration?)] = [
    ("default", nil), ("small", .init(scale: .small)), ("medium", .init(scale: .medium)),
    ("large", .init(scale: .large)), ("13pt", .init(pointSize: 13, weight: .regular))]
for width: CGFloat in [260, 180] {
    let sidebar = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 400))
    let open = SidebarProjectButton(frame: .zero)
    open.title = "Open Project…"; open.image = NSImage(systemSymbolName: "folder", accessibilityDescription: nil)
    open.translatesAutoresizingMaskIntoConstraints = false
    sidebar.addSubview(open)
    // Same insets as NativeShell: a 10-point action stack; the source list insets its own rows.
    NSLayoutConstraint.activate([open.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor, constant: 10),
                                 open.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor, constant: -10),
                                 open.topAnchor.constraint(equalTo: sidebar.topAnchor, constant: 8),
                                 open.heightAnchor.constraint(equalToConstant: SidebarRowStyle.height)])
    sidebar.layoutSubtreeIfNeeded()
    let openIcon = checkIcon(open.symbol, in: sidebar, "Open Project \(width)")
    let openLabel = sidebar.convert(open.label.alignmentRect(forFrame: open.label.frame), from: open)
    precondition(openLabel.minX - openIcon.maxX == SidebarIconLayout.gap)
    for (name, configuration) in configurations {
        let rows = Rows(configuration)
        let outline = NSOutlineView(frame: NSRect(x: 0, y: 0, width: width, height: 300))
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("name"))
        column.width = width
        outline.addTableColumn(column); outline.outlineTableColumn = column
        outline.headerView = nil; outline.rowSizeStyle = .custom; outline.style = .sourceList
        outline.rowHeight = SidebarRowStyle.height; outline.indentationPerLevel = 0
        outline.dataSource = rows; outline.delegate = rows
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 52, width: width, height: 300))
        scroll.documentView = outline; scroll.drawsBackground = false
        sidebar.addSubview(scroll)
        outline.reloadData()
        for index in 0..<outline.numberOfRows {
            let cell = outline.view(atColumn: 0, row: index, makeIfNecessary: true) as! NSTableCellView
            cell.layoutSubtreeIfNeeded()
            let text = cell.textField!
            let rect = checkIcon(cell.imageView!, in: sidebar, "row \(index) \(name) \(width)")
            let label = sidebar.convert(text.alignmentRect(forFrame: text.frame), from: cell)
            precondition(label.minX - rect.maxX == SidebarIconLayout.gap, "row \(index) \(name) \(width): label gap")
            precondition(rect.minX == openIcon.minX && label.minX == openLabel.minX, "row \(index) \(name) \(width): not aligned with Open Project")
        }
        scroll.removeFromSuperview()
    }
}
print("SIDEBAR ICON PASS — folder symbols draw in integral 16×16 frames aligned with Open Project at 260/180 points")
