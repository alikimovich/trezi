import AppKit

/// LKM-186: an assistant text segment in one non-editable, selectable TextKit 1 view
/// (`ChatRichText`), so a drag, Select All and Copy cover all of it. It draws the code
/// and table backgrounds itself, keeps a Copy button on each code block, copies a code
/// snippet on a single click (LKM-431) and fades in newly streamed words.
final class ChatTextView: NSTextView {
    /// Views on screen by `identity` (message id and segment), for verification.
    static let live = NSMapTable<NSString, ChatTextView>.strongToWeakObjects()
    /// Where Copy and the code Copy buttons write; verification swaps in a private one.
    static var pasteboard = NSPasteboard.general
    /// Writes copied code; whether it reached the pasteboard decides the Copied feedback.
    static var write: (String) -> Bool = { copyChatText($0, to: pasteboard) }
    private static let selected = Notification.Name("TreziChatTextSelected")

    private(set) var rich = ChatRichText(markdown: "")
    private(set) var source = ""
    var identity: String? {
        didSet {
            guard identity != oldValue else { return }
            if let oldValue, Self.live.object(forKey: oldValue as NSString) === self { Self.live.removeObject(forKey: oldValue as NSString) }
            if let identity { Self.live.setObject(self, forKey: identity as NSString) }
            endClick()
        }
    }
    var reduceMotion = false
    /// LKM-364: a clicked link that is not a web link (a code candidate, a file path).
    /// It goes to Trezi's own editor; without a handler nothing opens.
    var onLink: ((String) -> Void)?
    private(set) var copyButtons: [NSButton] = []
    private var arrivals: [(range: NSRange, time: TimeInterval)] = []
    private var revealTimer: Timer?
    /// A released click on a snippet, waiting out the double-click interval.
    private(set) var clickTimer: Timer?
    /// A drag that returns to its start ends with nothing selected: this remembers it.
    private var selectedInPress = false
    private var measured: (width: CGFloat, size: CGSize)?
    private var observer: NSObjectProtocol?

    static func make() -> ChatTextView {
        let storage = NSTextStorage(), manager = NSLayoutManager()
        storage.addLayoutManager(manager)
        let container = NSTextContainer(size: NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.lineFragmentPadding = 0; container.widthTracksTextView = true
        manager.addTextContainer(container)
        let view = ChatTextView(frame: .zero, textContainer: container)
        view.isEditable = false; view.isSelectable = true; view.drawsBackground = false
        view.textContainerInset = .zero; view.isVerticallyResizable = false; view.isHorizontallyResizable = false
        view.allowsUndo = false; view.usesFontPanel = false
        // As SwiftUI drew links: the accent colour, no underline.
        view.linkTextAttributes = [.foregroundColor: NSColor.controlAccentColor, .cursor: NSCursor.pointingHand]
        // One selection in the conversation at a time, as in Messages.
        view.observer = NotificationCenter.default.addObserver(forName: selected, object: nil, queue: .main) { [weak view] note in
            guard let view, note.object as? ChatTextView !== view, view.selectedRange().length > 0 else { return }
            view.setSelectedRange(NSRange(location: 0, length: 0))
        }
        return view
    }
    deinit {
        clickTimer?.invalidate()
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    func show(_ next: String, streaming: Bool) {
        guard next != source, let storage = textStorage else { return }
        let previous = storage.string, appended = next.hasPrefix(source) && !source.isEmpty
        source = next
        rich = ChatRichText(markdown: next)
        let selection = selectedRanges.map(\.rangeValue)
        storage.setAttributedString(rich.string)
        let length = storage.length
        if selection.contains(where: { $0.length > 0 }) {
            setSelectedRanges(selection.filter { $0.upperBound <= length }.map { NSValue(range: $0) }.ifEmpty([NSValue(range: NSRange(location: 0, length: 0))]), affinity: .downstream, stillSelecting: false)
        }
        measured = nil
        // Markdown can reparse an unfinished delimiter: never replay old words.
        if streaming && !reduceMotion && appended && storage.string.hasPrefix(previous) { reveal(from: (previous as NSString).length) }
        else if !appended { arrivals = [] }
        invalidateIntrinsicContentSize(); needsLayout = true; needsDisplay = true
    }

    /// Size for a proposed width (SwiftUI's), every block background included.
    func fittingSize(width: CGFloat?) -> CGSize {
        let target = width.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? 10_000
        if let measured, measured.width == target { return measured.size }
        guard let manager = layoutManager, let container = textContainer else { return .zero }
        let kept = container.size
        container.size = NSSize(width: target, height: CGFloat.greatestFiniteMagnitude)
        manager.ensureLayout(for: container)
        let used = manager.usedRect(for: container)
        let bottom = blockFrames().map(\.frame.maxY).max() ?? 0
        let size = CGSize(width: width == nil ? ceil(used.width) : target, height: ceil(max(used.maxY, bottom - textContainerOrigin.y)))
        if bounds.width > 0 { container.size = kept }
        measured = (target, size)
        return size
    }

    // MARK: Code and table backgrounds

    /// Each code block and table: its rounded background and, for a table, the rule under its header.
    func blockFrames() -> [(block: ChatRichBlock, frame: NSRect, rule: CGFloat?)] {
        guard let manager = layoutManager, let container = textContainer, let storage = textStorage else { return [] }
        manager.ensureLayout(for: container)
        let origin = textContainerOrigin, width = container.size.width
        func bounds(_ block: NSTextBlock, at character: Int) -> NSRect {
            var range = NSRange()
            var rect = manager.boundsRect(for: block, at: manager.glyphIndexForCharacter(at: character), effectiveRange: &range)
            rect.size.height -= block.width(for: .margin, edge: .maxY)
            return rect.offsetBy(dx: origin.x, dy: origin.y)
        }
        return rich.blocks.compactMap { block in
            guard block.range.length > 0, block.range.upperBound <= storage.length else { return nil }
            if let code = block.code { return (block, bounds(code, at: block.range.location), nil) }
            guard block.kind == .table else { return nil }
            var frame = NSRect.null, header: CGFloat = 0
            storage.enumerateAttribute(.paragraphStyle, in: block.range) { value, range, _ in
                guard let cell = (value as? NSParagraphStyle)?.textBlocks.first as? NSTextTableBlock else { return }
                let rect = bounds(cell, at: range.location)
                frame = frame.union(rect)
                if cell.startingRow == 0 { header = max(header, rect.maxY) }
            }
            guard !frame.isNull else { return nil }
            return (block, NSRect(x: origin.x, y: frame.minY, width: width, height: frame.height), block.cells.count > 1 ? header : nil)
        }
    }
    /// Where an inline snippet's chip paints: one rect per line it wraps onto, around its
    /// glyphs, the same on every line. The last line's width already holds the kerned padding.
    func inlineFrames(_ snippet: ChatCodeSnippet) -> [NSRect] {
        guard let manager = layoutManager, let container = textContainer, let storage = textStorage,
              !snippet.block, snippet.range.upperBound <= storage.length,
              let font = storage.attribute(.font, at: snippet.range.location, effectiveRange: nil) as? NSFont else { return [] }
        manager.ensureLayout(for: container)
        let glyphs = manager.glyphRange(forCharacterRange: snippet.range, actualCharacterRange: nil), origin = textContainerOrigin
        let padding = ChatRichText.inlinePadding
        var frames: [NSRect] = []
        manager.enumerateLineFragments(forGlyphRange: glyphs) { line, _, _, lineGlyphs, _ in
            let part = NSIntersectionRange(glyphs, lineGlyphs)
            guard part.length > 0 else { return }
            let box = manager.boundingRect(forGlyphRange: part, in: container)
            let baseline = line.minY + manager.location(forGlyphAt: part.location).y
            let left = max(line.minX, box.minX - padding)
            let right = min(line.maxX, part.upperBound == glyphs.upperBound ? box.maxX : box.maxX + padding)
            frames.append(NSRect(x: left + origin.x, y: baseline - font.ascender - 1 + origin.y, width: right - left, height: font.ascender - font.descender + 2))
        }
        return frames
    }
    override func draw(_ dirtyRect: NSRect) {
        for item in blockFrames() where item.frame.intersects(dirtyRect) {
            (item.block.kind == .code ? ChatRichText.codeFill : NSColor.quaternaryLabelColor).setFill()
            NSBezierPath(roundedRect: item.frame, xRadius: ChatRichText.cornerRadius, yRadius: ChatRichText.cornerRadius).fill()
            if let rule = item.rule {
                NSColor.separatorColor.setFill()
                NSRect(x: item.frame.minX + ChatRichText.codeInset, y: rule, width: item.frame.width - 2 * ChatRichText.codeInset, height: 1).fill()
            }
        }
        ChatRichText.codeFill.setFill()
        for snippet in rich.snippets where !snippet.block {
            for frame in inlineFrames(snippet) where frame.intersects(dirtyRect) {
                NSBezierPath(roundedRect: frame, xRadius: ChatRichText.inlineRadius, yRadius: ChatRichText.inlineRadius).fill()
            }
        }
        super.draw(dirtyRect)
    }
    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        needsLayout = true
    }
    override func layout() {
        super.layout()
        placeCopyButtons()
    }
    private func placeCopyButtons() {
        let codes = blockFrames().filter { $0.block.kind == .code }
        while copyButtons.count > codes.count { copyButtons.removeLast().removeFromSuperview() }
        while copyButtons.count < codes.count {
            let button = NSButton(image: NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: "Copy code") ?? NSImage(), target: self, action: #selector(copyCode(_:)))
            button.isBordered = false; button.contentTintColor = .secondaryLabelColor; button.toolTip = "Copy code"
            button.setAccessibilityLabel("Copy code")
            addSubview(button); copyButtons.append(button)
        }
        for (index, code) in codes.enumerated() {
            copyButtons[index].tag = index
            copyButtons[index].frame = NSRect(x: code.frame.maxX - ChatRichText.codeInset - 18, y: code.frame.minY + 6, width: 18, height: 18)
        }
    }
    @objc private func copyCode(_ sender: NSButton) {
        guard let code = code(at: sender.tag), !code.isEmpty else { return }
        // A click still waiting on its interval would overwrite this later.
        clickTimer?.invalidate(); clickTimer = nil
        copy(code, at: sender.convert(NSPoint(x: sender.bounds.midX, y: sender.bounds.midY), to: nil))
    }
    /// The text a code block's Copy button copies.
    func code(at index: Int) -> String? {
        let codes = rich.blocks.filter { $0.kind == .code }
        return codes.indices.contains(index) ? codes[index].raw : nil
    }

    // MARK: Click to copy

    /// The snippet painted at `point`, in view coordinates: all of a code block's
    /// background, each line of an inline chip. Anywhere else is not a snippet.
    func snippet(at point: NSPoint) -> ChatCodeSnippet? {
        if let code = blockFrames().first(where: { $0.block.kind == .code && $0.frame.contains(point) }) {
            return rich.snippets.first { $0.block && $0.range == code.block.range }
        }
        return rich.snippets.first { snippet in inlineFrames(snippet).contains { $0.contains(point) } }
    }
    /// A single primary click copies the snippet under it. NSTextView tracks the press in
    /// its own loop and takes the mouse-up, so the click is judged after it returns. Only a
    /// release where it began, that selected nothing on the way, counts; a press that clears
    /// a selection only clears it, so it cannot replace what that selection just copied.
    /// Links are not snippets and go on to `clicked(onLink:at:)`.
    override func mouseDown(with event: NSEvent) {
        clickTimer?.invalidate(); clickTimer = nil
        let start = event.locationInWindow
        let single = event.clickCount == 1 && event.modifierFlags.isDisjoint(with: [.shift, .command, .control, .option])
        let target = single && selectedRange().length == 0 ? snippet(at: convert(start, from: nil)) : nil
        selectedInPress = false
        super.mouseDown(with: event)
        guard let target, let up = NSApp.currentEvent, up.type == .leftMouseUp,
              hypot(up.locationInWindow.x - start.x, up.locationInWindow.y - start.y) <= Self.clickSlop,
              !selectedInPress, snippet(at: convert(up.locationInWindow, from: nil)) == target else { return }
        // The next press may be a double click's second: it cancels this, and only then
        // has the click proved to be single.
        let point = up.locationInWindow
        let timer = Timer(timeInterval: Self.doubleClickWait, repeats: false) { [weak self] _ in
            guard let self else { return }
            clickTimer = nil
            // A stream may have reparsed the text since: only the same snippet still counts.
            if window != nil, selectedRange().length == 0, rich.snippets.contains(target) { copy(target.text, at: point) }
        }
        RunLoop.main.add(timer, forMode: .common)
        clickTimer = timer
    }
    private static let clickSlop: CGFloat = 4
    /// The user's double-click speed. A process cut off from the input services reads 0,
    /// which would turn every double click into a copy, so that takes the system default.
    static var doubleClickWait: TimeInterval { NSEvent.doubleClickInterval > 0 ? NSEvent.doubleClickInterval : 0.5 }
    /// Writes `code` and, once it is on the pasteboard, shows Copied at `point` (window coordinates).
    private func copy(_ code: String, at point: NSPoint) {
        if Self.write(code) { ChatCopiedToast.show(at: point, from: self) }
    }
    /// Reuse or close: no waiting click may copy, and no feedback outlives its view.
    private func endClick() {
        clickTimer?.invalidate(); clickTimer = nil
        ChatCopiedToast.dismiss(from: self)
    }

    // MARK: Links

    static func isWebLink(_ link: String) -> Bool { ["http", "https", "mailto"].contains(URL(string: link)?.scheme?.lowercased() ?? "") }
    /// Clicks handed to AppKit's own link handling (NSWorkspace), for verification (LKM-366).
    private(set) static var appKitLinks = 0
    /// Web links keep AppKit's handling (the browser). Every other link, code candidates
    /// (`trezi-code:`) and file paths included, never reaches NSWorkspace or another app.
    override func clicked(onLink link: Any, at charIndex: Int) {
        let text = (link as? URL)?.absoluteString ?? link as? String ?? ""
        if Self.isWebLink(text) { Self.appKitLinks += 1; super.clicked(onLink: link, at: charIndex) } else if !text.isEmpty { onLink?(text) }
    }

    // MARK: Selection and copy

    override func copy(_ sender: Any?) {
        _ = writeSelection(to: Self.pasteboard, types: [.string])
    }
    override var writablePasteboardTypes: [NSPasteboard.PasteboardType] { [.string] }
    /// Copy, drag and Services all write plain text: paragraph breaks kept, whole code blocks fenced.
    var selectionText: String { rich.copyText(selectedRanges.map(\.rangeValue)) }
    override func writeSelection(to pboard: NSPasteboard, types: [NSPasteboard.PasteboardType]) -> Bool {
        let text = selectionText
        guard !text.isEmpty else { return false }
        pboard.clearContents()
        return pboard.setString(text, forType: .string)
    }
    override func setSelectedRanges(_ ranges: [NSValue], affinity: NSSelectionAffinity, stillSelecting: Bool) {
        super.setSelectedRanges(ranges, affinity: affinity, stillSelecting: stillSelecting)
        if ranges.contains(where: { $0.rangeValue.length > 0 }) {
            selectedInPress = true
            NotificationCenter.default.post(name: Self.selected, object: self)
        }
    }

    // MARK: Streaming reveal

    /// New words fade in over 350 ms, a little staggered, as the SwiftUI reveal did.
    private func reveal(from start: Int) {
        guard let storage = textStorage, start < storage.length else { return }
        let now = Date.timeIntervalSinceReferenceDate
        var word = 0
        (storage.string as NSString).enumerateSubstrings(in: NSRange(location: start, length: storage.length - start), options: [.byWords, .substringNotRequired]) { _, range, _, _ in
            self.arrivals.append((range, now + min(0.24, Double(word) * 0.06))); word += 1
        }
        guard revealTimer == nil, !arrivals.isEmpty else { return }
        let timer = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(timer, forMode: .common)
        revealTimer = timer
        tick()
    }
    private func tick() {
        guard let manager = layoutManager, let storage = textStorage, window != nil else { return stopReveal() }
        let now = Date.timeIntervalSinceReferenceDate
        arrivals = arrivals.filter { arrival in
            guard arrival.range.upperBound <= storage.length else { return false }
            manager.removeTemporaryAttribute(.foregroundColor, forCharacterRange: arrival.range)
            let progress = min(1, max(0, (now - arrival.time) / 0.35)), eased = 1 - pow(1 - progress, 3)
            guard eased < 1 else { return false }
            storage.enumerateAttribute(.foregroundColor, in: arrival.range) { value, range, _ in
                let color = value as? NSColor ?? .labelColor
                manager.addTemporaryAttribute(.foregroundColor, value: color.withAlphaComponent(color.alphaComponent * eased), forCharacterRange: range)
            }
            return true
        }
        if arrivals.isEmpty { stopReveal() }
    }
    private func stopReveal() {
        revealTimer?.invalidate(); revealTimer = nil
        if let manager = layoutManager { for arrival in arrivals { manager.removeTemporaryAttribute(.foregroundColor, forCharacterRange: arrival.range) } }
        arrivals = []
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { stopReveal(); endClick() }
    }
}

/// LKM-431: a brief "Copied" beside the click. A plain subview over the chat, so it shows
/// in window captures; hit-testing passes through it, it never takes focus and moves
/// nothing. One shows at a time: a newer one replaces it.
final class ChatCopiedToast: NSView {
    private(set) static weak var current: ChatCopiedToast?
    /// Verification holds it longer for a capture.
    static var lifetime: TimeInterval = 1.2
    private static let label = NSAttributedString(string: "Copied", attributes: [.font: NSFont.systemFont(ofSize: 11, weight: .medium), .foregroundColor: NSColor.labelColor])
    private static let gap = NSSize(width: 12, height: 10), margin: CGFloat = 6
    private weak var source: ChatTextView?
    private var timer: Timer?

    /// `point` is in window coordinates.
    static func show(at point: NSPoint, from view: ChatTextView) {
        guard let window = view.window else { return }
        current?.dismiss()
        // The window's content view is a split view here, which would take a subview as a pane.
        var host: NSView = view
        while let next = host.superview, !(next is NSSplitView), host !== window.contentView { host = next }
        var visible = window.contentLayoutRect.intersection(host.convert(host.bounds, to: nil))
        if let screen = window.screen { visible = visible.intersection(window.convertFromScreen(screen.visibleFrame)) }
        let size = NSSize(width: ceil(label.size().width) + 16, height: 22)
        let toast = ChatCopiedToast(frame: host.convert(place(size, near: point, in: visible), from: nil))
        toast.wantsLayer = true; toast.source = view
        toast.setAccessibilityElement(true); toast.setAccessibilityRole(.staticText); toast.setAccessibilityLabel("Copied")
        host.addSubview(toast, positioned: .above, relativeTo: nil)
        current = toast
        let timer = Timer(timeInterval: lifetime, repeats: false) { [weak toast] _ in toast?.dismiss() }
        RunLoop.main.add(timer, forMode: .common)
        toast.timer = timer
        NSAccessibility.post(element: toast, notification: .announcementRequested, userInfo: [.announcement: "Copied", .priority: NSAccessibilityPriorityLevel.high.rawValue])
    }
    /// Up and to the right of `point`, on the other side where that leaves `visible`, then
    /// kept inside it (y grows upward, as in window coordinates).
    static func place(_ size: NSSize, near point: NSPoint, in visible: NSRect) -> NSRect {
        var origin = NSPoint(x: point.x + gap.width, y: point.y + gap.height)
        guard !visible.isEmpty else { return NSRect(origin: origin, size: size) }
        let area = visible.insetBy(dx: min(margin, visible.width / 2), dy: min(margin, visible.height / 2))
        if origin.x + size.width > area.maxX { origin.x = point.x - gap.width - size.width }
        if origin.y + size.height > area.maxY { origin.y = point.y - gap.height - size.height }
        origin.x = max(area.minX, min(origin.x, area.maxX - size.width))
        origin.y = max(area.minY, min(origin.y, area.maxY - size.height))
        return NSRect(origin: origin, size: size)
    }
    static func dismiss(from view: ChatTextView) { if current?.source === view { current?.dismiss() } }
    private func dismiss() {
        timer?.invalidate(); timer = nil
        removeFromSuperview()
        if Self.current === self { Self.current = nil }
    }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func draw(_ dirtyRect: NSRect) {
        let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 6, yRadius: 6)
        NSColor.windowBackgroundColor.setFill(); shape.fill()
        NSColor.separatorColor.setStroke(); shape.stroke()
        let size = Self.label.size()
        Self.label.draw(at: NSPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2))
    }
}

private extension Array {
    func ifEmpty(_ fallback: [Element]) -> [Element] { isEmpty ? fallback : self }
}
