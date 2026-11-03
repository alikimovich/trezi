import AppKit

/// Test-profile hook for the pop-out's full-screen close (LKM-444, `smoke-source-popout.ts`):
/// enters or leaves full screen (waiting, or only until the transition started), closes through
/// the editor's ×, the window's red button or ⌘W through the main menu, sets and reads the draft
/// and selection, waits for the pop-out to settle and captures the foreground windows.
extension Host {
    @MainActor func verifySourcePopout(_ editor: NativeSourceEditor, _ c: [String: Any]) async throws -> [String: Any] {
        func fail(_ message: String) -> NSError { NSError(domain: "SourcePopout", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
        func until(_ seconds: Double, _ done: () -> Bool) async throws -> Bool {
            for _ in 0..<Int(seconds * 20) where !done() { try await Task.sleep(nanoseconds: 50_000_000) }
            return done()
        }
        guard let popout = editor.popout, let presenter = editor.presenter else { throw fail("No pop-out") }
        let step = c["popout"] as? String ?? "inspect"
        var extra: [String: Any] = [:]
        switch step {
        case "enter", "enter-start":
            if presenter.phase == .windowed && !popout.styleMask.contains(.fullScreen) {
                NSApp.activate(ignoringOtherApps: true); popout.makeKeyAndOrderFront(nil); popout.toggleFullScreen(nil)
            }
            let started = try await until(step == "enter" ? 10 : 3) { step == "enter" ? presenter.phase == .full && popout.styleMask.contains(.fullScreen) : presenter.phase != .windowed }
            guard started else { throw fail("Full screen did not \(step == "enter" ? "finish" : "start"): \(presenter.inspect())") }
            if step == "enter" { try await Task.sleep(nanoseconds: 400_000_000) }
        case "exit":
            if presenter.phase == .full { popout.toggleFullScreen(nil) }
            guard try await until(10, { presenter.phase == .windowed && !popout.styleMask.contains(.fullScreen) }) else { throw fail("Exit did not finish: \(presenter.inspect())") }
        case "exit-start":
            guard presenter.phase == .full else { throw fail("Not in full screen: \(presenter.inspect())") }
            popout.toggleFullScreen(nil)
            guard try await until(3, { presenter.phase == .exiting || presenter.phase == .windowed }) else { throw fail("Exit did not start") }
        case "close":
            let via = c["via"] as? String ?? "control"
            extra["via"] = via
            switch via {
            case "control": guard let button = editor.controls["hide"] else { throw fail("No close control") }; button.performClick(nil)
            case "button": guard let button = popout.standardWindowButton(.closeButton) else { throw fail("No close button") }; button.performClick(nil)
            case "key":
                // ⌘W reaches File → Close Window, whose performClose: must land on the pop-out.
                guard popout.isKeyWindow else { throw fail("⌘W would not reach the pop-out: \(presenter.inspect())") }
                let menuItems = NSApp.mainMenu?.items.flatMap { $0.submenu?.items ?? [] } ?? []
                guard let item = menuItems.first(where: { $0.keyEquivalent == "w" && $0.keyEquivalentModifierMask == .command }),
                      let action = item.action,
                      let target = NSApp.target(forAction: action, to: item.target, from: item) as? NSWindow,
                      target === popout else { throw fail("⌘W would not reach the pop-out: \(presenter.inspect())") }
                guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: popout.windowNumber,
                                                   context: nil, characters: "w", charactersIgnoringModifiers: "w", isARepeat: false, keyCode: 13) else { throw fail("No key event") }
                extra["handled"] = NSApp.mainMenu?.performKeyEquivalent(with: event) ?? false
            default: throw fail("Unknown close \(via)")
            }
        case "settle":
            // Closed: off screen, out of full screen, nothing pending, the main window key on the
            // active Space (`key: false` in a background run, where the app need not be active).
            let key = c["key"] as? Bool != false
            let settled = try await until(10) {
                !popout.isVisible && presenter.phase == .windowed && !presenter.pendingHide && !popout.styleMask.contains(.fullScreen)
                    && (!key || window.isKeyWindow && window.isOnActiveSpace)
            }
            extra["settled"] = settled
            try await Task.sleep(nanoseconds: 300_000_000)
            // Usable: the composer takes keyboard focus and the content's centre hit-tests to a view.
            extra["composerFocus"] = window.makeFirstResponder(composer.text) && window.firstResponder === composer.text
            if let content = window.contentView { extra["hitTest"] = content.hitTest(NSPoint(x: content.frame.midX, y: content.frame.midY)) != nil }
            extra["ignoresMouse"] = window.ignoresMouseEvents
        case "select":
            let location = c["location"] as? Int ?? 0, length = c["length"] as? Int ?? 0
            popout.makeFirstResponder(editor.code); editor.code.setSelectedRange(NSRange(location: location, length: length))
        case "type":
            popout.makeFirstResponder(editor.code); editor.code.insertText(c["text"] as? String ?? "", replacementRange: editor.code.selectedRange())
        case "capture":
            // The main window, or the pop-out while it is up (full screen included), in the foreground.
            let target = c["window"] as? String == "popout" ? popout : window!
            guard let view = target.contentView else { throw fail("No content") }
            NSApp.activate(ignoringOtherApps: true); target.makeKeyAndOrderFront(nil)
            _ = try await until(3) { target.isKeyWindow && NSApp.isActive }
            extra = try await captureVisibleRegion(window: target, view: view, region: view.bounds, recognize: false)
        case "inspect": break
        default: throw fail("Unknown step \(step)")
        }
        let selected = editor.code.selectedRange()
        return presenter.inspect().merging(extra) { _, new in new }.merging([
            "step": step, "text": editor.code.string, "selection": [selected.location, selected.length], "dirty": editor.state["dirty"] as? Bool ?? false,
            "editorInPopout": editor.window === popout, "editorHidden": editor.isHiddenOrHasHiddenAncestor
        ]) { _, new in new }
    }
}
