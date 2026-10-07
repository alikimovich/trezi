import AppKit

/// The test broker's inspect, perform, verification and capture commands (LKM-160 split
/// from Host.swift). `command` falls through to here; false means the method is unknown.
extension Host {
    func testBroker(_ c: [String: Any], id: Int) -> Bool {
        switch c["method"] as? String {
        case "previewInspector":
            if let action = c["action"] as? String { reply(id, PreviewInspector.perform(action, on: views["preview"])) }
            else { reply(id, previewInspectorReport()) }
        case "layoutInspect": reply(id, nativeLayout.inspect())
        case "inspectorInspect": reply(id, ["native":true, "visible":!editingInspector.isHidden, "fields":editingInspector.model.state?.fields.count ?? 0, "error":editingInspector.model.state?.error ?? "", "generation":editingInspector.model.state?.generation ?? 0, "title":editingInspector.model.state?.title ?? "", "tab":editingInspector.model.state?.tab ?? ""])
        case "inspectorPerform": guard ephemeral else { return true }; emit((c["action"] as? [String: Any] ?? [:]).merging(["event":"inspector-action"]) { _, new in new }); reply(id)
        case "inspectorIsland":
            guard ephemeral else { reply(id, error: "Test profile required"); return true }
            if c["capture"] as? Bool == true { Task { @MainActor in do { reply(id, try await captureInspectorIsland()) } catch { reply(id, error: error.localizedDescription) } } }
            else if c["pointer"] as? Bool == true { Task { @MainActor in do { reply(id, try await verifyInspectorPointer(c)) } catch { reply(id, error: error.localizedDescription) } } }
            else { reply(id, verifyInspectorIsland(c)) }
        case "layersInspect": reply(id, ["native":true, "visible":!layers.isHidden, "count":layers.nodes.count, "frame":NSStringFromRect(layers.frame), "selected":layers.selectedPath.map { $0 as Any } ?? NSNull()])
        case "layersIsland":
            guard ephemeral else { reply(id, error: "Test profile required"); return true }
            if let dark = c["capture"] as? String { Task { @MainActor in do { reply(id, try await captureLayersIsland(dark: dark == "dark")) } catch { reply(id, error: error.localizedDescription) } } }
            else if c["pointer"] as? Bool == true { Task { @MainActor in do { reply(id, try await layersPointer(c)) } catch { reply(id, error: error.localizedDescription) } } }
            else if c["action"] is String { reply(id, performLayers(c)) }
            else { reply(id, verifyLayersIsland(c)) }
        case "movableIslands":
            guard ephemeral else { reply(id, error: "Test profile required"); return true }
            if let dark = c["capture"] as? String { Task { @MainActor in do { reply(id, try await captureLayersIsland(dark: dark == "dark")) } catch { reply(id, error: error.localizedDescription) } } }
            else { reply(id, verifyIslands(c)) }
        case "sourceInspect":
            let editor = sourceEditors[c["root"] as? String ?? sourceRoot]
            reply(id, ["native":true, "visible":editor?.state["visible"] as? Bool ?? false, "source":editor?.source ?? "", "text":editor?.code.string ?? "", "popped":editor?.popout?.isVisible ?? false, "dirty":editor?.state["dirty"] as? Bool ?? false, "error":editor?.state["error"] as? String ?? "", "width":editor?.bounds.width ?? 0, "height":editor?.bounds.height ?? 0, "viewportHeight":editor?.scroll.contentSize.height ?? 0, "minHeight":editor?.popout?.contentMinSize.height ?? 0, "maxHeight":editor?.popout?.contentMaxSize.height ?? 0])
        case "sourceResize":
            guard ephemeral, let panel = sourceEditors[c["root"] as? String ?? sourceRoot]?.popout else { return true }
            panel.setContentSize(NSSize(width: c["width"] as? Double ?? 1000, height: c["height"] as? Double ?? 700)); reply(id)
        case "captureSource":
            guard let editor = sourceEditors[c["root"] as? String ?? sourceRoot], let bitmap = editor.bitmapImageRepForCachingDisplay(in: editor.bounds) else { reply(id, error: "No source editor"); return true }
            editor.cacheDisplay(in: editor.bounds, to: bitmap); reply(id, bitmap.representation(using: .png, properties: [:])?.base64EncodedString() ?? "")
        case "sourcePerform":
            guard ephemeral else { return true }; emit((c["action"] as? [String: Any] ?? [:]).merging(["event":"source-action"]) { _, new in new }); reply(id)
        case "sourceVerification":
            guard ephemeral, let editor = sourceEditors[c["root"] as? String ?? sourceRoot] else { reply(id, error: "Test source editor required"); return true }
            if c["prepare"] as? Bool == true { reply(id, editor.prepareForeground()) }
            else if c["capture"] as? Bool == true { Task { @MainActor in do { reply(id, try await editor.captureToolbar()) } catch { reply(id, error: error.localizedDescription) } } }
            else { reply(id, editor.verifyShortcut(c["key"] as? String ?? "", focus: c["focus"] as? String ?? "code").merging(["toolbar": editor.inspectToolbar()]) { _, new in new }) }
        case "sourceSyntax":
            guard ephemeral, let editor = sourceEditors[c["root"] as? String ?? sourceRoot] else { reply(id, error: "Test source editor required"); return true }
            if let appearance = c["capture"] as? String { Task { @MainActor in do { reply(id, try await editor.captureSyntax(dark: appearance == "dark", offscreen: c["offscreen"] as? Bool == true)) } catch { reply(id, error: error.localizedDescription) } } }
            else if let text = c["type"] as? String { Task { @MainActor in reply(id, await editor.typeSyntax(text, after: c["after"] as? String ?? "", pace: c["pace"] as? Double ?? 0.06)) } }
            else { reply(id, editor.inspectSyntax(c["probes"] as? [String] ?? [])) }
        case "activityInspect": reply(id, ["visible":activity.window?.isVisible ?? false, "key":activity.window?.isKeyWindow ?? false, "count":activity.count, "text":String(activity.text.string.suffix(20000))].merging(activityIndicator.inspect()) { _, new in new })
        case "activityMenu":
            // Pipe test: Command-L through the main menu's key equivalents, as the keyboard sends it.
            guard ephemeral, let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: "l", charactersIgnoringModifiers: "l", isARepeat: false, keyCode: 37) else { reply(id, error: "Test profile required"); return true }
            reply(id, ["handled":NSApp.mainMenu?.performKeyEquivalent(with: event) ?? false])
        case "sheetInspect": reply(id, sheets.inspect())
        case "settingsVerification":
            guard ephemeral else { reply(id, error: "Test profile required"); return true }
            do { reply(id, try sheets.verifySettings(c)) }
            catch { reply(id, error: error.localizedDescription) }
        case "settingsMenu":
            // Trezi → Settings… as the menu bar has it; `perform` chooses it like a click or Command-, would.
            guard ephemeral, let app = NSApp.mainMenu?.items.first?.submenu, let index = app.items.firstIndex(where: { $0.representedObject as? String == "settings" }) else { reply(id, error: "Settings menu item unavailable"); return true }
            let item = app.items[index]
            if c["perform"] as? Bool == true { app.performActionForItem(at: index) }
            reply(id, ["menu":app.title, "title":item.title, "key":item.keyEquivalent, "command":item.keyEquivalentModifierMask == .command, "enabled":item.isEnabled])
        case "captureVisibleSettings":
            guard ephemeral, let panel = sheets.panel, let content = panel.contentView,
                  sheets.model.state?.title == "Settings" else { reply(id, error: "Test Settings window required"); return true }
            Task { @MainActor in
                do { reply(id, try await captureVisibleRegion(window: panel, view: content, region: content.bounds)) }
                catch { reply(id, error: error.localizedDescription) }
            }
        case "captureSheet":
            guard let content = sheets.panel?.contentView?.superview else { reply(id, error: "No native sheet"); return true }
            content.layoutSubtreeIfNeeded(); content.displayIfNeeded()
            guard let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) else { reply(id, error: "No native sheet"); return true }
            content.cacheDisplay(in: content.bounds, to: bitmap)
            reply(id, bitmap.representation(using: .png, properties: [:])?.base64EncodedString() ?? "")
        case "sheetPerform":
            guard ephemeral else { reply(id, false); return true }
            if let values = c["values"] as? [String: String] { sheets.model.values.merge(values) { _, new in new } }
            if c["action"] as? String == "closeWindow" { sheets.panel?.performClose(nil) }
            else { sheets.model.perform(c["action"] as? String ?? "") }
            reply(id, true)
        // The in-window confirmation toast (LKM-170); perform clicks its action.
        case "toastInspect":
            let point = NSPoint(x: toast.frame.midX, y: toast.frame.midY)
            let hit = canvas.hitTest(canvas.convert(point, to: canvas.superview))
            reply(id, toast.inspect().merging(["cover":previewCoverRects(), "sentCover":previewCover,
                                               "hitToast":hit === toast || hit?.isDescendant(of: toast) == true]) { _, new in new })
        case "toastPerform": guard ephemeral else { reply(id, false); return true }; toast.model.perform(c["index"] as? Int ?? 0); reply(id, true)
        case "captureToast":
            // The workspace band around the toast, so the capture shows it in place.
            guard !toast.isHidden, toast.superview === canvas else { reply(id, error: "No toast"); return true }
            canvas.layoutSubtreeIfNeeded()
            let band = NSRect(x: 0, y: toast.frame.minY - 24, width: canvas.bounds.width, height: toast.frame.height + 48).intersection(canvas.bounds)
            guard let bitmap = canvas.bitmapImageRepForCachingDisplay(in: band) else { reply(id, error: "No toast"); return true }
            canvas.cacheDisplay(in: band, to: bitmap)
            reply(id, bitmap.representation(using: .png, properties: [:])?.base64EncodedString() ?? "")
        case "welcomeInspect": reply(id, welcome.inspect())
        case "dividerInspect": reply(id, ["visible":!chatDivider.isHidden, "width":chatDivider.width, "dragging":chatDivider.dragging, "frame":NSStringFromRect(chatDivider.frame), "hitTarget":canvas.hitTest(NSPoint(x: chatDivider.frame.midX, y: chatDivider.frame.midY)) === chatDivider])
        case "dividerPerform":
            guard ephemeral else { reply(id, false); return true }
            chatDivider.begin(at: .zero)
            chatDivider.drag(to: NSPoint(x: (c["delta"] as? Double ?? 0), y: 0)); chatDivider.end()
            reply(id, true)
        case "islandPerform":
            if let island = chat.model.snapshot?.messages.flatMap({ $0.segments.compactMap { $0.island } }).first(where: { $0.id == c["island"] as? String }) {
                chat.model.islandAction(island, action: c["action"] as? String ?? "", values: c["values"] as? [String: Any] ?? [:], gesture: c["gesture"] as? String, ended: c["ended"] as? Bool ?? false); reply(id)
            } else { reply(id, error: "Island not found") }
        case "revealChatIsland":
            guard ephemeral, let target = c["island"] as? String,
                  let message = chat.model.snapshot?.messages.first(where: { $0.segments.contains { $0.island?.id == target } }) else {
                reply(id, error: "Test island unavailable"); return true
            }
            let bottom = c["bottom"] as? Bool ?? false
            // Publish the request synchronously so overlapping requests take
            // revisions in arrival order; only the settlement wait is async.
            NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil)
            chat.model.revealIsland = target; chat.model.revealMessage = message.id; chat.model.revealBottom = bottom
            chat.model.revealRevision += 1
            let request = chat.model.revealRequest
            Task { @MainActor in
                var lastFrame: CGRect?
                for _ in 0..<100 {
                    try? await Task.sleep(nanoseconds: 20_000_000)
                    lastFrame = chat.model.islandPositions[request.position]
                    // Resolve against this request's own revision and anchor;
                    // a newer request's applied state never acknowledges it.
                    switch islandRevealState(request, currentRevision: chat.model.revealRevision, appliedRevision: chat.model.revealAppliedRevision,
                                             positions: chat.model.islandPositions, readingHeight: max(1, chat.bounds.height - chat.model.bottomInset)) {
                    case .pending: continue
                    case .settled(let frame):
                        reply(id, ["message":message.id, "revision":request.revision, "position":NSStringFromRect(frame)]); return
                    case .superseded(let newer):
                        reply(id, error: "Island reveal superseded; revision=\(request.revision), newer=\(newer)"); return
                    }
                }
                reply(id, error: "Island reveal did not settle at \(bottom ? "bottom" : "top"); revision=\(request.revision), applied=\(chat.model.revealAppliedRevision), attempts=\(chat.model.revealAttempt), frame=\(lastFrame.map { NSStringFromRect($0) } ?? "missing")")
            }
        case "captureVisibleChat":
            guard ephemeral else { reply(id, error: "Test profile required"); return true }
            Task { @MainActor in
                do { reply(id, try await captureVisibleChat(window: window, chat: chat)) }
                catch { reply(id, error: error.localizedDescription) }
            }
        case "chatAcceptance":
            guard ephemeral else { reply(id, error: "Test profile required"); return true }
            Task { @MainActor in
                do { reply(id, try await chatAcceptance(c)) }
                catch { reply(id, error: error.localizedDescription) }
            }
        case "chatInspect": reply(id, chat.inspect())
        case "chatCommentRows":
            guard ephemeral else { reply(id, error: "Test profile required"); return true }
            Task { @MainActor in
                do { reply(id, try await verifyCommentRows(c)) }
                catch { reply(id, error: error.localizedDescription) }
            }
        // The same state a thumbnail click sets; null closes the preview (LKM-166).
        case "chatAttachmentPreview":
            guard ephemeral else { reply(id, error: "Test profile required"); return true }
            chat.model.attachmentPreview = c["attachment"] as? String; reply(id)
        case "chatPerform": chat.model.action(c["action"] as? String ?? "", id: c["card"] as? String, value: c["value"] as? String, answers: c["answers"] as? [String: String]); reply(id)
        case "composerVerification":
            guard ephemeral else { reply(id, error: "Test profile required"); return true }
            reply(id, composer.verifyInteraction(c))
        case "captureVisibleComposer":
            guard ephemeral else { reply(id, error: "Test profile required"); return true }
            Task { @MainActor in
                do {
                    // Include surrounding chat pixels to expose any external fade.
                    let region = composer.bounds.insetBy(dx: -8, dy: -12)
                    reply(id, try await captureVisibleRegion(window: window, view: composer, region: region))
                } catch { reply(id, error: error.localizedDescription) }
            }
        case "composerInspect":
            var inspected = composer.inspect()
            inspected["queueNote"] = composer.state["queueNote"] ?? ""
            // Send lives in the shared controls row, not directly in the form bubble.
            inspected["sendInsideForm"] = composer.sendButton.isDescendant(of: composer.content)
            let clip = composer.scroll.contentSize
            inspected["inputWidth"] = Double(clip.width); inspected["textMinimumHeight"] = Double(composer.text.minSize.height)
            inspected["scrollerStyle"] = composer.scroll.scrollerStyle.rawValue
            reply(id, inspected)
        case "composerIMECheck":
            guard ephemeral else { reply(id, error: "Test profile required"); return true }
            let old = composer.text.string
            composer.text.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
            let marked = composer.text.hasMarkedText()
            let swallowed = composer.textView(composer.text, doCommandBy: NSSelectorFromString("insertNewline:"))
            composer.text.unmarkText(); composer.text.string = old
            reply(id, ["marked":marked, "swallowed":swallowed])
        case "composerPasteCheck":
            guard ephemeral else { reply(id, error: "Test profile required"); return true }
            reply(id, composer.checkPaste(c))
        case "composerPerform": composer.perform(c); reply(id)
        case "captureComposer":
            composer.layoutSubtreeIfNeeded()
            let target: NSView = c["contentOnly"] as? Bool == true ? composer.content : composer
            guard let bitmap = target.bitmapImageRepForCachingDisplay(in: target.bounds) else { reply(id, error: "Composer capture unavailable"); return true }
            target.cacheDisplay(in: target.bounds, to: bitmap)
            reply(id, bitmap.representation(using: .png, properties: [:])?.base64EncodedString() ?? "")
        case "shellInspect": reply(id, shell.inspect().merging(shell.gateInspect()) { _, new in new })
        case "sidebarVerification":
            guard ephemeral else { reply(id, error: "Test profile required"); return true }
            SidebarMenuMonitor.shared.install()
            reply(id, shell.verifySidebar(c))
        case "sidebarFocus":
            guard ephemeral else { reply(id, error: "Test profile required"); return true }
            SidebarMenuMonitor.shared.install()
            if c["cleanup"] as? Bool == true {
                sidebarFocusCleanup(main: window, cells: shell.projectCells, dismissAuxiliary: {
                    if self.sheets.panel?.isVisible == true { self.sheets.model.perform("cancel") }
                })
            }
            reply(id, sidebarFocusReport(main: window, auxiliary: sheets.panel))
        case "captureVisibleSidebar":
            guard ephemeral, !shell.sidebarItem.isCollapsed else { reply(id, error: "Visible test sidebar required"); return true }
            Task { @MainActor in
                do { reply(id, try await captureVisibleRegion(window: window, view: shell.sidebar.view, region: shell.sidebar.view.bounds)) }
                catch { reply(id, error: error.localizedDescription) }
            }
        case "captureVisibleWindow":
            guard ephemeral, let content = window.contentView else { reply(id, error: "Test profile required"); return true }
            Task { @MainActor in
                do { reply(id, try await captureVisibleRegion(window: window, view: content, region: content.bounds, recognize: false)) }
                catch { reply(id, error: error.localizedDescription) }
            }
        case "previewSurfaceInspect": reply(id, previewSurface.inspect())
        case "shellPerform": reply(id, shell.perform(c["action"] as? String ?? "", id: c["row"] as? String))
        case "captureVisibleShell":
            guard ephemeral else { reply(id, error: "Test profile required"); return true }
            Task { @MainActor in
                do {
                    let content = window.contentView?.superview ?? shell.split.view
                    reply(id, try await captureVisibleRegion(window: window, view: content, region: content.bounds, recognize: false))
                } catch { reply(id, error: error.localizedDescription) }
            }
        case "captureShell", "captureShellImage":
            let content = window.contentView?.superview ?? shell.split.view
            guard let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) else { reply(id, error: "Shell capture unavailable"); return true }
            content.cacheDisplay(in: content.bounds, to: bitmap)
            if c["method"] as? String == "captureShellImage" {
                reply(id, ["png":bitmap.representation(using: .png, properties: [:])?.base64EncodedString() ?? "", "jpeg":bitmap.representation(using: .jpeg, properties: [.compressionFactor:0.65])?.base64EncodedString() ?? "", "width":bitmap.pixelsWide, "height":bitmap.pixelsHigh])
            } else { reply(id, bitmap.representation(using: .png, properties: [:])?.base64EncodedString() ?? "") }
        case "captureSidebar":
            shell.split.view.layoutSubtreeIfNeeded()
            let content = shell.sidebar.view
            guard let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) else { reply(id, error: "Sidebar capture unavailable"); return true }
            content.cacheDisplay(in: content.bounds, to: bitmap)
            // Source-list materials are transparent when cached offscreen. Render
            // the cached native cells over the system background for readable QA.
            let image = NSImage(size: content.bounds.size); image.lockFocus()
            NSColor.windowBackgroundColor.setFill(); NSRect(origin: .zero, size: content.bounds.size).fill()
            let cells = NSImage(size: content.bounds.size); cells.addRepresentation(bitmap)
            cells.draw(in: NSRect(origin: .zero, size: content.bounds.size), from: .zero, operation: .sourceOver, fraction: 1)
            image.unlockFocus()
            let png = image.tiffRepresentation.flatMap { NSBitmapImageRep(data: $0)?.representation(using: .png, properties: [:]) }
            reply(id, png?.base64EncodedString() ?? "")
        case "smokeFocus":
            guard ephemeral else { reply(id, error: "Test profile required"); return true }
            Task { @MainActor in reply(id, await smokeFocus(c)) }
        case "previewInput":
            guard ephemeral, let preview = views["preview"] else { reply(id, error: "Test preview unavailable"); return true }
            if c["prepare"] as? Bool == true {
                // Native input fixtures must regain the main window after auxiliary windows.
                // Keep the existing WebKit responder during contentEditable gestures.
                NSApp.activate(ignoringOtherApps: true)
                window.makeKeyAndOrderFront(nil)
                window.contentView?.layoutSubtreeIfNeeded()
                let focused = c["preserveResponder"] as? Bool == true
                    ? window.firstResponder != nil : window.makeFirstResponder(preview)
                reply(id, ["active": NSApp.isActive, "key": window.isKeyWindow,
                           "focused": focused, "visible": preview.window === window && !preview.isHidden])
                return true
            }
            if let key = c["key"] as? String {
                let code: UInt16 = key == "ArrowRight" ? 124 : key == "Escape" ? 53 : key == "Enter" ? 36 : 0
                let chars = key == "ArrowRight" ? "\u{F703}" : key == "Escape" ? "\u{1B}" : key == "Enter" ? "\r" : key
                for type in [NSEvent.EventType.keyDown, .keyUp] {
                    if let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code) { window.sendEvent(event) }
                }
            } else {
                let y = c["y"] as? Double ?? 20
                let point = preview.convert(NSPoint(x: c["x"] as? Double ?? 20, y: preview.isFlipped ? y : preview.bounds.height - y), to: nil)
                for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                    if let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: c["clicks"] as? Int ?? 1, pressure: 1) { window.sendEvent(event) }
                }
            }
            reply(id)
        default: return false
        }
        return true
    }
}
