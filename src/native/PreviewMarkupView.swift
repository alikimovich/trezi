import AppKit

/// The frozen snapshot and the marks over it. `image` is the captured bitmap and never
/// changes, whatever the page does underneath. Nothing here animates, so Reduce Motion has
/// nothing to reduce.
final class PreviewMarkupCanvas: NSView, NSTextFieldDelegate {
    let image: CGImage
    private(set) var document: MarkupDocument
    var tool = MarkupTool.pen
    var ink = MarkupInk.red
    var changed: (() -> Void)?
    private var textEditor: NSTextField?
    private var textPoint: CGPoint?
    private var textIndex: Int?

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
    func pointerDown(_ point: NSPoint, tool: MarkupTool) {
        commitText()
        if tool == .text { editText(at: point); return }
        document.begin(tool, at: mapping.toImage(point), ink: ink); edited()
    }
    func pointerDragged(_ point: NSPoint) { document.extend(to: mapping.toImage(point)); edited() }
    func pointerUp() { document.finish(); edited() }
    func undo() { document.undo(); edited() }
    func clear() { document.clear(); edited() }
    var hasDraft: Bool { textEditor?.stringValue.isEmpty == false }
    func commitText() {
        guard let editor = textEditor, let point = textPoint else { return }
        let text = editor.stringValue, index = textIndex
        textEditor = nil; textPoint = nil; textIndex = nil
        editor.delegate = nil
        editor.removeFromSuperview()
        document.putText(text, at: point, ink: ink, replacing: index)
        edited()
    }
    private func editText(at location: NSPoint) {
        let point = mapping.toImage(location)
        let index = document.marks.lastIndex { mark in
            MarkupRenderer.textBounds(mark).insetBy(dx: -2, dy: -2).contains(point)
        }
        let editor = NSTextField(string: index.map { document.marks[$0].text } ?? "")
        editor.placeholderString = "Type on canvas"
        editor.font = .systemFont(ofSize: max(12, MarkupRenderer.textSize * mapping.scale), weight: .semibold)
        editor.textColor = NSColor(cgColor: ink.color)
        editor.delegate = self
        let width = min(bounds.width, max(130, 260 * mapping.scale))
        editor.frame = CGRect(x: min(location.x, bounds.maxX - width), y: location.y, width: width, height: max(28, 38 * mapping.scale))
        addSubview(editor)
        textEditor = editor; textPoint = index.map { document.marks[$0].points[0] } ?? point; textIndex = index
        window?.makeFirstResponder(editor)
        changed?()
    }
    func controlTextDidEndEditing(_ notification: Notification) { commitText() }

    override func mouseDown(with event: NSEvent) {
        if tool != .text, let overlay = superview { window?.makeFirstResponder(overlay) }
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

/// LKM-645: the ink swatch, a real AppKit colour well: a click (or Space/Return) opens the
/// shared standard colour panel bound to it. Like `MarkupButton`, Tab reaches it, and keys it
/// does not use go up to the overlay.
final class MarkupColorWell: NSColorWell {
    override var canBecomeKeyView: Bool { isEnabled && !isHidden }
    override var acceptsFirstResponder: Bool { isEnabled }
    override func keyDown(with event: NSEvent) {
        guard [36, 49, 76].contains(event.keyCode) else { nextResponder?.keyDown(with: event); return }
        guard isEnabled else { return }
        activate(true); NSApp.orderFrontColorPanel(nil)
    }
}

/// LKM-448: the Mark up controls as an island floating at the top of the preview, over the
/// snapshot, in the look of the other islands there (`FloatingIsland`): a Liquid Glass edge
/// from macOS 26 and an opaque face, so no mark or page pixel shows through a control. Its own
/// frame takes the pointer; everywhere else the snapshot takes the pen.
final class PreviewMarkupIsland: NSView {
    static let cornerRadius: CGFloat = 22
    /// Holds the controls: the glass's content view, or the blur's subview before macOS 26.
    let face = MarkupIslandFace()
    private(set) var glass = false
    private var backdrop = NSView()
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        if #available(macOS 26.0, *) {
            let effect = NSGlassEffectView(); effect.style = .regular
            effect.cornerRadius = Self.cornerRadius; effect.contentView = face
            backdrop = effect; glass = true
        } else {
            let effect = NSVisualEffectView(); effect.material = .popover
            effect.blendingMode = .withinWindow; effect.state = .followsWindowActiveState
            effect.wantsLayer = true; effect.layer?.cornerRadius = Self.cornerRadius; effect.layer?.masksToBounds = true
            effect.addSubview(face); backdrop = effect
        }
        face.frame = backdrop.bounds; face.autoresizingMask = [.width, .height]
        backdrop.frame = bounds; backdrop.autoresizingMask = [.width, .height]; addSubview(backdrop)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    /// The glass sizes its content view (and the holder around it, which clips hit-testing) in a
    /// later layout pass; the controls are placed now, so the island lays it out with the frame:
    /// a grown island (a wrapped row, an error) takes clicks on its new rows at once.
    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        backdrop.frame = bounds
        backdrop.needsLayout = true; backdrop.layoutSubtreeIfNeeded()
        face.frame = face.superview?.bounds ?? bounds
    }
    override var isFlipped: Bool { true }
    /// The whole island is the island's: a click on its padding never draws a mark.
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden, frame.contains(point) else { return nil }
        let hit = super.hitTest(point)
        return hit is NSControl ? hit : self
    }
    override func mouseDown(with event: NSEvent) { superview.map { window?.makeFirstResponder($0) } }
}

/// The island's opaque face, drawn in the current appearance.
final class MarkupIslandFace: NSView {
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill()
        NSBezierPath(roundedRect: bounds, xRadius: PreviewMarkupIsland.cornerRadius, yRadius: PreviewMarkupIsland.cornerRadius).fill()
    }
}

/// A changed page never receives the old snapshot. The retained composite can still be
/// attached to its original chat, or explicitly discarded, from this small native island.
final class PreviewMarkupRecovery: NSVisualEffectView {
    let message = NSTextField(labelWithString: "Preview changed. Save the marked image to chat or discard it.")
    let saveButton = NSButton(title: "Save to chat", target: nil, action: nil)
    let discardButton = NSButton(title: "Discard", target: nil, action: nil)
    var onSave: (() -> Void)?
    var onDiscard: (() -> Void)?
    var adding = false { didSet { saveButton.isEnabled = !adding } }
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        material = .popover; blendingMode = .withinWindow; state = .active
        wantsLayer = true; layer?.cornerRadius = 16; layer?.masksToBounds = true
        message.font = .systemFont(ofSize: 12)
        saveButton.target = self; saveButton.action = #selector(save)
        discardButton.target = self; discardButton.action = #selector(discard)
        for view in [message, saveButton, discardButton] { addSubview(view) }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func layout() {
        super.layout()
        message.frame = CGRect(x: 12, y: bounds.height - 25, width: bounds.width - 24, height: 18)
        saveButton.frame = CGRect(x: 12, y: 8, width: 116, height: 28)
        discardButton.frame = CGRect(x: 136, y: 8, width: 90, height: 28)
    }
    @objc private func save() { onSave?() }
    @objc private func discard() { onDiscard?() }
    func show(error: String) { message.stringValue = error }
}

/// The opaque cover over the preview area while a session is open: the live page never shows
/// through and takes no keys. LKM-448: the snapshot sits exactly where the page was, at its
/// size, and the controls float over it, so opening and closing moves and resizes nothing.
/// Labels and roles sit on the buttons' cells (LKM-379).
final class PreviewMarkupOverlay: NSView {
    private static let padding: CGFloat = 8, gap: CGFloat = 4, rowHeight: CGFloat = 28, toolWidth: CGFloat = 32
    private static let cancelWidth: CGFloat = 76, addWidth: CGFloat = 104
    /// Room between the island and the preview's edges (`FloatingIsland.inset`).
    static let inset: CGFloat = 10
    /// The widest an island with an error gets, so the message wraps rather than spans the page.
    private static let errorWidth: CGFloat = 480
    private static let status = "Snapshot of the preview"

    let canvas: PreviewMarkupCanvas
    let island = PreviewMarkupIsland()
    private(set) var tool = MarkupTool.pen
    var onCancel: (() -> Void)?
    var onAdd: (() -> Void)?
    /// Bun has the image and has not answered yet.
    var adding = false { didSet { if adding { releaseColorPanel() }; refresh() } }
    let animates = false
    /// The live page's frame in the superview's coordinates; the snapshot takes exactly that.
    /// Nil: the whole overlay.
    var page: NSRect? { didSet { if page != oldValue { needsLayout = true } } }
    private var toolButtons: [(MarkupTool, NSButton)] = []
    /// LKM-645: the ink. Each overlay owns its well; only an active well is bound to the shared
    /// `NSColorPanel`, so releasing it here never touches another control's binding.
    let colorWell = MarkupColorWell(style: .default)
    private let undoButton = MarkupButton(), clearButton = MarkupButton(), cancelButton = MarkupButton(), addButton = MarkupButton()
    private let statusLabel = NSTextField(labelWithString: PreviewMarkupOverlay.status)
    private let errorLabel = NSTextField(wrappingLabelWithString: "")
    /// The island's frame in this view.
    var barFrame: NSRect { island.frame }
    /// LKM-451: how far the corner probe stays from the window's edges. A `.resizable` window with
    /// a `minSize` (the Host's) has its theme frame claim the outermost ~4 pt of every edge, and a
    /// diagonal zone ~16-20 pt deep at the rounded corners, before any content view: the page's
    /// bottom edge is the window's, so a probe 2 pt inside the snapshot lands on NSThemeFrame. The
    /// pen cannot draw there either (AppKit resizes the window), so that is not a point to prove.
    static let edgeClear: CGFloat = 24
    /// A point in window coordinates on the drawable page near its lower-left corner: 2 pt inside
    /// the snapshot, pushed `edgeClear` in from the window's edges, never outside the snapshot.
    func cornerProbe() -> NSPoint {
        let snapshot = convert(canvas.frame, to: nil)
        var near = NSPoint(x: snapshot.minX + 2, y: snapshot.minY + 2)
        if let root = window?.contentView?.superview {
            let edges = root.convert(root.bounds, to: nil)
            near.x = max(near.x, edges.minX + Self.edgeClear)
            near.y = max(near.y, edges.minY + Self.edgeClear)
        }
        return NSPoint(x: min(near.x, snapshot.maxX - 2), y: min(near.y, snapshot.maxY - 2))
    }

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
        colorWell.color = canvas.ink.nsColor
        colorWell.target = self; colorWell.action = #selector(pickColor(_:))
        colorWell.toolTip = "Color for new marks and text"
        colorWell.setAccessibilityLabel("Annotation color")
        island.face.addSubview(colorWell)
        configure(undoButton, label: "Undo", symbol: "arrow.uturn.backward", hint: "Undo (⌘Z)"); undoButton.action = #selector(undo)
        configure(clearButton, label: "Clear", symbol: "trash", hint: "Clear all marks"); clearButton.action = #selector(clear)
        configure(cancelButton, label: "Cancel", symbol: nil, hint: "Discard this mark up (Esc)"); cancelButton.action = #selector(cancel)
        configure(addButton, label: "Add to chat", symbol: nil, hint: "Add the marked-up image to the message"); addButton.action = #selector(add)
        statusLabel.font = .systemFont(ofSize: 12); statusLabel.textColor = .secondaryLabelColor; statusLabel.lineBreakMode = .byTruncatingTail
        errorLabel.font = .systemFont(ofSize: 12); errorLabel.textColor = .systemRed; errorLabel.isHidden = true
        island.face.addSubview(statusLabel); island.face.addSubview(errorLabel)
        // Above the snapshot: the island floats over it, and the snapshot keeps the page's frame.
        addSubview(island)
        // Tab walks the bar and comes back: it never reaches the views under the overlay.
        var previous: NSView = self
        for control in toolButtons.map(\.1) { previous.nextKeyView = control; previous = control }
        previous.nextKeyView = colorWell; previous = colorWell
        for control in [undoButton, clearButton, cancelButton, addButton] { previous.nextKeyView = control; previous = control }
        previous.nextKeyView = self
        updateColors(); refresh()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    private func configure(_ button: NSButton, label: String, symbol: String?, hint: String, role: NSAccessibility.Role = .button) {
        button.bezelStyle = .rounded; button.target = self; button.toolTip = hint
        if let symbol { button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label); button.title = "" } else { button.title = label }
        button.cell?.setAccessibilityRole(role); button.cell?.setAccessibilityLabel(label)
        island.face.addSubview(button)
    }
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override var canBecomeKeyView: Bool { true }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); updateColors(); island.face.needsDisplay = true }
    private func updateColors() {
        effectiveAppearance.performAsCurrentDrawingAppearance { layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor }
    }
    /// A click here never reaches what is behind.
    override func mouseDown(with event: NSEvent) { window?.makeFirstResponder(self) }

    /// The snapshot's frame here: the live page's, so nothing moves or scales when Mark up opens.
    var pageFrame: NSRect {
        guard let page, let superview, page.width > 0, page.height > 0 else { return bounds }
        let frame = convert(page, from: superview).intersection(bounds)
        return frame.isNull || frame.isEmpty ? bounds : frame
    }
    override func layout() {
        super.layout()
        let shown = pageFrame
        canvas.frame = shown
        // The island: one row when the tools, the status and the actions fit across the preview,
        // then one row without the status, then the actions under the tools.
        let padding = Self.padding, gap = Self.gap, row = Self.rowHeight
        let room = max(0, shown.width - Self.inset * 2)
        let buttons = toolButtons.map(\.1) + [undoButton, clearButton]
        let count = CGFloat(buttons.count)
        let colorWidth: CGFloat = 44
        let tools = count * Self.toolWidth + (count - 1) * gap + gap + colorWidth, actions = Self.cancelWidth + gap + Self.addWidth
        let status = ceil(statusLabel.intrinsicContentSize.width) + padding
        let bare = padding + tools + padding + actions + padding
        let oneRow = room >= bare
        var width = oneRow ? min(room, bare + status) : min(room, padding * 2 + max(tools, actions))
        if errorShown { width = max(width, min(room, Self.errorWidth)) }
        let side = max(12, min(Self.toolWidth, (width - padding * 2 - colorWidth - gap * count) / count))
        for (index, button) in buttons.enumerated() {
            button.frame = NSRect(x: padding + CGFloat(index) * (side + gap), y: padding, width: side, height: row)
        }
        colorWell.frame = NSRect(x: padding + count * (side + gap), y: padding, width: colorWidth, height: row)
        let top = oneRow ? padding : padding * 1.5 + row
        addButton.frame = NSRect(x: width - padding - Self.addWidth, y: top, width: Self.addWidth, height: row)
        cancelButton.frame = NSRect(x: addButton.frame.minX - gap - Self.cancelWidth, y: top, width: Self.cancelWidth, height: row)
        let left = oneRow ? colorWell.frame.maxX + padding : padding
        let space = cancelButton.frame.minX - padding - left
        statusLabel.frame = NSRect(x: left, y: top + 6, width: max(0, space), height: 16)
        statusLabel.isHidden = space < 120
        var bottom = top + row + padding
        if errorShown {
            let text = errorLabel.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: width - padding * 2, height: 200)).height ?? 16
            errorLabel.frame = NSRect(x: padding, y: bottom - padding / 2, width: width - padding * 2, height: text)
            bottom = errorLabel.frame.maxY + padding
        }
        // Centred at the top of the page, inside it, over the snapshot.
        island.frame = backingAlignedRect(NSRect(x: shown.midX - width / 2, y: shown.minY + Self.inset, width: width, height: bottom), options: .alignAllEdgesNearest)
    }
    private func refresh() {
        let marks = canvas.document.marks.count
        for (candidate, button) in toolButtons {
            button.state = candidate == tool ? .on : .off
            button.contentTintColor = candidate == tool ? .controlAccentColor : nil
            button.cell?.setAccessibilityValue(candidate == tool ? "selected" : "")
        }
        colorWell.isEnabled = !adding
        undoButton.isEnabled = !adding && canvas.document.canUndo
        clearButton.isEnabled = !adding && marks > 0
        // Only a marked image can leave: an unmarked original is never added.
        addButton.isEnabled = !adding && (marks > 0 || canvas.hasDraft) && !canvas.document.isDrawing
        statusLabel.stringValue = adding ? "Adding…" : Self.status
    }
    /// A failure stays on screen, in its own row, until the next attempt.
    func show(error: String?) {
        errorLabel.stringValue = error ?? ""
        errorLabel.isHidden = error == nil
        needsLayout = true; layout()
    }
    func select(_ tool: MarkupTool) { canvas.commitText(); self.tool = tool; canvas.tool = tool; refresh() }
    @objc private func pick(_ sender: NSButton) { select(MarkupTool.allCases[sender.tag]) }
    /// The panel's choice, live while it is dragged: the ink of the next marks only. A text
    /// draft commits in the colour it was typed in first.
    @objc private func pickColor(_ sender: NSColorWell) {
        guard sender === colorWell, !adding, !isHidden, window != nil, let ink = MarkupInk(sender.color) else { return }
        canvas.commitText()
        canvas.ink = ink
    }
    /// Unbind the shared panel from this overlay's well, and put the panel away, only when it is
    /// this well's: another control's active well and its panel are left as they are.
    func releaseColorPanel() {
        guard colorWell.isActive else { return }
        colorWell.deactivate()
        if NSColorPanel.sharedColorPanelExists { NSColorPanel.shared.orderOut(nil) }
    }
    override func viewWillMove(toWindow newWindow: NSWindow?) {
        if newWindow == nil { releaseColorPanel() }
        super.viewWillMove(toWindow: newWindow)
    }
    override func viewDidHide() { releaseColorPanel(); super.viewDidHide() }
    @objc func undo() { if !adding { canvas.commitText(); canvas.undo() } }
    @objc func clear() { if !adding { canvas.commitText(); canvas.clear() } }
    @objc func cancel() { onCancel?() }
    @objc func add() { canvas.commitText(); onAdd?() }

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
