import AppKit
import AVKit

final class SourceTextView: NSTextView {
    var component: ((String) -> Void)?
    override func mouseDown(with event: NSEvent) {
        if event.modifierFlags.contains(.command) {
            let point = convert(event.locationInWindow, from: nil)
            let position = characterIndexForInsertion(at: point)
            let text = string as NSString
            if let regex = try? NSRegularExpression(pattern: "[A-Za-z_$][A-Za-z0-9_$]*") {
                let range = NSRange(location: 0, length: text.length)
                if let match = regex.matches(in: string, range: range).first(where: { NSLocationInRange(position, $0.range) }) { component?(text.substring(with: match.range)); return }
            }
        }
        super.mouseDown(with: event)
    }
    /// Syntax colours are dynamic; redraw them for the new appearance.
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
}

final class SourceLineRuler: NSRulerView {
    weak var text: NSTextView?
    init(scroll: NSScrollView, text: NSTextView) { self.text = text; super.init(scrollView: scroll, orientation: .verticalRuler); clientView = text; ruleThickness = 48 }
    required init(coder: NSCoder) { fatalError() }
    override func drawHashMarksAndLabels(in rect: NSRect) {
        guard let text, let manager = text.layoutManager, let container = text.textContainer else { return }
        NSColor.controlBackgroundColor.setFill(); bounds.fill()
        guard manager.numberOfGlyphs > 0 else { return }
        let ns = text.string as NSString
        let visible = text.visibleRect
        let glyphs = manager.glyphRange(forBoundingRect: visible, in: container)
        let start = manager.characterIndexForGlyph(at: min(glyphs.location, max(0, manager.numberOfGlyphs - 1)))
        var line = ns.substring(to: min(start, ns.length)).filter { $0 == "\n" }.count + 1
        var position = start
        while position < ns.length {
            let range = ns.lineRange(for: NSRange(location: position, length: 0))
            let glyph = manager.glyphIndexForCharacter(at: range.location)
            let frame = manager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
            if frame.minY > visible.maxY { break }
            let label = "\(line)" as NSString
            label.draw(at: NSPoint(x: 6, y: frame.minY + text.textContainerOrigin.y - visible.minY), withAttributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular), .foregroundColor: NSColor.secondaryLabelColor])
            position = NSMaxRange(range); line += 1
        }
    }
}

final class NativeSourceEditor: NSView, NSTextViewDelegate, NSSearchFieldDelegate, NSWindowDelegate {
    var root = "", source = "", revision = 0, state: [String: Any] = [:]
    var files: [String] = [], filtered: [String] = []
    let code = SourceTextView(), scroll = NSScrollView(), tree = SourceFileTree(), search = NSSearchField()
    let status = NSTextField(labelWithString: ""), filename = NSTextField(labelWithString: ""), edited = NSTextField(labelWithString: "•")
    let image = NSImageView(), player = AVPlayerView(), binary = NSTextField(labelWithString: "")
    let header = NSStackView(), spacer = NSView()
    var popout: NSWindow?, updating = false
    /// Grammar highlighting (`SourceSyntax.swift`): the last applied revision, the
    /// reported visible lines and a test-only main-thread timing hook.
    var highlighted = -1, viewport: [Int] = [], viewportWork: DispatchWorkItem?
    var measure: ((String, Int, CFTimeInterval) -> Void)?
    var dock: (() -> Void)?
    var controls: [String: NSButton] = [:], symbols: [String: String] = [:]
    var documentKey = "", reveal = -1
    init() {
        super.init(frame: .zero); wantsLayer = true; layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        header.orientation = .horizontal; header.spacing = 6
        // The path is selectable (⌘C copies it); the unsaved marker sits outside it so it is never copied.
        filename.isSelectable = true; filename.lineBreakMode = .byTruncatingMiddle
        filename.setContentCompressionResistancePriority(.defaultLow, for: .horizontal); filename.setContentHuggingPriority(.defaultHigh, for: .horizontal)
        edited.textColor = .secondaryLabelColor; edited.isHidden = true; edited.setAccessibilityLabel("Unsaved changes")
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        for (name, symbol, label) in [("back", "chevron.left", "Back"), ("forward", "chevron.right", "Forward")] { header.addArrangedSubview(iconButton(name, symbol, label)) }
        for view in [filename, edited, spacer] { header.addArrangedSubview(view) }
        for (name, symbol, label) in [("popout", "arrow.up.left.and.arrow.down.right", "Pop Out Editor"), ("hide", "xmark", "Close Editor")] { header.addArrangedSubview(iconButton(name, symbol, label)) }
        let split = NSSplitView(); split.isVertical = true; split.dividerStyle = .thin
        let sidebar = NSView(), content = NSView(); split.addArrangedSubview(sidebar); split.addArrangedSubview(content)
        search.placeholderString = "Filter files"; search.delegate = self
        let treeScroll = NSScrollView(); treeScroll.hasVerticalScroller = true; treeScroll.autohidesScrollers = true
        tree.open = { [weak self] source in self?.send("open", ["source":source]) }
        treeScroll.documentView = tree
        let operations = NSStackView(); operations.spacing = 6
        for (name, label) in [("create", "+"), ("rename", "Rename"), ("delete", "Trash")] { let b = NSButton(title: label, target: self, action: #selector(buttonAction(_:))); b.identifier = NSUserInterfaceItemIdentifier(name); b.controlSize = .small; operations.addArrangedSubview(b) }
        scroll.hasVerticalScroller = true; scroll.hasHorizontalScroller = true; scroll.autohidesScrollers = true
        code.isRichText = false; code.isEditable = true; code.isSelectable = true; code.allowsUndo = true; code.usesFindBar = true; code.isIncrementalSearchingEnabled = true
        code.isAutomaticQuoteSubstitutionEnabled = false; code.isAutomaticDashSubstitutionEnabled = false; code.isAutomaticTextReplacementEnabled = false; code.isAutomaticSpellingCorrectionEnabled = false
        code.font = SourceSyntaxTheme.regular; code.textColor = .labelColor; code.typingAttributes = SourceSyntaxTheme.plain; code.textContainerInset = NSSize(width: 8, height: 10)
        code.minSize = NSSize(width: 0, height: 0); code.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        code.isVerticallyResizable = true; code.isHorizontallyResizable = false; code.autoresizingMask = [.width]; code.textContainer?.widthTracksTextView = true
        code.layoutManager?.allowsNonContiguousLayout = true
        code.delegate = self; scroll.documentView = code
        scroll.verticalRulerView = SourceLineRuler(scroll: scroll, text: code); scroll.hasVerticalRuler = true; scroll.rulersVisible = true
        scroll.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: scroll.contentView, queue: .main) { [weak self] _ in self?.scheduleViewport() }
        code.component = { [weak self] name in self?.send("component", ["name":name]) }
        image.imageScaling = .scaleProportionallyUpOrDown
        binary.alignment = .center; binary.textColor = .secondaryLabelColor
        status.lineBreakMode = .byTruncatingMiddle; status.font = .systemFont(ofSize: 11); status.textColor = .secondaryLabelColor
        for view in [header, split, status] { view.translatesAutoresizingMaskIntoConstraints = false; addSubview(view) }
        for view in [search, treeScroll, operations] { view.translatesAutoresizingMaskIntoConstraints = false; sidebar.addSubview(view) }
        for view in [scroll, image, player, binary] { view.translatesAutoresizingMaskIntoConstraints = false; content.addSubview(view); NSLayoutConstraint.activate([view.leadingAnchor.constraint(equalTo: content.leadingAnchor), view.trailingAnchor.constraint(equalTo: content.trailingAnchor), view.topAnchor.constraint(equalTo: content.topAnchor), view.bottomAnchor.constraint(equalTo: content.bottomAnchor)]) }
        // These alternative viewers fill the editor even while hidden. Their
        // intrinsic sizes must not constrain the containing window's resize range.
        for view in [image, player, binary] {
            view.setContentHuggingPriority(.defaultLow, for: .vertical)
            view.setContentHuggingPriority(.defaultLow, for: .horizontal)
            view.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
            view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        }
        NSLayoutConstraint.activate([
            header.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10), header.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10), header.topAnchor.constraint(equalTo: topAnchor, constant: 6), header.heightAnchor.constraint(equalToConstant: 28),
            split.leadingAnchor.constraint(equalTo: leadingAnchor), split.trailingAnchor.constraint(equalTo: trailingAnchor), split.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 6), split.bottomAnchor.constraint(equalTo: status.topAnchor, constant: -4),
            status.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10), status.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10), status.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -5), status.heightAnchor.constraint(equalToConstant: 16),
            sidebar.widthAnchor.constraint(greaterThanOrEqualToConstant: 180), sidebar.widthAnchor.constraint(lessThanOrEqualToConstant: 360),
            search.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor, constant: 6), search.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor, constant: -6), search.topAnchor.constraint(equalTo: sidebar.topAnchor, constant: 4),
            treeScroll.topAnchor.constraint(equalTo: search.bottomAnchor, constant: 4), treeScroll.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor), treeScroll.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor), treeScroll.bottomAnchor.constraint(equalTo: operations.topAnchor, constant: -4),
            operations.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor, constant: 6), operations.bottomAnchor.constraint(equalTo: sidebar.bottomAnchor, constant: -4)
        ])
        split.setPosition(210, ofDividerAt: 0)
    }
    required init?(coder: NSCoder) { fatalError() }
    func send(_ action: String, _ extra: [String: Any] = [:]) { var payload: [String: Any] = ["event":"source-action", "root":root, "action":action, "source":source]; payload.merge(extra) { _, new in new }; emit(payload) }
    func iconButton(_ name: String, _ symbol: String, _ label: String) -> NSButton {
        let button = NSButton(image: NSImage(), target: self, action: #selector(buttonAction(_:))); button.identifier = NSUserInterfaceItemIdentifier(name); button.title = ""; button.isBordered = false; button.imagePosition = .imageOnly
        controls[name] = button; setIcon(name, symbol, label); return button
    }
    func setIcon(_ name: String, _ symbol: String, _ label: String) {
        guard let button = controls[name], symbols[name] != symbol else { return }
        button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label); button.toolTip = label; button.setAccessibilityLabel(label); symbols[name] = symbol
    }
    /// ⌘S saves and ⌘R reloads only while focus is inside this editor, so ⌘R
    /// elsewhere still reaches the menu's Reload Preview. The window offers key
    /// equivalents to its views before the main menu.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard event.modifierFlags.intersection([.command, .shift, .option, .control]) == .command, !isHiddenOrHasHiddenAncestor,
              let focus = window?.firstResponder as? NSView, focus.isDescendant(of: self) else { return super.performKeyEquivalent(with: event) }
        switch event.charactersIgnoringModifiers {
        case "s": send("save"); return true
        case "r": perform("reload"); return true
        default: return super.performKeyEquivalent(with: event)
        }
    }
    @objc func buttonAction(_ sender: NSButton) { perform(sender.identifier?.rawValue ?? "") }
    func perform(_ action: String) {
        if action == "popout" { send(state["popped"] as? Bool == true ? "dock" : "popout"); return }
        if action == "reload" && state["dirty"] as? Bool == true || action == "delete" {
            let alert = NSAlert(); alert.messageText = action == "delete" ? "Move this file to Trash?" : "Discard unsaved changes?"; alert.informativeText = action == "delete" ? source : "Reload \(source) from disk. Your unsaved edits will be lost."; alert.addButton(withTitle: action == "delete" ? "Move to Trash" : "Discard and reload"); alert.addButton(withTitle: "Cancel")
            guard let window else { return }; alert.beginSheetModal(for: window) { [weak self] response in if response == .alertFirstButtonReturn { self?.send(action) } }; return
        }
        if action == "create" || action == "rename" {
            let alert = NSAlert(); alert.messageText = action == "create" ? "New file" : "Rename file"; alert.informativeText = "Enter a file path within this project, for example src/Button.tsx."; let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 340, height: 24)); input.stringValue = action == "rename" ? source : ""; alert.accessoryView = input; alert.addButton(withTitle: action == "create" ? "Create" : "Rename"); alert.addButton(withTitle: "Cancel")
            guard let window else { return }; alert.beginSheetModal(for: window) { [weak self] response in if response == .alertFirstButtonReturn { self?.send(action, ["name":input.stringValue]) } }; return
        }
        send(action)
    }
    func update(_ value: [String: Any]) {
        let started = CACurrentMediaTime()
        state = value; root = value["root"] as? String ?? ""; source = value["source"] as? String ?? ""
        let newFiles = value["files"] as? [String] ?? []; if files != newFiles { files = newFiles; filter() }
        // Rewriting an unchanged path would drop the user's selection in it.
        if filename.stringValue != source { filename.stringValue = source; filename.toolTip = source }
        edited.isHidden = value["dirty"] as? Bool != true
        let error = value["error"] as? String ?? ""; status.stringValue = !error.isEmpty ? error : value["busy"] as? Bool == true ? "Working…" : "⌘S Save · ⌘R Reload · ⌘F Find · ⌘Click component to navigate"
        status.toolTip = status.stringValue; status.textColor = error.isEmpty ? .secondaryLabelColor : .systemRed
        controls["back"]?.isEnabled = value["canBack"] as? Bool == true
        controls["forward"]?.isEnabled = value["canForward"] as? Bool == true
        if value["popped"] as? Bool == true { setIcon("popout", "arrow.down.right.and.arrow.up.left", "Dock Editor") } else { setIcon("popout", "arrow.up.left.and.arrow.down.right", "Pop Out Editor") }
        let document = value["document"] as? [String: Any] ?? [:], incoming = value["text"] as? String ?? "", nextRevision = value["revision"] as? Int ?? 0
        let key = root + "/" + source, changed = key != documentKey
        var replaced = false
        if changed || nextRevision >= revision && incoming != code.string {
            updating = true; code.string = incoming; updating = false; replaced = true
            if changed { code.undoManager?.removeAllActions(); documentKey = key; let line = document["line"] as? Int ?? 1; let pieces = incoming.split(separator: "\n", omittingEmptySubsequences: false); let offset = pieces.prefix(max(0, line - 1)).reduce(0) { $0 + ($1 as NSString).length + 1 }; code.setSelectedRange(NSRange(location: min(offset, (incoming as NSString).length), length: 0)); code.scrollRangeToVisible(code.selectedRange()) }
        }
        if let nextReveal = value["reveal"] as? Int, nextReveal != reveal {
            reveal = nextReveal
            let line = max(1, document["line"] as? Int ?? 1)
            let pieces = incoming.split(separator: "\n", omittingEmptySubsequences: false)
            let offset = pieces.prefix(line - 1).reduce(0) { $0 + ($1 as NSString).length + 1 }
            code.setSelectedRange(NSRange(location: min(offset, (incoming as NSString).length), length: 0)); code.scrollRangeToVisible(code.selectedRange())
        }
        revision = max(changed ? 0 : revision, nextRevision)
        let media = document["media"] as? [String: Any], isBinary = document["binary"] as? Bool == true
        scroll.isHidden = media != nil || isBinary; image.isHidden = true; player.isHidden = true; binary.isHidden = !isBinary
        binary.stringValue = "Binary file · \(document["bytes"] as? Int ?? 0) bytes"
        if let path = value["mediaPath"] as? String, let media { if media["kind"] as? String == "image" { image.isHidden = false; image.image = NSImage(contentsOfFile: path) } else { player.isHidden = false; if changed { player.player?.pause(); player.player = AVPlayer(url: URL(fileURLWithPath: path)) } } } else { player.player?.pause() }
        tree.selectFile(source)
        // A replaced text shows plain until the backend's highlight for this revision lands.
        if replaced { resetHighlight(nextRevision) }
        measure?("update", nextRevision, CACurrentMediaTime() - started)
    }
    /// Highlighting is the backend's (LKM-183): an edit only sends the text and revision.
    func textDidChange(_ notification: Notification) { guard !updating else { return }; revision += 1; send("edit", ["text":code.string, "revision":revision]); scroll.verticalRulerView?.needsDisplay = true }
    func filter() { tree.update(files, query: search.stringValue) }
    func controlTextDidChange(_ obj: Notification) { filter() }
    func windowShouldClose(_ sender: NSWindow) -> Bool { send("hide"); return false }
}

/// Test-profile hooks for the smoke's source-editor check.
extension NativeSourceEditor {
    func inspectToolbar() -> [String: Any] {
        layoutSubtreeIfNeeded()
        let items = header.arrangedSubviews.filter { !$0.isHidden && $0 !== spacer }.map { view -> [String: Any] in
            let name = view === filename ? "path" : view === edited ? "edited" : view.identifier?.rawValue ?? "", rect = view.convert(view.bounds, to: self)
            return ["id": name, "symbol": symbols[name] ?? "", "toolTip": view.toolTip ?? "", "label": view.accessibilityLabel() ?? "", "title": (view as? NSButton)?.title ?? "", "minX": rect.minX, "maxX": rect.maxX]
        }
        return ["items": items, "width": bounds.width, "pathSelectable": filename.isSelectable, "pathEditable": filename.isEditable, "path": filename.stringValue]
    }
    /// Offers a ⌘-key to the window's key-equivalent pass (which AppKit runs before
    /// the main menu) with focus in the code, the path or outside the editor. A
    /// discard prompt is answered Cancel. Path focus also selects and copies the
    /// path to a private pasteboard, never the user's clipboard.
    func verifyShortcut(_ key: String, focus: String) -> [String: Any] {
        guard let window else { return ["error": "Source editor has no window"] }
        // A label refuses keyboard focus; a click selects it through `selectText`, as here.
        if focus == "path" { filename.selectText(nil) } else { window.makeFirstResponder(focus == "code" ? code : nil) }
        var copied: String?
        if focus == "path", let field = filename.currentEditor() as? NSTextView {
            field.selectAll(nil)
            let board = NSPasteboard(name: NSPasteboard.Name("dev.trezi.source-path-test")); board.clearContents()
            copied = field.writeSelection(to: board, types: field.writablePasteboardTypes) ? board.string(forType: .string) : nil; board.releaseGlobally()
        }
        let focused = (window.firstResponder as? NSView)?.isDescendant(of: self) ?? false
        if focus == "path" { window.makeFirstResponder(code) }
        guard !key.isEmpty, let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: key, charactersIgnoringModifiers: key, isARepeat: false, keyCode: key == "s" ? 1 : key == "r" ? 15 : 0) else { return ["focused": focused, "copied": copied ?? NSNull()] }
        let handled = window.performKeyEquivalent(with: event), sheet = window.attachedSheet
        if let sheet { window.endSheet(sheet, returnCode: .alertSecondButtonReturn) }
        let entries: [NSMenuItem] = (NSApp.mainMenu?.items ?? []).flatMap { $0.submenu?.items ?? [] }
        let menu: [String] = entries.filter { $0.keyEquivalent == key && $0.keyEquivalentModifierMask == .command }.map { $0.title }
        return ["handled": handled, "guarded": sheet != nil, "focused": focused, "menu": menu, "copied": copied ?? NSNull()]
    }
    /// Brings the editor's window forward; `capture` then grabs its toolbar strip through WindowServer.
    func prepareForeground() -> [String: Any] {
        NSApp.activate(ignoringOtherApps: true); window?.makeKeyAndOrderFront(nil); layoutSubtreeIfNeeded()
        return ["active": NSApp.isActive, "key": window?.isKeyWindow ?? false, "visible": window?.isVisible == true && !isHiddenOrHasHiddenAncestor]
    }
    @MainActor func captureToolbar() async throws -> [String: Any] {
        guard let window else { throw NSError(domain: "SourceEditor", code: 1, userInfo: [NSLocalizedDescriptionKey: "Source editor has no window"]) }
        let strip = NSRect(x: 0, y: max(0, header.frame.minY - 6), width: bounds.width, height: min(bounds.height, header.frame.height + 12))
        return try await captureVisibleRegion(window: window, view: self, region: strip)
    }
}
