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

