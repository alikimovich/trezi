import AppKit

/// A bounded, horizontally scrolling strip. Decode only when attachment IDs change,
/// not on every draft keystroke or streamed chat update. Image tiles match the sent
/// bubble's thumbnails (`AttachmentThumbnail`, LKM-166).
final class ComposerAttachments: NSScrollView {
    static let tileHeight = AttachmentThumbnail.side + 4
    static let rowHeight: CGFloat = tileHeight + 8
    private let row = NSView()
    private var ids: [String] = []
    private var tiles: [ComposerAttachmentTile] = []
    var remove: ((Int) -> Void)?
    var count: Int { tiles.count }

    init() {
        super.init(frame: .zero)
        drawsBackground = false; borderType = .noBorder
        hasHorizontalScroller = true; autohidesScrollers = true; scrollerStyle = .overlay
        documentView = row
        setAccessibilityLabel("Attached files")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func update(_ values: [[String: Any]]) {
        let nextIDs = values.map { $0["id"] as? String ?? "" }
        guard ids != nextIDs else { return }
        ids = nextIDs
        tiles.forEach { $0.dismissPreview(); $0.removeFromSuperview() }
        tiles = values.enumerated().map { index, value in
            let tile = ComposerAttachmentTile(value)
            tile.remove = { [weak self] in self?.remove?(index) }
            row.addSubview(tile)
            return tile
        }
        isHidden = tiles.isEmpty; needsLayout = true
        contentView.scroll(to: .zero)
    }
    override func layout() {
        super.layout()
        var x: CGFloat = 0
        for tile in tiles {
            let width: CGFloat = tile.hasThumbnail ? Self.tileHeight : 164
            tile.frame = NSRect(x: x, y: 4, width: width, height: Self.tileHeight)
            x += width + 10
        }
        row.frame = NSRect(x: 0, y: 0, width: max(contentSize.width, x - 10), height: Self.rowHeight)
    }
    func removeAt(_ index: Int) {
        guard tiles.indices.contains(index) else { return }
        tiles[index].removeButton.performClick(nil)
    }
    func inspect() -> [String: Any] {
        ["count":count, "images":tiles.filter { $0.hasThumbnail }.count, "checkerboards":tiles.filter { $0.checkerboard }.count,
         "tiles":tiles.map { NSStringFromRect($0.frame) },
         "height":bounds.height, "documentWidth":row.bounds.width, "viewportWidth":contentSize.width]
    }
}

private final class ComposerAttachmentTile: NSView {
    let isImage: Bool
    let hasThumbnail: Bool
    /// True when the thumbnail has transparency and sits on a checkerboard.
    let checkerboard: Bool
    let removeButton = NSButton()
    var remove: (() -> Void)?
    private let surface = NSView()
    private let checker = CheckerboardView()
    private let imageView = NSImageView()
    private let previewButton = NSButton()
    private let name: String
    private let imageData: Data?
    private var popover: NSPopover?

    init(_ value: [String: Any]) {
        name = value["name"] as? String ?? "Attachment"
        isImage = (value["type"] as? String ?? "").hasPrefix("image/")
        imageData = isImage ? Data(base64Encoded: value["data"] as? String ?? "") : nil
        let thumbnail = AttachmentThumbnail.image(imageData, maxPixels: AttachmentThumbnail.pixels)
        hasThumbnail = thumbnail != nil
        checkerboard = thumbnail.map(AttachmentThumbnail.hasAlpha) ?? false
        super.init(frame: .zero)
        surface.wantsLayer = true
        surface.layer?.cornerRadius = 10; surface.layer?.masksToBounds = true
        surface.layer?.borderWidth = 1
        addSubview(surface)
        if let thumbnail {
            checker.isHidden = !checkerboard
            surface.addSubview(checker)
            imageView.image = NSImage(cgImage: thumbnail, size: .zero)
            imageView.imageScaling = .scaleProportionallyUpOrDown
            surface.addSubview(imageView)
            previewButton.title = ""; previewButton.isBordered = false
            previewButton.target = self; previewButton.action = #selector(preview)
            previewButton.setAccessibilityLabel("Preview " + name)
            surface.addSubview(previewButton)
        } else {
            let icon = NSImageView(image: NSImage(systemSymbolName: isImage ? "photo" : "doc", accessibilityDescription: nil)!)
            icon.frame = NSRect(x: 10, y: 40, width: 20, height: 22)
            surface.addSubview(icon)
            let label = NSTextField(wrappingLabelWithString: name)
            label.font = .systemFont(ofSize: 11, weight: .medium); label.textColor = .labelColor
            label.maximumNumberOfLines = 2; label.lineBreakMode = .byTruncatingMiddle
            label.frame = NSRect(x: 10, y: 6, width: 140, height: 30)
            surface.addSubview(label)
        }
        toolTip = name
        removeButton.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Remove " + name)
        removeButton.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 8, weight: .bold)
        removeButton.bezelStyle = .circular; removeButton.isBordered = true
        removeButton.title = ""; removeButton.target = self; removeButton.action = #selector(removeClicked)
        removeButton.setAccessibilityLabel("Remove " + name); removeButton.toolTip = "Remove " + name
        addSubview(removeButton)
        updateColors()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func layout() {
        super.layout()
        surface.frame = bounds.insetBy(dx: 2, dy: 2)
        for view in [checker, imageView, previewButton] { view.frame = surface.bounds }
        removeButton.frame = NSRect(x: bounds.width - 22, y: bounds.height - 22, width: 20, height: 20)
    }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); updateColors() }
    override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); updateColors() }
    private func updateColors() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            surface.layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
            surface.layer?.borderColor = NSColor.separatorColor.cgColor
        }
    }
    @objc private func removeClicked() { dismissPreview(); remove?() }
    func dismissPreview() { popover?.close(); popover = nil }
    @objc private func preview() {
        guard let cgImage = AttachmentThumbnail.image(imageData, maxPixels: 1600) else { return }
        let scale = min(1, 480 / CGFloat(cgImage.width), 360 / CGFloat(cgImage.height))
        let size = NSSize(width: max(80, CGFloat(cgImage.width) * scale), height: max(80, CGFloat(cgImage.height) * scale))
        let view = NSImageView(frame: NSRect(origin: .zero, size: size))
        view.image = NSImage(cgImage: cgImage, size: .zero); view.imageScaling = .scaleProportionallyUpOrDown
        view.setAccessibilityLabel(name)
        let container = AttachmentThumbnail.hasAlpha(cgImage) ? CheckerboardView(frame: view.frame) : NSView(frame: view.frame)
        container.addSubview(view)
        let controller = NSViewController(); controller.view = container
        let panel = NSPopover(); panel.behavior = .transient; panel.contentViewController = controller
        panel.contentSize = size; panel.show(relativeTo: bounds, of: self, preferredEdge: .maxY)
        popover = panel
    }
}
