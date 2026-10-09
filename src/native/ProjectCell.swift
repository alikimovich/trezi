import AppKit

/// Keep project selection on the row and its actions on a separate hover control.
final class ProjectCell: SourceListCell {
    let more = NSPopUpButton(frame: .zero, pullsDown: true)
    private var tracking: NSTrackingArea?
    var selected = false { didSet { updateVisibility() } }
    private var hovered = false
    override var backgroundStyle: NSView.BackgroundStyle { didSet { updateVisibility() } }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area); tracking = area
        if let window { hovered = bounds.contains(convert(window.mouseLocationOutsideOfEventStream, from: nil)) }
        updateVisibility()
    }
    override func mouseEntered(with event: NSEvent) { hovered = true; updateVisibility() }
    override func mouseExited(with event: NSEvent) { hovered = false; updateVisibility() }
    private func updateVisibility() {
        let emphasized = backgroundStyle == .emphasized
        more.alphaValue = hovered || selected || emphasized ? 1 : 0
        more.contentTintColor = emphasized ? .alternateSelectedControlTextColor : .labelColor
    }
}

final class ShellRow: NSObject {
    let id: String, title: String, kind: String, project: String
    let running: Bool
    let icon: NSImage?
    let children: [ShellRow]
    init(_ data: [String: Any]) {
        id = data["id"] as? String ?? ""; title = data["title"] as? String ?? ""
        kind = data["kind"] as? String ?? "chat"; project = data["project"] as? String ?? ""
        running = data["running"] as? Bool ?? false
        if let uri = data["icon"] as? String, uri.hasPrefix("data:image/"), let comma = uri.firstIndex(of: ",") {
            let body = String(uri[uri.index(after: comma)...])
            let bytes = uri[..<comma].contains(";base64") ? Data(base64Encoded: body) : body.removingPercentEncoding?.data(using: .utf8)
            icon = bytes.flatMap { NSImage(data: $0) }
        } else { icon = nil }
        children = (data["children"] as? [[String: Any]] ?? []).map(ShellRow.init)
    }
}

extension NSPasteboard.PasteboardType {
    static let treziProject = NSPasteboard.PasteboardType("dev.trezi.project-row")
}

extension NativeShell {
    func outlineView(_ outlineView: NSOutlineView, pasteboardWriterForItem item: Any) -> NSPasteboardWriting? {
        guard let row = item as? ShellRow, row.kind == "project" else { return nil }
        let pasteboard = NSPasteboardItem()
        pasteboard.setString(row.project, forType: .treziProject)
        return pasteboard
    }
    func outlineView(_ outlineView: NSOutlineView, validateDrop info: NSDraggingInfo, proposedItem item: Any?, proposedChildIndex index: Int) -> NSDragOperation {
        guard let source = info.draggingSource as? NSOutlineView, source === outlineView,
              item == nil, index >= 0, index <= rows.count,
              let key = info.draggingPasteboard.string(forType: .treziProject),
              let from = rows.firstIndex(where: { $0.project == key }),
              index != from, index != from + 1 else { return [] }
        return .move
    }
    func outlineView(_ outlineView: NSOutlineView, acceptDrop info: NSDraggingInfo, item: Any?, childIndex index: Int) -> Bool {
        guard self.outlineView(outlineView, validateDrop: info, proposedItem: item, proposedChildIndex: index) == .move,
              let key = info.draggingPasteboard.string(forType: .treziProject) else { return false }
        emit(["event":"shell-action", "action":"project-reorder", "project":key,
              "value":index < rows.count ? rows[index].project : ""])
        return true
    }
}
