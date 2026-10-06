import AppKit
import UniformTypeIdentifiers

final class ComposerTextView: NSTextView {
    var pasteFiles: ((NSPasteboard) -> Bool)?
    // Plain NSTextView disables Paste for non-text clipboard contents unless
    // these types are advertised, so paste(_:) alone never receives Cmd-V.
    override var readablePasteboardTypes: [NSPasteboard.PasteboardType] {
        [.fileURL, .png, .tiff] + super.readablePasteboardTypes
    }
    override func readSelection(from board: NSPasteboard, type: NSPasteboard.PasteboardType) -> Bool {
        if [.fileURL, .png, .tiff].contains(type), pasteFiles?(board) == true { return true }
        return super.readSelection(from: board, type: type)
    }
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        if string.isEmpty && !hasMarkedText() {
            ("Ask Trezi  (/ for skills)" as NSString).draw(at: NSPoint(x: 7, y: 4), withAttributes: [.font:font ?? NSFont.systemFont(ofSize: 14), .foregroundColor:NSColor.placeholderTextColor])
        }
    }
    override func paste(_ sender: Any?) {
        if pasteFiles?(NSPasteboard.general) == true { return }
        super.paste(sender)
    }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        if pasteFiles?(sender.draggingPasteboard) == true { return true }
        return super.performDragOperation(sender)
    }
}

/// Uses Apple's Liquid Glass directly; no custom blur, gradient or glass shader.
final class NativeComposer: NSView, NSTextViewDelegate {
    let text = ComposerTextView()
    let content = NSView()
    let scroll = NSScrollView()
    let sendButton = NSButton()
    let queuedMessages = ComposerQueueHost()
    var formTop: NSLayoutConstraint!
    let buttonBeam = ComposerBeamHost()
    let readyBeam = ComposerBeamHost()
    var welcomedChats = Set<String>()
    let plus = NSPopUpButton(frame: .zero, pullsDown: true)
    let chips = NSStackView()
    let controls = NSStackView()
    let context = NSButton()
    let attachments = ComposerAttachments()
    var attachmentsHeight: NSLayoutConstraint!
    let skillList = NSScrollView()
    let skillRows = NSView()
    var skillEntries: [[String: Any]] = []
    var pickers: [String: NSPopUpButton] = [:]
    var state: [String: Any] = [:]
    var chat = ""
    var revision = 0
    var applying = false
    var glass = false
    var choicesSignature = Data()
    var chipsHeight: NSLayoutConstraint!
    var pickerWidths: [String: NSLayoutConstraint] = [:]

    override init(frame: NSRect) {
        super.init(frame: frame)
        let backdrop: NSView
        if #available(macOS 26.0, *) {
            let effect = NSGlassEffectView(); effect.style = .regular
            effect.cornerRadius = 24; effect.contentView = content
            content.frame = effect.bounds; content.autoresizingMask = [.width, .height]
            backdrop = effect; glass = true
        } else {
            let effect = NSVisualEffectView(); effect.material = .popover
            effect.blendingMode = .withinWindow; effect.state = .followsWindowActiveState
            effect.wantsLayer = true; effect.layer?.cornerRadius = 24; effect.layer?.masksToBounds = true
            effect.addSubview(content); content.frame = effect.bounds; content.autoresizingMask = [.width, .height]
            backdrop = effect
        }
        queuedMessages.translatesAutoresizingMaskIntoConstraints = false; addSubview(queuedMessages)
        queuedMessages.action = { [weak self] action, id in
            guard let self else { return }
            var event: [String: Any] = ["event":"chat-action", "chat":self.chat, "action":action]
            if let id { event["id"] = id }
            emit(event)
        }
        backdrop.translatesAutoresizingMaskIntoConstraints = false; addSubview(backdrop)
        text.isRichText = false; text.allowsUndo = true; text.importsGraphics = false; text.drawsBackground = false
        text.font = .systemFont(ofSize: 14); text.textColor = .labelColor; text.insertionPointColor = .labelColor
        text.textContainerInset = NSSize(width: 2, height: 4)
        text.isVerticallyResizable = true; text.isHorizontallyResizable = false
        text.frame = NSRect(x: 0, y: 0, width: 400, height: 70)
        text.minSize = .zero
        text.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        text.autoresizingMask = [.width]; text.textContainer?.widthTracksTextView = true
        text.textContainer?.containerSize = NSSize(width: 400, height: CGFloat.greatestFiniteMagnitude)
        text.delegate = self; text.setAccessibilityLabel("Message to Trezi")
        text.registerForDraggedTypes([.fileURL, .png, .tiff])
        text.pasteFiles = { [weak self] board in self?.readPasteboard(board) ?? false }
        scroll.documentView = text; scroll.drawsBackground = false; scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true; scroll.scrollerStyle = .overlay
        scroll.borderType = .noBorder
        controls.orientation = .horizontal; controls.spacing = 4; controls.alignment = .centerY
        controls.detachesHiddenViews = false
        plus.addItem(withTitle: ""); plus.item(at: 0)?.image = NSImage(systemSymbolName: "plus", accessibilityDescription: "Attach or select")
        plus.isBordered = false; (plus.cell as? NSPopUpButtonCell)?.arrowPosition = .noArrow; plus.setAccessibilityLabel("Attachments and tools")
        for (title, action) in [("Attach Files…", "attach"), ("Show Layers", "layers")] {
            let item = NSMenuItem(title: title, action: #selector(menuAction(_:)), keyEquivalent: "")
            item.target = self; item.representedObject = ["action":action]; plus.menu?.addItem(item)
        }
        controls.addArrangedSubview(plus)
        let spacer = NSView(); spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        controls.addArrangedSubview(spacer)
        spacer.widthAnchor.constraint(greaterThanOrEqualToConstant: 0).isActive = true
        for label in ["Provider", "Model", "Permission mode"] {
            let picker = NSPopUpButton(frame: .zero, pullsDown: false)
            picker.isBordered = false
            (picker.cell as? NSPopUpButtonCell)?.arrowPosition = .noArrow
            picker.menu?.autoenablesItems = false
            picker.cell?.lineBreakMode = .byTruncatingTail
            picker.controlSize = .small; picker.font = .systemFont(ofSize: 11)
            picker.setAccessibilityLabel(label); picker.target = self; picker.action = #selector(pick(_:))
            picker.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            picker.addItem(withTitle: label); pickers[label] = picker; controls.addArrangedSubview(picker)
            picker.widthAnchor.constraint(greaterThanOrEqualToConstant: 35).isActive = true
            let width = picker.widthAnchor.constraint(equalToConstant: 60); width.priority = .defaultHigh; width.isActive = true
            pickerWidths[label] = width
            picker.setContentHuggingPriority(.required, for: .horizontal)
        }
        sendButton.bezelStyle = .circular; sendButton.isBordered = true
        sendButton.target = self; sendButton.action = #selector(send(_:))
        controls.addArrangedSubview(sendButton)
        plus.widthAnchor.constraint(equalToConstant: 30).isActive = true
        sendButton.widthAnchor.constraint(equalToConstant: 30).isActive = true
        sendButton.heightAnchor.constraint(equalToConstant: 30).isActive = true
        sendButton.imageScaling = .scaleNone
        sendButton.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 13, weight: .medium)
        chips.orientation = .horizontal; chips.spacing = 4
        context.bezelStyle = .roundRect; context.controlSize = .small; context.lineBreakMode = .byTruncatingTail
        context.target = self; context.action = #selector(clearContext(_:))
        context.widthAnchor.constraint(lessThanOrEqualToConstant: 160).isActive = true
        chips.addArrangedSubview(context)
        attachments.remove = { [weak self] index in self?.emitAction("remove", ["index":index]) }
        skillList.documentView = skillRows; skillList.hasVerticalScroller = true
        skillList.autohidesScrollers = true; skillList.scrollerStyle = .overlay
        skillList.backgroundColor = .windowBackgroundColor
        skillList.wantsLayer = true; skillList.layer?.cornerRadius = 12
        skillList.layer?.borderWidth = 1; skillList.layer?.borderColor = NSColor.separatorColor.cgColor
        skillList.setAccessibilityLabel("Skills and commands"); skillList.isHidden = true
        for view in [chips, attachments, scroll, controls] { view.translatesAutoresizingMaskIntoConstraints = false; content.addSubview(view) }
        chipsHeight = chips.heightAnchor.constraint(equalToConstant: 0)
        attachmentsHeight = attachments.heightAnchor.constraint(equalToConstant: 0)
        formTop = backdrop.topAnchor.constraint(equalTo: topAnchor)
        NSLayoutConstraint.activate([
            queuedMessages.topAnchor.constraint(equalTo: topAnchor), queuedMessages.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14), queuedMessages.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14), queuedMessages.bottomAnchor.constraint(equalTo: backdrop.topAnchor, constant: 16),
            formTop, backdrop.leadingAnchor.constraint(equalTo: leadingAnchor), backdrop.trailingAnchor.constraint(equalTo: trailingAnchor), backdrop.bottomAnchor.constraint(equalTo: bottomAnchor),
            chips.topAnchor.constraint(equalTo: content.topAnchor, constant: 10), chips.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 12), chips.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -12), chipsHeight,
            attachments.topAnchor.constraint(equalTo: chips.bottomAnchor), attachments.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 12), attachments.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -12), attachmentsHeight,
            scroll.topAnchor.constraint(equalTo: attachments.bottomAnchor, constant: 4), scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 12), scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -12), scroll.bottomAnchor.constraint(equalTo: controls.topAnchor, constant: -5),
            controls.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 10), controls.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -10), controls.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -8), controls.heightAnchor.constraint(equalToConstant: 30)
        ])
        for overlay in [readyBeam, buttonBeam] { addSubview(overlay) }
        isHidden = true
    }
    /// Measure using the same TextKit wrapping, padding and font as the editor.
    func preferredHeight(for value: String, width: CGFloat, availableHeight: CGFloat, hasContext: Bool, hasAttachments: Bool = false, queueHeight: CGFloat = 0) -> CGFloat {
        let storage = NSTextStorage(string: value, attributes: [.font: text.font ?? NSFont.systemFont(ofSize: 14)])
        let manager = NSLayoutManager()
        // A legacy scroller can retain its gutter after a capped draft. Measure
        // with that gutter so replacing it cannot wrap into an extra clipped line.
        let viewport = NSScrollView.contentSize(forFrameSize: NSSize(width: max(1, width - 24), height: 1),
            horizontalScrollerClass: nil, verticalScrollerClass: scroll.hasVerticalScroller ? NSScroller.self : nil,
            borderType: scroll.borderType, controlSize: scroll.verticalScroller?.controlSize ?? .regular,
            scrollerStyle: scroll.scrollerStyle)
        let container = NSTextContainer(size: NSSize(width: max(1, viewport.width - text.textContainerInset.width * 2), height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = text.textContainer?.lineFragmentPadding ?? 5
        storage.addLayoutManager(manager); manager.addTextContainer(container)
        manager.ensureLayout(for: container)
        // The extra fragment includes the caret's empty line after a trailing newline.
        let used = max(manager.usedRect(for: container).maxY, manager.extraLineFragmentRect.maxY)
        let textHeight = ceil(max(manager.defaultLineHeight(for: text.font ?? NSFont.systemFont(ofSize: 14)), used) + text.textContainerInset.height * 2)
        // 8 bottom inset + 30 controls (including Send) + 14 top + 5 text/row gap.
        let desired = max(128, textHeight + 57 + (hasContext ? 22 : 0)) + (hasAttachments ? ComposerAttachments.rowHeight : 0)
        let limit = min(368, max(128, availableHeight * 0.5))
        return min(availableHeight, min(desired, limit) + queueHeight)
    }
    override func layout() {
        super.layout()
        readyBeam.frame = content.convert(content.bounds, to: self).insetBy(dx: -8, dy: -8)
        buttonBeam.frame = sendButton.convert(sendButton.bounds, to: self).insetBy(dx: -8, dy: -8)
        layoutSkills()
        // String replacement invalidates TextKit lazily. Resolve it at the new
        // viewport size so a shorter draft cannot retain the capped document's
        // height until the next paint (and show a spurious scrollbar).
        scroll.layoutSubtreeIfNeeded()
        if !text.string.isEmpty && scroll.contentSize.width > 0 {
            text.sizeToFit()
        }
        // An empty document must not retain its initial 70pt height in a shorter field.
        if text.string.isEmpty && scroll.contentSize.height > 0 && text.frame.size != scroll.contentSize {
            text.setFrameSize(scroll.contentSize)
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func emitAction(_ action: String, _ extra: [String: Any] = [:]) {
        var message = extra; message["event"] = "composer-action"; message["action"] = action; message["chat"] = chat
        emit(message)
    }
    func textDidChange(_ notification: Notification) { changed() }
    func textViewDidChangeSelection(_ notification: Notification) { if !text.hasMarkedText() { changed() } }
    func changed() {
        guard !applying, !chat.isEmpty else { return }
        revision += 1
        emitAction("input", ["text":text.string, "caret":text.selectedRange().location, "revision":revision])
    }
    func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if text.hasMarkedText() { return false }
        let commands = ["insertNewline:":"Enter", "insertTab:":"Tab", "moveUp:":"ArrowUp", "moveDown:":"ArrowDown", "cancelOperation:":"Escape"]
        guard let key = commands[NSStringFromSelector(selector)] else { return false }
        let hasSuggestions = !(state["suggestions"] as? [Any] ?? []).isEmpty
        if key == "Enter" && !(NSApp.currentEvent?.modifierFlags.contains(.shift) ?? false) || hasSuggestions {
            emitAction("key", ["key":key]); return true
        }
        return false
    }
    @objc func send(_ sender: Any?) { if sendButton.isEnabled { emitAction("send") } }
    @objc func clearContext(_ sender: Any?) { emitAction("context") }
    @objc func pick(_ sender: NSPopUpButton) {
        guard let label = pickers.first(where: { $0.value === sender })?.key,
              let value = sender.selectedItem?.representedObject as? String else { return }
        emitAction("choice", ["label":label, "value":value])
    }
    @objc func menuAction(_ item: NSMenuItem) {
        guard let value = item.representedObject as? [String: Any], let action = value["action"] as? String else { return }
        if action == "attach" {
            let panel = NSOpenPanel(); panel.allowsMultipleSelection = true; panel.canChooseDirectories = false
            guard let window = window else { return }
            panel.beginSheetModal(for: window) { [weak self] result in if result == .OK { self?.attach(panel.urls) } }
        } else if action == "select" { emit(["event":"menu", "action":"select"]) }
        else { emitAction(action, value) }
    }
    func attach(_ urls: [URL]) {
        var files: [[String: String]] = []
        for url in urls {
            let type = UTType(filenameExtension: url.pathExtension)
            let image = type?.conforms(to: .image) ?? false
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            if image, size <= AttachmentPayload.readBytes {
                guard let data = try? Data(contentsOf: url) else { emitAction("attachment-error", ["message":"Could not read \(url.lastPathComponent)."]); continue }
                files.append(AttachmentPayload.file(path: url.path, name: url.lastPathComponent, type: type?.preferredMIMEType ?? "image/png", data: data))
            } else { files.append(AttachmentPayload.plainFile(path: url.path, name: url.lastPathComponent)) }
        }
        for file in files { emitAction("files", ["files":[file]]) }
    }
    func readPasteboard(_ board: NSPasteboard) -> Bool {
        if let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly:true]) as? [URL], !urls.isEmpty { attach(urls); return true }
        let data = board.data(forType: .png) ?? board.data(forType: .tiff).flatMap { NSBitmapImageRep(data: $0)?.representation(using: .png, properties: [:]) }
        if let data {
            emitAction("files", ["files":[AttachmentPayload.file(path: "", name: "Pasted image.png", type: "image/png", data: data)]]); return true
        }
        return false
    }
    // Integration-only caller in Host requires an ephemeral test profile.
    func checkPaste(_ fixture: [String: Any]) -> [String: Any] {
        let board = NSPasteboard.general
        let saved = (board.pasteboardItems ?? []).map { item -> NSPasteboardItem in
            let copy = NSPasteboardItem()
            for type in item.types { if let data = item.data(forType: type) { copy.setData(data, forType: type) } }
            return copy
        }
        defer { board.clearContents(); board.writeObjects(saved) }
        board.clearContents()
        if let paths = fixture["paths"] as? [String] {
            board.writeObjects(paths.map { NSURL(fileURLWithPath: $0) })
        } else if let value = fixture["text"] as? String {
            board.setString(value, forType: .string)
        } else if let type = fixture["image"] as? String {
            let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
            board.setData(bitmap.representation(using: type == "png" ? .png : .tiff, properties: [:])!, forType: type == "png" ? .png : .tiff)
        }
        window?.makeFirstResponder(text)
        let item = NSMenuItem(title: "Paste", action: #selector(NSTextView.paste(_:)), keyEquivalent: "v")
        let enabled = text.validateMenuItem(item)
        // Background integration windows are deliberately not the key window.
        let dispatched = enabled && NSApp.sendAction(item.action!, to: window?.firstResponder, from: item)
        return ["enabled":enabled, "dispatched":dispatched]
    }
    func update(_ next: [String: Any]) {
        applying = true; defer { applying = false }
        state = next; isHidden = !(next["visible"] as? Bool ?? false)
        let queue = next["queue"] as? [[String: Any]] ?? []
        let queuePaused = next["queuePaused"] as? Bool ?? false
        let queueNote = next["queueNote"] as? String ?? ""
        queuedMessages.update(queue, paused: queuePaused, note: queueNote, canSend: next["queueCanSend"] as? Bool ?? true)
        formTop.constant = ComposerQueueHost.height(count: queue.count, paused: queuePaused, note: queueNote)
        if let b = next["bounds"] as? [String: Double], let x = b["x"], let y = b["y"], let width = b["width"], let height = b["height"], [x,y,width,height].allSatisfy({ $0.isFinite && abs($0) < 100000 }) {
            frame = NSRect(x: x, y: y, width: max(0, width), height: max(0, height))
        }
        let nextChat = next["chat"] as? String ?? ""
        if chat != nextChat {
            readyBeam.show(false, radius: 24)
            buttonBeam.show(false, radius: 15)
            text.undoManager?.removeAllActions(); chat = nextChat; revision = next["revision"] as? Int ?? 0
        }
        buttonBeam.show(!isHidden && next["thinking"] as? Bool == true, radius: 15)
        if isHidden { readyBeam.show(false, radius: 24) }
        else if next["ready"] as? Bool == true && !chat.isEmpty && welcomedChats.insert(chat).inserted {
            readyBeam.show(true, radius: 24, once: true)
        }
        needsLayout = true
        if (next["revision"] as? Int ?? 0) >= revision && !text.hasMarkedText() {
            let value = next["text"] as? String ?? ""
            if text.string != value {
                text.string = value
                let cursor = min((value as NSString).length, next["caret"] as? Int ?? (value as NSString).length)
                text.setSelectedRange(NSRange(location: cursor, length: 0))
            }
        }
        sendButton.isEnabled = next["enabled"] as? Bool ?? false
        let stop = next["stop"] as? Bool ?? false
        sendButton.image = NSImage(systemSymbolName: stop ? "stop.fill" : "arrow.up", accessibilityDescription: next["sendLabel"] as? String)
        sendButton.setAccessibilityLabel(next["sendLabel"] as? String ?? "Send")
        let choices = next["choices"] as? [[String: Any]] ?? []
        let signature = (try? JSONSerialization.data(withJSONObject: choices, options: [.sortedKeys])) ?? Data()
        if signature != choicesSignature {
        choicesSignature = signature
        for choice in choices {
            guard let label = choice["label"] as? String, let picker = pickers[label] else { continue }
            picker.removeAllItems()
            for option in choice["options"] as? [[String: Any]] ?? [] {
                picker.addItem(withTitle: option["label"] as? String ?? "")
                picker.lastItem?.representedObject = option["value"] as? String
                picker.lastItem?.isEnabled = !(option["disabled"] as? Bool ?? false)
                if option["value"] as? String == choice["value"] as? String { picker.select(picker.lastItem) }
            }
            picker.isEnabled = !(choice["disabled"] as? Bool ?? false)
            picker.toolTip = picker.titleOfSelectedItem
            let title = picker.titleOfSelectedItem ?? ""
            let textWidth = (title as NSString).size(withAttributes: [.font: picker.font ?? NSFont.systemFont(ofSize: 11)]).width
            pickerWidths[label]?.constant = min(60, max(35, ceil(textWidth) + 12))
        }
        }
        let selected = next["context"] as? String ?? ""
        context.isHidden = selected.isEmpty; context.title = selected; context.toolTip = "Clear selected element: " + selected
        attachments.update(next["attachments"] as? [[String: Any]] ?? [])
        attachmentsHeight.constant = attachments.count > 0 ? ComposerAttachments.rowHeight : 0
        chips.isHidden = context.isHidden; chipsHeight.constant = context.isHidden ? 0 : 22
        skillEntries = next["suggestions"] as? [[String: Any]] ?? []
        rebuildSkills()
    }
    override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        if let superview { superview.addSubview(skillList); layoutSkills() }
        else { skillList.removeFromSuperview() }
    }
    private func layoutSkills() {
        let height = min(240, CGFloat(skillEntries.count * 48), max(0, frame.minY - 6))
        skillList.frame = NSRect(x: frame.minX, y: max(0, frame.minY - height - 6), width: frame.width, height: height)
        skillList.isHidden = isHidden || skillEntries.isEmpty || height == 0
        skillRows.frame = NSRect(x: 0, y: 0, width: skillList.contentSize.width, height: CGFloat(skillEntries.count * 48))
        for (index, row) in skillRows.subviews.enumerated() {
            row.frame = NSRect(x: 6, y: CGFloat((skillEntries.count - index - 1) * 48), width: max(0, skillList.contentSize.width - 12), height: 48)
        }
    }
    private func rebuildSkills() {
        skillRows.subviews.forEach { $0.removeFromSuperview() }
        for (index, entry) in skillEntries.enumerated() {
            let button = NSButton(title: "", target: self, action: #selector(chooseSkill(_:)))
            button.tag = index; button.isBordered = false; button.alignment = .left
            let title = entry["title"] as? String ?? ""
            let description = entry["description"] as? String ?? ""
            let label = NSMutableAttributedString(string: title, attributes: [.font:NSFont.systemFont(ofSize: 13, weight: .medium), .foregroundColor:NSColor.labelColor])
            if !description.isEmpty { label.append(NSAttributedString(string: "\n" + description, attributes: [.font:NSFont.systemFont(ofSize: 11), .foregroundColor:NSColor.secondaryLabelColor])) }
            button.attributedTitle = label; button.cell?.wraps = false; button.cell?.lineBreakMode = .byTruncatingTail
            button.setAccessibilityLabel(title + " " + description)
            button.wantsLayer = true; button.layer?.cornerRadius = 6
            if entry["active"] as? Bool == true { button.layer?.backgroundColor = NSColor.selectedContentBackgroundColor.withAlphaComponent(0.25).cgColor }
            skillRows.addSubview(button)
        }
        layoutSkills()
        if let index = skillEntries.firstIndex(where: { $0["active"] as? Bool == true }), index < skillRows.subviews.count {
            skillRows.scrollToVisible(skillRows.subviews[index].frame)
        }
    }
    @objc private func chooseSkill(_ button: NSButton) {
        emitAction("suggestion", ["index":button.tag]); window?.makeFirstResponder(text)
    }
    func configure(_ popup: NSPopUpButton, title: String, entries: [(String, [String: Any])]) {
        popup.isHidden = entries.isEmpty; popup.removeAllItems(); popup.addItem(withTitle: title)
        for (label, payload) in entries {
            let item = NSMenuItem(title: label, action: #selector(menuAction(_:)), keyEquivalent: "")
            item.target = self; item.representedObject = payload; popup.menu?.addItem(item)
        }
    }
    func inspect() -> [String: Any] { layoutSubtreeIfNeeded(); return ["attachmentPreviews":attachments.inspect(), "queueCount":queuedMessages.count, "queue":state["queue"] ?? [], "queuePaused":state["queuePaused"] ?? false, "queueHeight":formTop.constant, "queueInset":queuedMessages.frame.minX, "queueOverlap":content.convert(content.bounds, to: self).maxY - queuedMessages.frame.minY, "buttonBeam":buttonBeam.active, "readyBeam":readyBeam.active, "welcomedChat":welcomedChats.contains(chat), "pickerWidths":pickers.mapValues { $0.bounds.width }, "pickersPlain":pickers.values.allSatisfy { !$0.isBordered }, "attachIsPlus":plus.item(at: 0)?.image != nil && (plus.cell as? NSPopUpButtonCell)?.arrowPosition == .noArrow, "controlsBelowForm":controls.frame.maxY < content.convert(content.bounds, to: self).minY, "sendInsideForm":sendButton.superview === content, "skillListVisible":!skillList.isHidden, "skillCount":skillEntries.count, "inputTopInset":content.bounds.maxY - scroll.frame.maxY, "sendRightInset":content.bounds.maxX - sendButton.convert(sendButton.bounds, to: content).maxX, "autohidesScrollers":scroll.autohidesScrollers, "contentWidth":content.bounds.width, "inputHeight":scroll.bounds.height, "documentHeight":text.bounds.height, "sendWidth":sendButton.bounds.width, "visible":!isHidden, "glass":glass, "text":text.string, "chat":chat, "enabled":sendButton.isEnabled, "revision":revision, "choices":state["choices"] ?? [], "attachments":state["attachments"] ?? [], "windowKey":window?.isKeyWindow ?? false, "appActive":NSApp.isActive, "inputIsFirstResponder":window?.firstResponder === text, "bounds":["x":frame.minX,"y":frame.minY,"width":frame.width,"height":frame.height]] }
    func perform(_ c: [String: Any]) {
        if let value = c["text"] as? String { text.string = value; text.setSelectedRange(NSRange(location: (value as NSString).length, length: 0)); changed() }
        if c["action"] as? String == "send" { send(nil) }
        if let key = c["key"] as? String { emitAction("key", ["key":key]) }
        if let label = c["label"] as? String, let value = c["value"] as? String, let picker = pickers[label], picker.isEnabled,
           let item = picker.itemArray.first(where: { $0.representedObject as? String == value }) { picker.select(item); pick(picker) }
        if let paths = c["files"] as? [String] { attach(paths.map { URL(fileURLWithPath: $0) }) }
        if let index = c["remove"] as? Int { attachments.removeAt(index) }
    }
}
