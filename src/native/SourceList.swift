import AppKit

/// Source-list setup shared by the projects sidebar (`NativeShell`) and the Settings
/// sidebar (`SheetSplit`): one `.sourceList` column with the same row height, icon
/// size, selection style and insets, in a transparent overlay-scroller scroll view,
/// hosted by a full-height `NSSplitViewItem(sidebarWithViewController:)`.
enum SourceList {
    static let iconLeading: CGFloat = 2

    static func configure(_ outline: NSOutlineView, label: String) {
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("name"))
        column.minWidth = 0; column.width = 230; column.resizingMask = .autoresizingMask
        outline.frame = NSRect(x: 0, y: 0, width: 230, height: 600)
        outline.autoresizingMask = [.width]
        outline.addTableColumn(column); outline.outlineTableColumn = column
        outline.headerView = nil; outline.rowSizeStyle = .custom; outline.style = .sourceList
        outline.rowHeight = SidebarRowStyle.height
        outline.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle
        outline.indentationPerLevel = 0
        outline.setAccessibilityLabel(label)
    }

    static func scrollView(_ outline: NSOutlineView) -> SourceListScrollView {
        let scroll = SourceListScrollView(); scroll.documentView = outline; scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true; scroll.scrollerStyle = .overlay
        scroll.drawsBackground = false
        return scroll
    }

    static func sidebarItem(_ controller: NSViewController, minimum: CGFloat, maximum: CGFloat) -> NSSplitViewItem {
        let item = NSSplitViewItem(sidebarWithViewController: controller)
        item.minimumThickness = minimum; item.maximumThickness = maximum
        item.allowsFullHeightLayout = true
        item.titlebarSeparatorStyle = .none
        return item
    }

    /// The configuration and first row's geometry, compared across both sidebars by the native suite.
    static func inspect(_ outline: NSOutlineView, item: NSSplitViewItem) -> [String: Any] {
        var result: [String: Any] = [
            "style": outline.style == .sourceList ? "sourceList" : "other",
            "behavior": item.behavior == .sidebar ? "sidebar" : "other",
            "fullHeight": item.allowsFullHeightLayout,
            "rowHeight": outline.rowHeight, "rowSizeStyle": outline.rowSizeStyle.rawValue,
            "indentation": outline.indentationPerLevel, "highlight": outline.selectionHighlightStyle.rawValue,
            // Not the scroller style: AppKit resets it to the system preference (e.g. a mouse attached).
            "transparentScroll": (outline.enclosingScrollView?.autohidesScrollers == true) && (outline.enclosingScrollView?.drawsBackground == false)
        ]
        if outline.numberOfRows > 0, let cell = outline.view(atColumn: 0, row: 0, makeIfNecessary: true) as? NSTableCellView,
           let icon = cell.imageView, let text = cell.textField {
            cell.layoutSubtreeIfNeeded()
            // Layout rects, as the shared constraints place them (a label's frame adds its text inset).
            let iconFrame = icon.alignmentRect(forFrame: icon.frame), textFrame = text.alignmentRect(forFrame: text.frame)
            result["row"] = ["height": outline.rect(ofRow: 0).height, "iconWidth": iconFrame.width, "iconHeight": iconFrame.height,
                             "iconLeading": iconFrame.minX, "labelGap": textFrame.minX - iconFrame.maxX,
                             "fontSize": text.font?.pointSize ?? 0]
        }
        return result
    }
}

/// A symbol and label with the sidebar rhythm; a template symbol follows the selection emphasis.
class SourceListCell: NSTableCellView {
    override var backgroundStyle: NSView.BackgroundStyle { didSet { tintSymbol() } }
    func tintSymbol() {
        imageView?.contentTintColor = imageView?.image?.isTemplate == true
            ? (backgroundStyle == .emphasized ? .alternateSelectedControlTextColor : .labelColor) : nil
    }
    /// Adds the symbol and label; the caller pins the label's trailing edge.
    @discardableResult func install(title: String, image: NSImage) -> NSTextField {
        let text = NSTextField(labelWithString: title)
        text.font = SidebarRowStyle.font
        text.lineBreakMode = .byTruncatingTail
        text.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let icon = SidebarIconView(image: image)
        icon.imageScaling = .scaleProportionallyDown
        for view in [icon, text] { view.translatesAutoresizingMaskIntoConstraints = false; addSubview(view) }
        imageView = icon; textField = text
        NSLayoutConstraint.activate(SidebarIconLayout.constraints(icon: icon, label: text, in: self, leading: SourceList.iconLeading))
        tintSymbol()
        return text
    }
}

/// Keep the source-list document and column inside their actual clip viewport.
final class SourceListScrollView: NSScrollView {
    override func tile() {
        super.tile()
        fitRows()
    }
    override func layout() {
        super.layout()
        fitRows()
    }
    private func fitRows() {
        guard let table = documentView as? NSTableView, contentSize.width > 0 else { return }
        if abs(table.frame.width - contentSize.width) > 0.5 {
            table.setFrameSize(NSSize(width: contentSize.width, height: table.frame.height))
            table.sizeLastColumnToFit()
        }
    }
}
