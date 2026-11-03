import AppKit

/// LKM-456: host steps of the opt-in `fullscreen-popout-close-native` acceptance for LKM-444
/// (`bun run acceptance:source-popout`, `smoke-source-popout-acceptance.ts`); HostInspect.swift
/// gates them to the test profile. A close, a dock or a probe of the main window is a left click
/// at a control's centre or a key press, posted to the app's event queue as window-targeted
/// NSEvents: AppKit hit-tests, tracks and dispatches them (⌘W through the main menu) as it does
/// the window server's input. They are programmatic, and every receipt says so. A preflight that
/// only reads comes first: the app active, no modal, the target window key and the point on the
/// control. If it fails, nothing is posted and the receipt says why.
extension Host {
    /// RED only (`legacy-order-out`): the presenter set aside while one input's hide takes the
    /// pre-LKM-444 path; restored right after that input, or by `recover`.
    @MainActor static var sourcePopoutRedPresenter: (editor: NativeSourceEditor, presenter: SourcePopout)?

    @MainActor func sourcePopoutAcceptance(_ editor: NativeSourceEditor, _ c: [String: Any]) async throws -> [String: Any] {
        func fail(_ message: String) -> NSError { NSError(domain: "SourcePopoutAcceptance", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
        func until(_ seconds: Double, _ done: () -> Bool) async throws -> Bool {
            for _ in 0..<Int(seconds * 20) where !done() { try await Task.sleep(nanoseconds: 50_000_000) }
            return done()
        }
        guard let popout = editor.popout, let presenter = editor.presenter ?? Host.sourcePopoutRedPresenter?.presenter else { throw fail("No pop-out") }
        let main: NSWindow = window
        let origin = "programmatic: window-targeted NSEvents posted to the app event queue (NSApplication.sendEvent, window hit-testing, menu key equivalents); not OS or HID hardware input"

        /// Reads only: activates, orders and focuses nothing.
        func preflight(_ name: String, host: NSWindow, view: NSView?, key target: NSWindow) -> (refused: String?, info: [String: Any], point: NSPoint) {
            var info: [String: Any] = ["appActive": NSApp.isActive, "modal": NSApp.modalWindow != nil, "keyWindow": NSApp.keyWindow?.title ?? "",
                                       "targetWindow": target.title, "targetKey": target.isKeyWindow, "targetVisible": target.isVisible,
                                       "targetOnActiveSpace": target.isOnActiveSpace, "sheet": target.attachedSheet != nil,
                                       "hostWindow": String(describing: type(of: host)), "hostIsTarget": host === target, "hostVisible": host.isVisible,
                                       "permission": "none needed: in-process app event queue (no Accessibility or Input Monitoring grant is asked for)"]
            var point = NSPoint.zero, layout: String?
            if let view {
                // The centre of the control's own laid-out bounds, not of its `visibleRect` (LKM-457,
                // ControlHitPoint.swift); empty, clipped or off-window layout refuses.
                let located = ControlHitPoint.locate(view, in: host, onScreen: host === target)
                point = located.point ?? .zero; layout = located.refused.map { "\(name): \($0)" }
                info["geometry"] = located.info
                for key in ["point", "hitView", "pointOnScreen"] { info[key] = located.info[key] }
                info["hitIsTarget"] = located.info["hitIsTarget"] as? Bool ?? false
                info["enabled"] = (view as? NSControl)?.isEnabled ?? true
            }
            let refused: String? = !NSApp.isActive ? "the app is not active (key window: \(NSApp.keyWindow?.title ?? "none"))"
                : NSApp.modalWindow != nil ? "a modal window is up"
                : !target.isVisible ? "\(name): \(target.title) is not visible"
                : !target.isKeyWindow ? "\(name): \(target.title) is not key (key window: \(NSApp.keyWindow?.title ?? "none"))"
                : target.attachedSheet != nil ? "\(name): a sheet is attached to \(target.title)"
                : layout != nil ? layout
                : view != nil && info["hitIsTarget"] as? Bool != true ? "\(name): the point hit-tests to \(info["hitView"] ?? ""), not the control"
                : info["enabled"] as? Bool == false ? "\(name): the control is disabled" : nil
            return (refused, info, point)
        }

        /// One click or key press through `NSApp.postEvent`, or a refusal receipt with nothing posted.
        func input(_ name: String) throws -> [String: Any] {
            let pointers: [String: NSView?] = ["editor-close": editor.controls["hide"], "editor-dock": editor.controls["popout"],
                                               "window-close": popout.standardWindowButton(.closeButton), "composer": composer.text]
            let keys: [String: (String, UInt16, NSEvent.ModifierFlags, NSWindow)] = ["cmd-w": ("w", 13, .command, popout), "type-x": ("x", 7, [], main),
                                                                                    "delete": ("\u{7f}", 51, [], main)]
            var receipt: [String: Any] = ["target": name, "route": "NSApp.postEvent", "origin": origin, "posted": false]
            if let entry = pointers[name] {
                guard let view = entry, let host = view.window else { receipt["refused"] = "\(name): the control is not in a window"; return receipt }
                // In full screen the red button lives in AppKit's title bar window; the pop-out must be key.
                let check = preflight(name, host: host, view: view, key: name == "window-close" ? popout : host)
                receipt["kind"] = "pointer"; receipt["preflight"] = check.info
                if let refused = check.refused { receipt["refused"] = refused; return receipt }
                for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                    guard let event = NSEvent.mouseEvent(with: type, location: check.point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                         windowNumber: host.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
                                                         pressure: type == .leftMouseDown ? 1 : 0) else { throw fail("Mouse event unavailable") }
                    NSApp.postEvent(event, atStart: false)
                }
            } else if let key = keys[name] {
                let (characters, code, flags, target) = key
                let check = preflight(name, host: target, view: nil, key: target)
                receipt["kind"] = "keyboard"; receipt["preflight"] = check.info
                if let refused = check.refused { receipt["refused"] = refused; return receipt }
                for type in [NSEvent.EventType.keyDown, .keyUp] {
                    guard let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                                                       windowNumber: target.windowNumber, context: nil, characters: characters,
                                                       charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code) else { throw fail("Key event unavailable") }
                    NSApp.postEvent(event, atStart: false)
                }
            } else { throw fail("Unknown input \(name)") }
            receipt["posted"] = true; receipt["postedAt"] = ProcessInfo.processInfo.systemUptime
            return receipt
        }

        func state() -> [String: Any] {
            let selected = editor.code.selectedRange()
            return presenter.inspect().merging(["text": editor.code.string, "selection": [selected.location, selected.length],
                                                "editorInPopout": editor.window === popout, "editorVisible": editor.state["visible"] as? Bool ?? false,
                                                "redArmed": Host.sourcePopoutRedPresenter != nil]) { _, new in new }
        }

        switch c["op"] as? String ?? "inspect" {
        case "input":
            // A close or dock: the editor's ×, its Dock control, the red button or ⌘W.
            let name = c["input"] as? String ?? ""
            guard c["red"] as? Bool == true else { return ["receipt": try input(name), "after": state()] }
            // RED: the hide this input causes reaches `sourceState` with no presenter, then the
            // window is ordered out as `sourceState` did before LKM-444 (252f23a5^ Host.swift).
            guard presenter.isFullScreen else { throw fail("RED needs a full-screen pop-out: \(presenter.inspect())") }
            Host.sourcePopoutRedPresenter = (editor, presenter); editor.presenter = nil
            defer { editor.presenter = presenter; Host.sourcePopoutRedPresenter = nil }
            var receipt = try input(name)
            var red: [String: Any] = ["mode": "legacy-order-out", "posted": receipt["posted"] as? Bool ?? false]
            if receipt["posted"] as? Bool == true {
                red["stateArrived"] = try await until(5) { editor.state["visible"] as? Bool == false || editor.state["popped"] as? Bool == false }
                red["fullScreenAtOrderOut"] = popout.styleMask.contains(.fullScreen)
                popout.orderOut(nil)
            }
            receipt["red"] = red
            return ["receipt": receipt, "after": state()]
        case "wait-closed":
            // Waits only; changes no focus. Settled or not, the caller asserts on what it returns.
            let settled = try await until(10) {
                !popout.isVisible && presenter.phase == .windowed && !presenter.pendingHide && !popout.styleMask.contains(.fullScreen)
                    && main.isKeyWindow && main.isOnActiveSpace
            }
            return state().merging(["settled": settled]) { _, new in new }
        case "probe":
            // The main window through input alone: click the composer, type x, press Delete.
            let before = composer.text.string
            var probe: [String: Any] = ["responderBefore": main.firstResponder.map { String(describing: type(of: $0)) } ?? "", "composerLength": before.count]
            let click = try input("composer"); probe["click"] = click
            guard click["posted"] as? Bool == true else { return probe }
            probe["focused"] = try await until(2) { main.firstResponder === composer.text }
            let typed = try input("type-x"); probe["type"] = typed
            guard typed["posted"] as? Bool == true else { return probe }
            probe["typed"] = try await until(2) { composer.text.string.count == before.count + 1 && composer.text.string.contains("x") }
            let erase = try input("delete"); probe["erase"] = erase
            guard erase["posted"] as? Bool == true else { return probe }
            probe["restored"] = try await until(2) { composer.text.string == before }
            probe["mainKey"] = main.isKeyWindow; probe["appActive"] = NSApp.isActive
            return probe
        case "recover":
            // Cleanup, after RED above all: no full-screen pop-out or Space is left behind.
            var steps: [String] = []
            if let red = Host.sourcePopoutRedPresenter { red.editor.presenter = red.presenter; Host.sourcePopoutRedPresenter = nil; steps.append("presenter-restored") }
            if popout.styleMask.contains(.fullScreen) || presenter.phase != .windowed {
                steps.append("full-screen-\(presenter.phase.rawValue)\(popout.isVisible ? "" : "-off-screen")")
                NSApp.activate(ignoringOtherApps: true); popout.makeKeyAndOrderFront(nil)
                _ = try await until(10) { presenter.phase == .full || presenter.phase == .windowed }
                if popout.styleMask.contains(.fullScreen) && presenter.phase == .full { popout.toggleFullScreen(nil) }
                let left = try await until(10) { !popout.styleMask.contains(.fullScreen) && presenter.phase == .windowed }
                steps.append(left ? "left-full-screen" : "still-full-screen")
            }
            if popout.isVisible && editor.state["visible"] as? Bool != true { presenter.hide(); steps.append("hidden") }
            return state().merging(["recovered": steps]) { _, new in new }
        case "inspect": return state()
        default: throw fail("Unknown step \(c["op"] ?? "")")
        }
    }
}
