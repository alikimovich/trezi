import AppKit

/// LKM-555: Reply on selected assistant text. A settled selection shows a small Reply button
/// over its first line, and the text view's context menu gains Reply above Copy. Either adds a
/// quote card to the composer with the message and segment (`identity`) and the selection
/// exactly as Copy gives it. Selection, Copy, links and the code snippets are untouched: the
/// button is a subview beside them and the menu item is added to NSTextView's own menu.
extension ChatTextView {
    /// Takes a Reply: the message id, its text segment and the excerpt. True when the composer
    /// took it; the selection then clears. Set by the host; nil (no composer) shows no Reply.
    static var reply: ((_ message: String, _ segment: Int?, _ excerpt: String) -> Bool)? = nil

    /// The message id and segment `identity` names (`<message id>#<segment>`).
    var replySource: (message: String, segment: Int?)? {
        guard let identity, let mark = identity.lastIndex(of: "#") else { return nil }
        let message = String(identity[..<mark])
        return message.isEmpty ? nil : (message, Int(identity[identity.index(after: mark)...]))
    }
    /// Whether Reply applies now: a selection in a message the composer can quote.
    var canReply: Bool {
        Self.reply != nil && replySource != nil && selectedRanges.contains { $0.rangeValue.length > 0 }
            && !selectionText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The selection as Copy gives it goes to the composer as a quote card.
    @objc func replyToSelection(_ sender: Any?) {
        guard canReply, let source = replySource else { return }
        let excerpt = selectionText
        if Self.reply?(source.message, source.segment, excerpt) == true {
            setSelectedRange(NSRange(location: selectedRange().upperBound, length: 0))
        }
    }

    func selectionSettled(stillSelecting: Bool) {
        guard !stillSelecting else { replyButton?.isHidden = true; return }
        placeReplyButton()
    }

    /// Over the selection's first line, at its start, kept inside the view (a click outside
    /// a view's bounds never reaches its subviews); under the last line when there is no
    /// room above. Hidden while there is nothing to reply to.
    func placeReplyButton() {
        guard canReply, window != nil, let manager = layoutManager, let container = textContainer,
              let range = selectedRanges.map(\.rangeValue).first(where: { $0.length > 0 }) else {
            replyButton?.isHidden = true; return
        }
        let button = replyButton ?? makeReplyButton()
        let glyphs = manager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        var first = NSRect.null, last = NSRect.null
        manager.enumerateLineFragments(forGlyphRange: glyphs) { _, _, _, lineGlyphs, _ in
            let part = NSIntersectionRange(glyphs, lineGlyphs)
            guard part.length > 0 else { return }
            let box = manager.boundingRect(forGlyphRange: part, in: container)
            if first.isNull { first = box }
            last = box
        }
        guard !first.isNull else { button.isHidden = true; return }
        let origin = textContainerOrigin, gap: CGFloat = 4
        let fitted = button.fittingSize
        // Never taller than the view: a part outside its bounds would not take clicks.
        let size = NSSize(width: fitted.width, height: min(fitted.height, bounds.height))
        let top = first.offsetBy(dx: origin.x, dy: origin.y), bottom = last.offsetBy(dx: origin.x, dy: origin.y)
        // Flipped: y grows downward. Above the first line, else under the last, else after the
        // last line's end, and only then over the text.
        var point = NSPoint(x: top.minX, y: top.minY - size.height - gap)
        if point.y < 0 { point = NSPoint(x: top.minX, y: bottom.maxY + gap) }
        if point.y + size.height > bounds.height, bottom.maxX + gap + size.width <= bounds.width {
            point = NSPoint(x: bottom.maxX + gap, y: bottom.midY - size.height / 2)
        }
        point.y = max(0, min(point.y, bounds.height - size.height))
        point.x = max(0, min(point.x, bounds.width - size.width))
        button.frame = NSRect(origin: point, size: size)
        button.isHidden = false
    }

    private func makeReplyButton() -> NSButton {
        let button = NSButton(title: "Reply", image: NSImage(systemSymbolName: "arrowshape.turn.up.left", accessibilityDescription: nil) ?? NSImage(), target: self, action: #selector(replyToSelection(_:)))
        button.bezelStyle = .push; button.controlSize = .small; button.font = .systemFont(ofSize: 11, weight: .medium)
        button.imagePosition = .imageLeading; button.toolTip = "Reply to the selected text"
        button.setAccessibilityLabel("Reply to selection")
        button.wantsLayer = true
        button.shadow = { let shadow = NSShadow(); shadow.shadowBlurRadius = 6; shadow.shadowOffset = NSSize(width: 0, height: -1); shadow.shadowColor = NSColor.black.withAlphaComponent(0.18); return shadow }()
        button.isHidden = true
        addSubview(button)
        replyButton = button
        return button
    }

    /// NSTextView's own menu (Copy, Look Up, Services…) with Reply first while it applies.
    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = super.menu(for: event)
        guard canReply, let menu else { return menu }
        let item = NSMenuItem(title: "Reply", action: #selector(replyToSelection(_:)), keyEquivalent: "")
        item.target = self; item.image = NSImage(systemSymbolName: "arrowshape.turn.up.left", accessibilityDescription: nil)
        menu.insertItem(item, at: 0)
        menu.insertItem(.separator(), at: 1)
        return menu
    }
}
