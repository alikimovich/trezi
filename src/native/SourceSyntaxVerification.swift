import AppKit

/// Test-profile hooks for grammar highlighting (LKM-183): the category shown at probe
/// texts, timed typing, and the code captured in light and dark.
extension NativeSourceEditor {
    /// The category at the first character of each probe's first occurrence.
    func inspectSyntax(_ probes: [String]) -> [String: Any] {
        let text = code.string as NSString
        var categories: [String: Any] = [:]
        for probe in probes {
            let range = text.range(of: probe)
            guard range.location != NSNotFound, let storage = code.textStorage else { categories[probe] = NSNull(); continue }
            let value = storage.attribute(SourceSyntaxTheme.attribute, at: range.location, effectiveRange: nil) as? Int ?? 0
            categories[probe] = (SourceSyntaxCategory(rawValue: value) ?? .plain).name
        }
        return ["revision": revision, "highlighted": highlighted, "length": text.length, "categories": categories]
    }
    /// Types `text` a character at a time after the first `after`, at a typing pace, and
    /// returns each keystroke's main-thread time in ms: the insertion with its layout and
    /// display, plus the state update and highlight its revision brought back.
    @MainActor func typeSyntax(_ text: String, after: String, pace: Double) async -> [String: Any] {
        let anchor = (code.string as NSString).range(of: after)
        guard anchor.location != NSNotFound, let window else { return ["error": "No \(after) in the editor"] }
        window.makeFirstResponder(code)
        code.setSelectedRange(NSRange(location: NSMaxRange(anchor), length: 0))
        var costs: [Int: CFTimeInterval] = [:], revisions: [Int] = []
        let previous = measure
        measure = { _, revision, time in costs[revision, default: 0] += time }
        defer { measure = previous }
        for character in text {
            let started = CACurrentMediaTime()
            code.insertText(String(character), replacementRange: code.selectedRange())
            window.displayIfNeeded()
            costs[revision, default: 0] += CACurrentMediaTime() - started
            revisions.append(revision)
            try? await Task.sleep(nanoseconds: UInt64(pace * 1_000_000_000))
        }
        let deadline = CACurrentMediaTime() + 5
        while highlighted < revision && CACurrentMediaTime() < deadline { try? await Task.sleep(nanoseconds: 20_000_000) }
        return ["keystrokes": revisions.map { (costs[$0] ?? 0) * 1000 }, "highlighted": highlighted, "revision": revision]
    }
    /// The code area in one appearance; the window's own appearance is restored after.
    @MainActor func captureSyntax(dark: Bool, offscreen: Bool) async throws -> [String: Any] {
        guard let window else { throw NSError(domain: "SourceEditor", code: 1, userInfo: [NSLocalizedDescriptionKey: "Source editor has no window"]) }
        let previous = window.appearance
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        defer { window.appearance = previous }
        layoutSubtreeIfNeeded(); window.displayIfNeeded()
        try await Task.sleep(nanoseconds: 300_000_000)
        guard offscreen else { return try await captureVisibleRegion(window: window, view: scroll, region: scroll.bounds, recognize: false) }
        guard let bitmap = scroll.bitmapImageRepForCachingDisplay(in: scroll.bounds) else { throw NSError(domain: "SourceEditor", code: 2, userInfo: [NSLocalizedDescriptionKey: "No bitmap for the code"]) }
        scroll.cacheDisplay(in: scroll.bounds, to: bitmap)
        return ["png": bitmap.representation(using: .png, properties: [:])?.base64EncodedString() ?? "", "width": bitmap.pixelsWide, "height": bitmap.pixelsHigh]
    }
}
