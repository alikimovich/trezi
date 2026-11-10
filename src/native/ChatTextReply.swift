import AppKit

/// LKM-555: Reply on selected assistant text. A settled selection shows a small Reply button
/// next to it, and the text view's context menu gains Reply above Copy. Either adds a quote card
/// to the composer with the message and segment (`identity`) and the selection exactly as Copy
/// gives it. Selection, Copy, links and the code snippets are untouched: the menu item is added
/// to NSTextView's own menu and the button is not inside the text view at all.
///
/// LKM-627: the button floats over the transcript, not inside the selected text view. A text
/// view is exactly as tall as its text, so a button kept inside it had to sit on or beside the
/// lines (a two-line message put it inline after the last word). One button per chat lives over
/// the conversation (`ChatReplyHost`, a sibling above it, as the latest button), placed in its
/// visible reading area clear of every line of text and of other messages, and moved or hidden
/// as the transcript scrolls, resizes or the selection changes.
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

    /// The conversation this view is in, which owns the floating Reply.
    var replyHost: ChatReplyHost? {
        var view = superview
        while let next = view { if let host = next as? ChatReplyHost { return host }; view = next.superview }
        return nil
    }
    /// The chat's Reply while it is showing for this view's selection.
    var replyButton: ChatReplyButton? {
        guard let button = replyHost?.replyButton, button.owner === self, !button.isHidden else { return nil }
        return button
    }

    func selectionSettled(stillSelecting: Bool) {
        guard !stillSelecting else { return releaseReply() }
        placeReplyButton()
    }
    /// Hides the chat's Reply if it is this view's (reuse, a cleared selection, leaving the
    /// window: by then the view may have no host to ask).
    func releaseReply() { floatingReply?.release(self) }

    /// Shows the chat's Reply beside this view's settled selection, or hides it.
    func placeReplyButton() {
        guard let host = replyHost, canReply, window != nil, window === host.window else { return releaseReply() }
        floatingReply = host.replyButton
        host.replyButton.show(for: self, in: host)
    }

    /// Each line of the selection: its selected glyphs' box, in this view.
    func selectionLineRects() -> [NSRect] {
        guard let manager = layoutManager, let container = textContainer,
              let range = selectedRanges.map(\.rangeValue).first(where: { $0.length > 0 }) else { return [] }
        let glyphs = manager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        var lines: [NSRect] = []
        manager.enumerateLineFragments(forGlyphRange: glyphs) { _, _, _, lineGlyphs, _ in
            let part = NSIntersectionRange(glyphs, lineGlyphs)
            guard part.length > 0 else { return }
            let box = manager.boundingRect(forGlyphRange: part, in: container)
            if box.width > 0 { lines.append(box.offsetBy(dx: self.textContainerOrigin.x, dy: self.textContainerOrigin.y)) }
        }
        return lines
    }
    /// Every laid-out line's used box (where its glyphs are), in this view.
    func textLineRects() -> [NSRect] {
        guard let manager = layoutManager, let container = textContainer else { return [] }
        let all = manager.glyphRange(for: container)
        var lines: [NSRect] = []
        manager.enumerateLineFragments(forGlyphRange: all) { _, used, _, _, _ in
            if used.width > 0 { lines.append(used.offsetBy(dx: self.textContainerOrigin.x, dy: self.textContainerOrigin.y)) }
        }
        return lines
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

/// The view a chat's text views sit in that carries their one floating Reply (`NativeChat`).
/// It adds `replyButton` to its own superview above itself, so the button is hit-tested before
/// anything in the conversation and is never clipped by a message or the scroll view.
protocol ChatReplyHost: NSView {
    var replyButton: ChatReplyButton { get }
    /// The visible transcript, top-down (y grows down from the host's top): no composer
    /// clearance, nothing outside the conversation.
    var replyArea: NSRect { get }
    /// What else Reply must not cover, top-down: the other messages, whatever they draw.
    func replyObstacles(excluding message: String) -> [NSRect]
}

/// The floating Reply: a standard small push button with a soft shadow (LKM-555's), owned by
/// one text view's selection at a time.
final class ChatReplyButton: NSButton {
    private(set) weak var owner: ChatTextView?
    private var scrollObservers: [NSObjectProtocol] = []
    private weak var observedClip: NSClipView?

    init() {
        super.init(frame: .zero)
        title = "Reply"
        image = NSImage(systemSymbolName: "arrowshape.turn.up.left", accessibilityDescription: nil)
        bezelStyle = .push; controlSize = .small; font = .systemFont(ofSize: 11, weight: .medium)
        imagePosition = .imageLeading; toolTip = "Reply to the selected text"
        setAccessibilityLabel("Reply to selection")
        wantsLayer = true
        shadow = { let shadow = NSShadow(); shadow.shadowBlurRadius = 6; shadow.shadowOffset = NSSize(width: 0, height: -1); shadow.shadowColor = NSColor.black.withAlphaComponent(0.18); return shadow }()
        target = self; action = #selector(press)
        isHidden = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    deinit { scrollObservers.forEach(NotificationCenter.default.removeObserver) }
    @objc private func press() { owner?.replyToSelection(self) }
    /// A click in an inactive window still replies: it does not first just activate it.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// Beside `view`'s selection inside `host`'s reading area, or hidden when none of the
    /// selection is in view or there is no room at all.
    func show(for view: ChatTextView, in host: ChatReplyHost) {
        guard let parent = superview, !host.isHidden else { return hide() }
        if owner !== view { owner = view; observeScroll(of: view) }
        let height = host.bounds.height
        // Host coordinates to top-down and back (the same flip both ways).
        func topDown(_ rect: NSRect) -> NSRect { host.isFlipped ? rect : NSRect(x: rect.minX, y: height - rect.maxY, width: rect.width, height: rect.height) }
        var area = host.replyArea
        if let clip = view.enclosingScrollView?.contentView { area = area.intersection(topDown(host.convert(clip.bounds, from: clip))) }
        let selection = view.selectionLineRects().map { topDown(host.convert($0, from: view)) }
        // The lines of every chat text view in sight, the selected one's included.
        var text = view.textLineRects().map { topDown(host.convert($0, from: view)) }
        for case let other as ChatTextView in ChatTextView.live.objectEnumerator() ?? NSEnumerator()
        where other !== view && other.window === host.window && other.isDescendant(of: host) && topDown(host.convert(other.bounds, from: other)).intersects(area) {
            text += other.textLineRects().map { topDown(host.convert($0, from: other)) }
        }
        let blocked = view.replySource.map { host.replyObstacles(excluding: $0.message) } ?? []
        // Out of view or no room: hidden but still its, so scrolling back shows it again.
        guard let placed = ChatReplyPlacement.frame(size: fittingSize, selection: selection, area: area, text: text, blocked: blocked) else { isHidden = true; return }
        frame = parent.convert(topDown(placed), from: host)
        isHidden = false
    }
    /// Hides it if `view` owns it.
    func release(_ view: ChatTextView) { if owner === view { hide() } }
    /// Places it again for its selection (the transcript scrolled, resized or the composer grew).
    func refresh() {
        guard let owner else { return isHidden = true }
        owner.placeReplyButton()
    }
    private func hide() {
        isHidden = true; owner = nil
        observeScroll(of: nil)
    }
    private func observeScroll(of view: ChatTextView?) {
        let clip = view?.enclosingScrollView?.contentView
        guard clip !== observedClip || clip == nil else { return }
        scrollObservers.forEach(NotificationCenter.default.removeObserver); scrollObservers = []
        observedClip = clip
        guard let clip else { return }
        clip.postsBoundsChangedNotifications = true; clip.postsFrameChangedNotifications = true
        for name in [NSView.boundsDidChangeNotification, NSView.frameDidChangeNotification] {
            scrollObservers.append(NotificationCenter.default.addObserver(forName: name, object: clip, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.refresh() }
            })
        }
    }
}

/// Where Reply goes, top-down (y grows downward), always inside the reading area:
/// 1. above the selection's first visible line, else under its last (each moved right past a
///    line ending early, or on past what is in the way within `reach`), clear of all text and
///    of other messages;
/// 2. beside its last line, past the end of every line it would cross;
/// 3. as 1, clear of text but over another message's spare edge (messages sit 20 pt apart);
/// 4. only when no spot near it is clear (a dense paragraph filling the view), the one of
///    those covering least, the selection's own glyphs counting most.
/// Nil when none of the selection is in view or the area cannot hold it.
enum ChatReplyPlacement {
    static let gap: CGFloat = 4, margin: CGFloat = 4
    /// How far above or below the selection a clear spot still reads as next to it.
    static let reach: CGFloat = 48

    static func frame(size: NSSize, selection: [NSRect], area: NSRect, text: [NSRect], blocked: [NSRect]) -> NSRect? {
        let area = area.insetBy(dx: margin, dy: margin)
        let shown = selection.filter { $0.intersects(area) }
        guard let first = shown.first, let last = shown.last, area.width >= size.width, area.height >= size.height else { return nil }
        func box(_ x: CGFloat, _ y: CGFloat) -> NSRect { NSRect(x: max(area.minX, min(x, area.maxX - size.width)), y: y, width: size.width, height: size.height) }
        func inside(_ rect: NSRect) -> NSRect { NSRect(x: rect.minX, y: max(area.minY, min(rect.minY, area.maxY - size.height)), width: size.width, height: size.height) }
        // From `start`: right past lines ending early, else on up or down past what is in
        // the way, until clear, out of reach or out of view.
        func slide(_ start: NSRect, up: Bool, avoiding obstacles: [NSRect]) -> NSRect? {
            var rect = start
            while area.contains(rect), abs(rect.minY - start.minY) <= reach {
                let hits = obstacles.filter { $0.intersects(rect) }
                if hits.isEmpty { return rect }
                var right = rect; right.origin.x = hits.map(\.maxX).max()! + gap
                if right.maxX <= area.maxX, !obstacles.contains(where: { $0.intersects(right) }) { return right }
                rect.origin.y = up ? hits.map(\.minY).min()! - gap - size.height : hits.map(\.maxY).max()! + gap
            }
            return nil
        }
        let above = box(first.minX, first.minY - gap - size.height), below = box(last.minX, last.maxY + gap)
        let everything = text + blocked
        if let rect = slide(above, up: true, avoiding: everything) ?? slide(below, up: false, avoiding: everything) { return rect }
        // Beside the last line, past the end of every line the button's height crosses.
        var beside = inside(box(last.maxX + gap, last.midY - size.height / 2))
        beside.origin.x = (text.filter { $0.minY < beside.maxY && $0.maxY > beside.minY }.map(\.maxX) + [last.maxX]).max()! + gap
        if beside.maxX <= area.maxX, !everything.contains(where: { $0.intersects(beside) }) { return beside }
        if let rect = slide(above, up: true, avoiding: text) ?? slide(below, up: false, avoiding: text) { return rect }
        func cost(_ rect: NSRect) -> CGFloat {
            func covered(_ rects: [NSRect]) -> CGFloat { rects.reduce(0) { let part = $1.intersection(rect); return $0 + (part.isNull ? 0 : part.width * part.height) } }
            return 4 * covered(shown) + 2 * covered(text) + covered(blocked)
        }
        return [inside(above), inside(below), inside(box(beside.minX, beside.minY))].min { cost($0) < cost($1) }
    }
}
