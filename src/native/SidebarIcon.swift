import AppKit

enum SidebarRowStyle {
    static let height: CGFloat = 28
    static let font = NSFont.systemFont(ofSize: NSFont.systemFontSize)
}

/// SF Symbol image views report the symbol's alignment insets (the 19×14 folder
/// adds 3/2 points vertically), and Auto Layout sizes that alignment rect, so a
/// 16-point constraint drew the glyph in a 16.5×21 frame at a half-point origin.
/// Zero insets make the constraints size the frame the symbol is drawn in.
final class SidebarIconView: NSImageView {
    override var alignmentRectInsets: NSEdgeInsets { NSEdgeInsetsZero }
}

/// Leading symbol + label rhythm shared by project rows and the sidebar actions.
enum SidebarIconLayout {
    static let size: CGFloat = 16
    static let gap: CGFloat = 7

    static func constraints(icon: NSView, label: NSView, in container: NSView, leading: CGFloat) -> [NSLayoutConstraint] {
        [icon.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: leading),
         icon.centerYAnchor.constraint(equalTo: container.centerYAnchor),
         icon.widthAnchor.constraint(equalToConstant: size),
         icon.heightAnchor.constraint(equalToConstant: size),
         label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: gap),
         label.centerYAnchor.constraint(equalTo: container.centerYAnchor)]
    }
}

/// A project's favicon (`project:icon`'s data URL, LKM-372) as sidebar artwork, or nil so the
/// row keeps its folder: missing, non-image, corrupt or undecodable data never leaves a blank slot.
/// The image is fitted into the 16-point slot with its aspect ratio kept, so a tiny or large
/// favicon fills the same frame as the folder symbol.
enum SidebarFavicon {
    private final class Decoded { let image: NSImage?; init(_ image: NSImage?) { self.image = image } }
    private static let cache = NSCache<NSString, Decoded>()

    static func image(dataURL: String?) -> NSImage? {
        guard let uri = dataURL, uri.hasPrefix("data:image/"), let comma = uri.firstIndex(of: ",") else { return nil }
        if let hit = cache.object(forKey: uri as NSString) { return hit.image }
        let body = String(uri[uri.index(after: comma)...])
        let bytes = uri[..<comma].contains(";base64") ? Data(base64Encoded: body) : body.removingPercentEncoding?.data(using: .utf8)
        let image = bytes.flatMap(decode)
        cache.setObject(Decoded(image), forKey: uri as NSString)
        return image
    }

    static func decode(_ data: Data) -> NSImage? {
        guard !data.isEmpty, let image = NSImage(data: data), image.isValid, !image.representations.isEmpty else { return nil }
        let size = image.size
        guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0 else { return nil }
        // NSImage decodes lazily: render once so a truncated or corrupt body is refused here.
        var probe = NSRect(x: 0, y: 0, width: SidebarIconLayout.size * 2, height: SidebarIconLayout.size * 2)
        guard image.cgImage(forProposedRect: &probe, context: nil, hints: nil) != nil else { return nil }
        let scale = SidebarIconLayout.size / max(size.width, size.height)
        image.size = NSSize(width: size.width * scale, height: size.height * scale)
        image.isTemplate = false
        return image
    }
}

/// Pixel evidence for a row's icon slot: the share of painted pixels (a blank slot is 0) and
/// the centre pixel as sRGB `#RRGGBB`. Used by the sidebar verification and its unit fixture.
enum SidebarFaviconInk {
    static func measure(_ view: NSView) -> (fraction: Double, center: String) {
        // An explicit premultiplied RGBA rep at 2×, read as bytes: a window-less view has no
        // usable default colour space for `colorAt`.
        let width = Int(view.bounds.width * 2), height = Int(view.bounds.height * 2)
        guard width > 0, height > 0,
              let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
                                         samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                         bytesPerRow: width * 4, bitsPerPixel: 32),
              let bytes = rep.bitmapData else { return (0, "") }
        rep.size = view.bounds.size
        view.cacheDisplay(in: view.bounds, to: rep)
        var painted = 0
        for index in 0..<(width * height) where bytes[index * 4 + 3] > 25 { painted += 1 }
        let center = ((height / 2) * width + width / 2) * 4, alpha = Double(bytes[center + 3])
        let channel = { (offset: Int) in alpha > 0 ? Int(min(255, round(Double(bytes[center + offset]) * 255 / alpha))) : 0 }
        let hex = String(format: "#%02X%02X%02X", channel(0), channel(1), channel(2))
        return (Double(painted) / Double(width * height), hex)
    }
}

/// Full-width actions with the same regular label and icon rhythm as project rows.
final class SidebarProjectButton: NSButton {
    let label = NSTextField(labelWithString: "")
    let symbol = SidebarIconView()

    override var title: String { didSet { label.stringValue = title } }
    override var image: NSImage? { didSet { symbol.image = image } }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        label.font = SidebarRowStyle.font
        label.textColor = .labelColor
        label.lineBreakMode = .byTruncatingTail
        symbol.imageScaling = .scaleProportionallyDown
        symbol.contentTintColor = .labelColor
        for view in [symbol, label] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
        }
        NSLayoutConstraint.activate(SidebarIconLayout.constraints(icon: symbol, label: label, in: self, leading: 8) + [
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8)
        ])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func hitTest(_ point: NSPoint) -> NSView? { super.hitTest(point) == nil ? nil : self }
    override func draw(_ dirtyRect: NSRect) {
        if isHighlighted {
            NSColor.quaternaryLabelColor.setFill()
            NSBezierPath(roundedRect: bounds, xRadius: 7, yRadius: 7).fill()
        }
    }
}

