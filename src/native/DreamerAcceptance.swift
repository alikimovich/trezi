import AppKit
import SwiftUI

// LKM-447: the opt-in Dreamer acceptance (`bun run acceptance:dreamer`); HostInspect.swift
// gates it to the test profile. It chooses Trezi → Dreamer Proposals… in the real menu,
// measures the Overview's buttons where SwiftUI drew them, clicks Export… or presses Return
// with events posted to the app's queue (where the window server's input arrives), and
// answers the real NSSavePanel that Export… attaches. That panel is drawn out of process, so
// its Save and Cancel get Return and Escape from the window server, behind a non-prompting
// access preflight and a focus guard (LKM-452). Nothing here changes the window, the export
// or the panel: each step is one a user could take.
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
            // The panel's own Save or Cancel (LKM-452): `pressSavePanel` below.
            guard let save = attachedSavePanel else { throw acceptanceFailure("No save panel is open") }
            let (window, _) = try dreamerWindow()
            return try NativeSheets.pressSavePanel(save, parent: window, save: c["button"] as? String == "save",
                                                   access: { CGPreflightPostEventAccess() }, postKey: NativeSheets.postWindowServerKey,
                                                   clickLocal: { try self.click(at: $0, in: save) })
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
    private func savePanelState() -> [String: Any] {
        guard let save = attachedSavePanel else {
            return ["open": false, "savePanels": NSApp.windows.filter { $0 is NSSavePanel && $0.isVisible }.count]
        }
        return NativeSheets.savePanelSnapshot(save, parent: panel)
    }

    /// The enabled, visible in-process button with Save's Return or Cancel's Escape key
    /// equivalent: what `savePress` clicks. Nil when the panel's buttons are drawn by AppKit's
    /// out-of-process panel service (a remote view in this window), as on macOS 26 and later.
    static func savePressTarget(_ window: NSWindow, save: Bool) -> NSButton? {
        panelViews(window).compactMap { $0 as? NSButton }
            .first { !$0.isHiddenOrHasHiddenAncestor && $0.isEnabled && $0.keyEquivalent == (save ? "\r" : "\u{1b}") }
    }
    /// What must hold just before a window-server key goes to the save panel: Trezi is the
    /// active, frontmost app, the panel is the sheet on the Dreamer window, both are on
    /// screen, and the panel has key focus. Otherwise a global Return could reach another app.
    struct SavePanelFocus {
        var appActive: Bool, frontmost: Bool, attached: Bool, foreground: Bool, key: Bool
        var failed: [String] {
            [("app not active", appActive), ("app not frontmost", frontmost), ("panel not attached to the Dreamer window", attached),
             ("panel not on screen", foreground), ("panel not key", key)].filter { !$0.1 }.map(\.0)
        }
        var dictionary: [String: Any] { ["appActive": appActive, "frontmost": frontmost, "attached": attached, "foreground": foreground, "key": key] }
    }
    static func savePanelFocus(_ save: NSWindow, parent: NSWindow) -> SavePanelFocus {
        SavePanelFocus(appActive: NSApp.isActive,
                       frontmost: NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier,
                       attached: save.sheetParent === parent && parent.attachedSheet === save,
                       foreground: save.isVisible && parent.isVisible && !parent.isMiniaturized && save.occlusionState.contains(.visible),
                       key: save.isKeyWindow && NSApp.keyWindow === save)
    }
    /// LKM-452: in-process buttons keep the app-queue click (`local`). A panel drawn by the
    /// out-of-process service gets Return or Escape from the window server (`remote`), and only
    /// when post-event access is already granted (checked without a prompt) and the focus holds.
    static func savePanelRoute(inProcess: Bool, preflight: Bool, focus: SavePanelFocus) -> (route: String, refused: String?) {
        if inProcess { return ("local", nil) }
        if !preflight { return ("remote", "post-event access is not granted (CGPreflightPostEventAccess() is false)") }
        if !focus.failed.isEmpty { return ("remote", "the save panel is not in focus: \(focus.failed.joined(separator: ", "))") }
        return ("remote", nil)
    }
    /// Which process asked for post-event access: this host and its parent (no paths, no arguments).
    static func accessReceipt(preflight: Bool, route: String) -> [String: Any] {
        let parent = getppid()
        var path = [CChar](repeating: 0, count: 4096)
        let parentName = proc_pidpath(parent, &path, UInt32(path.count)) > 0 ? URL(fileURLWithPath: String(cString: path)).lastPathComponent : ""
        return ["check": "dreamer-export-primary", "access": "post events (CGPreflightPostEventAccess, never requested)",
                "preflight": preflight, "process": ProcessInfo.processInfo.processName, "pid": Int(getpid()),
                "bundle": Bundle.main.bundleIdentifier ?? "", "parentPid": Int(parent), "parent": parentName, "route": route]
    }
    /// Presses Save (Return) or Cancel (Escape) in the panel. `before` is the panel as it was
    /// when the input was chosen. A refused route sends nothing and carries the reason and
    /// the access receipt; the caller fails the check on `sent: false`.
    static func pressSavePanel(_ save: NSWindow, parent: NSWindow, save isSave: Bool, access: () -> Bool,
                               postKey: (CGKeyCode, Bool) -> Void, clickLocal: (NSPoint) throws -> Void) throws -> [String: Any] {
        let before = savePanelSnapshot(save, parent: parent)
        let key = isSave ? "return" : "escape"
        if let button = savePressTarget(save, save: isSave) {
            try clickLocal(button.convert(NSPoint(x: button.bounds.midX, y: button.bounds.midY), to: nil))
            return ["route": "local", "input": "click", "pressed": button.title, "sent": true, "refused": NSNull(), "before": before]
        }
        let preflight = access()
        let focus = savePanelFocus(save, parent: parent)
        let decision = savePanelRoute(inProcess: false, preflight: preflight, focus: focus)
        let result: [String: Any] = ["route": decision.route, "input": "window-server \(key)", "pressed": NSNull(),
                                     "preflight": preflight, "guard": focus.dictionary, "sent": decision.refused == nil,
                                     "refused": decision.refused ?? NSNull(), "before": before,
                                     "receipt": accessReceipt(preflight: preflight, route: "remote window-server \(key)")]
        if decision.refused == nil {
            let code: CGKeyCode = isSave ? 36 : 53
            postKey(code, true); postKey(code, false)
        }
        return result
    }
    /// One key event at the window server's HID level, which delivers it to the frontmost app's key window.
    static func postWindowServerKey(_ code: CGKeyCode, _ down: Bool) {
        CGEvent(keyboardEventSource: CGEventSource(stateID: .hidSystemState), virtualKey: code, keyDown: down)?.post(tap: .cghidEventTap)
    }
    private static func panelViews(_ window: NSWindow) -> [NSView] {
        func all(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap { all($0) } }
        return window.contentView.map { all($0) } ?? []
    }
    /// LKM-452: the save panel as one step saw it, written to evidence.json before the wait
    /// that follows. Window, focus, the in-process view classes (a remote view means another
    /// process draws the buttons), every in-process button, and where the panel points.
    static func savePanelSnapshot(_ window: NSWindow, parent: NSWindow?) -> [String: Any] {
        let name = { (w: NSWindow?) -> String in
            guard let w else { return "" }
            return w === window ? "save panel" : w === parent ? "Dreamer window" : NSStringFromClass(type(of: w))
        }
        let views = panelViews(window)
        var classes: [String] = []
        for view in views where classes.count < 24 {
            let cls = NSStringFromClass(type(of: view))
            if !classes.contains(cls) { classes.append(cls) }
        }
        let key = { (b: NSButton) in b.keyEquivalent == "\r" ? "return" : b.keyEquivalent == "\u{1b}" ? "escape" : b.keyEquivalent }
        var state: [String: Any] = [
            "open": true, "visible": window.isVisible, "key": window.isKeyWindow, "attached": window.sheetParent === parent,
            "class": String(describing: type(of: window)), "appActive": NSApp.isActive, "keyWindow": name(NSApp.keyWindow),
            "firstResponder": window.firstResponder.map { NSStringFromClass(type(of: $0)) } ?? "",
            "remote": classes.contains { $0.contains("Remote") }, "views": classes,
            "buttons": views.compactMap { $0 as? NSButton }.map { ["title": $0.title, "enabled": $0.isEnabled, "hidden": $0.isHiddenOrHasHiddenAncestor, "key": key($0)] },
            "saveTarget": savePressTarget(window, save: true)?.title ?? NSNull(),
            "cancelTarget": savePressTarget(window, save: false)?.title ?? NSNull()
        ]
        if let save = window as? NSSavePanel {
            state["name"] = save.nameFieldStringValue
            state["directory"] = save.directoryURL?.path ?? ""
            state["url"] = save.url?.path ?? ""
        }
        return state
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
