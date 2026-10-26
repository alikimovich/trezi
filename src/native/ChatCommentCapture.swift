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
        // Read live: the composer's height can still change while the rows settle.
        func readingArea() -> NSRect { NSRect(x: 0, y: 0, width: chat.bounds.width, height: max(1, chat.bounds.height - chat.model.bottomInset)) }
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
        func inView() -> Bool {
            let frame = chat.model.messageFrames[user] ?? .zero, area = readingArea()
            return frame != .zero && frame.minY >= 0 && frame.maxY <= area.height
        }
        // Only the capture that samples the bubble needs it in view; expanded rows can scroll it away.
        let needsBubble = c["bubble"] as? Bool == true
        if needsBubble, !inView(), let scroll = chat.conversationScroll, let document = scroll.documentView {
            // Stop following the latest message first, as scrolling by hand does (the chat ends
            // its follow when a control is used), or the pin returns the bubble to where it was.
            chat.model.controlInteraction += 1
            try await Task.sleep(nanoseconds: 200_000_000)
            let clip = scroll.contentView
            var target = clip.bounds
            let shift = (chat.model.messageFrames[user] ?? .zero).minY - 12
            target.origin.y += document.isFlipped ? shift : -shift
            clip.scroll(to: NSPoint(x: clip.bounds.minX, y: clip.constrainBoundsRect(target).origin.y))
            scroll.reflectScrolledClipView(clip)
            try await settle()
        }
        chat.layoutSubtreeIfNeeded(); window.contentView?.displayIfNeeded()
        try await Task.sleep(nanoseconds: 200_000_000)
        // Measured after the last settle, so the rows and the bubble are judged against the
        // composer clearance the capture really has.
        let reading = readingArea()
        guard !needsBubble || inView() else {
            throw NSError(domain: "CommentRows", code: 2, userInfo: [NSLocalizedDescriptionKey:
                "The reference bubble is outside the reading area: frame \(NSStringFromRect(chat.model.messageFrames[user] ?? .zero)), reading height \(reading.height)"])
        }
        let captured = try await captureVisibleRegion(window: window, view: chat, region: reading, recognize: false)
        // LKM-334: colours come from the window's own rendering, which maps exactly onto the
        // frames; the capture showed rows at x 8–389 for frames at 18–422. It stays the evidence.
        let bitmap = try renderRegion(window: window, view: chat, region: reading)
        // Frames are in the conversation's top-left space, which the rendering starts at.
        let scale = CGFloat(bitmap.pixelsWide) / reading.width
        func sample(_ x: CGFloat, _ y: CGFloat) -> [Double] {
            let px = Int(x * scale), py = Int(y * scale)
            guard px >= 0, py >= 0, px < bitmap.pixelsWide, py < bitmap.pixelsHigh,
                  let color = bitmap.colorAt(x: px, y: py)?.usingColorSpace(.sRGB) else { return [] }
            return [color.redComponent, color.greenComponent, color.blueComponent].map { Double(($0 * 255).rounded()) }
        }
        // LKM-351: SwiftUI can keep every row's frame from an earlier offset after the AppKit pin
        // (the bubble read 74 pt where the identical rendering of a passing run drew it at ~155),
        // while the end marker is current. One pass reported them all, so they share one shift.
        // Only when the frames would sample nothing, find the shift that puts each row's fill and
        // the gap above it, and the bubble beside the chat background, on the rendering.
        let reported = (ids + [user]).compactMap { id in chat.model.messageFrames[id].map { (id, $0) } }
        let frames = Dictionary(reported, uniquingKeysWith: { $1 })
        func differs(_ a: [Double], _ b: [Double]) -> Double { a.isEmpty || b.isEmpty ? 0 : zip(a, b).map { abs($0 - $1) }.max() ?? 0 }
        func filled(_ x: CGFloat, _ y: CGFloat) -> Bool { differs(sample(x, y), sample(5, y)) >= 2 }
        func blank(_ d: CGFloat) -> Bool {
            let bubble = frames[user].map { $0.offsetBy(dx: 0, dy: d) }
            if needsBubble, let bubble, differs(sample(bubble.maxX - 5, bubble.midY), sample(bubble.minX + 5, bubble.midY)) == 0 { return true }
            return ids.contains { id in
                guard let f = frames[id]?.offsetBy(dx: 0, dy: d) else { return false }
                return differs(sample(f.minX + 5, f.midY), sample(f.minX + 5, f.minY - 10)) < 2
            }
        }
        func aligned(_ d: CGFloat) -> Bool {
            guard let bubble = frames[user]?.offsetBy(dx: 0, dy: d) else { return false }
            let rowsFit = ids.allSatisfy { id in
                guard let f = frames[id]?.offsetBy(dx: 0, dy: d) else { return false }
                return [f.minX + 5, f.maxX - 5].allSatisfy { filled($0, f.midY) && !filled($0, f.minY - 10) }
            }
            return rowsFit && (!needsBubble || filled(bubble.maxX - 5, bubble.midY) && !filled(bubble.minX + 5, bubble.midY))
        }
        // The shifts that fit form one band (26 pt wide on the failing run's rendering); its middle
        // samples clear of the rounded corners its edges reach.
        var shift: CGFloat = 0
        if blank(0), let first = (1...300).lazy.flatMap({ [CGFloat($0), -CGFloat($0)] }).first(where: aligned) {
            let step: CGFloat = first > 0 ? 1 : -1
            var last = first
            while abs(last + step) <= 300, aligned(last + step) { last += step }
            shift = ((first + last) / 2).rounded()
        }
        func shifted(_ id: String) -> CGRect { frames[id]?.offsetBy(dx: 0, dy: shift) ?? .zero }
        let rows = ids.map { id -> [String: Any] in
            let frame = shifted(id)
            return ["id": id, "frame": NSStringFromRect(frame), "expanded": chat.model.expandedComments.contains(id),
                    "fill": sample(frame.minX + 5, frame.midY), "background": sample(frame.minX + 5, frame.minY - 10)]
        }
        // The user bubble trails its row: its fill at the right edge, background at the left.
        let bubble = shifted(user)
        return ["png": captured["png"] ?? "", "sampled": bitmap.representation(using: .png, properties: [:])?.base64EncodedString() ?? "",
                "capture": captured["geometry"] ?? [:], "appearance": window.effectiveAppearance.name.rawValue,
                "readingHeight": Double(reading.height), "rows": rows, "userFrame": NSStringFromRect(bubble),
                "frameShift": Double(shift), "reportedUserFrame": NSStringFromRect(frames[user] ?? .zero),
                "user": sample(bubble.maxX - 5, bubble.midY), "userBackground": sample(bubble.minX + 5, bubble.midY)]
    }
}
