import AppKit

final class LayerItem: NSObject {
    var value: [String: Any]
    var children: [LayerItem] = []
    weak var parent: LayerItem?
    init(_ value: [String: Any]) { self.value = value }
    var path: [Int] { value["path"] as? [Int] ?? [] }
    var source: String? { value["source"] as? String }
    var label: String {
        let tag = value["tag"] as? String ?? "element", id = value["id"] as? String ?? "", text = value["text"] as? String ?? ""
        return tag + (id.isEmpty ? "" : "#" + id) + (text.isEmpty ? "" : " · " + String(text.prefix(60)))
    }
}
final class LayerOutline: NSOutlineView {
    var hovered: ((Int) -> Void)?
    override func updateTrackingAreas() { for area in trackingAreas { removeTrackingArea(area) }; super.updateTrackingAreas(); addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)) }
    override func mouseMoved(with event: NSEvent) { hovered?(row(at: convert(event.locationInWindow, from: nil))) }
    override func mouseExited(with event: NSEvent) { hovered?(-1) }
}
/// The Layers island (LKM-179): a `FloatingIsland` like the editing island, moved by its
/// header and sized by a thin rim. Its rows follow the preview's selection, select and hover
/// page elements, and reorder them in the source by drag.
final class NativeLayers: FloatingIsland, NSOutlineViewDataSource, NSOutlineViewDelegate {
    enum Edge { case left, right, bottom }
    static let edge: CGFloat = 5
    let tree = LayerOutline(), status = NSTextField(labelWithString: ""), notice = NSTextField(labelWithString: "")
    let scroll = NSScrollView()
    var root = "", roots: [LayerItem] = [], nodes: [LayerItem] = [], dragged: LayerItem?
    var signature = "", updating = false
    /// The selected row's path as last applied or clicked; nil when nothing is selected.
    private(set) var selectedPath: [Int]?
    /// Row clicks sent to the preview; programmatic selections never add one (no echo).
    private(set) var selectionsSent = 0
    private var stateNotice = ""
    /// The island's new frame in its superview while an edge is dragged.
    var resized: ((NSRect, Set<Edge>, Bool) -> Void)?
    private var resizing: (edges: Set<Edge>, start: NSPoint, frame: NSRect)?
    init() {
        super.init(title: "Layers")
        header.margin = Self.edge
        let close = NSButton(image: NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close Layers")!, target: self, action: #selector(closeLayers)); close.isBordered = false; close.toolTip = "Close Layers"
        let refresh = NSButton(image: NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: "Refresh Layers")!, target: self, action: #selector(refreshLayers)); refresh.isBordered = false; refresh.toolTip = "Refresh Layers"
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("layer")); tree.addTableColumn(column); tree.outlineTableColumn = column; tree.headerView = nil; tree.rowHeight = 22; tree.indentationPerLevel = 12; tree.dataSource = self; tree.delegate = self
        tree.backgroundColor = .clear; tree.style = .plain; tree.draggingDestinationFeedbackStyle = .regular
        tree.registerForDraggedTypes([.string]); tree.setDraggingSourceOperationMask(.move, forLocal: true)
        tree.hovered = { [weak self] row in guard let self else { return }; self.send("hover", (row >= 0 ? self.tree.item(atRow: row) as? LayerItem : nil).map { ["path":$0.path] } ?? [:]) }
        scroll.documentView = tree; scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true; scroll.drawsBackground = false
        status.font = .systemFont(ofSize: 11); status.textColor = .secondaryLabelColor; status.lineBreakMode = .byTruncatingTail
        status.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        notice.font = .systemFont(ofSize: 11); notice.textColor = .secondaryLabelColor; notice.lineBreakMode = .byTruncatingTail; notice.isHidden = true
        notice.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        for view in [status, refresh, close] { view.translatesAutoresizingMaskIntoConstraints = false; header.addSubview(view) }
        for view in [scroll, notice] { view.translatesAutoresizingMaskIntoConstraints = false; face.addSubview(view) }
        let pad = Self.padding
        NSLayoutConstraint.activate([
            status.leadingAnchor.constraint(equalTo: title.trailingAnchor, constant: 6), status.firstBaselineAnchor.constraint(equalTo: title.firstBaselineAnchor), status.trailingAnchor.constraint(lessThanOrEqualTo: refresh.leadingAnchor, constant: -8),
            close.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -pad), close.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            refresh.trailingAnchor.constraint(equalTo: close.leadingAnchor, constant: -10), refresh.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            scroll.leadingAnchor.constraint(equalTo: face.leadingAnchor, constant: 6), scroll.trailingAnchor.constraint(equalTo: face.trailingAnchor, constant: -6), scroll.topAnchor.constraint(equalTo: header.bottomAnchor),
            notice.leadingAnchor.constraint(equalTo: face.leadingAnchor, constant: pad), notice.trailingAnchor.constraint(equalTo: face.trailingAnchor, constant: -pad),
            notice.topAnchor.constraint(equalTo: scroll.bottomAnchor, constant: 4), notice.bottomAnchor.constraint(equalTo: face.bottomAnchor, constant: -12)
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
    // The whole frame takes the pointer (LKM-162/LKM-173); a thin rim resizes it.
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden, frame.contains(point) else { return nil }
        if !edges(at: convert(point, from: superview)).isEmpty { return self }
        return super.hitTest(point)
    }
    func edges(at point: NSPoint) -> Set<Edge> {
        var edges = Set<Edge>()
        if point.x < Self.edge { edges.insert(.left) } else if point.x > bounds.width - Self.edge { edges.insert(.right) }
        if point.y > bounds.height - Self.edge { edges.insert(.bottom) }
        return edges
    }
    override func resetCursorRects() {
        addCursorRect(NSRect(x: 0, y: 0, width: Self.edge, height: bounds.height), cursor: .resizeLeftRight)
        addCursorRect(NSRect(x: bounds.width - Self.edge, y: 0, width: Self.edge, height: bounds.height), cursor: .resizeLeftRight)
        addCursorRect(NSRect(x: 0, y: bounds.height - Self.edge, width: bounds.width, height: Self.edge), cursor: .resizeUpDown)
    }
    private func canvasPoint(_ event: NSEvent) -> NSPoint? { superview?.convert(event.locationInWindow, from: nil) }
    override func mouseDown(with event: NSEvent) {
        let edges = edges(at: convert(event.locationInWindow, from: nil))
        if !edges.isEmpty, let start = canvasPoint(event) { resizing = (edges, start, frame) }
    }
    override func mouseDragged(with event: NSEvent) { if let resizing, let p = canvasPoint(event) { resize(resizing, to: p, ended: false) } }
    override func mouseUp(with event: NSEvent) { if let resizing, let p = canvasPoint(event) { resize(resizing, to: p, ended: true) }; resizing = nil }
    private func resize(_ drag: (edges: Set<Edge>, start: NSPoint, frame: NSRect), to point: NSPoint, ended: Bool) {
        var next = drag.frame
        let dx = point.x - drag.start.x, dy = point.y - drag.start.y
        if drag.edges.contains(.left) { next.origin.x += dx; next.size.width -= dx }
        if drag.edges.contains(.right) { next.size.width += dx }
        if drag.edges.contains(.bottom) { next.size.height += dy }
        resized?(next, drag.edges, ended)
    }
    func send(_ action: String, _ data: [String: Any] = [:]) { emit(data.merging(["event":"layers-action", "root":root, "action":action]) { _, new in new }) }
    @objc func closeLayers() { send("close") }
    @objc func refreshLayers() { send("refresh") }
    func show(notice text: String) { notice.stringValue = text; notice.toolTip = text; notice.isHidden = text.isEmpty }
    func update(_ state: [String: Any]) {
        root = state["root"] as? String ?? ""; isHidden = state["visible"] as? Bool != true || root.isEmpty
        let error = state["error"] as? String ?? ""
        status.stringValue = error.isEmpty ? "\(state["total"] as? Int ?? 0)\(state["truncated"] as? Bool == true ? " (truncated)" : "")" : error; status.toolTip = status.stringValue
        status.textColor = error.isEmpty ? .secondaryLabelColor : .systemRed
        let next = state["notice"] as? String ?? ""
        if next != stateNotice { stateNotice = next; show(notice: next) }
        let values = state["nodes"] as? [[String: Any]] ?? []
        let signature = String(data: (try? JSONSerialization.data(withJSONObject: values, options: [.sortedKeys])) ?? Data(), encoding: .utf8) ?? ""
        let selected = state["selected"] as? [Int]
        guard signature != self.signature else { if selected != selectedPath || selectedRowPath() != selected { select(selected, reveal: true) }; return }
        self.signature = signature
        let expanded = Set(nodes.filter { tree.isItemExpanded($0) }.map { $0.path.description })
        nodes = values.map(LayerItem.init); roots = []
        let lookup = Dictionary(nodes.map { ($0.path.description, $0) }, uniquingKeysWith: { first, _ in first })
        for node in nodes { if let parent = lookup[(node.value["parentPath"] as? [Int] ?? []).description], parent !== node { node.parent = parent; parent.children.append(node) } else { roots.append(node) } }
        updating = true; tree.reloadData()
        for node in nodes where expanded.contains(node.path.description) || node.path.count <= 2 { tree.expandItem(node) }
        updating = false
        select(selected, reveal: selected != selectedPath)
    }
    private func selectedRowPath() -> [Int]? { tree.selectedRow >= 0 ? (tree.item(atRow: tree.selectedRow) as? LayerItem)?.path : nil }
    func item(_ path: [Int]) -> LayerItem? { nodes.first { $0.path == path } }
    /// Applies the preview's selection without echoing it back: expands its ancestors and
    /// scrolls it into view when it changed.
    func select(_ path: [Int]?, reveal: Bool) {
        updating = true; defer { updating = false }
        selectedPath = path
        guard let path, let item = item(path) else { tree.deselectAll(nil); return }
        var ancestors: [LayerItem] = [], parent = item.parent
        while let next = parent { ancestors.insert(next, at: 0); parent = next.parent }
        for ancestor in ancestors { tree.expandItem(ancestor) }
        let row = tree.row(forItem: item)
        guard row >= 0 else { tree.deselectAll(nil); return }
        tree.selectRowIndexes([row], byExtendingSelection: false)
        if reveal { tree.scrollRowToVisible(row) }
    }
    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int { (item as? LayerItem)?.children.count ?? roots.count }
    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any { ((item as? LayerItem)?.children ?? roots)[index] }
    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool { !(item as! LayerItem).children.isEmpty }
    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        let node = item as! LayerItem
        let label = NSTextField(labelWithString: node.label); label.font = .systemFont(ofSize: 11); label.lineBreakMode = .byTruncatingTail; label.toolTip = node.source
        if node.source == nil { label.textColor = .secondaryLabelColor }
        return label
    }
    func outlineViewSelectionDidChange(_ notification: Notification) {
        guard !updating, let node = tree.item(atRow: tree.selectedRow) as? LayerItem else { return }
        selectedPath = node.path; selectionsSent += 1; send("select", ["path":node.path])
    }
    // MARK: Drag to reorder
    func outlineView(_ outlineView: NSOutlineView, pasteboardWriterForItem item: Any) -> NSPasteboardWriting? {
        dragged = item as? LayerItem; show(notice: "")
        let pasteboard = NSPasteboardItem(); pasteboard.setString(dragged?.path.description ?? "", forType: .string); return pasteboard
    }
    func outlineView(_ outlineView: NSOutlineView, draggingSession session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) { dragged = nil }
    /// What a drop at `index` among `parent`'s rows (or onto `parent` at -1) means.
    func drop(onto parent: LayerItem?, index: Int) -> (target: LayerItem?, position: String) {
        if index < 0 { return (parent, "inside") }
        let siblings = parent?.children ?? roots
        if siblings.isEmpty { return (parent, "inside") }
        return index < siblings.count ? (siblings[index], "before") : (siblings.last, "after")
    }
    /// Why the source cannot express this move ("" refuses silently: a no-op), or nil.
    func refusal(_ dragged: LayerItem, _ target: LayerItem?, _ position: String) -> String? {
        guard let target, position == "inside" || target.parent != nil else { return "Elements stay inside the page body." }
        if target === dragged { return "" }
        if dragged.parent == nil { return "The page body cannot move." }
        var ancestor: LayerItem? = target
        while let next = ancestor { if next === dragged { return "An element cannot move inside itself." }; ancestor = next.parent }
        if dragged.source == nil { return "This element comes from a library or generated markup, so its position is not in your code." }
        if dragged.value["dupStamp"] as? Bool == true { return "This element is generated by a loop; reorder the data instead." }
        if target.source == nil { return "The drop target comes from a library or generated markup, so it is not in your code." }
        if target.value["dupStamp"] as? Bool == true { return "The drop target is generated by a loop; reorder the data instead." }
        if position != "inside", target.parent === dragged.parent, let siblings = dragged.parent?.children,
           let from = siblings.firstIndex(where: { $0 === dragged }), let to = siblings.firstIndex(where: { $0 === target }),
           (position == "before" && to == from + 1) || (position == "after" && to == from - 1) { return "" }
        return nil
    }
    /// Validates and, with `commit`, sends the move; the reason when refused.
    @discardableResult func perform(drag dragged: LayerItem, onto parent: LayerItem?, index: Int, commit: Bool) -> String? {
        let (target, position) = drop(onto: parent, index: index)
        if let reason = refusal(dragged, target, position) { if !reason.isEmpty { show(notice: reason) }; return reason }
        show(notice: "")
        if commit, let target { send("move", ["path":dragged.path, "target":target.path, "position":position]) }
        return nil
    }
    func outlineView(_ outlineView: NSOutlineView, validateDrop info: NSDraggingInfo, proposedItem item: Any?, proposedChildIndex index: Int) -> NSDragOperation {
        guard info.draggingSource as? NSOutlineView === tree, let dragged else { return [] }
        return perform(drag: dragged, onto: item as? LayerItem, index: index, commit: false) == nil ? .move : []
    }
    func outlineView(_ outlineView: NSOutlineView, acceptDrop info: NSDraggingInfo, item: Any?, childIndex index: Int) -> Bool {
        guard let dragged else { return false }
        self.dragged = nil
        return perform(drag: dragged, onto: item as? LayerItem, index: index, commit: true) == nil
    }
}
