import AppKit

/// LKM-186: an assistant text segment in one non-editable, selectable TextKit 1 view
/// (`ChatRichText`), so a drag, Select All and Copy cover all of it. It draws the code
/// and table backgrounds itself, keeps a Copy button on each code block and fades in
/// newly streamed words.
final class ChatTextView: NSTextView {
    /// Views on screen by `identity` (message id and segment), for verification.
    static let live = NSMapTable<NSString, ChatTextView>.strongToWeakObjects()
    /// Where Copy and the code Copy buttons write; verification swaps in a private one.
    static var pasteboard = NSPasteboard.general
    private static let selected = Notification.Name("TreziChatTextSelected")

    private(set) var rich = ChatRichText(markdown: "")
    private(set) var source = ""
    var identity: String? {
        didSet {
            guard identity != oldValue else { return }
            if let oldValue, Self.live.object(forKey: oldValue as NSString) === self { Self.live.removeObject(forKey: oldValue as NSString) }
            if let identity { Self.live.setObject(self, forKey: identity as NSString) }
        }
    }
    var reduceMotion = false
    private(set) var copyButtons: [NSButton] = []
    private var arrivals: [(range: NSRange, time: TimeInterval)] = []
    private var revealTimer: Timer?
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
    deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }

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
    override func draw(_ dirtyRect: NSRect) {
        for item in blockFrames() where item.frame.intersects(dirtyRect) {
            NSColor.quaternaryLabelColor.setFill()
            NSBezierPath(roundedRect: item.frame, xRadius: ChatRichText.cornerRadius, yRadius: ChatRichText.cornerRadius).fill()
            if let rule = item.rule {
                NSColor.separatorColor.setFill()
                NSRect(x: item.frame.minX + ChatRichText.codeInset, y: rule, width: item.frame.width - 2 * ChatRichText.codeInset, height: 1).fill()
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
        if let code = code(at: sender.tag) { copyChatText(code, to: Self.pasteboard) }
    }
    /// The text a code block's Copy button copies.
    func code(at index: Int) -> String? {
        let codes = rich.blocks.filter { $0.kind == .code }
        return codes.indices.contains(index) ? (rich.string.string as NSString).substring(with: codes[index].range) : nil
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
        if ranges.contains(where: { $0.rangeValue.length > 0 }) { NotificationCenter.default.post(name: Self.selected, object: self) }
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
        if window == nil { stopReveal() }
    }
}

private extension Array {
    func ifEmpty(_ fallback: [Element]) -> [Element] { isEmpty ? fallback : self }
}
