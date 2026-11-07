import AppKit

/// Glass-backed Publish trigger. Its two native segments keep the primary action separate
/// from the menu arrow; only the text segment uses a monospace font.
final class PublishToolbarControl: NSView {
    private let glass: NSView = {
        if #available(macOS 26.0, *) { return NSGlassEffectView() }
        let effect = NSVisualEffectView()
        effect.material = .popover; effect.blendingMode = .withinWindow; effect.state = .active
        effect.wantsLayer = true; effect.layer?.cornerRadius = 16; effect.layer?.masksToBounds = true
        return effect
    }()
    let segments = IslandSegmentedControl(labels: ["Publish", ""], trackingMode: .momentary, target: nil, action: nil)
    private let spinnerView = PublishSpinnerImageView()
    weak var item: NSMenuToolbarItem?
    private(set) var title = "Publish"
    private(set) var busy = false
    let textFont = NSFont.systemFont(ofSize: NSFont.systemFontSize, weight: .regular)
    private var primaryWidth: CGFloat {
        let text = busy ? "   " + title : title
        return ceil((text as NSString).size(withAttributes: [.font:textFont]).width) + 20
    }
    override var intrinsicContentSize: NSSize { NSSize(width: primaryWidth + 22, height: 32) }
    var isNativeGlass: Bool {
        if #available(macOS 26.0, *) { return glass is NSGlassEffectView }
        return glass is NSVisualEffectView
    }
    var titleFits: Bool {
        let text = busy ? "   " + title : title
        return segments.width(forSegment: 0) >= ceil((text as NSString).size(withAttributes: [.font:textFont]).width) + 20
    }
    init() {
        super.init(frame: .zero)
        setFrameSize(intrinsicContentSize)
        if #available(macOS 26.0, *), let effect = glass as? NSGlassEffectView {
            effect.style = .regular; effect.cornerRadius = 16; effect.contentView = segments
        } else { glass.addSubview(segments) }
        segments.font = textFont
        segments.segmentStyle = .texturedRounded
        segments.cell?.isBordered = false
        segments.usesGlassHover = true; segments.alignsFullFrame = true
        segments.setImage(NSImage(systemSymbolName: "chevron.down", accessibilityDescription: "Publish options")?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 9, weight: .medium)), forSegment: 1)
        segments.setWidth(22, forSegment: 1)
        segments.target = self; segments.action = #selector(activate(_:))
        segments.setContentHuggingPriority(.required, for: .horizontal)
        glass.translatesAutoresizingMaskIntoConstraints = false; addSubview(glass)
        segments.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([glass.leadingAnchor.constraint(equalTo: leadingAnchor), glass.trailingAnchor.constraint(equalTo: trailingAnchor),
            glass.topAnchor.constraint(equalTo: topAnchor), glass.bottomAnchor.constraint(equalTo: bottomAnchor),
            segments.leadingAnchor.constraint(equalTo: glass.leadingAnchor), segments.trailingAnchor.constraint(equalTo: glass.trailingAnchor),
            segments.topAnchor.constraint(equalTo: glass.topAnchor), segments.bottomAnchor.constraint(equalTo: glass.bottomAnchor)])
        spinnerView.isHidden = true; segments.addSubview(spinnerView)
        setTitle("Publish", busy: false, enabled: false)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
    override func layout() {
        super.layout()
        spinnerView.frame = NSRect(x: 10, y: (segments.bounds.height - 16) / 2, width: 16, height: 16)
    }
    func setTitle(_ title: String, busy: Bool, enabled: Bool) {
        self.title = title; self.busy = busy
        segments.setLabel(busy ? "   " + title : title, forSegment: 0)
        segments.setWidth(primaryWidth, forSegment: 0)
        segments.setEnabled(enabled, forSegment: 0); segments.setEnabled(enabled, forSegment: 1)
        segments.isEnabled = enabled
        segments.setToolTip(title, forSegment: 0); segments.setToolTip("Publish options", forSegment: 1)
        segments.setAccessibilityLabel(title)
        spinnerView.isHidden = !busy
        invalidateIntrinsicContentSize()
        setFrameSize(intrinsicContentSize)
    }
    func setSpinner(_ image: NSImage?) { spinnerView.image = image; spinnerView.isHidden = image == nil }
    @objc private func activate(_ sender: NSSegmentedControl) {
        defer { if sender.selectedSegment >= 0 { sender.setSelected(false, forSegment: sender.selectedSegment) } }
        guard let item, segments.isEnabled else { return }
        if sender.selectedSegment == 1 || item.action == nil {
            item.menu.popUp(positioning: nil, at: NSPoint(x: bounds.minX, y: isFlipped ? bounds.maxY + 4 : bounds.minY - 4), in: self)
        } else if let action = item.action { NSApp.sendAction(action, to: item.target, from: item) }
    }
}

private final class PublishSpinnerImageView: NSImageView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// LKM-187: eight template spinner frames beside the Publish text.
final class ToolbarPublishSpinner {
    static let frames = 8
    private static let images: [NSImage] = (0..<frames).map(frame)
    private var timer: Timer?
    private var phase = 0
    private weak var item: NSToolbarItem?
    private var changed: ((NSImage?) -> Void)?

    var spinning: Bool { timer != nil }

    /// Eight spokes, the head (`phase`) opaque and the tail fading counter-clockwise.
    static func frame(_ phase: Int) -> NSImage {
        let image = NSImage(size: NSSize(width: 16, height: 16), flipped: false) { rect in
            for spoke in 0..<frames {
                let angle = CGFloat.pi / 2 - CGFloat(spoke) * 2 * .pi / CGFloat(frames)
                let age = (phase - spoke + frames) % frames
                NSColor.black.withAlphaComponent(1 - CGFloat(age) / CGFloat(frames) * 0.85).setStroke()
                let path = NSBezierPath(); path.lineWidth = 1.8; path.lineCapStyle = .round
                path.move(to: NSPoint(x: rect.midX + cos(angle) * 3.5, y: rect.midY + sin(angle) * 3.5))
                path.line(to: NSPoint(x: rect.midX + cos(angle) * 7, y: rect.midY + sin(angle) * 7))
                path.stroke()
            }
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "In progress"
        return image
    }

    /// Spins on `item`, or stops (clearing the image) when nil.
    func spin(_ item: NSToolbarItem?, changed: @escaping (NSImage?) -> Void) {
        guard let item else {
            timer?.invalidate(); timer = nil
            self.item?.image = nil; self.item = nil; self.changed?(nil); self.changed = nil
            return
        }
        self.changed = changed
        self.item = item
        if item.image == nil { item.image = Self.images[phase] }
        changed(item.image)
        guard timer == nil else { return }
        let timer = Timer(timeInterval: 1.0 / 12, repeats: true) { [weak self] _ in
            guard let self, let item = self.item else { return }
            self.phase = (self.phase + 1) % Self.frames
            item.image = Self.images[self.phase]
            self.changed?(item.image)
        }
        // Common modes: it keeps turning while the item's menu is open.
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }
}

extension NativeShell {
    /// Publish's label, menu and spinner from the shell state. While a publish runs the
    /// control only opens its menu (a click can't publish twice): the step, and Cancel
    /// while the step allows it.
    func updatePublish(_ item: NSMenuToolbarItem, state: [String: Any], ready: Bool) {
        let publishing = state["publishing"] as? Bool ?? false
        let cancellable = publishing && state["publishCancellable"] as? Bool == true
        item.title = state["publishLabel"] as? String ?? "Publish"; item.label = item.title; item.toolTip = item.title
        item.isEnabled = ready
        item.target = self; item.action = publishing ? nil : #selector(toolbarAction(_:))
        let previousWidth = publishControl.intrinsicContentSize.width
        publishControl.setTitle(item.title, busy: publishing, enabled: ready)
        publishSpinner.spin(publishing ? item : nil) { [weak self] image in self?.publishControl.setSpinner(image) }
        let widthGrowth = publishControl.intrinsicContentSize.width - previousWidth
        if item.title != publishTitle || abs(widthGrowth) > 0.5 { republished(item.title, widthGrowth: widthGrowth) }
        let menu = NSMenu(); menu.autoenablesItems = false
        func add(_ title: String, _ action: String, _ value: String = "") -> NSMenuItem {
            let entry = NSMenuItem(title: title, action: #selector(previewMenuAction(_:)), keyEquivalent: ""); entry.target = self
            entry.representedObject = ["event":"shell-action", "action":action, "value":value]
            menu.addItem(entry); return entry
        }
        if publishing {
            let status = NSMenuItem(title: item.title, action: nil, keyEquivalent: ""); status.isEnabled = false
            menu.addItem(status)
            if cancellable { menu.addItem(.separator()); _ = add("Cancel Publish", "publish-cancel") }
        } else {
            for (title, value) in [("Create PR and merge to main", "merge"), ("Create PR", "pr")] {
                let entry = add(title, "publish-mode", value)
                entry.state = value == state["publishMode"] as? String ? .on : .off; entry.isEnabled = ready
            }
        }
        item.menu = menu
    }

    /// Opens the publish menu's Cancel, as the user would (tests).
    func cancelPublish(_ item: NSMenuToolbarItem?) -> Bool {
        guard let item, publishControl.segments.isEnabled, let entry = item.menu.items.first(where: {
            ($0.representedObject as? [String: String])?["action"] == "publish-cancel"
        }), entry.isEnabled else { return false }
        previewMenuAction(entry); return true
    }

    /// LKM-213: Publish against the other laid-out toolbar items (window x): it must be the last
    /// one, its trailing edge on the toolbar's trailing inset.
    func publishTrailingInspect() -> [String: Any] {
        let frames = toolbarFrames
        let order = frames.sorted { $0.value.minX < $1.value.minX }.map(\.key)
        var state: [String: Any] = ["publishMeasured":frames["publish"] != nil, "toolbarItemOrder":order,
            "publishVisible":toolbar.visibleItems?.contains { $0.itemIdentifier.rawValue == "publish" } ?? false]
        guard let publish = frames["publish"] else { return state }
        state["publishLeading"] = publish.minX; state["publishTrailing"] = publish.maxX
        state["publishTrailingInset"] = (window?.frame.width ?? 0) - publish.maxX
        state["beforePublishTrailing"] = frames.filter { $0.key != "publish" }.map(\.value.maxX).max() ?? 0
        return state
    }

    func publishInspect(_ item: NSMenuToolbarItem?, state: [String: Any]) -> [String: Any] {
        ["publishing":state["publishing"] as? Bool ?? false, "publishEnabled":publishControl.segments.isEnabled, "publishSpinning":publishSpinner.spinning && item?.image != nil,
         "publishClickable":item?.action != nil, "publishMenu":item?.menu.items.filter { !$0.isSeparatorItem }.map(\.title) ?? [],
         "publishFont":publishControl.textFont.fontName, "publishFontSize":publishControl.textFont.pointSize,
         "publishTitleFits":publishControl.titleFits, "publishControlWidth":publishControl.bounds.width,
         "publishControlGlass":publishControl.isNativeGlass, "publishControlEnabled":publishControl.segments.isEnabled,
         "publishControlLabel":publishControl.title]
    }
}
