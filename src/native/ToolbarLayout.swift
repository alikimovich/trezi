import AppKit

private var toolbarSymbolCache: [String: NSImage] = [:]

func toolbarSymbol(_ name: String, _ label: String? = nil, size: CGFloat = 20) -> NSImage? {
    let key = name + "|" + (label ?? "") + "|" + String(Double(size))
    if let cached = toolbarSymbolCache[key] { return cached }
    // Toolbar controls reconfigure SF Symbols to their own standard size.
    // Give AppKit a template bitmap with fixed glyph bounds instead, keeping
    // system tinting and native buttons without the symbol-size override.
    guard let symbol = NSImage(systemSymbolName: name, accessibilityDescription: label)?
        .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 14, weight: .regular)),
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 40, pixelsHigh: 40,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
        let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return nil }
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = context
    let scale = 36 / max(symbol.size.width, symbol.size.height)
    let glyphSize = NSSize(width: symbol.size.width * scale, height: symbol.size.height * scale)
    symbol.draw(in: NSRect(x: (40 - glyphSize.width) / 2, y: (40 - glyphSize.height) / 2, width: glyphSize.width, height: glyphSize.height))
    NSGraphicsContext.restoreGraphicsState()
    let image = NSImage(size: NSSize(width: size, height: size))
    image.addRepresentation(bitmap); image.isTemplate = true
    image.accessibilityDescription = label
    toolbarSymbolCache[key] = image
    return image
}

/// The symbol in the accent colour, for a segment that shows a state (LKM-213: slow motion
/// inside the interaction group, where an item's prominent style does not draw).
func toolbarAccentSymbol(_ name: String, _ label: String? = nil) -> NSImage? {
    guard let glyph = toolbarSymbol(name, label) else { return nil }
    let image = NSImage(size: glyph.size, flipped: false) { rect in
        glyph.draw(in: rect)
        NSColor.controlAccentColor.set(); rect.fill(using: .sourceAtop)
        return true
    }
    image.accessibilityDescription = label
    return image
}

/// LKM-213: laid-out toolbar item frames (window coordinates) by identifier. NSToolbarItem has
/// no public frame, so this reads AppKit's item views; nil-safe for inspection and estimates only.
func toolbarItemFrames(_ window: NSWindow?) -> [String: NSRect] {
    guard let root = window?.contentView?.superview else { return [:] }
    var frames: [String: NSRect] = [:]
    let key = NSSelectorFromString("item")
    func walk(_ view: NSView) {
        guard !view.isHidden else { return }
        if NSStringFromClass(type(of: view)).contains("Toolbar"), view.responds(to: key),
           let item = view.value(forKey: "item") as? NSToolbarItem, view.bounds.width > 0 {
            frames[item.itemIdentifier.rawValue] = view.convert(view.bounds, to: nil)
            return
        }
        view.subviews.forEach(walk)
    }
    walk(root)
    return frames
}

/// Keep the system sidebar toggle consistent with the preview toolbar symbols.
final class ToolbarLayout {
    init(toolbar: NSToolbar, sidebar: NSSplitViewItem) {
        toolbar.items.first { $0.itemIdentifier == .toggleSidebar }?.image = toolbarSymbol("sidebar.left", "Toggle Sidebar")
    }
}

/// Use an explicit momentary control: selectionMode on a group assembled from
/// subitems does not configure AppKit's automatically created segmented view.
final class MomentaryToolbarGroup: NSToolbarItemGroup {
    private let control: NSSegmentedControl
    /// Subitems without a segment (LKM-213: slow motion in a narrow window).
    private var hiddenSegments: Set<String> = []
    /// The subitems that have a segment, in segment order.
    var shown: [NSToolbarItem] { subitems.filter { !hiddenSegments.contains($0.itemIdentifier.rawValue) } }
    init(identifier: NSToolbarItem.Identifier, items: [NSToolbarItem]) {
        control = NSSegmentedControl(images: items.map { $0.image ?? NSImage() }, trackingMode: .momentary, target: nil, action: nil)
        super.init(itemIdentifier: identifier)
        subitems = items; selectionMode = .momentary
        control.segmentStyle = .texturedRounded
        view = control
        target = self; action = #selector(activate(_:))
        control.target = self; control.action = #selector(activate(_:))
        refresh()
    }
    func refresh() {
        let items = shown
        if control.segmentCount != items.count { control.segmentCount = items.count }
        for (index, item) in items.enumerated() {
            control.setWidth(32, forSegment: index)
            control.setImage(item.image, forSegment: index)
            control.setEnabled(item.isEnabled, forSegment: index)
            control.setToolTip(item.toolTip ?? item.label, forSegment: index)
        }
    }
    /// Removes or restores a subitem's segment; returns how much narrower the control got.
    func setSegment(_ identifier: String, hidden hide: Bool) -> CGFloat {
        guard hiddenSegments.contains(identifier) != hide else { return 0 }
        let before = control.intrinsicContentSize.width
        if hide { hiddenSegments.insert(identifier) } else { hiddenSegments.remove(identifier) }
        refresh(); control.invalidateIntrinsicContentSize()
        return before - control.intrinsicContentSize.width
    }
    var hasMomentaryControl: Bool {
        (control.cell as? NSSegmentedCell)?.trackingMode == .momentary && control.selectedSegment == -1
    }
    func clickSegment(_ identifier: String) -> Bool {
        let subitems = shown
        // A menu segment would block the pipe in its menu; checks pick its entries directly.
        guard let index = subitems.firstIndex(where: { $0.itemIdentifier.rawValue == identifier }), subitems[index].isEnabled,
              !(subitems[index] is NSMenuToolbarItem) else { return false }
        // Momentary cells only expose selection during mouse tracking. Simulate
        // that transient selection for the automation action, then restore it.
        guard let cell = control.cell as? NSSegmentedCell else { return false }
        cell.trackingMode = .selectOne
        defer { cell.trackingMode = .momentary }
        control.selectedSegment = index
        control.sendAction(control.action, to: control.target)
        return true
    }
    /// A segment's frame in window coordinates; nil while the group is not in the window.
    func segmentFrame(_ identifier: String) -> NSRect? {
        let subitems = shown
        guard let index = subitems.firstIndex(where: { $0.itemIdentifier.rawValue == identifier }), control.window != nil, !subitems.isEmpty else { return nil }
        let width = control.bounds.width / CGFloat(subitems.count)
        return control.convert(NSRect(x: control.bounds.minX + width * CGFloat(index), y: control.bounds.minY, width: width, height: control.bounds.height), to: nil)
    }
    @objc private func activate(_ sender: NSSegmentedControl) {
        let index = sender.selectedSegment, subitems = shown
        guard subitems.indices.contains(index) else { return }
        let item = subitems[index]
        // Clear immediately, independent of later renderer state updates.
        defer { sender.setSelected(false, forSegment: index) }
        guard item.isEnabled else { return }
        // A menu-only subitem (slow motion) opens its menu under its segment.
        if let menuItem = item as? NSMenuToolbarItem, item.action == nil {
            sender.setSelected(false, forSegment: index)
            let width = sender.bounds.width / CGFloat(subitems.count)
            menuItem.menu.popUp(positioning: nil, at: NSPoint(x: sender.bounds.minX + width * CGFloat(index), y: sender.isFlipped ? sender.bounds.maxY + 4 : sender.bounds.minY - 4), in: sender)
        } else if let action = item.action { NSApp.sendAction(action, to: item.target, from: item) }
    }
}

/// Shared history/new-chat capsule inside the column-aligned chat header.
final class ChatToolbarActions: NSView {
    let control = NSSegmentedControl(images: [toolbarSymbol("clock.arrow.circlepath")!, toolbarSymbol("square.and.pencil")!], trackingMode: .momentary, target: nil, action: nil)
    var onNewChat: (() -> Void)?
    var historyMenu: NSMenu?
    override init(frame: NSRect) {
        super.init(frame: frame)
        control.segmentStyle = .texturedRounded
        for index in 0..<2 { control.setWidth(32, forSegment: index) }
        control.setShowsMenuIndicator(false, forSegment: 0)
        control.setToolTip("Chat History", forSegment: 0)
        control.setToolTip("New Chat", forSegment: 1)
        control.target = self; control.action = #selector(activate(_:))
        let surface: NSView
        if #available(macOS 26.0, *) {
            let glass = NSGlassEffectView()
            glass.cornerRadius = 18
            glass.contentView = control
            surface = glass
        } else { surface = control }
        surface.translatesAutoresizingMaskIntoConstraints = false
        addSubview(surface)
        NSLayoutConstraint.activate([
            surface.leadingAnchor.constraint(equalTo: leadingAnchor), surface.trailingAnchor.constraint(equalTo: trailingAnchor),
            surface.topAnchor.constraint(equalTo: topAnchor), surface.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func updateEnabled(project: Bool, history: Bool) {
        control.setEnabled(history, forSegment: 0)
        control.setEnabled(project, forSegment: 1)
    }
    @objc private func activate(_ sender: NSSegmentedControl) {
        let segment = sender.selectedSegment
        guard segment >= 0 else { return }
        sender.setSelected(false, forSegment: segment)
        if segment == 0 { historyMenu?.popUp(positioning: nil, at: NSPoint(x: 0, y: -4), in: self) }
        else if segment == 1 { onNewChat?() }
    }
}
