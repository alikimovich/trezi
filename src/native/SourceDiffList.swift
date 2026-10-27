import AppKit

/// The editor sidebar's read-only Changes list (LKM-364, `src/main/branch-diff.ts`): the
/// labelled comparison base, then committed, staged, unstaged and untracked files with
/// +/− counts and their hunks. A click opens the file (its first hunk) or the hunk in the
/// editor. Its one control is Refresh: there is nothing to stage, discard or commit here.
final class SourceDiffList: NSView, NSOutlineViewDataSource, NSOutlineViewDelegate {
    final class Node: NSObject {
        let kind: String, section: String, path: String, hunk: Int?
        let title: String, status: String, added: String, removed: String
        var children: [Node] = []
        init(kind: String, section: String = "", path: String = "", hunk: Int? = nil, title: String, status: String = "", added: String = "", removed: String = "") {
            self.kind = kind; self.section = section; self.path = path; self.hunk = hunk
            self.title = title; self.status = status; self.added = added; self.removed = removed
        }
    }
    let base = NSTextField(wrappingLabelWithString: ""), outline = NSOutlineView(), scroll = NSScrollView()
    let refresh = NSButton(image: NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: "Refresh Changes") ?? NSImage(), target: nil, action: nil)
    private(set) var sections: [Node] = []
    private var shown: NSDictionary?
    /// `section` kind, project-relative path and hunk index (nil: the file).
    var open: ((String, String, Int?) -> Void)?
    var reload: (() -> Void)?
    static let letters = ["added": "A", "modified": "M", "deleted": "D", "renamed": "R", "copied": "C", "type": "T", "untracked": "U"]

    init() {
        super.init(frame: .zero)
        base.font = .systemFont(ofSize: 11); base.textColor = .secondaryLabelColor; base.isSelectable = true
        base.setContentCompressionResistancePriority(.defaultHigh, for: .vertical)
        refresh.identifier = NSUserInterfaceItemIdentifier("diff-refresh"); refresh.isBordered = false; refresh.imagePosition = .imageOnly
        refresh.toolTip = "Refresh Changes"; refresh.setAccessibilityLabel("Refresh Changes"); refresh.target = self; refresh.action = #selector(refreshAction)
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("change")); column.resizingMask = .autoresizingMask
        outline.addTableColumn(column); outline.outlineTableColumn = column; outline.headerView = nil; outline.rowHeight = 22
        outline.dataSource = self; outline.delegate = self; outline.target = self; outline.action = #selector(clicked)
        outline.setAccessibilityLabel("Changed files")
        scroll.documentView = outline; scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
        for view in [base, refresh, scroll] { view.translatesAutoresizingMaskIntoConstraints = false; addSubview(view) }
        NSLayoutConstraint.activate([
            base.topAnchor.constraint(equalTo: topAnchor, constant: 4), base.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8), base.trailingAnchor.constraint(equalTo: refresh.leadingAnchor, constant: -4),
            refresh.topAnchor.constraint(equalTo: topAnchor, constant: 2), refresh.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6), refresh.widthAnchor.constraint(equalToConstant: 20), refresh.heightAnchor.constraint(equalToConstant: 20),
            scroll.topAnchor.constraint(equalTo: base.bottomAnchor, constant: 4), scroll.leadingAnchor.constraint(equalTo: leadingAnchor), scroll.trailingAnchor.constraint(equalTo: trailingAnchor), scroll.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
    @objc func refreshAction() { reload?() }

    /// The editor state's `diff` (null until first read) and `diffBusy`.
    func update(_ diff: [String: Any]?, busy: Bool) {
        refresh.isEnabled = !busy
        base.stringValue = Self.header(diff, busy: busy); base.toolTip = base.stringValue
        // Edits republish the editor state; the rows rebuild only when the list changed.
        let next = diff.map { NSDictionary(dictionary: $0) }
        guard next != shown else { return }
        shown = next
        let expanded = Set(sections.flatMap(\.children).filter { outline.isItemExpanded($0) }.map { "\($0.section)\0\($0.path)" })
        sections = (diff?["sections"] as? [[String: Any]] ?? []).map(Self.section)
        outline.reloadData()
        for section in sections {
            outline.expandItem(section)
            for file in section.children where expanded.contains("\(file.section)\0\(file.path)") { outline.expandItem(file) }
        }
    }
    static func header(_ diff: [String: Any]?, busy: Bool) -> String {
        guard let diff else { return busy ? "Reading changes…" : "" }
        let base = diff["base"] as? [String: Any], head = diff["head"] as? String ?? "", branch = diff["branch"] as? String ?? ""
        var lines: [String] = []
        if !branch.isEmpty { lines.append("Branch \(branch)\(head.isEmpty ? "" : " @ \(head)")") }
        if let label = base?["label"] as? String { lines.append(label) }
        if let message = diff["message"] as? String, !message.isEmpty { lines.append(message) }
        if busy { lines.append("Refreshing…") }
        return lines.joined(separator: "\n")
    }
    static func section(_ value: [String: Any]) -> Node {
        let kind = value["kind"] as? String ?? "", files = value["files"] as? [[String: Any]] ?? []
        let more = value["truncated"] as? Bool == true ? " (more not shown)" : ""
        let node = Node(kind: "section", section: kind, title: (value["label"] as? String ?? kind) + more, status: "\(files.count)",
                        added: "+\(value["added"] as? Int ?? 0)", removed: "−\(value["removed"] as? Int ?? 0)")
        node.children = files.map { file in
            let path = file["path"] as? String ?? "", from = file["from"] as? String, binary = file["binary"] as? Bool == true
            let added = file["added"] as? Int, removed = file["removed"] as? Int
            let row = Node(kind: "file", section: kind, path: path, title: from.map { "\($0) → \(path)" } ?? path, status: letters[file["status"] as? String ?? ""] ?? "M",
                           added: binary ? "binary" : added.map { "+\($0)" } ?? "", removed: binary ? "" : removed.map { "−\($0)" } ?? "")
            row.children = (file["hunks"] as? [[String: Any]] ?? []).enumerated().map { index, hunk in
                let start = hunk["newStart"] as? Int ?? 1, count = hunk["newCount"] as? Int ?? 0
                let title = count == 0 ? "Removed after line \(start)" : count == 1 ? "Line \(start)" : "Lines \(start)–\(start + count - 1)"
                return Node(kind: "hunk", section: kind, path: path, hunk: index, title: title, added: "+\(count)", removed: "−\(hunk["oldCount"] as? Int ?? 0)")
            }
            return row
        }
        if files.isEmpty { node.children = [Node(kind: "note", section: kind, title: "No changes")] }
        return node
    }

    @objc func clicked() { activate(row: outline.clickedRow) }
    /// A file or hunk row opens; section and note rows only fold.
    func activate(row: Int) {
        guard row >= 0, let node = outline.item(atRow: row) as? Node, node.kind == "file" || node.kind == "hunk" else { return }
        open?(node.section, node.path, node.hunk)
    }
    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int { (item as? Node)?.children.count ?? sections.count }
    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any { ((item as? Node)?.children ?? sections)[index] }
    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool { !((item as? Node)?.children.isEmpty ?? true) }
    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        guard let node = item as? Node else { return nil }
        let cell = NSTableCellView(), status = NSTextField(labelWithString: node.kind == "section" ? "" : node.status), title = NSTextField(labelWithString: node.title)
        let counts = NSTextField(labelWithString: "")
        let count = NSMutableAttributedString(string: node.added, attributes: [.foregroundColor: node.added == "binary" ? NSColor.secondaryLabelColor : NSColor.systemGreen])
        if !node.removed.isEmpty { count.append(NSAttributedString(string: " " + node.removed, attributes: [.foregroundColor: NSColor.systemRed])) }
        count.addAttribute(.font, value: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .regular), range: NSRange(location: 0, length: count.length)); counts.attributedStringValue = count
        status.font = .monospacedSystemFont(ofSize: 10, weight: .semibold); status.textColor = .secondaryLabelColor
        title.font = node.kind == "section" ? .systemFont(ofSize: 11, weight: .semibold) : .systemFont(ofSize: 11); title.lineBreakMode = .byTruncatingMiddle; title.toolTip = node.title
        title.textColor = node.kind == "note" ? .tertiaryLabelColor : node.status == "D" ? .secondaryLabelColor : .labelColor
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal); counts.setContentCompressionResistancePriority(.required, for: .horizontal)
        for view in [status, title, counts] { view.translatesAutoresizingMaskIntoConstraints = false; cell.addSubview(view) }
        NSLayoutConstraint.activate([
            status.leadingAnchor.constraint(equalTo: cell.leadingAnchor), status.centerYAnchor.constraint(equalTo: cell.centerYAnchor), status.widthAnchor.constraint(equalToConstant: node.kind == "file" ? 12 : 0),
            title.leadingAnchor.constraint(equalTo: status.trailingAnchor, constant: node.kind == "file" ? 4 : 0), title.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
            counts.leadingAnchor.constraint(greaterThanOrEqualTo: title.trailingAnchor, constant: 4), counts.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -4), counts.centerYAnchor.constraint(equalTo: cell.centerYAnchor)
        ])
        cell.textField = title
        cell.setAccessibilityLabel([node.status, node.title, node.added, node.removed].filter { !$0.isEmpty }.joined(separator: " "))
        return cell
    }

    /// Verification: the header, every row (folded ones too) and every control in the list
    /// (AppKit's own fold triangles and scrollers aside).
    func inspect() -> [String: Any] {
        func rows(_ nodes: [Node]) -> [[String: Any]] { nodes.flatMap { [["kind": $0.kind, "section": $0.section, "path": $0.path, "title": $0.title, "status": $0.status, "added": $0.added, "removed": $0.removed] as [String: Any]] + rows($0.children) } }
        func own(_ view: NSView) -> Bool { view is NSControl && !(view is NSTextField || view is NSTableView || view is NSScroller) && view.identifier != NSOutlineView.disclosureButtonIdentifier }
        func controls(_ view: NSView) -> [String] { (own(view) ? [view.identifier?.rawValue ?? (view as? NSButton)?.title ?? "\(type(of: view))"] : []) + view.subviews.flatMap(controls) }
        return ["base": base.stringValue, "rows": rows(sections), "controls": controls(self)]
    }
}
