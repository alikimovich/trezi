import AppKit

private final class SourceFileNode {
    let path: String
    var children: [SourceFileNode] = []
    var directory = false
    init(_ path: String) { self.path = path }
}
/// A real outline, retaining expanded folders when the backend refreshes its file list.
final class SourceFileTree: NSOutlineView, NSOutlineViewDataSource, NSOutlineViewDelegate {
    private var roots: [SourceFileNode] = []
    private var nodes: [String: SourceFileNode] = [:]
    private var applying = false
    var open: ((String) -> Void)?
    init() {
        super.init(frame: .zero)
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("file")); column.resizingMask = .autoresizingMask
        addTableColumn(column); outlineTableColumn = column; headerView = nil; dataSource = self; delegate = self; rowHeight = 24
        setAccessibilityLabel("Project files")
    }
    required init?(coder: NSCoder) { fatalError() }
    func update(_ files: [String], query: String) {
        let expanded = Set(nodes.values.filter { isItemExpanded($0) }.map(\.path))
        nodes = [:]; roots = []; applying = true
        for file in files.filter({ query.isEmpty || $0.localizedCaseInsensitiveContains(query) }).sorted() {
            var parent: SourceFileNode?, path = ""
            for part in file.split(separator: "/") {
                path = path.isEmpty ? String(part) : path + "/" + part
                let node: SourceFileNode
                if let existing = nodes[path] { node = existing }
                else { node = SourceFileNode(path); nodes[path] = node; if let parent { parent.children.append(node) } else { roots.append(node) } }
                if let parent { parent.directory = true }; parent = node
            }
        }
        reloadData()
        for node in nodes.values where node.directory && (!query.isEmpty || expanded.contains(node.path)) { expandItem(node) }
        applying = false
    }
    func selectFile(_ path: String) {
        guard let node = nodes[path] else { return }; applying = true
        var directory = (path as NSString).deletingLastPathComponent
        var parents: [SourceFileNode] = []
        while !directory.isEmpty { if let parent = nodes[directory] { parents.append(parent) }; directory = (directory as NSString).deletingLastPathComponent }
        for parent in parents.reversed() { expandItem(parent) }
        let index = row(forItem: node); if index >= 0 { selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false) }
        applying = false
    }
    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int { (item as? SourceFileNode)?.children.count ?? roots.count }
    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any { ((item as? SourceFileNode)?.children ?? roots)[index] }
    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool { (item as? SourceFileNode)?.directory ?? false }
    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        guard let node = item as? SourceFileNode else { return nil }
        let cell = NSTableCellView(), label = NSTextField(labelWithString: (node.path as NSString).lastPathComponent), icon = NSImageView()
        label.font = .systemFont(ofSize: 11); label.lineBreakMode = .byTruncatingMiddle; label.toolTip = node.path
        icon.image = NSImage(systemSymbolName: node.directory ? "folder" : "doc", accessibilityDescription: node.directory ? "Folder" : "File")
        for view in [icon, label] { view.translatesAutoresizingMaskIntoConstraints = false; cell.addSubview(view) }
        NSLayoutConstraint.activate([icon.leadingAnchor.constraint(equalTo: cell.leadingAnchor), icon.centerYAnchor.constraint(equalTo: cell.centerYAnchor), icon.widthAnchor.constraint(equalToConstant: 14), icon.heightAnchor.constraint(equalToConstant: 14), label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 5), label.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -4), label.centerYAnchor.constraint(equalTo: cell.centerYAnchor)])
        cell.textField = label; cell.imageView = icon; return cell
    }
    func outlineViewSelectionDidChange(_ notification: Notification) { if !applying, let node = item(atRow: selectedRow) as? SourceFileNode, !node.directory { open?(node.path) } }
}
