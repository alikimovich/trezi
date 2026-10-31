import AppKit

/// The frozen snapshot and the marks over it. `image` is the captured bitmap and never
/// changes, whatever the page does underneath. Nothing here animates, so Reduce Motion has
/// nothing to reduce.
final class PreviewMarkupCanvas: NSView {
    let image: CGImage
    private(set) var document: MarkupDocument
    var tool = MarkupTool.pen
    var changed: (() -> Void)?

    init(image: CGImage) {
        self.image = image
        document = MarkupDocument(size: CGSize(width: image.width, height: image.height))
        super.init(frame: .zero)
        setAccessibilityElement(true); setAccessibilityRole(.image)
        updateLabel()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var isFlipped: Bool { true }
    var mapping: MarkupMapping { MarkupMapping(image: document.size, bounds: bounds) }

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        let mapping = mapping, frame = mapping.frame
        context.saveGState()
        context.interpolationQuality = .high
        context.translateBy(x: frame.minX, y: frame.maxY); context.scaleBy(x: 1, y: -1)
        context.draw(image, in: CGRect(origin: .zero, size: frame.size))
        context.restoreGState()
        context.saveGState()
        context.translateBy(x: frame.minX, y: frame.minY); context.scaleBy(x: mapping.scale, y: mapping.scale)
        // 2 pt on screen at the least; the geometry is the composite's whatever the width.
        MarkupRenderer.draw(document.visible, in: context, size: document.size, minimumWidth: mapping.scale > 0 ? 2 / mapping.scale : 0)
        context.restoreGState()
    }
    private func updateLabel() {
        let count = document.marks.count
        setAccessibilityLabel("Preview snapshot, \(count) \(count == 1 ? "mark" : "marks")")
    }
    private func edited() { needsDisplay = true; updateLabel(); changed?() }
    func pointerDown(_ point: NSPoint, tool: MarkupTool) { document.begin(tool, at: mapping.toImage(point)); edited() }
    func pointerDragged(_ point: NSPoint) { document.extend(to: mapping.toImage(point)); edited() }
    func pointerUp() { document.finish(); edited() }
    func undo() { document.undo(); edited() }
    func clear() { document.clear(); edited() }

    override func mouseDown(with event: NSEvent) {
        if let overlay = superview { window?.makeFirstResponder(overlay) }
        pointerDown(convert(event.locationInWindow, from: nil), tool: tool)
    }
    override func mouseDragged(with event: NSEvent) { pointerDragged(convert(event.locationInWindow, from: nil)) }
    override func mouseUp(with event: NSEvent) { pointerUp() }
}

/// Tab reaches it with or without Full Keyboard Access; a disabled one is skipped. Keys it
/// does not use go up to the overlay, never to the page.
private final class MarkupButton: NSButton {
    override var canBecomeKeyView: Bool { isEnabled && !isHidden }
    override var acceptsFirstResponder: Bool { isEnabled }
    override func keyDown(with event: NSEvent) {
        if [36, 49, 76].contains(event.keyCode) { performClick(nil) } else { nextResponder?.keyDown(with: event) }
    }
}

/// The opaque cover over the preview area while a session is open: the live page never shows
/// through and takes no keys. Labels and roles sit on the buttons' cells (LKM-379).
final class PreviewMarkupOverlay: NSView {
    private static let padding: CGFloat = 8, gap: CGFloat = 4, rowHeight: CGFloat = 28, toolWidth: CGFloat = 32
    private static let cancelWidth: CGFloat = 76, addWidth: CGFloat = 104
    /// Below this the tools take a row of their own.
    private static let oneRowWidth: CGFloat = 620
    private static let status = "Snapshot of the preview"

    let canvas: PreviewMarkupCanvas
    private(set) var tool = MarkupTool.pen
    var onCancel: (() -> Void)?
    var onAdd: (() -> Void)?
    /// Bun has the image and has not answered yet.
    var adding = false { didSet { refresh() } }
    let animates = false
    private var toolButtons: [(MarkupTool, NSButton)] = []
    private let undoButton = MarkupButton(), clearButton = MarkupButton(), cancelButton = MarkupButton(), addButton = MarkupButton()
    private let statusLabel = NSTextField(labelWithString: PreviewMarkupOverlay.status)
    private let errorLabel = NSTextField(wrappingLabelWithString: "")
    private(set) var barFrame = NSRect.zero

    var controls: [NSButton] { toolButtons.map(\.1) + [undoButton, clearButton, cancelButton, addButton] }
    var addEnabled: Bool { addButton.isEnabled }
    var undoEnabled: Bool { undoButton.isEnabled }
    var errorShown: Bool { !errorLabel.isHidden }
    var statusText: String { errorShown ? errorLabel.stringValue : statusLabel.stringValue }

    init(image: CGImage) {
        canvas = PreviewMarkupCanvas(image: image)
        super.init(frame: .zero)
        wantsLayer = true
        addSubview(canvas)
        canvas.changed = { [weak self] in self?.refresh() }
        for tool in MarkupTool.allCases {
            let button = MarkupButton()
            configure(button, label: tool.label, symbol: tool.symbol, hint: "\(tool.label) (\(tool.key.uppercased()))", role: .radioButton)
            button.setButtonType(.toggle)
            button.tag = toolButtons.count; button.action = #selector(pick(_:))
            toolButtons.append((tool, button))
        }
        configure(undoButton, label: "Undo", symbol: "arrow.uturn.backward", hint: "Undo (⌘Z)"); undoButton.action = #selector(undo)
        configure(clearButton, label: "Clear", symbol: "trash", hint: "Clear all marks"); clearButton.action = #selector(clear)
        configure(cancelButton, label: "Cancel", symbol: nil, hint: "Discard this mark up (Esc)"); cancelButton.action = #selector(cancel)
        configure(addButton, label: "Add to chat", symbol: nil, hint: "Add the marked-up image to the message"); addButton.action = #selector(add)
        statusLabel.font = .systemFont(ofSize: 12); statusLabel.textColor = .secondaryLabelColor; statusLabel.lineBreakMode = .byTruncatingTail
        errorLabel.font = .systemFont(ofSize: 12); errorLabel.textColor = .systemRed; errorLabel.isHidden = true
        addSubview(statusLabel); addSubview(errorLabel)
        // Tab walks the bar and comes back: it never reaches the views under the overlay.
        var previous: NSView = self
        for control in controls { previous.nextKeyView = control; previous = control }
        previous.nextKeyView = self
        updateColors(); refresh()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    private func configure(_ button: NSButton, label: String, symbol: String?, hint: String, role: NSAccessibility.Role = .button) {
        button.bezelStyle = .rounded; button.target = self; button.toolTip = hint
        if let symbol { button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label); button.title = "" } else { button.title = label }
        button.cell?.setAccessibilityRole(role); button.cell?.setAccessibilityLabel(label)
        addSubview(button)
    }
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override var canBecomeKeyView: Bool { true }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); updateColors() }
    private func updateColors() {
        effectiveAppearance.performAsCurrentDrawingAppearance { layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor }
    }
    /// A click here never reaches what is behind.
    override func mouseDown(with event: NSEvent) { window?.makeFirstResponder(self) }

    override func layout() {
        super.layout()
        let padding = Self.padding, width = bounds.width, row = Self.rowHeight
        let buttons = toolButtons.map(\.1) + [undoButton, clearButton]
        let side = max(16, min(Self.toolWidth, (width - padding * 2 - Self.gap * CGFloat(buttons.count - 1)) / CGFloat(buttons.count)))
        for (index, button) in buttons.enumerated() {
            button.frame = NSRect(x: padding + CGFloat(index) * (side + Self.gap), y: padding, width: side, height: row)
        }
        let tools = padding + CGFloat(buttons.count) * (side + Self.gap)
        let oneRow = width >= Self.oneRowWidth
        let actions = oneRow ? padding : padding * 1.5 + row
        addButton.frame = NSRect(x: width - padding - Self.addWidth, y: actions, width: Self.addWidth, height: row)
        cancelButton.frame = NSRect(x: addButton.frame.minX - Self.gap - Self.cancelWidth, y: actions, width: Self.cancelWidth, height: row)
        let left = oneRow ? tools + padding : padding, room = cancelButton.frame.minX - padding - left
        statusLabel.frame = NSRect(x: left, y: actions + 6, width: max(0, room), height: 16)
        statusLabel.isHidden = room < 120
        var bottom = actions + row + padding
        if errorShown {
            let text = errorLabel.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: width - padding * 2, height: 200)).height ?? 16
            errorLabel.frame = NSRect(x: padding, y: bottom - padding / 2, width: width - padding * 2, height: text)
            bottom = errorLabel.frame.maxY + padding
        }
        barFrame = NSRect(x: 0, y: 0, width: width, height: bottom)
        canvas.frame = NSRect(x: 0, y: bottom, width: width, height: max(0, bounds.height - bottom))
    }
    private func refresh() {
        let marks = canvas.document.marks.count
        for (candidate, button) in toolButtons {
            button.state = candidate == tool ? .on : .off
            button.contentTintColor = candidate == tool ? .controlAccentColor : nil
            button.cell?.setAccessibilityValue(candidate == tool ? "selected" : "")
        }
        undoButton.isEnabled = !adding && canvas.document.canUndo
        clearButton.isEnabled = !adding && marks > 0
        // Only a marked image can leave: an unmarked original is never added.
        addButton.isEnabled = !adding && marks > 0 && !canvas.document.isDrawing
        statusLabel.stringValue = adding ? "Adding…" : Self.status
    }
    /// A failure stays on screen, in its own row, until the next attempt.
    func show(error: String?) {
        errorLabel.stringValue = error ?? ""
        errorLabel.isHidden = error == nil
        needsLayout = true; layout()
    }
    func select(_ tool: MarkupTool) { self.tool = tool; canvas.tool = tool; refresh() }
    @objc private func pick(_ sender: NSButton) { select(MarkupTool.allCases[sender.tag]) }
    @objc func undo() { if !adding { canvas.undo() } }
    @objc func clear() { if !adding { canvas.clear() } }
    @objc func cancel() { onCancel?() }
    @objc func add() { onAdd?() }

    /// Whether the keyboard is here, not on the chat next to it.
    var ownsFocus: Bool { (window?.firstResponder as? NSView)?.isDescendant(of: self) == true }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { cancel(); return }
        if event.keyCode == 48 {
            if event.modifierFlags.contains(.shift) { window?.selectPreviousKeyView(nil) } else { window?.selectNextKeyView(nil) }
            return
        }
        guard event.modifierFlags.intersection(KeyShortcut.shortcutModifiers).isEmpty, let key = KeyShortcut.latin(event)?.lowercased(),
              let tool = MarkupTool.allCases.first(where: { $0.key == key }) else { return }
        select(tool)
    }
    override func cancelOperation(_ sender: Any?) { cancel() }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if ownsFocus, KeyShortcut.matches(event, "z", .command) { undo(); return true }
        return super.performKeyEquivalent(with: event)
    }
}
