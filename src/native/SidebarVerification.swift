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
        if let key = command["focus"] as? String {
            let cell = projectCells.first { $0.more.identifier?.rawValue == "more:\(key)" }
            let target = command["control"] as? String == "new-chat" ? cell?.newChat : cell?.more
            _ = window?.makeFirstResponder(target)
            return ["focused": target != nil && window?.firstResponder === target, "keyboardAccess": NSApp.isFullKeyboardAccessEnabled]
        }
        if let key = command["menu"] as? String, let row = rows.first(where: { $0.id == key }),
           let cell = outline.view(atColumn: 0, row: outline.row(forItem: row), makeIfNecessary: true) as? ProjectCell {
            // Press the real "…", then cancel the menu deterministically without changing a project.
            var menu: NSMenu?, closed = false, shot: [String: Any] = [:]
            let center = NotificationCenter.default
            let observers = [center.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: nil) { menu = $0.object as? NSMenu },
                             center.addObserver(forName: NSMenu.didEndTrackingNotification, object: nil, queue: nil) { _ in closed = true }]
            defer { observers.forEach(center.removeObserver) }
            let capture = command["capture"] as? Bool == true
            // The capture cancels when it is done; the timer closes the menu either way.
            let cancel = Timer(timeInterval: capture ? 3 : 0.3, repeats: false) { _ in menu?.cancelTracking() }
            let shoot = Timer(timeInterval: 0.3, repeats: false) { _ in
                Task { @MainActor in
                    shot = await self.captureMenuWindow()
                    menu?.cancelTracking()
                }
            }
            RunLoop.main.add(cancel, forMode: .common)
            if capture { RunLoop.main.add(shoot, forMode: .common) }
            defer { cancel.invalidate(); shoot.invalidate() }
            cell.more.performClick(nil)
            let titles = menu?.items.map { $0.title } ?? []
            let states = menu?.items.map { $0.isEnabled ? $0.title : "\($0.title) (disabled)" } ?? []
            if command["memory"] as? Bool == true { menu?.performActionForItem(at: 0) }
            // A pick is a person's choice: a disabled item does nothing, as in the real menu.
            if let pick = command["pick"] as? String, let index = menu?.indexOfItem(withTitle: pick), index >= 0,
               menu?.item(at: index)?.isEnabled == true { menu?.performActionForItem(at: index) }
            return shot.merging(["titles": titles, "states": states, "project": row.project, "opened": menu != nil, "closed": closed]) { _, new in new }
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
            let template = icon.image?.isTemplate == true
            // A template folder follows the selection emphasis; a favicon keeps its own colours.
            let expectedTint: NSColor? = template ? (emphasized ? .alternateSelectedControlTextColor : .labelColor) : nil
            let ink = SidebarFaviconInk.measure(icon)
            return ["id": row.id, "title": row.title, "storedArtwork": row.icon != nil, "offeredIcon": row.offeredIcon,
                    "favicon": row.icon != nil && icon.image === row.icon,
                    "folder": icon.image?.tiffRepresentation == folder?.tiffRepresentation,
                    "template": template, "scaling": icon.imageScaling == .scaleProportionallyDown,
                    "imageWidth": icon.image?.size.width ?? 0, "imageHeight": icon.image?.size.height ?? 0,
                    "inkFraction": ink.fraction, "centerColor": ink.center,
                    "selected": cell.selected, "emphasized": emphasized,
                    "tintCorrect": icon.contentTintColor == expectedTint,
                    "iconX": iconRect.minX, "iconY": iconRect.minY, "iconWidth": iconRect.width, "iconHeight": iconRect.height,
                    "iconMidY": iconRect.midY, "textMidY": textRect.midY,
                    "textGap": textRect.minX - iconRect.maxX, "textWidth": textRect.width,
                    "matchesOpenProject": iconRect.minX == openIcon.minX && iconRect.size == openIcon.size && textRect.minX == openLabelX,
                    "contained": sidebar.view.bounds.contains(iconRect) && sidebar.view.bounds.contains(textRect) && sidebar.view.bounds.contains(moreRect),
                    "moreAlpha": cell.more.alphaValue, "more": cell.actionInspect(cell.more), "newChat": cell.actionInspect(cell.newChat),
                    "actionsLabel": AccessibilityElementInspect.element(of: cell.more)?.accessibilityLabel() ?? "",
                    "menu": projectMenu(row).items.map { $0.title }]
        }
        return ["width": sidebar.view.bounds.width, "collapsed": sidebarItem.isCollapsed,
                "foreground": window?.isKeyWindow == true && NSApp.isActive,
                "rows": cells]
    }
    /// The open menu's own window, which a capture of the main window does not contain. A failure
    /// comes back as `shotError`: the menu's titles are the assertion, the picture is evidence.
    @MainActor private func captureMenuWindow() async -> [String: Any] {
        let menuWindow = NSApp.windows.first { $0 !== window && $0.isVisible && String(describing: type(of: $0)).contains("Menu") }
        guard let menuWindow else { return ["shotError": "no menu window among \(NSApp.windows.map { String(describing: type(of: $0)) })"] }
        do { return ["shot": try await captureOwnWindow(menuWindow)] }
        catch { return ["shotError": error.localizedDescription] }
    }
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
