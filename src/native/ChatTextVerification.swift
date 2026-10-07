import AppKit

/// LKM-186 verification (test profile): in the real conversation, select one assistant
/// message from its first paragraph to its last code block by point, as a drag ends,
/// copy it with the Copy menu action (into a private pasteboard), Select All through the
/// responder chain and capture the foreground chat in a forced window appearance.
extension Host {
    @MainActor
    func verifyChatText(_ c: [String: Any]) async throws -> [String: Any] {
        func fail(_ reason: String) -> NSError { NSError(domain: "ChatText", code: 1, userInfo: [NSLocalizedDescriptionKey: reason]) }
        if c["restore"] as? Bool == true {
            window.appearance = nil; ChatTextView.pasteboard = .general
            window.makeFirstResponder(nil)
            return [:]
        }
        if let dark = c["dark"] as? Bool { window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua) }
        let message = c["message"] as? String ?? ""
        chat.model.pressLatest()
        var view: ChatTextView?, last = CGRect.null
        for _ in 0..<60 {
            try await Task.sleep(nanoseconds: 50_000_000)
            view = ChatTextView.live.object(forKey: "\(message)#0" as NSString)
            let frame = chat.model.messageFrames[message] ?? .null
            if let view, view.window != nil, view.bounds.height > 0, frame == last { break }
            last = frame
        }
        guard let view, view.window != nil else { throw fail("The message's text view is not on screen") }
        let views = (ChatTextView.live.keyEnumerator().allObjects as? [String] ?? []).filter { $0.hasPrefix(message + "#") }.count
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("trezi.chat-text.\(UUID().uuidString)"))
        defer { pasteboard.releaseGlobally(); ChatTextView.pasteboard = .general }
        ChatTextView.pasteboard = pasteboard
        guard window.makeFirstResponder(view) else { throw fail("The text view refused first responder") }

        // Where a drag from the first paragraph to past the end of the last code block lands.
        let text = view.string as NSString
        guard let manager = view.layoutManager, let container = view.textContainer,
              let code = view.rich.blocks.last(where: { $0.kind == .code }) else { throw fail("No code block in the message") }
        func glyphs(_ range: NSRange) -> NSRect {
            manager.boundingRect(forGlyphRange: manager.glyphRange(forCharacterRange: range, actualCharacterRange: nil), in: container)
        }
        let start = glyphs(NSRange(location: 0, length: 1)), end = glyphs(NSRange(location: code.range.upperBound - 1, length: 1))
        let from = view.characterIndexForInsertion(at: NSPoint(x: start.minX + 1, y: start.midY))
        let to = view.characterIndexForInsertion(at: NSPoint(x: end.maxX + 20, y: end.midY))
        view.setSelectedRange(NSRange(location: from, length: max(0, to - from)))
        let selected = text.substring(with: view.selectedRange())
        NSApp.sendAction(#selector(NSText.copy(_:)), to: nil, from: nil)
        let copied = pasteboard.string(forType: .string)

        // The selection shows in the capture; geometry for the code background sample.
        view.displayIfNeeded()
        let reading = NSRect(x: 0, y: 0, width: chat.bounds.width, height: max(1, chat.bounds.height - chat.model.bottomInset))
        let captured = try await captureVisibleRegion(window: window, view: chat, region: reading, recognize: false)
        guard let data = Data(base64Encoded: captured["png"] as? String ?? ""), let bitmap = NSBitmapImageRep(data: data) else { throw fail("Capture unreadable") }
        func top(_ rect: NSRect) -> NSRect {
            let inChat = view.convert(rect, to: chat)
            return chat.isFlipped ? inChat : NSRect(x: inChat.minX, y: chat.bounds.height - inChat.maxY, width: inChat.width, height: inChat.height)
        }
        let scale = CGFloat(bitmap.pixelsWide) / reading.width
        func sample(_ x: CGFloat, _ y: CGFloat) -> [Double] {
            let px = Int(x * scale), py = Int(y * scale)
            guard px >= 0, py >= 0, px < bitmap.pixelsWide, py < bitmap.pixelsHigh,
                  let color = bitmap.colorAt(x: px, y: py)?.usingColorSpace(.sRGB) else { return [] }
            return [color.redComponent, color.greenComponent, color.blueComponent].map { Double(($0 * 255).rounded()) }
        }
        let frames = view.blockFrames()
        let codeFrame = top(frames.last(where: { $0.block.kind == .code })?.frame ?? .zero)
        let textFrame = top(view.bounds)

        // Select All through the responder chain (the menu's action), then copy again.
        view.setSelectedRange(NSRange(location: 0, length: 0))
        NSApp.sendAction(#selector(NSText.selectAll(_:)), to: nil, from: nil)
        let all = view.selectedRange()
        NSApp.sendAction(#selector(NSText.copy(_:)), to: nil, from: nil)
        let copiedAll = pasteboard.string(forType: .string)
        view.copyButtons.last?.performClick(nil)
        let copiedCode = pasteboard.string(forType: .string)
        var links: [String] = []
        view.textStorage?.enumerateAttribute(.link, in: NSRange(location: 0, length: text.length)) { value, _, _ in
            if let url = value as? URL { links.append(url.absoluteString) } else if let url = value as? String { links.append(url) }
        }
        let firstResponder = window.firstResponder === view
        view.setSelectedRange(NSRange(location: 0, length: 0))
        return ["png": captured["png"] ?? "", "appearance": window.effectiveAppearance.name.rawValue, "views": views,
                "length": text.length, "from": from, "to": to, "selected": selected, "copied": copied ?? NSNull(),
                "selectAll": NSStringFromRange(all), "copiedAll": copiedAll ?? NSNull(), "copiedCode": copiedCode ?? NSNull(),
                "codeText": view.code(at: view.copyButtons.count - 1) ?? "", "copyButtons": view.copyButtons.count,
                "codeBlocks": view.rich.blocks.filter { $0.kind == .code }.count, "links": links, "firstResponder": firstResponder,
                "blockKinds": view.rich.blocks.map(\.kind.rawValue), "textFrame": NSStringFromRect(textFrame), "codeFrame": NSStringFromRect(codeFrame),
                "readingHeight": Double(reading.height),
                "codeFill": sample(codeFrame.minX + 4, codeFrame.minY + 4), "background": sample(codeFrame.minX + 4, codeFrame.minY - 6)]
    }
}
