import AppKit

/// LKM-366 verification (test profile): the source editor as the running-app smokes of
/// chat code links and the Changes list (`smoke-code-link.ts`, `smoke-changes-panel.ts`)
/// drive it. The sidebar switches through the segmented control's own action and a row
/// opens through the list's click handler (`activate(row:)`, which a mouse click calls
/// with the clicked row). Nothing here writes a file or runs Git.
extension Host {
    @MainActor
    func verifySourceNavigation(_ editor: NativeSourceEditor, _ c: [String: Any]) async throws -> [String: Any] {
        func fail(_ reason: String) -> NSError { NSError(domain: "SourceNavigation", code: 1, userInfo: [NSLocalizedDescriptionKey: reason]) }
        if let panel = c["panel"] as? String {
            editor.panel.selectedSegment = panel == "changes" ? 1 : 0
            editor.panelAction()
        }
        if let open = c["open"] as? [String: Any] { return try openChange(editor.changes, open, fail) }
        // Where the user's caret would be after clicking at the top of the file.
        if c["collapse"] as? Bool == true {
            editor.code.setSelectedRange(NSRange(location: 0, length: 0)); editor.code.scrollRangeToVisible(NSRange(location: 0, length: 0))
        }
        if let region = c["capture"] as? String {
            let prepared = editor.prepareForeground()
            try await Task.sleep(nanoseconds: 350_000_000)
            guard let window = editor.window, let content = window.contentView else { throw fail("The editor has no window") }
            let view: NSView = region == "window" ? content : editor
            return try await captureVisibleRegion(window: window, view: view, region: view.bounds, recognize: false).merging(["prepared": prepared]) { $1 }
        }
        let text = editor.code.string as NSString, selected = editor.code.selectedRange()
        return editor.changes.inspect().merging([
            "panel": editor.panel.selectedSegment == 1 ? "changes" : "files", "changesShown": !editor.changes.isHiddenOrHasHiddenAncestor,
            "treeHidden": editor.treeScroll.isHidden, "operationsHidden": editor.operations.isHidden,
            "editorShown": editor.window?.isVisible == true && !editor.isHiddenOrHasHiddenAncestor, "reveal": editor.reveal,
            "diffBusy": editor.state["diffBusy"] as? Bool == true,
            "selectedText": NSMaxRange(selected) <= text.length ? text.substring(with: selected) : ""
        ]) { $1 }
    }

    /// Unfolds the section and file the way a click on their triangles would, then opens
    /// the `section` file row at `path` (or its `hunk`th hunk row).
    @MainActor
    private func openChange(_ list: SourceDiffList, _ open: [String: Any], _ fail: (String) -> NSError) throws -> [String: Any] {
        let section = open["section"] as? String ?? "", path = open["path"] as? String ?? "", hunk = open["hunk"] as? Int
        for node in list.sections where node.section == section { list.outline.expandItem(node) }
        var index = 0, row = -1
        while index < list.outline.numberOfRows, row < 0 {
            if let node = list.outline.item(atRow: index) as? SourceDiffList.Node, node.section == section, node.path == path {
                if node.kind == "file", hunk == nil { row = index } else if node.kind == "file" { list.outline.expandItem(node) }
                else if node.kind == "hunk", node.hunk == hunk { row = index }
            }
            index += 1
        }
        guard row >= 0 else { throw fail("No \(section) row for \(path)\(hunk.map { " hunk \($0)" } ?? "")") }
        list.outline.scrollRowToVisible(row)
        list.outline.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        let title = (list.outline.item(atRow: row) as? SourceDiffList.Node)?.title ?? ""
        list.activate(row: row)
        return ["row": row, "title": title]
    }
}
