import AppKit

// LKM-453: the opt-in chat recovery acceptance (`bun run acceptance:chat-recovery`,
// docs/TESTING.md "Chat recovery acceptance"); HostInspect.swift gates it to the test profile.
// It finds a chat card's buttons where SwiftUI drew them and queues window-targeted mouse
// and key events on the app (NSApplication, NSWindow hit-testing and SwiftUI's own button
// handling take them as input; nothing is posted to the system and the cursor stays put).
// Nothing here changes the card or calls its actions: each step is one a user could take.

/// One rendered card button: the snapshot's action and the frame SwiftUI drew it at.
struct RecoveryCardButton {
    let label: String, action: String, disabled: Bool
    /// Window coordinates: the button's key-view proxy, or for a disabled button (SwiftUI
    /// removes its proxy) the frame derived from the card's last all-enabled row.
    let frame: NSRect
    let proxy: NSView?
    var derived: Bool { proxy == nil }
    var center: NSPoint { NSPoint(x: frame.midX, y: frame.midY) }
}

/// A card's action row as last drawn with every action enabled: each action's frame and label.
private struct RecoveryRow { let actions: [String], labels: [String], frames: [NSRect], width: CGFloat }
@MainActor private var recoveryRows: [String: RecoveryRow] = [:]
/// The width SwiftUI's push button gives a label at the regular control size.
private func recoveryLabelWidth(_ label: String) -> CGFloat {
    ceil((label as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: NSFont.systemFontSize)]).width)
}

extension NativeChat {
    private func recoveryDescendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap { recoveryDescendants($0) } }
    /// The part of the conversation above the composer, in window coordinates.
    var recoveryReadingFrame: NSRect {
        let inset = model.bottomInset
        let reading = isFlipped ? NSRect(x: 0, y: 0, width: bounds.width, height: max(1, bounds.height - inset))
                                : NSRect(x: 0, y: inset, width: bounds.width, height: max(1, bounds.height - inset))
        return convert(reading, to: nil)
    }

    /// Card `id`'s action buttons in the order the card lists them. SwiftUI draws these
    /// buttons itself (no NSButton) and builds no accessibility tree without an assistive
    /// client, but every enabled button keeps a key-view proxy at its frame (as in
    /// DreamerAcceptance.swift). Cards follow the transcript, so with no question open the
    /// card's action row is the lowest row of proxies in the reading area; the copy-detail
    /// glyph, when the card has one, sits first in that row. A disabled button has no proxy:
    /// its frame comes from the card's last all-enabled row (same actions, same width), with
    /// the label's width change, laid out from the row's trailing edge as SwiftUI's trailing
    /// HStack does; every enabled button's proxy must agree with that layout. `problem` says
    /// why the row could not be matched to the card's actions.
    func recoveryCardButtons(_ id: String) -> (buttons: [RecoveryCardButton], rows: [[NSRect]], problem: String?) {
        layoutSubtreeIfNeeded()
        guard let card = model.snapshot?.cards.first(where: { $0.id == id }) else { return ([], [], "No \(id) card in the conversation") }
        let reading = recoveryReadingFrame.insetBy(dx: -0.5, dy: -0.5)
        let proxies = recoveryDescendants(self)
            .filter { String(describing: type(of: $0)) == "KeyViewProxy" && !$0.isHiddenOrHasHiddenAncestor }
            .map { ($0, $0.convert($0.bounds, to: nil)) }
            .filter { $0.1.width > 0 && $0.1.height > 0 && reading.contains(NSPoint(x: $0.1.midX, y: $0.1.midY)) }
        // Rows by their centre line, lowest on screen first (window coordinates grow upwards).
        var rows: [[(NSView, NSRect)]] = []
        for proxy in proxies.sorted(by: { $0.1.midY < $1.1.midY }) {
            if let last = rows.indices.last, abs(rows[last][0].1.midY - proxy.1.midY) <= 2 { rows[last].append(proxy) } else { rows.append([proxy]) }
        }
        rows = rows.map { $0.sorted { $0.1.minX < $1.1.minX } }
        let frames = rows.map { $0.map(\.1) }
        if !(model.snapshot?.questions.isEmpty ?? true) { return ([], frames, "A question card follows the \(id) card") }
        let enabled = card.actions.filter { !($0.disabled ?? false) }, glyph = card.fullDetail != nil ? 1 : 0
        let shape = "\(enabled.count) enabled of \(card.actions.count) actions\(glyph == 1 ? " and a copy glyph" : "")"
        if enabled.count == card.actions.count {
            guard let row = rows.first else { return ([], frames, "No rendered buttons in the reading area") }
            guard row.count == enabled.count + glyph else {
                return ([], frames, "The lowest button row has \(row.count) buttons; the \(id) card has \(shape)")
            }
            let buttons = zip(card.actions, row.suffix(enabled.count)).map { action, proxy in
                RecoveryCardButton(label: action.label, action: action.action, disabled: false, frame: proxy.1, proxy: proxy.0)
            }
            recoveryRows[id] = RecoveryRow(actions: card.actions.map(\.action), labels: card.actions.map(\.label), frames: buttons.map(\.frame), width: bounds.width)
            return (buttons, frames, nil)
        }
        guard let last = recoveryRows[id], last.actions == card.actions.map(\.action), abs(last.width - bounds.width) < 0.5 else {
            return ([], frames, "The \(id) card has disabled buttons (no key-view proxy) and no all-enabled row of the same actions at this width was measured first")
        }
        let midY = last.frames[0].midY
        guard let row = rows.first(where: { abs($0[0].1.midY - midY) <= 2 }) ?? (enabled.isEmpty && glyph == 0 ? [] : nil),
              row.count == enabled.count + glyph else {
            return ([], frames, "The \(id) card's row at y \(Int(midY)) does not have \(shape)")
        }
        // Right to left from the live trailing edge, keeping each gap. The still-enabled
        // report button may compress when the busy label grows; its proxy anchors the
        // disabled mutations instead of the stale width from the all-enabled row.
        var live = [Int: NSRect](), next = 0
        let enabledFrames = Array(row.suffix(enabled.count)).map(\.1)
        for (index, action) in card.actions.enumerated() where !(action.disabled ?? false) {
            live[index] = enabledFrames[next]; next += 1
        }
        var derived = [NSRect](repeating: .zero, count: last.frames.count)
        var trailing = last.frames[last.frames.count - 1].maxX
        for index in stride(from: last.frames.count - 1, through: 0, by: -1) {
            let was = last.frames[index]
            let width = was.width + recoveryLabelWidth(card.actions[index].label) - recoveryLabelWidth(last.labels[index])
            derived[index] = live[index] ?? NSRect(x: trailing - width, y: was.minY, width: width, height: was.height)
            if index > 0 { trailing = derived[index].minX - (was.minX - last.frames[index - 1].maxX) }
        }
        var drawn = Array(row.suffix(enabled.count))
        var buttons: [RecoveryCardButton] = []
        for (index, action) in card.actions.enumerated() {
            guard !(action.disabled ?? false) else {
                buttons.append(RecoveryCardButton(label: action.label, action: action.action, disabled: true, frame: derived[index], proxy: nil))
                continue
            }
            let proxy = drawn.removeFirst()
            // SwiftUI can compress the still-enabled report button when the busy label
            // grows. Its live proxy is authoritative; only disabled mutations need a
            // derived frame from the earlier all-enabled row.
            guard action.action == "recovery-report" ||
                  (abs(proxy.1.midX - derived[index].midX) <= 3 && abs(proxy.1.midY - derived[index].midY) <= 2) else {
                return ([], frames, "The \(id) card's drawn \(action.label) is not where its row's layout puts it")
            }
            buttons.append(RecoveryCardButton(label: action.label, action: action.action, disabled: false, frame: proxy.1, proxy: proxy.0))
        }
        return (buttons, frames, nil)
    }

    /// Spinners drawn in the reading area (SwiftUI's small ProgressView), in window coordinates.
    var recoverySpinners: [NSRect] {
        let reading = recoveryReadingFrame
        return recoveryDescendants(self).compactMap { $0 as? NSProgressIndicator }
            .filter { !$0.isHiddenOrHasHiddenAncestor }
            .map { $0.convert($0.bounds, to: nil) }
            .filter { reading.intersects($0) }
    }

    /// What `recoveryCardButtons` found, as JSON, with the card as the snapshot has it.
    func recoveryMeasure(_ id: String) -> [String: Any] {
        let found = recoveryCardButtons(id)
        let card = model.snapshot?.cards.first { $0.id == id }
        func numbers(_ rect: NSRect) -> [Double] { [rect.minX, rect.minY, rect.width, rect.height].map { Double($0) } }
        return ["card": id, "present": card != nil, "title": card?.title ?? "", "detail": card?.detail ?? "",
                "busy": card?.busy ?? false, "actions": card?.actions.map(\.label) ?? [],
                "disabled": card?.actions.map { $0.disabled ?? false } ?? [],
                "buttons": found.buttons.map { ["label": $0.label, "action": $0.action, "disabled": $0.disabled, "frame": numbers($0.frame),
                                                "frameSource": $0.derived ? "derived from the last all-enabled row" : "key-view proxy"] as [String: Any] },
                "rows": found.rows.map { $0.map(numbers) }, "problem": found.problem ?? NSNull(),
                "spinners": recoverySpinners.map(numbers), "reading": numbers(recoveryReadingFrame),
                "cards": model.snapshot?.cards.map(\.id) ?? [], "questions": model.snapshot?.questions.count ?? 0]
    }

    /// A left click at `point` (window coordinates) and the Space key, as events for `window`.
    static func recoveryClick(at point: NSPoint, in window: NSWindow) -> [NSEvent] {
        [NSEvent.EventType.leftMouseDown, .leftMouseUp].compactMap { type in
            NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                               windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
                               pressure: type == .leftMouseDown ? 1 : 0)
        }
    }
    static func recoverySpace(in window: NSWindow) -> [NSEvent] {
        [NSEvent.EventType.keyDown, .keyUp].compactMap { type in
            NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                             windowNumber: window.windowNumber, context: nil, characters: " ", charactersIgnoringModifiers: " ",
                             isARepeat: false, keyCode: 49)
        }
    }
}

extension Host {
    @MainActor
    func chatRecoveryAcceptance(_ c: [String: Any]) async throws -> [String: Any] {
        func fail(_ reason: String) -> NSError {
            NSError(domain: "ChatRecoveryAcceptance", code: 1, userInfo: [NSLocalizedDescriptionKey: reason])
        }
        let id = c["card"] as? String ?? "conflict"
        var foreground: Bool { window.isKeyWindow && NSApp.isActive && !chat.isHidden && window.attachedSheet == nil }
        func state() -> [String: Any] {
            var result = chat.recoveryMeasure(id)
            result["foreground"] = foreground
            result["firstResponder"] = window.firstResponder.map { String(describing: type(of: $0)) } ?? ""
            result["keyboardNavigation"] = NSApp.isFullKeyboardAccessEnabled
            return result
        }
        func button(_ label: String) throws -> RecoveryCardButton {
            let found = chat.recoveryCardButtons(id)
            guard let button = found.buttons.first(where: { $0.label == label }) else {
                throw fail("Rendered \(id) button unavailable: \(label) (\(found.problem ?? "shown: \(found.buttons.map(\.label))"))")
            }
            return button
        }
        func hit(_ point: NSPoint) -> [String: Any] {
            guard let content = window.contentView, let view = content.hitTest(content.superview?.convert(point, from: nil) ?? point) else {
                return ["view": "nil", "inChat": false]
            }
            return ["view": String(describing: type(of: view)), "inChat": view === chat || view.isDescendant(of: chat)]
        }
        switch c["op"] as? String ?? "measure" {
        case "prepare":
            // The window in front and key, the conversation at its end (where cards are).
            NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil)
            for attempt in 0..<100 where !foreground {
                if attempt > 0, attempt % 10 == 0 { NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil) }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            chat.model.pressLatest()
            try await Task.sleep(nanoseconds: 300_000_000)
            return state()
        case "measure":
            return state()
        case "click":
            // A left click at the button's centre, whatever its state: a disabled one must ignore it.
            guard foreground else { throw fail("The chat window is not the key window of the active app") }
            let target = try button(c["label"] as? String ?? "")
            let events = NativeChat.recoveryClick(at: target.center, in: window)
            guard events.count == 2 else { throw fail("Mouse events unavailable") }
            let at = hit(target.center)
            for event in events { NSApp.postEvent(event, atStart: false) }
            return ["input": "pointer", "route": "leftMouseDown+leftMouseUp queued on NSApp for the chat window",
                    "label": target.label, "disabled": target.disabled, "point": [Double(target.center.x), Double(target.center.y)], "hit": at,
                    "frameSource": target.derived ? "derived from the last all-enabled row" : "key-view proxy"]
        case "key":
            // Keyboard: focus moves to the button's key-view proxy the way Tab with keyboard
            // navigation would (programmatic, reported as such), SwiftUI moves its focus to the
            // button on the next turns of the run loop, then a real Space key event goes
            // through the window to the focused button. A disabled button has left the key-view loop.
            guard foreground else { throw fail("The chat window is not the key window of the active app") }
            let target = try button(c["label"] as? String ?? "")
            guard let proxy = target.proxy else { throw fail("\(target.label) is disabled: it has no key-view proxy to focus") }
            let focused = window.makeFirstResponder(proxy) && window.firstResponder === proxy
            guard focused else {
                throw fail("Keyboard focus did not reach \(target.label) (keyboard navigation \(NSApp.isFullKeyboardAccessEnabled ? "on" : "off"); the check never changes it)")
            }
            try await Task.sleep(nanoseconds: 250_000_000)
            let events = NativeChat.recoverySpace(in: window)
            guard events.count == 2 else { throw fail("Key events unavailable") }
            for event in events { NSApp.postEvent(event, atStart: false) }
            return ["input": "keyboard", "focus": "makeFirstResponder on the button's key-view proxy (programmatic, not input)",
                    "route": "Space keyDown+keyUp queued on NSApp for the chat window", "label": target.label,
                    "disabled": target.disabled, "keyboardNavigation": NSApp.isFullKeyboardAccessEnabled]
        case "blur":
            // After a keyboard step: give focus back to the window so later clicks start clean.
            _ = window.makeFirstResponder(nil)
            return state()
        default:
            throw fail("Unknown chat recovery acceptance step")
        }
    }
}
