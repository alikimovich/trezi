import AppKit

/// The frozen snapshot and the marks over it. `image` is the captured bitmap and never
/// changes, whatever the page does underneath. Nothing here animates, so Reduce Motion has
/// nothing to reduce.
final class PreviewMarkupCanvas: NSView, NSTextFieldDelegate {
    let image: CGImage
    private(set) var document: MarkupDocument
    /// LKM-646: the part of the snapshot Add sends; never a mark.
    private(set) var region: MarkupRegion
    /// LKM-647: the drawn mark the Select tool picked, if any. Only Select holds one.
    private(set) var selection: Int?
    var tool = MarkupTool.select {
        didSet { if tool != oldValue { if tool != .select { selection = nil }; needsDisplay = true; updateLabel(); updateCursor() } }
    }
    /// The colour and weight of the next mark.
    var ink = MarkupInk.red
    var stroke = MarkupStroke.medium
    /// While Add commits, the context menu offers nothing.
    var locked = false
    var changed: (() -> Void)?
    private var textEditor: NSTextField?
    private var textPoint: CGPoint?
    private var textIndex: Int?
    /// A move or resize of the selected mark: the mark as it was, the handle, where it began.
    private var markDrag: (index: Int, start: MarkupMark, handle: MarkupSelection.Handle?, from: CGPoint)?

    init(image: CGImage) {
        self.image = image
        document = MarkupDocument(size: CGSize(width: image.width, height: image.height))
        region = MarkupRegion(size: CGSize(width: image.width, height: image.height))
        super.init(frame: .zero)
        setAccessibilityElement(true); setAccessibilityRole(.image)
        updateLabel()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var isFlipped: Bool { true }
    var mapping: MarkupMapping { MarkupMapping(image: document.size, bounds: bounds) }
    var selectedMark: MarkupMark? { selection.flatMap { document.marks.indices.contains($0) ? document.marks[$0] : nil } }
    private var tolerance: CGFloat { mapping.scale > 0 ? MarkupSelection.grab / mapping.scale : MarkupSelection.grab }
    private var regionTolerance: CGFloat { mapping.scale > 0 ? MarkupRegionChrome.grab / mapping.scale : MarkupRegionChrome.grab }

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
        // On screen only: the composite never sees the dimming, outline or handles.
        if let rect = region.rect { MarkupRegionChrome.draw(rect, mapping: mapping, handles: tool == .select && selection == nil, in: context) }
        if let mark = selectedMark { MarkupSelection.draw(mark, mapping: mapping, in: context) }
    }
    private func updateLabel() {
        let count = document.marks.count
        var label = "Preview snapshot, \(count) \(count == 1 ? "mark" : "marks")"
        if let mark = selectedMark { label += ", \(mark.tool.label.lowercased()) selected" }
        if let rect = region.valid { label += ", region \(Int(rect.width)) by \(Int(rect.height)) pixels selected" }
        setAccessibilityLabel(label)
    }
    private func edited() { needsDisplay = true; updateLabel(); updateCursor(); changed?() }
    func pointerDown(_ point: NSPoint, tool: MarkupTool) {
        commitText()
        if tool == .text { selection = nil; editText(at: point); return }
        let image = mapping.toImage(point)
        if tool == .select {
            // The selected mark's handles, then the region's, then a mark, then the snapshot.
            if let index = selection, let mark = selectedMark, let handle = MarkupSelection.handle(of: mark, at: image, tolerance: tolerance) {
                startMarkDrag(index, handle: handle, at: image); edited(); return
            }
            if region.handle(at: image, tolerance: regionTolerance) == nil,
               let index = MarkupSelection.hit(document.marks, at: image, tolerance: tolerance, size: document.size) {
                selection = index; startMarkDrag(index, handle: nil, at: image); edited(); return
            }
            selection = nil
            region.begin(at: image, tolerance: regionTolerance); edited(); return
        }
        selection = nil
        document.begin(tool, at: image, ink: ink, stroke: stroke); edited()
    }
    private func startMarkDrag(_ index: Int, handle: MarkupSelection.Handle?, at point: CGPoint) {
        document.beginEdit()
        markDrag = (index, document.marks[index], handle, point)
    }
    func pointerDragged(_ point: NSPoint) {
        let image = mapping.toImage(point)
        if let drag = markDrag {
            document.update(at: drag.index, points: MarkupSelection.dragged(drag.start, handle: drag.handle, from: drag.from, to: image, size: document.size))
        } else if region.isDragging { region.extend(to: image) } else { document.extend(to: image) }
        edited()
    }
    func pointerUp() {
        if markDrag != nil { markDrag = nil; document.endEdit() } else if region.isDragging { region.finish() } else { document.finish() }
        edited()
    }
    /// Escape's first step: the region goes and the session stays. False with no region.
    func clearRegion() -> Bool {
        guard region.clear() else { return false }
        edited(); return true
    }
    /// Escape's very first step: the mark is let go, nothing changes. False with none selected.
    func deselect() -> Bool {
        guard selection != nil, markDrag == nil else { return false }
        selection = nil; edited(); return true
    }
    /// LKM-647: Delete takes the selected mark (one Undo step) or else the selected region,
    /// never everything. False with neither.
    @discardableResult func deleteSelection() -> Bool {
        commitText()
        if let index = selection, markDrag == nil {
            selection = nil; document.remove(at: index); edited(); return true
        }
        return clearRegion()
    }
    /// LKM-647: a new colour or weight for the selected mark only.
    func restyleSelection(ink: MarkupInk? = nil, stroke weight: MarkupStroke? = nil, coalesce: Bool = false) {
        guard let index = selection, markDrag == nil else { return }
        document.restyle(at: index, ink: ink, stroke: weight, coalesce: coalesce); edited()
    }
    /// A selection survives Undo/Redo only while it still names the same place.
    private func stepped(_ step: () -> Void) {
        let count = document.marks.count
        markDrag = nil; step()
        if document.marks.count != count { selection = nil }
        edited()
    }
    func undo() { stepped { document.undo() } }
    func redo() { stepped { document.redo() } }
    func clear() { markDrag = nil; selection = nil; document.clear(); edited() }
    var hasDraft: Bool { textEditor?.stringValue.isEmpty == false }
    var editingText: Bool { textEditor != nil }
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

    /// LKM-647: Clear All stays a deliberate action of its own, apart from Delete.
    override func menu(for event: NSEvent) -> NSMenu? {
        guard !locked else { return nil }
        let menu = NSMenu(); menu.autoenablesItems = false
        let delete = NSMenuItem(title: "Delete Selected Mark", action: #selector(deleteFromMenu), keyEquivalent: "")
        delete.target = self; delete.isEnabled = selection != nil
        let clear = NSMenuItem(title: "Clear All Marks", action: #selector(clearFromMenu), keyEquivalent: "")
        clear.target = self; clear.isEnabled = !document.marks.isEmpty
        menu.addItem(delete); menu.addItem(.separator()); menu.addItem(clear)
        return menu
    }
    @objc private func deleteFromMenu() { guard !locked, selection != nil else { return }; deleteSelection() }
    @objc func clearFromMenu() { guard !locked else { return }; commitText(); clear() }

    override func mouseDown(with event: NSEvent) {
        if tool != .text, let overlay = superview { window?.makeFirstResponder(overlay) }
        let point = convert(event.locationInWindow, from: nil)
        let grabbing = tool == .select && pointer(at: point) == .openHand
        pointerDown(point, tool: tool)
        if grabbing { NSCursor.closedHand.set(); selectCursorShown = true }
    }
    override func mouseDragged(with event: NSEvent) { pointerDragged(convert(event.locationInWindow, from: nil)) }
    override func mouseUp(with event: NSEvent) { pointerUp() }

    // LKM-646/647: the pointer tells what a press will do while Select is the tool. Set only
    // where the canvas is what the pointer is over, so the island's buttons keep the arrow.
    private var pointerArea: NSTrackingArea?
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let pointerArea { removeTrackingArea(pointerArea) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseMoved, .cursorUpdate, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area); pointerArea = area
    }
    override func cursorUpdate(with event: NSEvent) { if tool == .select { updateCursor() } else { super.cursorUpdate(with: event) } }
    override func mouseMoved(with event: NSEvent) { updateCursor() }
    override func mouseExited(with event: NSEvent) { if tool == .select { NSCursor.arrow.set() } }
    private var selectCursorShown = false
    /// What a press with Select does here: the selected mark's handles, the region's, a mark, the region.
    private func pointer(at point: CGPoint) -> NSCursor {
        if let selected = selectedMark, let cursor = MarkupSelection.cursor(at: point, selected: selected, marks: [], mapping: mapping) { return cursor }
        if region.handle(at: mapping.toImage(point), tolerance: regionTolerance) == nil,
           let cursor = MarkupSelection.cursor(at: point, selected: nil, marks: document.marks, mapping: mapping) { return cursor }
        return MarkupRegionChrome.cursor(at: point, region: region, mapping: mapping)
    }
    private func updateCursor() {
        guard let window, !isHidden else { return }
        let location = window.mouseLocationOutsideOfEventStream
        let over = window.contentView?.superview?.hitTest(location) === self
        let point = convert(location, from: nil)
        let dragging = region.isDragging || markDrag != nil
        if tool == .select, over, !dragging, mapping.frame.contains(point) {
            pointer(at: point).set(); selectCursorShown = true
        } else if selectCursorShown, !dragging {
            NSCursor.arrow.set(); selectCursorShown = false
        }
    }
}

/// Tab reaches it with or without Full Keyboard Access; a disabled one is skipped. Keys it
/// does not use go up to the overlay, never to the page.
final class MarkupButton: NSButton {
    override var canBecomeKeyView: Bool { isEnabled && !isHidden }
    override var acceptsFirstResponder: Bool { isEnabled }
    override func keyDown(with event: NSEvent) {
        if [36, 49, 76].contains(event.keyCode) { performClick(nil) } else { nextResponder?.keyDown(with: event) }
    }
    /// LKM-671: the current tool. Its on state shows as a filled accent capsule (`pill`, a view
    /// of its own just below the button) with a white glyph that stays after the press ends:
    /// the rounded bezel's own on state is too faint to read (light or dark), and the press
    /// highlight and focus ring stay distinct from it.
    var selectedTool = false {
        didSet {
            guard selectedTool != oldValue else { return }
            isBordered = !selectedTool
            contentTintColor = selectedTool ? .white : nil
            placePill(); needsDisplay = true
        }
    }
    /// The fill under the selected tool. From macOS 26 a borderless NSButton renders through its
    /// layer and paints over whatever its superview drew there, so the fill is a sibling view,
    /// kept directly beneath the button and moved, sized and shown with it.
    let pill = MarkupSelectionPill()
    /// The bezel's own rect in the 28 pt row, so the fill matches the other buttons.
    var selectedFrame: NSRect { bounds.insetBy(dx: 0, dy: 2) }
    override var isHidden: Bool { didSet { placePill() } }
    override func setFrameOrigin(_ newOrigin: NSPoint) { super.setFrameOrigin(newOrigin); placePill() }
    override func setFrameSize(_ newSize: NSSize) { super.setFrameSize(newSize); placePill() }
    override func viewDidMoveToSuperview() { super.viewDidMoveToSuperview(); placePill() }
    private func placePill() {
        guard let superview, selectedTool || pill.superview != nil else { pill.removeFromSuperview(); return }
        if pill.superview !== superview { superview.addSubview(pill, positioned: .below, relativeTo: self) }
        pill.frame = selectedFrame.offsetBy(dx: frame.minX, dy: frame.minY)
        pill.isHidden = !selectedTool || isHidden
        pill.needsDisplay = true
    }
    /// LKM-671: the island is a capsule, so its buttons are too: the native capsule border
    /// shape (macOS 26) for the resting, hover and pressed bezels, at the same size and
    /// spacing. Older systems keep the rounded bezel; the selected fill is a capsule on both.
    static func round(_ button: NSButton) {
        if #available(macOS 26.0, *) { button.borderShape = .capsule }
    }
}

/// LKM-671: the selected tool's accent capsule, with an outline under Increase Contrast. It
/// draws itself (no layer of its own), beneath its button in the island face.
final class MarkupSelectionPill: NSView {
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
    override func draw(_ dirtyRect: NSRect) {
        let radius = min(bounds.width, bounds.height) / 2
        let path = NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius)
        NSColor.controlAccentColor.setFill(); path.fill()
        if NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast {
            let outline = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: radius - 0.5, yRadius: radius - 0.5)
            NSColor.labelColor.setStroke(); outline.lineWidth = 1; outline.stroke()
        }
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

/// LKM-647: the stroke width menu. Like `MarkupButton`, Tab reaches it, Space/Return and the
/// arrows open it, and other keys go up to the overlay.
final class MarkupPopUp: NSPopUpButton {
    override var canBecomeKeyView: Bool { isEnabled && !isHidden }
    override var acceptsFirstResponder: Bool { isEnabled }
    override func keyDown(with event: NSEvent) {
        if [36, 49, 76, 125, 126].contains(event.keyCode) { super.keyDown(with: event) } else { nextResponder?.keyDown(with: event) }
    }
}

/// LKM-448/647/671: the Mark up controls as an island floating at the top of the preview, over the
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
    /// How often the face painted (the toolbar fixture's diagnostics read it).
    private(set) var drawCount = 0
    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill()
        NSBezierPath(roundedRect: bounds, xRadius: PreviewMarkupIsland.cornerRadius, yRadius: PreviewMarkupIsland.cornerRadius).fill()
        drawCount += 1
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
