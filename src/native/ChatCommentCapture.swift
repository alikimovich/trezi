import AppKit

/// LKM-178 verification (test profile): comment result rows in a forced light or dark
/// window appearance, expanded or collapsed through the toggle a click uses, captured in
/// the foreground. Each row's fill is sampled beside the chat background, as is the user
/// bubble's. The appearance is the window's own; system settings are never touched.
extension Host {
    @MainActor
    func verifyCommentRows(_ c: [String: Any]) async throws -> [String: Any] {
        if c["restore"] as? Bool == true {
            window.appearance = nil; chat.model.expandedComments = []
            return [:]
        }
        if let dark = c["dark"] as? Bool { window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua) }
        for id in c["toggle"] as? [String] ?? [] { chat.model.toggleComment(id) }
        let ids = c["messages"] as? [String] ?? [], user = c["user"] as? String ?? ""
        let reading = NSRect(x: 0, y: 0, width: chat.bounds.width, height: max(1, chat.bounds.height - chat.model.bottomInset))
        // Settled: every row is laid out and holds its frame across two samples.
        func settle() async throws {
            var last: [CGRect] = []
            for _ in 0..<60 {
                try await Task.sleep(nanoseconds: 50_000_000)
                let frames = (ids + [user]).map { chat.model.messageFrames[$0] ?? .zero }
                if frames == last && !frames.contains(.zero) { break }
                last = frames
            }
        }
        chat.model.pressLatest()
        try await settle()
        // LKM-331: the reference bubble leads the rows, so what follows them (a setup card, a
        // taller composer) can push it above the reading area, where there is nothing to sample.
        // Bring it into view, then let the new appearance and position paint before the capture.
        let lead = chat.model.messageFrames[user] ?? .zero
        if (lead.minY < 8 || lead.maxY > reading.height), let scroll = chat.conversationScroll, let document = scroll.documentView {
            let clip = scroll.contentView
            var target = clip.bounds
            let shift = lead.minY - 12
            target.origin.y += document.isFlipped ? shift : -shift
            clip.scroll(to: NSPoint(x: clip.bounds.minX, y: clip.constrainBoundsRect(target).origin.y))
            scroll.reflectScrolledClipView(clip)
            try await settle()
        }
        chat.layoutSubtreeIfNeeded(); window.contentView?.displayIfNeeded()
        try await Task.sleep(nanoseconds: 200_000_000)
        let captured = try await captureVisibleRegion(window: window, view: chat, region: reading, recognize: false)
        guard let data = Data(base64Encoded: captured["png"] as? String ?? ""), let bitmap = NSBitmapImageRep(data: data) else {
            throw NSError(domain: "CommentRows", code: 1, userInfo: [NSLocalizedDescriptionKey: "Comment rows capture unreadable"])
        }
        // Frames are in the conversation's top-left space, which the capture starts at.
        let scale = CGFloat(bitmap.pixelsWide) / reading.width
        func sample(_ x: CGFloat, _ y: CGFloat) -> [Double] {
            let px = Int(x * scale), py = Int(y * scale)
            guard px >= 0, py >= 0, px < bitmap.pixelsWide, py < bitmap.pixelsHigh,
                  let color = bitmap.colorAt(x: px, y: py)?.usingColorSpace(.sRGB) else { return [] }
            return [color.redComponent, color.greenComponent, color.blueComponent].map { Double(($0 * 255).rounded()) }
        }
        let rows = ids.map { id -> [String: Any] in
            let frame = chat.model.messageFrames[id] ?? .zero
            return ["id": id, "frame": NSStringFromRect(frame), "expanded": chat.model.expandedComments.contains(id),
                    "fill": sample(frame.minX + 5, frame.midY), "background": sample(frame.minX + 5, frame.minY - 10)]
        }
        // The user bubble trails its row: its fill at the right edge, background at the left.
        let bubble = chat.model.messageFrames[user] ?? .zero
        return ["png": captured["png"] ?? "", "appearance": window.effectiveAppearance.name.rawValue,
                "readingHeight": Double(reading.height), "rows": rows, "userFrame": NSStringFromRect(bubble),
                "user": sample(bubble.maxX - 5, bubble.midY), "userBackground": sample(bubble.minX + 5, bubble.midY)]
    }
}
