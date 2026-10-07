import AppKit

/// Test-profile hooks for soft wrap (LKM-192): the wrapped geometry of the line holding
/// a probe with the ruler's labels, Wrap Lines through either menu, and Home/End.
extension NativeSourceEditor {
    /// The probe's logical line: its range without the newline and its visual lines'
    /// glyph ranges, laid out and scrolled into view.
    func wrapLine(_ probe: String) -> (NSRange, [NSRange])? {
        guard let manager = code.layoutManager else { return nil }
        let text = code.string as NSString, found = text.range(of: probe)
        guard found.location != NSNotFound else { return nil }
        var line = text.paragraphRange(for: found)
        if line.length > 0, text.character(at: NSMaxRange(line) - 1) == 10 { line.length -= 1 }
        layoutSubtreeIfNeeded()
        code.scrollRangeToVisible(NSRange(location: line.location, length: 0))
        let glyphs = manager.glyphRange(forCharacterRange: line, actualCharacterRange: nil)
        manager.ensureLayout(forGlyphRange: glyphs)
        var fragments: [NSRange] = []
        manager.enumerateLineFragments(forGlyphRange: glyphs) { _, _, _, range, _ in fragments.append(NSIntersectionRange(range, glyphs)) }
        return (line, fragments)
    }
    func inspectWrap(_ probe: String) -> [String: Any] {
        guard let manager = code.layoutManager, let container = code.textContainer, let (line, fragments) = wrapLine(probe) else { return ["error": "No \(probe) in the editor"] }
        let text = code.string as NSString, top = code.textContainerOrigin.y - code.visibleRect.minY
        let x = { (glyph: Int) -> CGFloat in manager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil).minX + manager.location(forGlyphAt: glyph).x }
        let lead = SourceSyntaxTheme.columns(text, at: line.location, end: NSMaxRange(line))
        let rows = fragments.map { range -> [String: Any] in
            let rect = manager.lineFragmentRect(forGlyphAt: range.location, effectiveRange: nil), used = manager.lineFragmentUsedRect(forGlyphAt: range.location, effectiveRange: nil)
            return ["y": rect.minY + top, "x": x(range.location), "usedMaxX": used.maxX, "glyphs": range.length]
        }
        let next = NSMaxRange(line) + 1 < text.length ? manager.lineFragmentRect(forGlyphAt: manager.glyphIndexForCharacter(at: NSMaxRange(line) + 1), effectiveRange: nil).minY + top : -1
        scroll.verticalRulerView?.needsDisplay = true
        return [
            "wraps": wraps, "state": state["wrap"] ?? NSNull(),
            "hasHorizontalScroller": scroll.hasHorizontalScroller, "horizontalVisible": scroll.hasHorizontalScroller && scroll.horizontalScroller?.isHidden == false,
            "documentWidth": code.frame.width, "clipWidth": scroll.contentView.bounds.width, "containerWidth": container.size.width,
            "length": line.length, "line": SourceSyntaxTheme.lines(in: text, before: line.location) + 1,
            "codeX": x(manager.glyphIndexForCharacter(at: line.location + lead)), "fragments": rows, "nextY": next,
            "labels": ((scroll.verticalRulerView as? SourceLineRuler)?.labels() ?? []).map { ["line": $0.0, "y": $0.1] }
        ]
    }
    /// Chooses Wrap Lines from the View menu (focus in the code) or the "…" menu and
    /// reports the checkmark it showed before.
    func chooseWrap(_ via: String) -> [String: Any] {
        guard let window else { return ["error": "Source editor has no window"] }
        window.makeFirstResponder(code)
        if via == "more" {
            let menu = moreMenu(); menu.update()
            let checked = menu.items[0].state == .on
            menu.performActionForItem(at: 0)
            return ["title": menu.items[0].title, "checked": checked, "enabled": menu.items[0].isEnabled]
        }
        guard let view = NSApp.mainMenu?.items.first(where: { $0.title == "View" })?.submenu, let item = view.items.first(where: { $0.title == "Wrap Lines" }), let action = item.action else { return ["error": "No View → Wrap Lines"] }
        view.update()
        let checked = item.state == .on, enabled = item.isEnabled
        // The target the menu itself resolves: the focused editor in its window's responder chain.
        let target = NSApp.target(forAction: action, to: item.target, from: item)
        let sent = NSApp.sendAction(action, to: target, from: item)
        return ["title": item.title, "checked": checked, "enabled": enabled, "sent": sent, "editor": (target as AnyObject?) === self]
    }
    /// Home/End from a wrapped line's second visual line, and arrow down from its first.
    func verifyWrapKeys(_ probe: String) -> [String: Any] {
        guard let window, let manager = code.layoutManager, let (line, fragments) = wrapLine(probe), fragments.count > 1 else { return ["error": "\(probe) does not wrap"] }
        window.makeFirstResponder(code)
        let previous = code.selectedRange()
        defer { code.setSelectedRange(previous) }
        let press = { (key: NSEvent.SpecialKey) -> Int in
            let characters = String(Character(UnicodeScalar(UInt16(key.rawValue))!))
            if let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: key == .home ? 115 : 119) { self.code.keyDown(with: event) }
            return self.code.selectedRange().location
        }
        let characters = { (glyphs: NSRange) in manager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil) }
        let second = characters(fragments[1]), first = characters(fragments[0])
        code.setSelectedRange(NSRange(location: second.location + min(3, second.length), length: 0))
        let home = press(.home), end = press(.end)
        code.setSelectedRange(NSRange(location: first.location + min(3, first.length), length: 0)); code.moveDown(nil)
        let down = code.selectedRange().location
        return ["start": line.location, "end": NSMaxRange(line), "home": home, "endKey": end, "down": down, "secondStart": second.location, "secondEnd": NSMaxRange(second)]
    }
}
