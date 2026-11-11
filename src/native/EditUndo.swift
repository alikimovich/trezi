import AppKit

/// LKM-644: who answers Edit → Undo (⌘Z) and Redo (⇧⌘Z). The menu items are Host's; this
/// decides from the key window's first responder, so the keyboard and a menu click agree.
/// A text view that is editing keeps its own typing Undo (the composer, the code editor, a
/// prop's text, an inspector field with uncommitted typing): visual Undo never runs with it.
/// An inspector Styles field whose value was committed hands the key to the visual draft,
/// so a committed field edit is undone as a style step after its text session.
/// A focused preview claims ⌘Z for the page first (`test/edit-undo-keys.mjs` measures it).
/// Outside a page field the preview script takes the key and sends the visual step back
/// (`src/preview/history-keys.ts`); in a page field it leaves the key alone and WebKit
/// re-sends it to this menu, so a ⌘Z that arrives here by key with the page focused is
/// the page field's own Undo (`.page`). A menu click with the page focused is visual.
enum EditUndo {
    enum Route: Equatable { case text, page, visual }
    static func route(_ responder: NSResponder?, island: NSView?, preview: NSView? = nil, key: Bool = false) -> Route {
        if key, let preview, let view = responder as? NSView, view === preview || view.isDescendant(of: preview) { return .page }
        guard let text = responder as? NSTextView, text.isEditable else { return .visual }
        if text.isFieldEditor, let island, let field = text.delegate as? NSView, field.isDescendant(of: island), !InspectorTyping.dirty { return .visual }
        return .text
    }
    /// Runs one step of the responder's own undo manager (a text view's typing, a page
    /// field's editing); whether it could.
    @discardableResult static func perform(_ responder: NSResponder, undo: Bool) -> Bool {
        guard let manager = responder.undoManager, undo ? manager.canUndo : manager.canRedo else { return false }
        if undo { manager.undo() } else { manager.redo() }
        return true
    }
    /// The Edit menu's titles and enabled state for the current focus. `visual` is what the
    /// selected element's draft can step (the inspector's published history).
    static func validate(_ item: NSMenuItem, undo: Bool, responder: NSResponder?, island: NSView?, visual: Bool) -> Bool {
        let verb = undo ? "Undo" : "Redo"
        if route(responder, island: island) == .text, let text = responder as? NSTextView {
            item.title = verb
            return undo ? text.undoManager?.canUndo == true : text.undoManager?.canRedo == true
        }
        // Otherwise the project's source history may still answer; Bun decides.
        item.title = visual ? "\(verb) Style Change" : verb
        return true
    }
}

/// LKM-644: whether the focused inspector field holds typing that was not committed yet
/// (Return, leaving the field, or a finished scrub commits). Set by the fields themselves.
enum InspectorTyping {
    static var dirty = false
}
