import AppKit
import SwiftUI

// LKM-447: the opt-in Dreamer acceptance (`bun run acceptance:dreamer`); HostInspect.swift
// gates it to the test profile. It chooses Trezi → Dreamer Proposals… in the real menu,
// measures the Overview's buttons where SwiftUI drew them, clicks Export… or presses Return
// with events posted to the app's queue (where the window server's input arrives), and
// answers the real NSSavePanel that Export… attaches. Nothing here changes the window, the
// export or the panel: each step is one a user could take.
extension NativeSheets {
    private func acceptanceFailure(_ message: String) -> NSError {
        NSError(domain: "DreamerAcceptance", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
    private func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap { descendants($0) } }
    private func dreamerWindow() throws -> (NSWindow, NSView) {
        guard let panel, let content = panel.contentView, model.state?.title == "Dreamer Proposals" else {
            throw acceptanceFailure("Dreamer Proposals is not open")
        }
        return (panel, content)
    }
    private func numbers(_ rect: NSRect) -> [Double] { [rect.minX, rect.minY, rect.width, rect.height].map { Double($0) } }
    /// The save panel Export… attached to the window (`pickLogExport` in HostLogs.swift).
    private var attachedSavePanel: NSSavePanel? { panel?.attachedSheet as? NSSavePanel }

    /// The pane's actions in the footer's order (`SectionedSheetContent.footer`: the others,
    /// a spacer, then the primary) with the frame SwiftUI drew each one at. SwiftUI draws
    /// these buttons itself (no NSButton) and builds no accessibility tree without an
    /// assistive client, but every focusable button keeps a key-view proxy at its frame.
    private func footerButtons(_ content: NSView) throws -> (pane: NSView, buttons: [(SheetAction, NSView)], proxies: Int, actions: [SheetAction]) {
        content.layoutSubtreeIfNeeded()
        guard let pane = descendants(content).first(where: { $0 is NSHostingView<SheetContent> }) else {
            throw acceptanceFailure("The Dreamer pane is not rendered")
        }
        let shown = model.section ?? model.state?.sections?.first?.id
        let actions = (model.state?.actions ?? []).filter { $0.section == shown }
        let ordered = actions.filter { $0.primary != true } + actions.filter { $0.primary == true }
        let proxies = descendants(pane).filter { String(describing: type(of: $0)) == "KeyViewProxy" && !$0.isHiddenOrHasHiddenAncestor }
            .sorted { a, b in
                let ra = a.convert(a.bounds, to: content), rb = b.convert(b.bounds, to: content)
                return abs(ra.midY - rb.midY) > 1 ? ra.midY > rb.midY : ra.minX < rb.minX
            }
        let buttons = proxies.count == ordered.count ? Array(zip(ordered, proxies)) : []
        return (pane, buttons, proxies.count, ordered)
    }

    func dreamerAcceptance(_ c: [String: Any]) throws -> [String: Any] {
        switch c["op"] as? String ?? "measure" {
        case "menu":
            // Trezi → Dreamer Proposals… as the menu bar has it, chosen like a click would.
            let action = c["item"] as? String ?? "dreamer-review"
            guard let app = NSApp.mainMenu?.items.first?.submenu,
                  let index = app.items.firstIndex(where: { $0.representedObject as? String == action }) else {
                throw acceptanceFailure("Trezi menu item unavailable: \(action)")
            }
            app.update()
            let item = app.items[index]
            guard item.isEnabled else { throw acceptanceFailure("Trezi menu item disabled: \(item.title)") }
            app.performActionForItem(at: index)
            return ["menu": app.title, "title": item.title, "enabled": item.isEnabled]
        case "prepare":
            let (window, content) = try dreamerWindow()
            if let width = c["width"] as? Double {
                guard width >= window.contentMinSize.width, width <= 1200 else { throw acceptanceFailure("Invalid Dreamer test width \(width)") }
                window.setContentSize(NSSize(width: width, height: max(content.bounds.height, window.contentMinSize.height)))
            }
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            return try measure(reveal: true)
        case "measure":
            return try measure(reveal: false)
        case "click":
            // A left click at the button's centre, through the event queue and the window's hit test.
            let (window, content) = try dreamerWindow()
            guard let id = c["action"] as? String, let (_, proxy) = try footerButtons(content).buttons.first(where: { $0.0.id == id }) else {
                throw acceptanceFailure("Rendered Dreamer button unavailable: \(c["action"] ?? "")")
            }
            guard window.isKeyWindow, NSApp.isActive, window.attachedSheet == nil else { throw acceptanceFailure("The Dreamer window is not the key window of the active app") }
            let point = proxy.convert(NSPoint(x: proxy.bounds.midX, y: proxy.bounds.midY), to: nil)
            try click(at: point, in: window)
            return ["action": id, "point": [Double(point.x), Double(point.y)]]
        case "key":
            let (window, _) = try dreamerWindow()
            guard window.isKeyWindow, NSApp.isActive, window.attachedSheet == nil else { throw acceptanceFailure("The Dreamer window is not the key window of the active app") }
            let responder = window.firstResponder.map { String(describing: type(of: $0)) } ?? ""
            try press(c["key"] as? String ?? "", in: window)
            return ["key": c["key"] as? String ?? "", "firstResponder": responder]
        case "savePanel":
            return savePanelState()
        case "saveTo":
            // Where the user would navigate to; the suggested name is kept.
            guard let save = attachedSavePanel, let folder = c["directory"] as? String else { throw acceptanceFailure("No save panel is open") }
            save.directoryURL = URL(fileURLWithPath: folder, isDirectory: true)
            return savePanelState()
        case "savePress":
            // The panel's own Save or Cancel button, clicked; its Return or Escape key if it has no in-process button.
            guard let save = attachedSavePanel else { throw acceptanceFailure("No save panel is open") }
            let save_ = c["button"] as? String == "save"
            if let button = savePanelButtons(save).first(where: { $0.keyEquivalent == (save_ ? "\r" : "\u{1b}") && $0.isEnabled }) {
                try click(at: button.convert(NSPoint(x: button.bounds.midX, y: button.bounds.midY), to: nil), in: save)
                return ["route": "click", "title": button.title]
            }
            try press(save_ ? "return" : "escape", in: save)
            return ["route": "key"]
        case "dismissSavePanel":
            // Cleanup after a failure only: never part of the checked path.
            let open = attachedSavePanel != nil
            attachedSavePanel?.cancel(nil)
            return ["dismissed": open]
        default:
            throw acceptanceFailure("Unknown Dreamer acceptance step")
        }
    }

    private func click(at point: NSPoint, in window: NSWindow) throws {
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            guard let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                 windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
                                                 pressure: type == .leftMouseDown ? 1 : 0) else { throw acceptanceFailure("Mouse event unavailable") }
            NSApp.postEvent(event, atStart: false)
        }
    }
    private func press(_ key: String, in window: NSWindow) throws {
        guard let (code, characters) = ["return": (UInt16(36), "\r"), "escape": (UInt16(53), "\u{1b}")][key] else { throw acceptanceFailure("Unknown key: \(key)") }
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            guard let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                               windowNumber: window.windowNumber, context: nil, characters: characters,
                                               charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code) else { throw acceptanceFailure("Key event unavailable") }
            NSApp.postEvent(event, atStart: false)
        }
    }
    private func savePanelButtons(_ save: NSSavePanel) -> [NSButton] {
        (save.contentView.map { descendants($0) } ?? []).compactMap { $0 as? NSButton }.filter { !$0.isHiddenOrHasHiddenAncestor && !$0.keyEquivalent.isEmpty }
    }
    private func savePanelState() -> [String: Any] {
        guard let save = attachedSavePanel else {
            return ["open": false, "savePanels": NSApp.windows.filter { $0 is NSSavePanel && $0.isVisible }.count]
        }
        return ["open": true, "visible": save.isVisible, "key": save.isKeyWindow, "attached": save.sheetParent === panel,
                "class": String(describing: type(of: save)), "name": save.nameFieldStringValue,
                "directory": save.directoryURL?.path ?? "", "url": save.url?.path ?? "",
                "buttons": savePanelButtons(save).map { ["title": $0.title, "enabled": $0.isEnabled,
                                                         "key": $0.keyEquivalent == "\r" ? "return" : $0.keyEquivalent == "\u{1b}" ? "escape" : $0.keyEquivalent] }]
    }

    /// The footer's geometry in the window's content coordinates; `reveal` scrolls the
    /// pane the least needed to bring a button below the fold into view, as a user would.
    private func measure(reveal: Bool) throws -> [String: Any] {
        let (window, content) = try dreamerWindow()
        var footer = try footerButtons(content)
        let scroll = descendants(footer.pane).compactMap { $0 as? NSScrollView }.first
        // Visible: inside the scroll view's clip and below the toolbar of the full-size content.
        let layout = content.convert(window.contentLayoutRect, from: nil)
        let visible = (scroll.map { $0.contentView.convert($0.contentView.bounds, to: content) } ?? content.bounds).intersection(layout).intersection(content.bounds)
        var revealed = false
        if reveal, let hidden = footer.buttons.first(where: { !visible.insetBy(dx: -0.5, dy: -0.5).contains($0.1.convert($0.1.bounds, to: content)) }) {
            hidden.1.scrollToVisible(hidden.1.bounds)
            revealed = true
            footer = try footerButtons(content)
        }
        let font = NSFont.systemFont(ofSize: NSFont.systemFontSize)
        let buttons: [[String: Any]] = footer.buttons.map { action, proxy in
            let rect = proxy.convert(proxy.bounds, to: content)
            let hit = content.hitTest(content.convert(NSPoint(x: rect.midX, y: rect.midY), to: content.superview))
            return ["id": action.id, "label": action.label, "primary": action.primary == true, "frame": numbers(rect),
                    "labelWidth": Double(ceil((action.label as NSString).size(withAttributes: [.font: font]).width)),
                    "visible": visible.insetBy(dx: -0.5, dy: -0.5).contains(rect),
                    "hitPane": hit.map { $0 === footer.pane || $0.isDescendant(of: footer.pane) } ?? false]
        }
        // AppKit's default button (an NSButton's) and the accessibility default, when either exists.
        var axDefault: Any = NSNull()
        if let element = window.accessibilityDefaultButton() as? NSAccessibilityProtocol {
            axDefault = ["label": element.accessibilityLabel() ?? "", "title": element.accessibilityTitle() ?? "",
                         "frame": numbers(content.convert(window.convertFromScreen(element.accessibilityFrame()), from: nil))]
        }
        return ["foreground": window.isVisible && window.isKeyWindow && NSApp.isActive,
                "width": Double(content.bounds.width), "height": Double(content.bounds.height),
                "minimumWidth": Double(window.contentMinSize.width), "section": model.section ?? "",
                "actions": footer.actions.map(\.id), "proxies": footer.proxies, "buttons": buttons,
                "visibleRect": numbers(visible), "revealed": revealed,
                "defaultButtonCell": window.defaultButtonCell?.title ?? NSNull(), "axDefault": axDefault,
                "firstResponder": window.firstResponder.map { String(describing: type(of: $0)) } ?? "",
                "message": model.state?.message ?? "", "busy": model.state?.busy ?? false]
    }
}
