import AppKit

/// LKM-431 verification (test profile): real pointer input on a chat message. Each step
/// queues window-targeted events on the app, so NSApplication, NSWindow hit-testing and
/// NSTextView's tracking loop handle them as a click (no CGEvent, nothing posted to the
/// system, the cursor stays put), at the glyphs' own geometry. Copies land on a private
/// pasteboard, kept until `restore`, that holds a sentinel before each step.
extension Host {
    @MainActor
    func verifyChatPointer(_ view: ChatTextView, _ c: [String: Any]) async throws -> [String: Any] {
        func fail(_ reason: String) -> NSError { NSError(domain: "ChatClick", code: 1, userInfo: [NSLocalizedDescriptionKey: reason]) }
        let action = c["pointer"] as? String ?? ""
        if ChatTextView.pasteboard.name == NSPasteboard.general.name {
            ChatTextView.pasteboard = NSPasteboard(name: NSPasteboard.Name("trezi.chat-click.\(UUID().uuidString)"))
        }
        let board = ChatTextView.pasteboard
        func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
        func toasts() -> [ChatCopiedToast] { window.contentView.map(descendants)?.compactMap { $0 as? ChatCopiedToast } ?? [] }
        if action == "dismiss" {
            for _ in 0..<60 where !toasts().isEmpty { try await Task.sleep(nanoseconds: 50_000_000) }
            return ["dismissed": toasts().isEmpty]
        }
        guard let manager = view.layoutManager, let container = view.textContainer else { throw fail("No layout") }
        /// Per line the glyphs' box and, for a click, the band of their x-height on the
        /// baseline: where a pointer lands on visible letters, whatever the line spacing.
        func lines(_ range: NSRange) -> [(box: NSRect, body: NSRect)] {
            var rects: [(NSRect, NSRect)] = []
            let glyphs = manager.glyphRange(forCharacterRange: range, actualCharacterRange: nil), origin = view.textContainerOrigin
            manager.enumerateLineFragments(forGlyphRange: glyphs) { line, _, _, lineGlyphs, _ in
                let part = NSIntersectionRange(glyphs, lineGlyphs)
                let box = manager.boundingRect(forGlyphRange: part, in: container).offsetBy(dx: origin.x, dy: origin.y)
                let font = view.textStorage?.attribute(.font, at: manager.characterIndexForGlyph(at: part.location), effectiveRange: nil) as? NSFont
                let baseline = line.minY + manager.location(forGlyphAt: part.location).y + origin.y
                let height = font?.xHeight ?? box.height / 2
                rects.append((box, NSRect(x: box.minX, y: baseline - height, width: box.width, height: height)))
            }
            return rects
        }
        let text = view.string as NSString
        func spot(_ find: String, line: Int = 0, kind: String = "") throws -> NSPoint {
            let range = text.range(of: find)
            guard range.location != NSNotFound else { throw fail("No \(find) in the message") }
            let all = lines(range)
            guard all.indices.contains(line) else { throw fail("\(find) has \(all.count) lines, not \(line + 1)") }
            let (box, body) = all[line]
            switch kind {
            case "end": return NSPoint(x: view.bounds.maxX - 6, y: body.midY)
            case "gap": return NSPoint(x: view.bounds.midX, y: box.minY - 5)
            default: return NSPoint(x: body.midX, y: body.midY)
            }
        }
        let at = view.convert(try spot(c["find"] as? String ?? "", line: c["line"] as? Int ?? 0, kind: c["spot"] as? String ?? ""), to: nil)
        guard let content = window.contentView, let hit = content.hitTest(content.superview?.convert(at, from: nil) ?? at) else { throw fail("Nothing at the click") }

        func event(_ type: NSEvent.EventType, _ point: NSPoint, clicks: Int = 1) throws -> NSEvent {
            guard let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                 windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: clicks, pressure: type == .leftMouseUp ? 0 : 1) else {
                throw fail("Cannot create \(type)")
            }
            return event
        }
        view.setSelectedRange(NSRange(location: 0, length: 0))
        board.clearContents(); board.setString("not copied", forType: .string)
        // A link is verified on its route: this handler replaces the real editor opening.
        var routed: [String] = []
        let keptLink = view.onLink, keptWeb = ChatTextView.appKitLinks, keptLifetime = ChatCopiedToast.lifetime
        view.onLink = { routed.append($0) }
        // Copied must outlast a capture, which takes about as long as Copied itself, and a
        // repeat that waits out the user's double-click interval (`hold`).
        if c["capture"] as? Bool == true || c["hold"] as? Bool == true { ChatCopiedToast.lifetime = 8 }
        defer { view.onLink = keptLink; ChatCopiedToast.lifetime = keptLifetime }
        let shownBefore = ChatCopiedToast.shown
        // LKM-442: the move goes to the view's own handler (its tracking area's owner), as
        // AppKit would deliver it; the cursor is read back, nothing on screen moves.
        if action == "hover" {
            let responder = window.firstResponder
            view.mouseMoved(with: try event(.mouseMoved, at))
            return ["pointing": NSCursor.current == NSCursor.pointingHand, "hovered": view.hovered != nil, "shownMore": ChatCopiedToast.shown - shownBefore,
                    "pasteboard": board.string(forType: .string) ?? NSNull(), "point": NSStringFromPoint(at), "hit": String(describing: type(of: hit)),
                    "focusKept": window.firstResponder === responder]
        }
        var events: [NSEvent] = []
        switch action {
        case "click": events = [try event(.leftMouseDown, at), try event(.leftMouseUp, at)]
        case "double":
            events = [try event(.leftMouseDown, at), try event(.leftMouseUp, at), try event(.leftMouseDown, at, clicks: 2), try event(.leftMouseUp, at, clicks: 2)]
        case "drag":
            let end = view.convert(try spot(c["to"] as? String ?? ""), to: nil)
            events = [try event(.leftMouseDown, at)]
            for step in 1...4 {
                let share = CGFloat(step) / 4
                events.append(try event(.leftMouseDragged, NSPoint(x: at.x + (end.x - at.x) * share, y: at.y + (end.y - at.y) * share)))
            }
            events.append(try event(.leftMouseUp, end))
        default: throw fail("Unknown pointer action \(action)")
        }
        for event in events { NSApp.postEvent(event, atStart: false) }
        try await Task.sleep(nanoseconds: 150_000_000)
        for _ in 0..<100 where view.clickTimer != nil { try await Task.sleep(nanoseconds: 30_000_000) }
        try await Task.sleep(nanoseconds: 30_000_000)

        var result: [String: Any] = ["pasteboard": board.string(forType: .string) ?? NSNull(), "hit": String(describing: type(of: hit)),
                                     "point": NSStringFromPoint(at), "routed": routed, "appKitLinks": ChatTextView.appKitLinks - keptWeb,
                                     "frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0, "pid": ProcessInfo.processInfo.processIdentifier,
                                     "selected": text.substring(with: view.selectedRange()), "firstResponder": window.firstResponder === view]
        let shown = toasts()
        result["toasts"] = shown.count
        result["shownMore"] = ChatCopiedToast.shown - shownBefore
        if let toast = shown.first, let parent = toast.superview {
            result["toast"] = NSStringFromRect(parent.convert(toast.frame, to: nil))
            result["toastText"] = toast.accessibilityLabel() ?? NSNull()
            result["visible"] = NSStringFromRect(window.contentLayoutRect)
        }
        if c["copy"] as? Bool == true {
            NSApp.sendAction(#selector(NSText.copy(_:)), to: nil, from: nil)
            result["copied"] = board.string(forType: .string) ?? NSNull()
        }
        if c["capture"] as? Bool == true {
            let reading = NSRect(x: 0, y: 0, width: chat.bounds.width, height: max(1, chat.bounds.height - chat.model.bottomInset))
            result["png"] = try await captureVisibleRegion(window: window, view: chat, region: reading, recognize: false)["png"] ?? ""
            result["toastInCapture"] = !toasts().isEmpty
            // The window's own rendering, as the code background sample in `verifyChatText`.
            let bitmap = try renderRegion(window: window, view: chat, region: reading)
            let scale = CGFloat(bitmap.pixelsWide) / reading.width
            func sample(_ point: NSPoint) -> [Double] {
                let inChat = view.convert(point, to: chat)
                let px = Int(inChat.x * scale), py = Int((chat.isFlipped ? inChat.y : chat.bounds.height - inChat.y) * scale)
                guard px >= 0, py >= 0, px < bitmap.pixelsWide, py < bitmap.pixelsHigh,
                      let color = bitmap.colorAt(x: px, y: py)?.usingColorSpace(.sRGB) else { return [] }
                return [color.redComponent, color.greenComponent, color.blueComponent].map { Double(($0 * 255).rounded()) }
            }
            guard let inline = view.rich.snippets.first(where: { !$0.block }), let chip = view.inlineFrames(inline).first else { throw fail("No inline code in the message") }
            result["chipFrame"] = NSStringFromRect(chip)
            result["chipFill"] = sample(NSPoint(x: chip.minX + 1, y: chip.midY))
            result["chipBackground"] = sample(NSPoint(x: chip.midX, y: chip.minY - 1))
            if let block = view.blockFrames().first(where: { $0.block.kind == .code }) {
                result["codeFill"] = sample(NSPoint(x: block.frame.minX + 4, y: block.frame.minY + 4))
                result["background"] = sample(NSPoint(x: block.frame.minX + 4, y: block.frame.minY - 3))
            }
        }
        return result
    }
}
