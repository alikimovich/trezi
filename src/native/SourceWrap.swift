import AppKit

/// Soft wrap in the code editor (LKM-192). Lines wrap at the visible width and each
/// wrapped line's continuation hangs at its own leading whitespace. Wrap Lines (View
/// menu and the editor's "…" menu) is the backend's `trezi:source-wrap` preference.
extension NativeSourceEditor: NSTextStorageDelegate, NSMenuItemValidation {
    /// Wrapping: the container tracks the text view, which follows the clip view's width.
    /// Not wrapping: the container is unbounded and the text view grows to the longest line.
    func setWrap(_ on: Bool) {
        guard let container = code.textContainer else { return }
        wraps = on
        scroll.hasHorizontalScroller = !on
        code.isHorizontallyResizable = !on
        container.widthTracksTextView = on
        if on {
            let clip = scroll.contentView
            if clip.bounds.minX != 0 { clip.scroll(to: NSPoint(x: 0, y: clip.bounds.minY)); scroll.reflectScrolledClipView(clip) }
            fitWidth()
        } else {
            container.size = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
            fitWidth(); code.sizeToFit()
        }
        scroll.verticalRulerView?.needsDisplay = true
    }
    /// Keeps the wrapping width equal to the visible width through every resize; without
    /// wrapping the text view is at least that wide.
    func fitWidth() {
        let width = scroll.contentView.bounds.width
        code.minSize = NSSize(width: wraps ? 0 : width, height: 0)
        guard wraps, let container = code.textContainer else {
            if code.frame.width < width { code.setFrameSize(NSSize(width: width, height: code.frame.height)) }
            return
        }
        let inner = max(0, width - 2 * code.textContainerInset.width)
        if abs(code.frame.width - width) > 0.5 { code.setFrameSize(NSSize(width: width, height: code.frame.height)) }
        if abs(container.size.width - inner) > 0.5 { container.size = NSSize(width: inner, height: CGFloat.greatestFiniteMagnitude) }
        scroll.verticalRulerView?.needsDisplay = true
    }
    /// Only records the edited lines: adding attributes while the storage processes a
    /// typed character misplaces the insertion point, so `applyIndent` runs afterwards.
    func textStorage(_ textStorage: NSTextStorage, didProcessEditing editedMask: NSTextStorageEditActions, range editedRange: NSRange, changeInLength delta: Int) {
        guard editedMask.contains(.editedCharacters) else { return }
        indentPending = indentPending.map { NSUnionRange($0, editedRange) } ?? editedRange
    }
    /// Gives the edited lines their hanging indent (a keystroke touches one line) and
    /// types with the insertion line's style, so the next keystroke needs no change.
    func applyIndent() {
        guard let range = indentPending, let storage = code.textStorage else { return }
        indentPending = nil
        storage.beginEditing(); SourceSyntaxTheme.indent(storage, in: range); storage.endEditing()
        let length = storage.length
        guard length > 0 else { return }
        var typing = code.typingAttributes
        typing[.paragraphStyle] = storage.attribute(.paragraphStyle, at: min(code.selectedRange().location, length - 1), effectiveRange: nil)
        code.typingAttributes = typing
    }
    @objc func toggleWrapLines(_ sender: Any?) { send("wrap", ["wrap": !wraps]) }
    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(toggleWrapLines(_:)) { item.state = wraps ? .on : .off }
        return true
    }
    /// The header's "…" menu.
    func moreMenu() -> NSMenu {
        let menu = NSMenu(), item = NSMenuItem(title: "Wrap Lines", action: #selector(toggleWrapLines(_:)), keyEquivalent: "")
        item.target = self; menu.addItem(item); return menu
    }
    func showMore(_ button: NSButton) { moreMenu().popUp(positioning: nil, at: NSPoint(x: 0, y: button.bounds.maxY + 4), in: button) }
}

extension SourceSyntaxTheme {
    static let space = (" " as NSString).size(withAttributes: [.font: regular]).width
    static let tabColumns = 4, maxHanging = 32
    /// One shared style per indent; tabs stop every four columns.
    static var hanging: [Int: NSParagraphStyle] = [:]
    static func paragraph(_ columns: Int) -> NSParagraphStyle {
        if let style = hanging[columns] { return style }
        let style = NSMutableParagraphStyle()
        style.tabStops = []; style.defaultTabInterval = space * CGFloat(tabColumns); style.headIndent = space * CGFloat(columns)
        hanging[columns] = style; return style
    }
    /// The leading whitespace of the line at `location`, in columns, capped so a deeply
    /// indented line still has room to wrap.
    static func columns(_ text: NSString, at location: Int, end: Int) -> Int {
        var column = 0, index = location
        while index < end, column < maxHanging {
            switch text.character(at: index) {
            case 32: column += 1
            case 9: column = (column / tabColumns + 1) * tabColumns
            default: return column
            }
            index += 1
        }
        return min(column, maxHanging)
    }
    /// Sets each line's hanging indent in `range` (widened to whole lines). Runs of lines
    /// with the same indent share one attribute run; an unchanged run is left alone.
    static func indent(_ storage: NSTextStorage, in range: NSRange) {
        let text = storage.string as NSString
        guard text.length > 0 else { return }
        let location = min(range.location, text.length)
        let lines = text.paragraphRange(for: NSRange(location: location, length: min(range.length, text.length - location)))
        var start = lines.location, current = -1, index = lines.location
        let flush = { (end: Int) in
            guard current >= 0, end > start else { return }
            let run = NSRange(location: start, length: end - start), style = paragraph(current)
            var effective = NSRange()
            if (storage.attribute(.paragraphStyle, at: run.location, longestEffectiveRange: &effective, in: run) as? NSParagraphStyle) == style, effective == run { return }
            storage.addAttribute(.paragraphStyle, value: style, range: run)
        }
        while index < NSMaxRange(lines) {
            let line = text.paragraphRange(for: NSRange(location: index, length: 0))
            let columns = columns(text, at: line.location, end: NSMaxRange(line))
            if columns != current { flush(line.location); start = line.location; current = columns }
            index = NSMaxRange(line)
        }
        flush(NSMaxRange(lines))
    }
}

extension Host: NSMenuItemValidation {
    /// View → Wrap Lines with focus outside an editor: the docked editor, else any open one.
    var wrapTarget: NativeSourceEditor? { dockedSource ?? sourceEditors[sourceRoot] ?? sourceEditors.values.first }
    @objc func toggleWrapLines(_ sender: Any?) { wrapTarget?.toggleWrapLines(sender) }
    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        guard item.action == #selector(toggleWrapLines(_:)) else { return true }
        guard let editor = wrapTarget else { item.state = .off; return false }
        return editor.validateMenuItem(item)
    }
}
