import AppKit

/// Native "Scroll to latest message" button: a round chevron centered over the
/// chat column, `gap` above the composer bubble. It was a SwiftUI Button:
/// acceptance clicks at its exact rendered frame never ran its action (click
/// count 0, hit target the hosting view). AppKit's button runs its own tracking
/// loop over the event queue, like the scroller, so every click path reaches it,
/// and it stays a standard native, accessible control.
///
/// The transcript is not masked under it (LKM-190): text scrolls on under the
/// button and the composer, so the button carries its own backdrop, Liquid Glass
/// on macOS 26 (as the composer) and a popover blur before, and claims every
/// click inside its circle so nothing under it is clicked through.
final class ChatLatestButton: NSButton {
    static let diameter: CGFloat = 30
    static let gap: CGFloat = 8
    /// The glass (or blur) circle behind the chevron.
    let backdrop: NSView
    private let chevron = NSImageView()
    var onPress: () -> Void = {}
    init() {
        let frame = NSRect(x: 0, y: 0, width: Self.diameter, height: Self.diameter)
        if #available(macOS 26.0, *) {
            let glass = NSGlassEffectView(frame: frame); glass.style = .regular; glass.cornerRadius = Self.diameter / 2
            backdrop = glass
        } else {
            let effect = NSVisualEffectView(frame: frame); effect.material = .popover
            effect.blendingMode = .withinWindow; effect.state = .followsWindowActiveState
            effect.wantsLayer = true; effect.layer?.cornerRadius = Self.diameter / 2; effect.layer?.masksToBounds = true
            backdrop = effect
        }
        super.init(frame: frame)
        let cell = LatestButtonCell()
        cell.onHighlight = { [weak self] in self?.chevron.contentTintColor = $0 ? .labelColor : .secondaryLabelColor }
        self.cell = cell
        title = ""
        imagePosition = .noImage
        isBordered = false
        wantsLayer = true
        backdrop.autoresizingMask = [.width, .height]; backdrop.setAccessibilityElement(false)
        chevron.image = NSImage(systemSymbolName: "chevron.down", accessibilityDescription: nil)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 12, weight: .semibold))
        chevron.contentTintColor = .secondaryLabelColor
        chevron.imageScaling = .scaleNone
        chevron.frame = bounds; chevron.autoresizingMask = [.width, .height]; chevron.setAccessibilityElement(false)
        if #available(macOS 26.0, *), let glass = backdrop as? NSGlassEffectView {
            glass.contentView = chevron
        } else {
            backdrop.addSubview(chevron)
            let lift = NSShadow()
            lift.shadowColor = .black.withAlphaComponent(0.14); lift.shadowBlurRadius = 4; lift.shadowOffset = NSSize(width: 0, height: -1)
            shadow = lift
        }
        addSubview(backdrop)
        toolTip = "Scroll to latest message"
        setAccessibilityLabel("Scroll to latest message")
        target = self
        action = #selector(press)
        isHidden = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    @objc private func press() { onPress() }
    override var intrinsicContentSize: NSSize { NSSize(width: Self.diameter, height: Self.diameter) }
    /// The backdrop and chevron are drawing only: every point of the circle is
    /// the button's, so its own tracking loop gets the click, never the text below.
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden, let superview else { return nil }
        let local = convert(point, from: superview)
        return NSBezierPath(ovalIn: bounds).contains(local) ? self : nil
    }
    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() { NSBezierPath(ovalIn: bounds).fill() }
    /// Places the button over `chat` (a sibling in the same superview): centered
    /// on the column, `gap` above a composer `composerHeight` tall. That is inside
    /// the composer clearance, below the reading area. Returns the frame in the
    /// chat's top-left space, or zero while hidden.
    @discardableResult
    func place(over chat: NSView, composerHeight: CGFloat, visible: Bool) -> CGRect {
        isHidden = !visible || chat.isHidden || superview == nil
        guard !isHidden, let superview else { return .zero }
        let size = Self.diameter
        let x = ((chat.bounds.width - size) / 2).rounded()
        let bottomGap = ChatLayout.composerInset + composerHeight + Self.gap
        let top = chat.bounds.height - bottomGap - size
        let local = NSRect(x: x, y: chat.isFlipped ? top : bottomGap, width: size, height: size)
        frame = superview.convert(local, from: chat)
        return NSRect(x: x, y: top, width: size, height: size)
    }
}

/// Reports the pressed state the button's tracking loop sets, so the chevron
/// (drawn above the backdrop, not by the cell) can show it.
private final class LatestButtonCell: NSButtonCell {
    var onHighlight: (Bool) -> Void = { _ in }
    override func highlight(_ flag: Bool, withFrame cellFrame: NSRect, in controlView: NSView) {
        super.highlight(flag, withFrame: cellFrame, in: controlView)
        onHighlight(flag)
    }
}
