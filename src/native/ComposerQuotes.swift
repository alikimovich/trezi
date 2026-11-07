import AppKit

/// LKM-555: the composer's quote cards (Reply on selected chat text), a horizontally scrolling
/// strip above the attachments like theirs. Each card shows its exact excerpt beside a bar, an
/// editable comment and a remove button. Cards are rebuilt only when the set of ids changes; a
/// comment being typed is never replaced by a snapshot, so a draft cannot lose keystrokes.
final class ComposerQuotes: NSScrollView {
    static let cardSize = NSSize(width: 248, height: 78)
    static let rowHeight: CGFloat = cardSize.height + 10
    private let row = NSView()
    private(set) var cards: [ComposerQuoteCard] = []
    /// `quote-comment` (id, comment) and `unquote` (id).
    var comment: ((String, String) -> Void)?
    var remove: ((String) -> Void)?
    /// Where Return or Escape in a comment sends focus (the message field).
    var done: (() -> Void)?
    /// When Reply here asked for a card: the next card to appear within 2 s takes focus. A
    /// refused Reply adds none, so the request lapses instead of grabbing a later card.
    var focusRequested: Date?
    var count: Int { cards.count }
    /// A draft being sent keeps its cards as they are (LKM-338).
    var locked = false {
        didSet { if locked != oldValue { cards.forEach { $0.locked = locked } } }
    }

    init() {
        super.init(frame: .zero)
        drawsBackground = false; borderType = .noBorder
        hasHorizontalScroller = true; autohidesScrollers = true; scrollerStyle = .overlay
        documentView = row
        setAccessibilityLabel("Quoted replies")
        isHidden = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func update(_ values: [[String: Any]]) {
        let ids = values.map { $0["id"] as? String ?? "" }
        if ids != cards.map(\.id) {
            let known = Set(cards.map(\.id)), next = Set(ids)
            // Only cards that left are removed: a comment being typed in a kept card stays focused.
            cards.filter { !next.contains($0.id) }.forEach { $0.removeFromSuperview() }
            var kept: [String: ComposerQuoteCard] = [:]
            for card in cards { kept[card.id] = card }
            cards = values.map { value in
                let id = value["id"] as? String ?? ""
                let card = kept[id] ?? ComposerQuoteCard(id: id, excerpt: value["excerpt"] as? String ?? "")
                card.comment = { [weak self] in self?.comment?(id, $0) }
                card.remove = { [weak self] in self?.remove?(id) }
                card.done = { [weak self] in self?.done?() }
                card.locked = locked
                if card.superview !== row { row.addSubview(card) }
                return card
            }
            isHidden = cards.isEmpty; needsLayout = true
            let fresh = focusRequested.map { Date().timeIntervalSince($0) < 2 } ?? false
            if fresh, let added = cards.last(where: { !known.contains($0.id) }) {
                focusRequested = nil
                layoutSubtreeIfNeeded()
                contentView.scrollToVisible(added.frame)
                window?.makeFirstResponder(added.field)
            }
        }
        for (card, value) in zip(cards, values) {
            card.show(comment: value["comment"] as? String ?? "", source: value["source"] as? Bool ?? true)
        }
    }
    override func layout() {
        super.layout()
        var x: CGFloat = 0
        for card in cards {
            card.frame = NSRect(x: x, y: 5, width: Self.cardSize.width, height: Self.cardSize.height)
            x += Self.cardSize.width + 8
        }
        row.frame = NSRect(x: 0, y: 0, width: max(contentSize.width, x - 8), height: Self.rowHeight)
    }
    func inspect() -> [String: Any] {
        ["count":count, "height":bounds.height, "hidden":isHidden,
         "cards":cards.map { ["id":$0.id, "excerpt":$0.excerptLabel.stringValue, "comment":$0.field.stringValue,
                              "frame":NSStringFromRect($0.frame), "editing":$0.field.currentEditor() != nil,
                              "editable":$0.field.isEditable, "source":$0.source] }]
    }
}

/// One card: the excerpt (two lines, its full text in the tooltip), the comment field and ×.
final class ComposerQuoteCard: NSView, NSTextFieldDelegate {
    let id: String
    let excerptLabel = NSTextField(wrappingLabelWithString: "")
    let field = NSTextField()
    let removeButton = NSButton()
    private let bar = NSView()
    var comment: ((String) -> Void)?
    var remove: (() -> Void)?
    var done: (() -> Void)?
    private(set) var source = true
    var locked = false {
        didSet { field.isEditable = !locked; removeButton.isEnabled = !locked }
    }

    init(id: String, excerpt: String) {
        self.id = id
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 12; layer?.borderWidth = 1
        bar.wantsLayer = true; bar.layer?.cornerRadius = 1
        excerptLabel.stringValue = excerpt
        excerptLabel.font = .systemFont(ofSize: 11); excerptLabel.textColor = .secondaryLabelColor
        excerptLabel.maximumNumberOfLines = 2; excerptLabel.lineBreakMode = .byTruncatingTail
        excerptLabel.cell?.truncatesLastVisibleLine = true
        excerptLabel.toolTip = excerpt
        excerptLabel.setAccessibilityLabel("Quoted: " + excerpt)
        field.placeholderString = "Add a comment"
        field.font = .systemFont(ofSize: 12); field.isBordered = false; field.drawsBackground = false
        field.focusRingType = .none; field.delegate = self
        field.cell?.wraps = false; field.cell?.isScrollable = true; field.lineBreakMode = .byTruncatingTail
        field.setAccessibilityLabel("Comment on the quoted text")
        removeButton.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Remove quote")
        removeButton.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 8, weight: .bold)
        removeButton.bezelStyle = .circular; removeButton.isBordered = true; removeButton.title = ""
        removeButton.target = self; removeButton.action = #selector(removeClicked)
        removeButton.toolTip = "Remove quote"; removeButton.setAccessibilityLabel("Remove quote")
        for view in [bar, excerptLabel, field, removeButton] { addSubview(view) }
        setAccessibilityElement(false)
        updateColors()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// The snapshot's comment, unless the user is typing in this field: their text is newer.
    func show(comment value: String, source: Bool) {
        if field.currentEditor() == nil, field.stringValue != value { field.stringValue = value }
        if self.source != source {
            self.source = source
            excerptLabel.toolTip = source ? excerptLabel.stringValue
                : excerptLabel.stringValue + "\n\nThe quoted message is no longer shown; this excerpt is still sent."
        }
    }
    override func layout() {
        super.layout()
        let inset: CGFloat = 10
        removeButton.frame = NSRect(x: bounds.width - 24, y: bounds.height - 24, width: 20, height: 20)
        bar.frame = NSRect(x: inset, y: bounds.height - 38, width: 2, height: 28)
        excerptLabel.frame = NSRect(x: inset + 8, y: bounds.height - 40, width: bounds.width - inset - 8 - 26, height: 32)
        field.frame = NSRect(x: inset - 2, y: 8, width: bounds.width - 2 * inset + 4, height: 20)
    }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); updateColors() }
    override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); updateColors() }
    private func updateColors() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
            layer?.borderColor = NSColor.separatorColor.cgColor
            bar.layer?.backgroundColor = NSColor.tertiaryLabelColor.cgColor
        }
    }
    func controlTextDidChange(_ notification: Notification) { comment?(field.stringValue) }
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        // Return or Escape ends the comment and returns to the message, as a popover's would.
        guard selector == #selector(NSResponder.insertNewline(_:)) || selector == #selector(NSResponder.cancelOperation(_:)) else { return false }
        comment?(field.stringValue)
        done?()
        return true
    }
    @objc private func removeClicked() { remove?() }
}

extension NativeComposer {
    func configureQuotes() {
        quotes.comment = { [weak self] id, comment in self?.emitAction("quote-comment", ["id":id, "comment":comment]) }
        quotes.remove = { [weak self] id in self?.emitAction("unquote", ["id":id]) }
        quotes.done = { [weak self] in guard let self else { return }; window?.makeFirstResponder(text) }
    }
    /// Reply from a chat text view: a quote card for this chat, whose comment then takes focus.
    /// Refused while the composer is hidden or its draft is being sent.
    func reply(message: String, segment: Int?, excerpt: String) -> Bool {
        guard !isHidden, !chat.isEmpty, text.isEditable, !excerpt.isEmpty else { return false }
        var action: [String: Any] = ["message":message, "excerpt":excerpt]
        if let segment { action["segment"] = segment }
        quotes.focusRequested = Date()
        emitAction("quote", action)
        return true
    }
    /// Verification: type a card's comment as the field would (`quoteComment`: index and
    /// text) or press its remove button (`quoteRemove`: index).
    func performQuote(_ c: [String: Any]) {
        if let edit = c["quoteComment"] as? [String: Any], let index = edit["index"] as? Int, quotes.cards.indices.contains(index) {
            let card = quotes.cards[index]
            window?.makeFirstResponder(card.field)
            card.field.stringValue = edit["text"] as? String ?? ""
            card.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: card.field))
            if edit["done"] as? Bool == true { _ = card.control(card.field, textView: NSTextView(), doCommandBy: #selector(NSResponder.insertNewline(_:))) }
        }
        if let index = c["quoteRemove"] as? Int, quotes.cards.indices.contains(index), quotes.cards[index].removeButton.isEnabled {
            quotes.cards[index].removeButton.performClick(nil)
        }
    }
}
