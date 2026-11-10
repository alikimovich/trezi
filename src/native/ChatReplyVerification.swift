import AppKit

/// LKM-555 verification (test profile): in the real conversation, select `select` in a
/// message's text view as a drag ends, read the Reply button and the text view's own context
/// menu, Copy the selection into a private pasteboard, optionally capture the chat with the
/// button showing, and optionally press Reply with a real click (window-targeted mouse events at its centre, LKM-627).
extension Host {
    @MainActor
    func verifyChatReply(_ c: [String: Any]) async throws -> [String: Any] {
        func fail(_ reason: String) -> NSError { NSError(domain: "ChatReply", code: 1, userInfo: [NSLocalizedDescriptionKey: reason]) }
        if c["sent"] as? Bool == true { return try await sentReply(capture: c["capture"] as? Bool ?? true) }
        let view = try await chatTextView(c["message"] as? String ?? "")
        let wanted = c["select"] as? String ?? ""
        let range = (view.string as NSString).range(of: wanted)
        guard !wanted.isEmpty, range.location != NSNotFound else { throw fail("\"\(wanted)\" is not in the message") }
        guard window.makeFirstResponder(view) else { throw fail("The text view refused first responder") }
        // A drag ends with a settled (not still selecting) selection.
        view.setSelectedRanges([NSValue(range: range)], affinity: .downstream, stillSelecting: false)
        view.layoutSubtreeIfNeeded(); view.displayIfNeeded()
        let excerpt = view.selectionText
        let button = view.replyButton
        let visible = button.map { !$0.isHidden && $0.superview != nil } ?? false
        let geometry = replyGeometry(view, button)
        // The text view's own menu for a right click inside the selection (a right click on an
        // unselected word selects that word, as AppKit does).
        guard let manager = view.layoutManager, let container = view.textContainer else { throw fail("No layout") }
        let glyph = manager.boundingRect(forGlyphRange: manager.glyphRange(forCharacterRange: NSRange(location: range.location + range.length / 2, length: 1), actualCharacterRange: nil), in: container)
        let inside = NSPoint(x: glyph.midX + view.textContainerOrigin.x, y: glyph.midY + view.textContainerOrigin.y)
        let event = NSEvent.mouseEvent(with: .rightMouseDown, location: view.convert(inside, to: nil),
                                       modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                       context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
        let menu = event.flatMap { view.menu(for: $0) }
        let titles = (menu?.items ?? []).map { $0.isSeparatorItem ? "-" : $0.title }
        // Copy still copies the selection (into a private pasteboard).
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("trezi.chat-reply.\(UUID().uuidString)"))
        defer { pasteboard.releaseGlobally(); ChatTextView.pasteboard = .general }
        ChatTextView.pasteboard = pasteboard
        // Sent to the view itself: a window that is not key (a background run) has no chain to it.
        NSApp.sendAction(#selector(NSText.copy(_:)), to: view, from: nil)
        let copied = pasteboard.string(forType: .string) ?? ""
        var result: [String: Any] = geometry.merging(["excerpt":excerpt, "buttonVisible":visible, "buttonTitle":button?.title ?? "",
                                                      "menu":titles, "copied":copied, "identity":view.identity ?? ""]) { $1 }
        if c["capture"] as? Bool == true {
            try await Task.sleep(nanoseconds: 150_000_000)
            let reading = NSRect(x: 0, y: 0, width: chat.bounds.width, height: max(1, chat.bounds.height - chat.model.bottomInset))
            let captured = try await captureVisibleRegion(window: window, view: chat, region: reading, recognize: false)
            result["png"] = captured["png"] ?? ""
        }
        if c["menuReply"] as? Bool == true {
            // Reply chosen from the context menu, as AppKit performs a menu item.
            guard let item = menu?.items.first, item.title == "Reply", let action = item.action else { throw fail("No Reply in the menu") }
            NSApp.sendAction(action, to: item.target, from: item)
            result["selectionAfter"] = view.selectedRange().length
        } else if c["click"] as? Bool == true {
            guard let button, visible else { throw fail("No Reply button to press") }
            // A real click: a press and release at the button's centre posted to the window,
            // which hit-tests and runs the button's own tracking loop.
            let center = button.convert(NSPoint(x: button.bounds.midX, y: button.bounds.midY), to: nil)
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                guard let event = NSEvent.mouseEvent(with: type, location: center, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                     windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1) else { throw fail("Cannot create \(type)") }
                NSApp.postEvent(event, atStart: false)
            }
            // Until the click has been handled (the selection clears), at most 3 s.
            for _ in 0..<150 where view.selectedRange().length > 0 { try await Task.sleep(nanoseconds: 20_000_000) }
            result["selectionAfter"] = view.selectedRange().length
            result["buttonHiddenAfter"] = button.isHidden
        }
        return result
    }

    /// LKM-627: where Reply is against the transcript, in the chat's top-down space: the reading
    /// area, the selection, every line of text in sight, whether it covers any of them, and what
    /// the window hit-tests at its centre.
    @MainActor
    private func replyGeometry(_ view: ChatTextView, _ button: ChatReplyButton?) -> [String: Any] {
        guard let button, let parent = button.superview else { return ["buttonHost":"none"] }
        func topDown(_ rect: NSRect) -> NSRect { chat.isFlipped ? rect : NSRect(x: rect.minX, y: chat.bounds.height - rect.maxY, width: rect.width, height: rect.height) }
        let frame = topDown(chat.convert(button.frame, from: parent))
        let selection = view.selectionLineRects().map { topDown(chat.convert($0, from: view)) }
        var lines: [NSRect] = []
        for case let other as ChatTextView in ChatTextView.live.objectEnumerator() ?? NSEnumerator() where other.window === window && other.isDescendant(of: chat) {
            lines += other.textLineRects().map { topDown(chat.convert($0, from: other)) }
        }
        let others = chat.replyObstacles(excluding: view.replySource?.message ?? "")
        let center = button.convert(NSPoint(x: button.bounds.midX, y: button.bounds.midY), to: nil)
        let hit = window.contentView.flatMap { $0.hitTest($0.superview?.convert(center, from: nil) ?? center) }
        return ["buttonHost": parent === view ? "text" : parent === chat.superview ? "chat-overlay" : String(describing: type(of: parent)),
                "buttonFrame": NSStringFromRect(frame), "readingArea": NSStringFromRect(chat.replyArea),
                "buttonInside": chat.replyArea.contains(frame), "selectionLines": selection.map(NSStringFromRect),
                "coversSelection": selection.filter { $0.intersects(frame) }.map(NSStringFromRect),
                "coversText": lines.filter { $0.intersects(frame) }.map(NSStringFromRect),
                "coversMessages": others.filter { $0.intersects(frame) }.map(NSStringFromRect),
                "hitIsButton": hit === button || hit?.isDescendant(of: button) == true,
                "hit": hit.map { String(describing: type(of: $0)) } ?? "none"]
    }

    /// The latest user bubble as decoded (its quotes) and a capture of it in view.
    @MainActor
    private func sentReply(capture: Bool) async throws -> [String: Any] {
        chat.model.pressLatest()
        try await Task.sleep(nanoseconds: 400_000_000)
        let bubble = chat.model.snapshot?.messages.last { $0.role == "user" }
        let quotes = (bubble?.quotes ?? []).map { ["excerpt":$0.excerpt, "comment":$0.comment] }
        var result: [String: Any] = ["text":bubble?.text ?? "", "quotes":quotes]
        if capture {
            let reading = NSRect(x: 0, y: 0, width: chat.bounds.width, height: max(1, chat.bounds.height - chat.model.bottomInset))
            result["png"] = try await captureVisibleRegion(window: window, view: chat, region: reading, recognize: false)["png"] ?? ""
        }
        return result
    }
}
