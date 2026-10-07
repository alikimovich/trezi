import AppKit

/// Token categories from the Bun highlighter (`src/main/syntax-theme.ts`, same order).
/// Colours follow Xcode's Default (Light) and Default (Dark) themes. They are dynamic,
/// so the editor recolours with the appearance without tokenizing again (LKM-183).
enum SourceSyntaxCategory: Int, CaseIterable {
    case plain, comment, keyword, string, number, regex, type, function, typeDeclaration, declaration
    case property, tag, attribute, preprocessor, constant, embedded, heading, emphasis, strong, link

    var name: String { String(describing: self) }
    var color: NSColor { SourceSyntaxTheme.colors[rawValue] }
    /// Keywords, headings and bold Markdown use a heavier face, as in Xcode.
    var weight: NSFont.Weight? { [.keyword, .heading, .strong].contains(self) ? .semibold : nil }
    var italic: Bool { self == .emphasis }
}

enum SourceSyntaxTheme {
    static let fontSize: CGFloat = 12
    static let attribute = NSAttributedString.Key("TreziSyntaxCategory")
    static let colors: [NSColor] = SourceSyntaxCategory.allCases.map { category in
        guard let (light, dark) = palette[category] else { return .labelColor }
        return NSColor(name: NSColor.Name("TreziSyntax.\(category.name)")) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? rgb(dark) : rgb(light)
        }
    }
    static let palette: [SourceSyntaxCategory: (UInt32, UInt32)] = [
        .comment: (0x5D6C79, 0x6C7986),
        .keyword: (0x9B2393, 0xFC5FA3),
        .string: (0xC41A16, 0xFC6A5D),
        .number: (0x1C00CF, 0xD0BF69),
        .regex: (0xB6301A, 0xFF8170),
        .type: (0x3900A0, 0xD0A8FF),
        .function: (0x6C36A9, 0xA167E6),
        .typeDeclaration: (0x0B4F79, 0x5DD8FF),
        .declaration: (0x0F68A0, 0x41A1C0),
        .property: (0x326D74, 0x67B7A4),
        .tag: (0x0B4F79, 0x5DD8FF),
        .attribute: (0x815F03, 0xBF8555),
        .preprocessor: (0x643820, 0xFD8F3F),
        .constant: (0x1C464A, 0x9EF1DD),
        .embedded: (0x9B2393, 0xFC5FA3),
        .link: (0x0E0EFF, 0x5482FF)
    ]
    static func rgb(_ value: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat(value >> 16 & 0xFF) / 255, green: CGFloat(value >> 8 & 0xFF) / 255, blue: CGFloat(value & 0xFF) / 255, alpha: 1)
    }
    static let regular = NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
    static let fonts: [NSFont] = SourceSyntaxCategory.allCases.map { category in
        var font = category.weight.map { NSFont.monospacedSystemFont(ofSize: fontSize, weight: $0) } ?? regular
        if category.italic { font = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask) }
        return font
    }
    static let plain: [NSAttributedString.Key: Any] = [.foregroundColor: NSColor.labelColor, .font: regular, attribute: 0]
}

extension NativeSourceEditor {
    /// Applies a highlight message only while its revision of this document is the one
    /// on screen; otherwise it is dropped and the backend is told, so the lines it
    /// carried are sent again for the current revision. Marked (IME) text is left alone.
    func applyHighlight(_ value: [String: Any]) {
        let started = CACurrentMediaTime(), messageRevision = value["revision"] as? Int ?? -1
        guard value["root"] as? String == root, value["source"] as? String == source else { return }
        guard messageRevision == revision, let storage = code.textStorage else { send("highlight", ["dropped": messageRevision]); return }
        let spans = value["spans"] as? [Int] ?? [], runs = value["runs"] as? [Int] ?? [], length = storage.length
        let marked = code.hasMarkedText() ? code.markedRange() : NSRange(location: NSNotFound, length: 0)
        let apply = { (range: NSRange, body: (NSRange) -> Void) in
            guard range.location >= 0, range.length > 0, NSMaxRange(range) <= length else { return }
            guard marked.location != NSNotFound, NSIntersectionRange(range, marked).length > 0 else { body(range); return }
            if marked.location > range.location { body(NSRange(location: range.location, length: marked.location - range.location)) }
            if NSMaxRange(range) > NSMaxRange(marked) { body(NSRange(location: NSMaxRange(marked), length: NSMaxRange(range) - NSMaxRange(marked))) }
        }
        storage.beginEditing()
        var index = 0
        while index + 1 < spans.count { apply(NSRange(location: spans[index], length: spans[index + 1])) { storage.addAttributes(SourceSyntaxTheme.plain, range: $0) }; index += 2 }
        index = 0
        while index + 2 < runs.count {
            if let category = SourceSyntaxCategory(rawValue: runs[index + 2]) {
                apply(NSRange(location: runs[index], length: runs[index + 1])) { range in
                    storage.addAttributes([.foregroundColor: category.color, SourceSyntaxTheme.attribute: category.rawValue], range: range)
                    if category.weight != nil || category.italic { storage.addAttribute(.font, value: SourceSyntaxTheme.fonts[category.rawValue], range: range) }
                }
            }
            index += 3
        }
        storage.endEditing()
        highlighted = messageRevision
        measure?("highlight", messageRevision, CACurrentMediaTime() - started)
    }
    /// Resets a replaced text to the plain style and tells the backend that nothing it
    /// sent before `revision` is shown.
    func resetHighlight(_ revision: Int) {
        guard let storage = code.textStorage else { return }
        storage.beginEditing(); storage.addAttributes(SourceSyntaxTheme.plain, range: NSRange(location: 0, length: storage.length)); storage.endEditing()
        code.typingAttributes = SourceSyntaxTheme.plain
        reportViewport(reset: revision)
    }
    /// The visible lines (0-based) go to the backend, which highlights them first.
    func reportViewport(reset: Int? = nil) {
        viewportWork?.cancel(); viewportWork = nil
        guard !source.isEmpty, let manager = code.layoutManager, let container = code.textContainer else { return }
        let text = (code.textStorage?.string ?? "") as NSString
        let glyphs = manager.glyphRange(forBoundingRect: code.visibleRect, in: container)
        let characters = manager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
        let first = SourceSyntaxTheme.lines(in: text, before: min(characters.location, text.length))
        let last = first + SourceSyntaxTheme.lines(in: text, range: NSIntersectionRange(characters, NSRange(location: 0, length: text.length)))
        guard reset != nil || viewport != [first, last] else { return }
        viewport = [first, last]
        var report: [String: Any] = ["first": first, "last": last]
        if let reset { report["reset"] = true; report["revision"] = reset }
        send("highlight", report)
    }
    func scheduleViewport() {
        guard viewportWork == nil else { return }
        let work = DispatchWorkItem { [weak self] in self?.viewportWork = nil; self?.reportViewport() }
        viewportWork = work; DispatchQueue.main.asyncAfter(deadline: .now() + 0.06, execute: work)
    }
}

extension SourceSyntaxTheme {
    static let newline = try? NSRegularExpression(pattern: "\n")
    static func lines(in text: NSString, before location: Int) -> Int { lines(in: text, range: NSRange(location: 0, length: location)) }
    static func lines(in text: NSString, range: NSRange) -> Int { newline?.numberOfMatches(in: text as String, range: range) ?? 0 }
}
