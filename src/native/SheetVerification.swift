import AppKit

// Test-only entrypoints are gated by the ephemeral profile in Host.swift.
// Drive the actual SwiftUI-backed AppKit picker; never assign SheetModel.values.
extension NativeSheets {
    private func renderedPickers(in view: NSView) -> [NSPopUpButton] {
        (view as? NSPopUpButton).map { [$0] } ?? view.subviews.flatMap { renderedPickers(in: $0) }
    }
    /// The window's split view: its sidebar item and source-list outline.
    private var split: SheetSplit? { panel?.contentViewController as? SheetSplit }
    /// An arrow key as the keyboard delivers it: through the window to the focused outline.
    private func press(_ key: String, in window: NSWindow, outline: NSOutlineView) -> Bool {
        guard let (code, scalar) = ["down": (UInt16(125), NSDownArrowFunctionKey), "up": (UInt16(126), NSUpArrowFunctionKey)][key],
              let character = UnicodeScalar(scalar), window.makeFirstResponder(outline),
              let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.numericPad, .function],
                                           timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
                                           characters: String(Character(character)), charactersIgnoringModifiers: String(Character(character)),
                                           isARepeat: false, keyCode: code) else { return false }
        window.sendEvent(event)
        return true
    }

    func verifySettings(_ command: [String: Any]) throws -> [String: Any] {
        func failure(_ message: String) -> NSError {
            NSError(domain: "SettingsVerification", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
        }
        guard let panel, let content = panel.contentView, model.state?.title == "Settings" else {
            throw failure("Settings window is not open")
        }
        if command["prepare"] as? Bool == true {
            if let width = command["width"] as? Double {
                let height = command["height"] as? Double ?? 600
                guard width >= panel.contentMinSize.width, width <= 1000,
                      height >= panel.contentMinSize.height, height <= 800 else { throw failure("Invalid Settings test size") }
                panel.setContentSize(NSSize(width: width, height: height))
                panel.center()
            }
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKeyAndOrderFront(nil)
        }
        if let id = command["section"] as? String {
            // Select the row of the rendered source list, as a click would.
            guard let index = model.state?.sections?.firstIndex(where: { $0.id == id }),
                  let sidebar = split?.outline, index < sidebar.numberOfRows else { throw failure("Rendered Settings sidebar unavailable: \(id)") }
            sidebar.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
        }
        if let key = command["key"] as? String {
            guard let sidebar = split?.outline, press(key, in: panel, outline: sidebar) else { throw failure("Settings sidebar key unavailable: \(key)") }
        }
        content.layoutSubtreeIfNeeded()
        content.displayIfNeeded()
        let fields = model.state!.fields.filter { $0.kind == "choice" }
        let popups = renderedPickers(in: content).filter { !$0.isHiddenOrHasHiddenAncestor }
        let sidebar = split?.outline
        let sidebarView = split?.sidebarItem.viewController.view
        let sidebarFrame = sidebarView.map { $0.convert($0.bounds, to: nil) } ?? .zero
        let close = panel.standardWindowButton(.closeButton).map { $0.convert($0.bounds, to: nil) } ?? .zero
        func picker(_ field: SheetField) -> NSPopUpButton? {
            // Match the complete option list, not subview order or private class names.
            popups.first { $0.itemTitles == (field.choices ?? []).map(\.label) }
        }
        if let fieldID = command["field"] as? String, let value = command["value"] as? String {
            guard let field = fields.first(where: { $0.id == fieldID }),
                  let popup = picker(field), popup.isEnabled,
                  let index = field.choices?.firstIndex(where: { $0.value == value }),
                  let item = popup.item(at: index), item.isEnabled,
                  let action = item.action else { throw failure("Rendered Settings picker/choice unavailable: \(fieldID)") }
            // SwiftUI's popup owns menu-item actions, not a popup-level action.
            guard NSApp.sendAction(action, to: item.target, from: item) else { throw failure("Settings picker menu action was not dispatched") }
        }
        let controls: [[String: Any]] = fields.compactMap { field in
            guard let popup = picker(field) else { return nil }
            let rect = popup.convert(popup.bounds, to: content)
            let point = NSPoint(x: rect.midX, y: rect.midY)
            let hit = content.hitTest(content.convert(point, to: content.superview))
            return ["id": field.id, "selected": popup.titleOfSelectedItem ?? "", "enabled": popup.isEnabled,
                    "contained": !rect.isEmpty && content.bounds.contains(rect) && popup.visibleRect.contains(popup.bounds),
                    "hitTarget": hit === popup || (hit?.isDescendant(of: popup) ?? false),
                    "frame": NSStringFromRect(rect)]
        }
        return ["foreground": panel.isVisible && panel.isKeyWindow && NSApp.isActive,
                "width": content.bounds.width, "height": content.bounds.height,
                "minimumWidth": panel.contentMinSize.width, "minimumHeight": panel.contentMinSize.height, "controls": controls,
                "values": model.values, "id": model.state!.id, "section": model.section ?? "",
                "sections": model.state!.sections?.map { ["id": $0.id, "label": $0.label, "symbol": $0.symbol] } ?? [],
                "sidebarRows": sidebar?.numberOfRows ?? 0, "sidebarSelected": sidebar?.selectedRow ?? -1,
                "sidebarFrame": sidebar.map { NSStringFromRect($0.convert($0.bounds, to: content)) } ?? "",
                "sidebarFocused": sidebar.map { panel.firstResponder === $0 } ?? false,
                "sourceList": split.map { SourceList.inspect($0.outline, item: $0.sidebarItem) } ?? [:],
                "sidebarCollapsible": split?.sidebarItem.canCollapse ?? true,
                "sidebarMinimum": split?.sidebarItem.minimumThickness ?? 0, "sidebarMaximum": split?.sidebarItem.maximumThickness ?? 0,
                "sidebarWidth": sidebarView?.bounds.width ?? 0,
                "fullSizeContent": panel.styleMask.contains(.fullSizeContentView),
                "trafficLightsOverSidebar": !close.isEmpty && sidebarFrame.contains(close),
                // Full height: the sidebar rises through the titlebar, above the content layout rect.
                "sidebarFullHeight": sidebarFrame.maxY > panel.contentLayoutRect.maxY,
                "windowTitle": panel.title]
    }
}
