import AppKit

/// A sidebar chat title that truncates at rest and, while its row is hovered, scrolls to show
/// the rest of an overflowing title: the retired Electron rail's marquee (`RailChatTitle`). The
/// scroll waits 0.7 s, moves at 30 points a second and holds at the end until the pointer
/// leaves. Reduce Motion keeps the truncated title (the row's tooltip has the full one).
final class SidebarMarqueeTitle: NSView {
    static let delay: CFTimeInterval = 0.7
    static let speed: CGFloat = 30
    let label: NSTextField
    /// Test seam for the pipe checks (`marquee-reduce-motion`): tests never change system settings.
    static var reduceMotionOverride: Bool?
    static var reduceMotion: Bool { reduceMotionOverride ?? NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
    private var fit: NSLayoutConstraint!
    private var natural: NSLayoutConstraint?
    private(set) var running = false

    init(title: String) {
        label = NSTextField(labelWithString: title)
        super.init(frame: .zero)
        label.font = SidebarRowStyle.font
        label.lineBreakMode = .byTruncatingTail
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        label.translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        layer?.masksToBounds = true
        addSubview(label)
        fit = label.trailingAnchor.constraint(equalTo: trailingAnchor)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor), fit,
            label.topAnchor.constraint(equalTo: topAnchor), label.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var intrinsicContentSize: NSSize { label.intrinsicContentSize }
    /// How far the title must move to show its end; 0 when it fits.
    var travel: CGFloat { max(0, ceil(label.intrinsicContentSize.width) - bounds.width) }

    /// Starts the scroll when the title overflows the width it has now.
    func start() {
        guard !running, !Self.reduceMotion else { return }
        superview?.layoutSubtreeIfNeeded()
        let distance = travel
        guard distance > 1 else { return }
        running = true
        fit.isActive = false
        let natural = label.widthAnchor.constraint(equalToConstant: ceil(label.intrinsicContentSize.width))
        natural.isActive = true; self.natural = natural
        label.lineBreakMode = .byClipping
        layoutSubtreeIfNeeded()
        label.wantsLayer = true
        let scroll = CABasicAnimation(keyPath: "transform.translation.x")
        scroll.fromValue = 0; scroll.toValue = -distance
        scroll.duration = CFTimeInterval(distance / Self.speed)
        scroll.beginTime = CACurrentMediaTime() + Self.delay
        scroll.timingFunction = CAMediaTimingFunction(name: .linear)
        scroll.fillMode = .both; scroll.isRemovedOnCompletion = false
        label.layer?.add(scroll, forKey: "marquee")
    }

    /// Back to the truncated title at its start.
    func stop() {
        guard running else { return }
        running = false
        label.layer?.removeAnimation(forKey: "marquee")
        natural?.isActive = false; natural = nil
        fit.isActive = true
        label.lineBreakMode = .byTruncatingTail
    }
}
