import AppKit

// Ephemeral-profile pipe fixture. Uses real row views and production delegates.
extension NativeShell {
    var projectCells: [ProjectCell] {
        (0..<outline.numberOfRows).compactMap { outline.view(atColumn: 0, row: $0, makeIfNecessary: false) as? ProjectCell }
    }
    func verifySidebar(_ command: [String: Any]) -> [String: Any] {
        if let hover = command["hover"] as? String {
            for index in 0..<outline.numberOfRows {
                guard let row = outline.item(atRow: index) as? ShellRow,
                      let cell = outline.view(atColumn: 0, row: index, makeIfNecessary: true) as? ProjectCell,
                      let event = NSEvent.enterExitEvent(with: row.id == hover ? .mouseEntered : .mouseExited,
                        location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window?.windowNumber ?? 0,
                        context: nil, eventNumber: 0, trackingNumber: 0, userData: nil) else { continue }
                if row.id == hover { cell.mouseEntered(with: event) } else { cell.mouseExited(with: event) }
            }
        }
        if let key = command["menu"] as? String, let row = rows.first(where: { $0.id == key }) {
            let menu = projectMenu(row)
            let tracking = SidebarMenuTracking()
            menu.delegate = tracking
            let titles = menu.items.map { $0.title }
            // Enter AppKit menu tracking, then cancel deterministically without changing a project.
            let cancel = Timer(timeInterval: 0.3, repeats: false) { _ in menu.cancelTracking() }
            RunLoop.main.add(cancel, forMode: .common)
            defer { cancel.invalidate() }
            let rect = outline.rect(ofRow: outline.row(forItem: row))
            menu.popUp(positioning: nil, at: NSPoint(x: rect.midX, y: rect.midY), in: outline)
            if command["memory"] as? Bool == true { menu.performActionForItem(at: 0) }
            return ["titles": titles, "project": row.project, "opened": tracking.opened, "closed": tracking.closed]
        }
        if let key = command["drag"] as? String, let row = rows.first(where: { $0.id == key }),
           let writer = outlineView(outline, pasteboardWriterForItem: row) {
            let info = SidebarTestDrag(source: outline, writer: writer)
            defer { info.draggingPasteboard.releaseGlobally() }
            let index = command["index"] as? Int ?? 0
            let noOp = outlineView(outline, validateDrop: info, proposedItem: nil, proposedChildIndex: outline.row(forItem: row))
            let nested = outlineView(outline, validateDrop: info, proposedItem: row, proposedChildIndex: index)
            let valid = outlineView(outline, validateDrop: info, proposedItem: nil, proposedChildIndex: index)
            let accepted = outlineView(outline, acceptDrop: info, item: nil, childIndex: index)
            return ["noOpRejected": noOp.isEmpty, "nestedRejected": nested.isEmpty,
                    "valid": valid == .move, "accepted": accepted]
        }
        split.view.layoutSubtreeIfNeeded()
        let folder = NSImage(systemSymbolName: "folder", accessibilityDescription: nil)
        // A label's frame includes its cell's 2-point padding; the 7-point spacing
        // and Open Project alignment are between icon and label alignment rects.
        let labelRect = { (text: NSView) in text.superview!.convert(text.alignmentRect(forFrame: text.frame), to: self.sidebar.view) }
        let open = sidebarButtons["open-project"] as? SidebarProjectButton
        open?.layoutSubtreeIfNeeded()
        let openIcon = open.map { $0.symbol.convert($0.symbol.bounds, to: sidebar.view) } ?? .null
        let openLabelX = open.map { labelRect($0.label).minX } ?? -1
        let cells: [[String: Any]] = (0..<outline.numberOfRows).compactMap { index in
            guard let row = outline.item(atRow: index) as? ShellRow,
                  let cell = outline.view(atColumn: 0, row: index, makeIfNecessary: true) as? ProjectCell,
                  let icon = cell.imageView, let text = cell.textField else { return nil }
            cell.layoutSubtreeIfNeeded()
            let iconRect = icon.convert(icon.bounds, to: sidebar.view)
            let textRect = labelRect(text)
            let moreRect = cell.more.convert(cell.more.bounds, to: sidebar.view)
            let emphasized = cell.backgroundStyle == .emphasized
            let expectedTint: NSColor = emphasized ? .alternateSelectedControlTextColor : .labelColor
            return ["id": row.id, "title": row.title, "storedArtwork": row.icon != nil,
                    "folder": icon.image?.tiffRepresentation == folder?.tiffRepresentation,
                    "template": icon.image?.isTemplate == true, "scaling": icon.imageScaling == .scaleProportionallyDown,
                    "selected": cell.selected, "emphasized": emphasized,
                    "tintCorrect": icon.contentTintColor == expectedTint,
                    "iconX": iconRect.minX, "iconY": iconRect.minY, "iconWidth": iconRect.width, "iconHeight": iconRect.height,
                    "textGap": textRect.minX - iconRect.maxX, "textWidth": textRect.width,
                    "matchesOpenProject": iconRect.minX == openIcon.minX && iconRect.size == openIcon.size && textRect.minX == openLabelX,
                    "contained": sidebar.view.bounds.contains(iconRect) && sidebar.view.bounds.contains(textRect) && sidebar.view.bounds.contains(moreRect),
                    "moreAlpha": cell.more.alphaValue, "actionsLabel": cell.more.accessibilityLabel() ?? "",
                    "menu": cell.more.menu?.items.dropFirst().map { $0.title } ?? []]
        }
        return ["width": sidebar.view.bounds.width, "collapsed": sidebarItem.isCollapsed,
                "foreground": window?.isKeyWindow == true && NSApp.isActive,
                "rows": cells]
    }
}

private final class SidebarMenuTracking: NSObject, NSMenuDelegate {
    var opened = false
    var closed = false
    func menuWillOpen(_ menu: NSMenu) { opened = true }
    func menuDidClose(_ menu: NSMenu) { closed = true }
}

// A deterministic local drag session passed through the actual AppKit delegates.
// Pointer travel/WindowServer drag animation is intentionally not simulated.
private final class SidebarTestDrag: NSObject, NSDraggingInfo {
    let draggingPasteboard = NSPasteboard.withUniqueName()
    let draggingSource: Any?
    init(source: NSOutlineView, writer: NSPasteboardWriting) {
        draggingSource = source
        super.init()
        draggingPasteboard.writeObjects([writer])
    }
    var draggingDestinationWindow: NSWindow? { (draggingSource as? NSView)?.window }
    var draggingSourceOperationMask: NSDragOperation { .move }
    var draggingLocation: NSPoint { .zero }
    var draggedImageLocation: NSPoint { .zero }
    var draggedImage: NSImage? { nil }
    var draggingSequenceNumber: Int { 1 }
    var draggingFormation: NSDraggingFormation = .none
    var animatesToDestination = false
    var numberOfValidItemsForDrop = 1
    var springLoadingHighlight: NSSpringLoadingHighlight { .none }
    func slideDraggedImage(to screenPoint: NSPoint) {}
    override func namesOfPromisedFilesDropped(atDestination dropDestination: URL) -> [String]? { nil }
    func resetSpringLoading() {}
    func enumerateDraggingItems(options: NSDraggingItemEnumerationOptions, for view: NSView?, classes: [AnyClass], searchOptions: [NSPasteboard.ReadingOptionKey: Any], using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {}
}
