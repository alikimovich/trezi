import AppKit

/// The opaque cover over the preview area while a session is open: the live page never shows
/// through and takes no keys. LKM-448: the snapshot sits exactly where the page was, at its
/// size, and the controls float over it, so opening and closing moves and resizes nothing.
/// Labels and roles sit on the buttons' cells (LKM-379).
///
/// LKM-647: the island is compact and contextual. Idle (no marks, no region): Select, Pen, the
/// shapes, Text and a trailing Close. A drawing tool or a selected mark adds its colour (the
/// standard panel, LKM-645) and, for stroked marks, its weight; content adds Undo, Redo,
/// Delete and Add to chat. No filler text: only a failure or "Adding…" is ever written there.
/// It sits at the top of the page (LKM-671); its width follows the context, the snapshot never moves.
final class PreviewMarkupOverlay: NSView {
    private static let padding: CGFloat = 8, gap: CGFloat = 4, rowHeight: CGFloat = 28, toolWidth: CGFloat = 32
    private static let chevronWidth: CGFloat = 16, colorWidth: CGFloat = 44, strokeWidth: CGFloat = 58, addWidth: CGFloat = 104
    private static let dividerWidth: CGFloat = 9
    /// Room between the island and the preview's edges (`FloatingIsland.inset`).
    static let inset: CGFloat = 10
    /// The widest an island with an error gets, so the message wraps rather than spans the page.
    private static let errorWidth: CGFloat = 480

    let canvas: PreviewMarkupCanvas
    let island = PreviewMarkupIsland()
    private(set) var tool = MarkupTool.select
    /// The shape the shapes slot shows and picks.
    private(set) var shape = MarkupTool.rectangle
    var onCancel: (() -> Void)?
    var onAdd: (() -> Void)?
    /// Bun has the image and has not answered yet.
    var adding = false { didSet { if adding { releaseColorPanel() }; canvas.locked = adding; refresh() } }
    let animates = false
    /// The live page's frame in the superview's coordinates; the snapshot takes exactly that.
    /// Nil: the whole overlay.
    var page: NSRect? { didSet { if page != oldValue { needsLayout = true } } }
    private var toolButtons: [(MarkupTool, MarkupButton)] = []
    /// The shapes share one slot: the button picks the last shape, the chevron's menu any of them.
    let shapeButton = MarkupButton(), shapeMenuButton = MarkupButton()
    let shapeMenu = NSMenu(title: "Shapes")
    /// LKM-645: the ink. Each overlay owns its well; only an active well is bound to the shared
    /// `NSColorPanel`, so releasing it here never touches another control's binding.
    let colorWell = MarkupColorWell(style: .default)
    let strokePopUp = MarkupPopUp(frame: .zero, pullsDown: false)
    private let undoButton = MarkupButton(), redoButton = MarkupButton(), deleteButton = MarkupButton()
    private let addButton = MarkupButton(), closeButton = MarkupButton()
    private let toolsDivider = NSBox(), styleDivider = NSBox()
    private let errorLabel = NSTextField(wrappingLabelWithString: "")
    /// What is shown, so layout runs only when that changes.
    private var shownSignature: [Bool] = []
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

    /// Every control in Tab order, shown or not (`isHidden` says which).
    var controls: [NSButton] {
        let tools: [NSButton] = toolButtons.map { $0.1 }
        let shapes: [NSButton] = [shapeButton, shapeMenuButton]
        let rest: [NSButton] = [strokePopUp, undoButton, redoButton, deleteButton, addButton, closeButton]
        return Array(tools.prefix(2)) + shapes + Array(tools.dropFirst(2)) + rest
    }
    var addEnabled: Bool { addButton.isEnabled && !addButton.isHidden }
    var undoEnabled: Bool { undoButton.isEnabled && !undoButton.isHidden }
    var redoEnabled: Bool { redoButton.isEnabled && !redoButton.isHidden }
    var deleteEnabled: Bool { deleteButton.isEnabled && !deleteButton.isHidden }
    var errorShown: Bool { !errorLabel.isHidden }
    /// What the island says in words: a failure, or that Add is running. Nothing otherwise.
    var statusText: String { errorShown ? errorLabel.stringValue : adding ? "Adding…" : "" }

    init(image: CGImage) {
        canvas = PreviewMarkupCanvas(image: image)
        super.init(frame: .zero)
        wantsLayer = true
        addSubview(canvas)
        canvas.changed = { [weak self] in self?.refresh() }
        for tool in [MarkupTool.select, .pen, .text] {
            let button = MarkupButton()
            let hint = tool == .select ? "Select a mark to edit it, or drag to capture a region of the preview (S)" : "\(tool.label) (\(tool.key.uppercased()))"
            configure(button, label: tool.label, symbol: tool.symbol, hint: hint, role: .radioButton)
            button.setButtonType(.toggle); button.action = #selector(pick(_:))
            toolButtons.append((tool, button))
        }
        configure(shapeButton, label: shape.label, symbol: shape.symbol, hint: "", role: .radioButton)
        shapeButton.setButtonType(.toggle); shapeButton.action = #selector(pickShapeSlot)
        configure(shapeMenuButton, label: "Shapes", symbol: "chevron.down", hint: "Rectangle, circle or arrow", role: .menuButton)
        shapeMenuButton.isBordered = false; shapeMenuButton.action = #selector(showShapes)
        shapeMenuButton.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 9, weight: .semibold)
        for (index, candidate) in MarkupTool.shapes.enumerated() {
            let item = NSMenuItem(title: candidate.label, action: #selector(pickShape(_:)), keyEquivalent: "")
            item.target = self; item.tag = index
            item.image = NSImage(systemSymbolName: candidate.symbol, accessibilityDescription: nil)
            shapeMenu.addItem(item)
        }
        colorWell.color = canvas.ink.nsColor
        colorWell.target = self; colorWell.action = #selector(pickColor(_:))
        colorWell.setAccessibilityLabel("Annotation color")
        island.face.addSubview(colorWell)
        for weight in MarkupStroke.allCases {
            strokePopUp.addItem(withTitle: weight.label)
            strokePopUp.lastItem?.image = Self.strokeImage(weight)
            strokePopUp.lastItem?.representedObject = weight.rawValue
        }
        (strokePopUp.cell as? NSPopUpButtonCell)?.imagePosition = .imageOnly
        strokePopUp.target = self; strokePopUp.action = #selector(pickStroke(_:))
        strokePopUp.toolTip = "Stroke width"
        strokePopUp.setAccessibilityLabel("Stroke width"); strokePopUp.cell?.setAccessibilityLabel("Stroke width")
        MarkupButton.round(strokePopUp)
        island.face.addSubview(strokePopUp)
        configure(undoButton, label: "Undo", symbol: "arrow.uturn.backward", hint: "Undo (⌘Z)"); undoButton.action = #selector(undo)
        configure(redoButton, label: "Redo", symbol: "arrow.uturn.forward", hint: "Redo (⇧⌘Z)"); redoButton.action = #selector(redo)
        configure(deleteButton, label: "Delete", symbol: "trash", hint: "Delete the selection (⌫)"); deleteButton.action = #selector(deleteSelection)
        configure(addButton, label: "Add to chat", symbol: nil, hint: ""); addButton.action = #selector(add)
        addButton.bezelColor = .controlAccentColor
        configure(closeButton, label: "Close annotation tools", symbol: "xmark", hint: ""); closeButton.action = #selector(cancel)
        for divider in [toolsDivider, styleDivider] { divider.boxType = .separator; island.face.addSubview(divider) }
        errorLabel.font = .systemFont(ofSize: 12); errorLabel.textColor = .systemRed; errorLabel.isHidden = true
        island.face.addSubview(errorLabel)
        // Above the snapshot: the island floats over it, and the snapshot keeps the page's frame.
        addSubview(island)
        // Tab walks the bar and comes back: it never reaches the views under the overlay.
        var previous: NSView = self
        let order = Array(controls.prefix(5)) + [colorWell] + Array(controls.dropFirst(5))
        for control in order { previous.nextKeyView = control; previous = control }
        previous.nextKeyView = self
        canvas.tool = tool
        updateColors(); refresh()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    private func configure(_ button: NSButton, label: String, symbol: String?, hint: String, role: NSAccessibility.Role = .button) {
        button.bezelStyle = .rounded; button.target = self; button.toolTip = hint.isEmpty ? nil : hint
        MarkupButton.round(button)
        if let symbol { button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label); button.title = "" } else { button.title = label }
        button.cell?.setAccessibilityRole(role); button.cell?.setAccessibilityLabel(label)
        island.face.addSubview(button)
    }
    /// A short horizontal line of the weight, for the stroke menu and its button.
    private static func strokeImage(_ weight: MarkupStroke) -> NSImage {
        let image = NSImage(size: NSSize(width: 22, height: 12), flipped: false) { rect in
            NSColor.labelColor.setFill()
            let height = 1.5 * weight.scale
            NSBezierPath(roundedRect: NSRect(x: 2, y: rect.midY - height / 2, width: rect.width - 4, height: height), xRadius: height / 2, yRadius: height / 2).fill()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = weight.label
        return image
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
        // The shown controls flow in rows; Close always ends the first row, at the right edge.
        let padding = Self.padding, gap = Self.gap, row = Self.rowHeight
        let room = max(0, shown.width - Self.inset * 2), content = max(Self.toolWidth, room - padding * 2)
        for divider in [toolsDivider, styleDivider] { divider.isHidden = !dividerShown(divider) }
        let items: [(NSView, CGFloat)] = [
            (toolButtons[0].1, Self.toolWidth), (toolButtons[1].1, Self.toolWidth), (shapeButton, Self.toolWidth),
            (shapeMenuButton, Self.chevronWidth), (toolButtons[2].1, Self.toolWidth), (toolsDivider, Self.dividerWidth),
            (colorWell, Self.colorWidth), (strokePopUp, Self.strokeWidth), (styleDivider, Self.dividerWidth),
            (undoButton, Self.toolWidth), (redoButton, Self.toolWidth), (deleteButton, Self.toolWidth), (addButton, Self.addWidth)
        ].filter { !$0.0.isHidden }
        var rows: [[(NSView, CGFloat)]] = [[]], used: CGFloat = 0
        for (view, wanted) in items {
            let width = min(wanted, content)
            // The chevron stays with its shape (they wrap as one); Close keeps its place on the first row.
            let tied = view === shapeMenuButton, unit = view === shapeButton ? width + Self.chevronWidth : width
            let limit = rows.count == 1 ? content - Self.toolWidth - gap : content
            if !rows[rows.count - 1].isEmpty, !tied, used + gap + unit > limit { rows.append([]); used = 0 }
            // A divider never starts a row.
            if view is NSBox, rows[rows.count - 1].isEmpty { view.isHidden = true; continue }
            used += (rows[rows.count - 1].isEmpty || tied ? 0 : gap) + width
            rows[rows.count - 1].append((view, width))
        }
        // Nor ends a wrapped one (the first row's is followed by Close).
        for index in rows.indices.dropFirst() where rows[index].last?.0 is NSBox { rows[index].last?.0.isHidden = true; rows[index].removeLast() }
        func span(_ items: [(NSView, CGFloat)]) -> CGFloat {
            items.enumerated().reduce(0) { $0 + $1.element.1 + ($1.offset == 0 || $1.element.0 === shapeMenuButton ? 0 : gap) }
        }
        let first = span(rows[0]) + (rows[0].isEmpty ? 0 : gap) + Self.toolWidth
        var width = min(room, padding * 2 + max(first, rows.dropFirst().map(span).max() ?? 0))
        if errorShown { width = max(width, min(room, Self.errorWidth)) }
        // LKM-671: the tools row is the first thing in the island, so it never moves when an
        // error or a wrapped row is added below it.
        var top = padding
        for (index, line) in rows.enumerated() {
            var x = padding
            for (offset, (view, itemWidth)) in line.enumerated() {
                if offset > 0, view !== shapeMenuButton { x += gap }
                view.frame = NSRect(x: x, y: top, width: itemWidth, height: row)
                x += itemWidth
            }
            if index == 0 { closeButton.frame = NSRect(x: width - padding - Self.toolWidth, y: top, width: Self.toolWidth, height: row) }
            top += row + (index == rows.count - 1 ? 0 : gap)
        }
        if errorShown {
            let text = errorLabel.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: width - padding * 2, height: 200)).height ?? 16
            errorLabel.frame = NSRect(x: padding, y: top + padding / 2, width: width - padding * 2, height: text)
            top = errorLabel.frame.maxY
        }
        // LKM-671: anchored to the top of the page, inside it, over the snapshot: a taller island
        // (a wrapped row, an error) grows downward and the controls under the pointer stay put.
        let height = top + padding
        island.frame = backingAlignedRect(NSRect(x: shown.midX - width / 2, y: shown.minY + Self.inset, width: width, height: height), options: .alignAllEdgesNearest)
    }
    /// The tools divider always shows (in the idle island it sets Close apart); the style
    /// divider only between colour/stroke and the history controls.
    private func dividerShown(_ divider: NSView) -> Bool {
        divider === toolsDivider || (!colorWell.isHidden && !undoButton.isHidden)
    }
    private func refresh() {
        let document = canvas.document, region = canvas.region.valid, selected = canvas.selectedMark
        let marks = document.marks.count
        let content = marks > 0 || canvas.hasDraft || region != nil
        for (candidate, button) in toolButtons { mark(button, on: candidate == tool) }
        mark(shapeButton, on: tool.isShape)
        shapeButton.image = NSImage(systemSymbolName: shape.symbol, accessibilityDescription: shape.label)
        shapeButton.cell?.setAccessibilityLabel(shape.label)
        shapeButton.toolTip = "\(shape.label) (\(shape.key.uppercased()))"
        for item in shapeMenu.items { item.state = MarkupTool.shapes[item.tag] == shape ? .on : .off }
        // Colour for a drawing tool's next marks or the selected mark; weight only where it applies.
        colorWell.isHidden = selected == nil && !(tool.strokes || tool == .text)
        strokePopUp.isHidden = !(selected.map { $0.tool.strokes } ?? tool.strokes)
        let ink = selected?.ink ?? canvas.ink, weight = selected?.stroke ?? canvas.stroke
        if MarkupInk(colorWell.color)?.hex != ink.hex { colorWell.color = ink.nsColor }
        strokePopUp.selectItem(at: MarkupStroke.allCases.firstIndex(of: weight) ?? 1)
        let target = selected == nil ? "new marks" : "the selected \(selected!.tool.label.lowercased())"
        colorWell.toolTip = "Color for \(target)"
        strokePopUp.toolTip = "Stroke width for \(target)"
        colorWell.isEnabled = !adding; strokePopUp.isEnabled = !adding
        // History and Delete once there is something to act on; Add only with something to send.
        // After the last content is undone, Undo/Redo stay (Redo still has work) and Delete goes.
        let history = content || document.canUndo || document.canRedo
        for button in [undoButton, redoButton] { button.isHidden = !history }
        deleteButton.isHidden = !content
        undoButton.isEnabled = !adding && document.canUndo
        redoButton.isEnabled = !adding && document.canRedo
        deleteButton.isEnabled = !adding && (selected != nil || region != nil)
        deleteButton.toolTip = selected != nil ? "Delete the selected \(selected!.tool.label.lowercased()) (⌫)" : region != nil ? "Remove the selected region (⌫)" : "Delete the selection (⌫)"
        // Only a marked image or an explicitly selected region (LKM-646) can leave: an unmarked
        // whole original is never added.
        addButton.isHidden = !(content || adding)
        addButton.isEnabled = !adding && content && !document.isDrawing && !document.isEditing && !canvas.region.isDragging
        addButton.title = adding ? "Adding…" : "Add to chat"
        addButton.toolTip = region.map { "Add the selected region (\(Int($0.width)) × \(Int($0.height)) px) to the message" }
            ?? "Add the marked-up preview to the message"
        closeButton.isEnabled = true
        closeButton.toolTip = content ? "Close annotation tools and discard the unsent marks (Esc)" : "Close annotation tools (Esc)"
        let signature = controls.map(\.isHidden) + [colorWell.isHidden, errorShown]
        if signature != shownSignature {
            shownSignature = signature
            needsLayout = true; layout()
            // A control that just went away hands the keys back to the overlay, never to nothing.
            if let focused = window?.firstResponder as? NSView, focused !== self, focused.isDescendant(of: island), focused.isHiddenOrHasHiddenAncestor {
                window?.makeFirstResponder(self)
            }
        }
    }
    /// LKM-671: the current tool keeps its on state and a filled accent bezel
    /// (`MarkupButton.selectedTool`, its `pill`) after the press ends, for a click, a key or the menu alike.
    private func mark(_ button: MarkupButton, on: Bool) {
        button.state = on ? .on : .off
        button.selectedTool = on
        button.cell?.setAccessibilityValue(on ? "selected" : "")
    }
    /// A failure stays on screen, in its own row, until the next attempt.
    func show(error: String?) {
        errorLabel.stringValue = error ?? ""
        errorLabel.isHidden = error == nil
        shownSignature = []
        needsLayout = true; layout()
    }
    func select(_ tool: MarkupTool) {
        canvas.commitText()
        self.tool = tool
        if tool.isShape { shape = tool }
        canvas.tool = tool; refresh()
    }
    @objc private func pick(_ sender: NSButton) { if let tool = toolButtons.first(where: { $0.1 === sender })?.0 { select(tool) } }
    @objc private func pickShapeSlot() { select(shape) }
    @objc private func pickShape(_ sender: NSMenuItem) { select(MarkupTool.shapes[sender.tag]) }
    @objc private func showShapes() {
        guard !adding else { return }
        shapeMenu.popUp(positioning: shapeMenu.item(withTag: MarkupTool.shapes.firstIndex(of: shape) ?? 0), at: .zero, in: shapeButton)
    }
    /// The panel's choice, live while it is dragged: the selected mark's colour (one Undo step
    /// per drag), or else the ink of the next marks. A text draft commits in its own colour first.
    @objc private func pickColor(_ sender: NSColorWell) {
        guard sender === colorWell, !adding, !isHidden, window != nil, let ink = MarkupInk(sender.color) else { return }
        canvas.commitText()
        if let selected = canvas.selectedMark {
            if selected.ink.hex != ink.hex { canvas.restyleSelection(ink: ink, coalesce: true) }
        } else { canvas.ink = ink }
    }
    @objc private func pickStroke(_ sender: NSPopUpButton) {
        guard !adding, let raw = sender.selectedItem?.representedObject as? String, let weight = MarkupStroke(rawValue: raw) else { return }
        if canvas.selectedMark != nil { canvas.restyleSelection(stroke: weight) } else { canvas.stroke = weight }
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
    @objc func redo() { if !adding { canvas.commitText(); canvas.redo() } }
    @objc func deleteSelection() { if !adding { canvas.deleteSelection() } }
    /// Clear All: every mark, one Undo step; the canvas's context menu offers it, apart from Delete.
    @objc func clear() { if !adding { canvas.commitText(); canvas.clear() } }
    /// Close: the session goes, unsent marks with it, as Escape and the top bar button do. It never adds.
    @objc func cancel() { onCancel?() }
    /// Escape: a selected mark is let go first, then a selected region, as in other macOS
    /// selections; then the session.
    func escape() {
        if adding { cancel(); return }
        if canvas.deselect() || canvas.clearRegion() { return }
        cancel()
    }
    @objc func add() { canvas.commitText(); onAdd?() }

    /// Whether the keyboard is here, not on the chat next to it.
    var ownsFocus: Bool { (window?.firstResponder as? NSView)?.isDescendant(of: self) == true }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { escape(); return }
        if event.keyCode == 48 {
            if event.modifierFlags.contains(.shift) { window?.selectPreviousKeyView(nil) } else { window?.selectNextKeyView(nil) }
            return
        }
        let plain = event.modifierFlags.intersection(KeyShortcut.shortcutModifiers).isEmpty
        if plain, [51, 117].contains(event.keyCode) { deleteSelection(); return }
        guard plain, let key = KeyShortcut.latin(event)?.lowercased(),
              let tool = MarkupTool.allCases.first(where: { $0.key == key }) else { return }
        select(tool)
    }
    override func cancelOperation(_ sender: Any?) { escape() }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        // Typing on the canvas keeps its own Undo (the menu routes it to the text view).
        if ownsFocus, !(window?.firstResponder is NSText) {
            if KeyShortcut.matches(event, "z", .command) { undo(); return true }
            if KeyShortcut.matches(event, "z", [.command, .shift]) { redo(); return true }
        }
        return super.performKeyEquivalent(with: event)
    }
}
