import AppKit

/// A sidebar chat title that truncates at rest and, while its row is hovered, scrolls to show
/// the rest of an overflowing title: the retired Electron rail's marquee (`RailChatTitle`). The
/// scroll waits 0.7 s, moves at 30 points a second and holds at the end until the pointer
/// leaves. Reduce Motion keeps the truncated title (the row's tooltip has the full one).
///
/// LKM-387: the label moves by layout, one step a frame, never by a layer transform. AppKit
/// paints a layer-backed view only inside its `visibleRect`, so a widened label's layer holds
/// just the title's width of text, and translating that layer drags the painted edge in with
/// it. Each step here reads the width the title has now, so a resize keeps the text's end on
/// the title's edge. Each edge fades while text runs past it, and no further.
final class SidebarMarqueeTitle: NSView {
    static let delay: CFTimeInterval = 0.7
    static let speed: CGFloat = 30
    /// How far each soft edge reaches into the title.
    static let fade: CGFloat = 14
    let label: NSTextField
    /// Test seam for the pipe checks (`marquee-reduce-motion`): tests never change system settings.
    static var reduceMotionOverride: Bool?
    static var reduceMotion: Bool { reduceMotionOverride ?? NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
    private var fit: NSLayoutConstraint!
    private var shift: NSLayoutConstraint!
    private var natural: NSLayoutConstraint?
    private var timer: Timer?
    private var began: CFTimeInterval = 0
    private let edges = CAGradientLayer()
    /// The row is hovered, whether or not the title overflows right now.
    private var wanted = false
    private(set) var running = false
    private(set) var offset: CGFloat = 0

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
        shift = label.leadingAnchor.constraint(equalTo: leadingAnchor)
        NSLayoutConstraint.activate([
            shift, fit,
            label.topAnchor.constraint(equalTo: topAnchor), label.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        edges.startPoint = CGPoint(x: 0, y: 0.5); edges.endPoint = CGPoint(x: 1, y: 0.5)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var intrinsicContentSize: NSSize { label.intrinsicContentSize }
    /// How far the title must move to show its end; 0 when it fits.
    var travel: CGFloat { max(0, ceil(label.intrinsicContentSize.width) - bounds.width) }

    /// A width change while hovered can start, retarget or end the scroll; the next step applies it.
    override func setFrameSize(_ newSize: NSSize) {
        let resized = newSize.width != frame.width
        super.setFrameSize(newSize)
        if resized && wanted { wake() }
    }

    /// Follows the hover: scrolls whenever the title overflows the width it has.
    func start() {
        guard !wanted else { return }
        wanted = true
        superview?.layoutSubtreeIfNeeded()
        step()
    }

    /// Back to the truncated title at its start.
    func stop() {
        wanted = false
        rest()
    }

    private func wake() {
        guard timer == nil else { return }
        // `.common`, so the text keeps moving during a live resize or a menu.
        let timer = Timer(timeInterval: 1.0 / 60, target: self, selector: #selector(step), userInfo: nil, repeats: true)
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    @objc private func step() {
        let distance = travel
        guard wanted, window != nil, !Self.reduceMotion, distance > 1 else { rest(); return }
        if !running {
            running = true
            began = CACurrentMediaTime()
            fit.isActive = false
            let natural = label.widthAnchor.constraint(equalToConstant: ceil(label.intrinsicContentSize.width))
            natural.isActive = true; self.natural = natural
            label.lineBreakMode = .byClipping
        }
        let moved = min(distance, max(0, CGFloat(CACurrentMediaTime() - began - Self.delay) * Self.speed))
        let scale = window?.backingScaleFactor ?? 2
        offset = (moved * scale).rounded() / scale
        shift.constant = -offset
        layoutSubtreeIfNeeded()
        label.needsDisplay = true
        shade(distance)
        // Holding at the end needs no frames; a resize wakes it.
        if moved >= distance { timer?.invalidate(); timer = nil } else { wake() }
    }

    private func rest() {
        timer?.invalidate(); timer = nil
        guard running else { return }
        running = false
        offset = 0; shift.constant = 0
        natural?.isActive = false; natural = nil
        fit.isActive = true
        label.lineBreakMode = .byTruncatingTail
        layer?.mask = nil
    }

    /// Soft edges: one opens as text leaves past it and closes as the text's end arrives, so the
    /// first and last glyphs are never faded, and neither edge ever cuts a glyph hard.
    private func shade(_ distance: CGFloat) {
        let stop = min(Self.fade / max(bounds.width, 1), 0.5)
        CATransaction.begin(); CATransaction.setDisableActions(true)
        edges.frame = bounds
        edges.locations = [0, stop, 1 - stop, 1].map { NSNumber(value: Double($0)) }
        edges.colors = [CGColor(gray: 0, alpha: 1 - fadeLeading), CGColor(gray: 0, alpha: 1), CGColor(gray: 0, alpha: 1),
                        CGColor(gray: 0, alpha: 1 - fadeTrailing(distance))]
        CATransaction.commit()
        if layer?.mask !== edges { layer?.mask = edges }
    }
    private var fadeLeading: CGFloat { running ? min(offset / Self.fade, 1) : 0 }
    private func fadeTrailing(_ distance: CGFloat) -> CGFloat { running ? min(max(0, distance - offset) / Self.fade, 1) : 0 }

    /// State and geometry for the pipe checks, in `reference`'s top-left coordinates, so that a
    /// capture of `reference` can be cropped to the title. `archive` is the row's trailing control.
    func inspect(archive: NSView?, in reference: NSView) -> [String: Any] {
        let box = reference.convert(bounds, from: self)
        let top = reference.isFlipped ? box.minY : reference.bounds.height - box.maxY
        var state: [String: Any] = ["offset": offset, "width": bounds.width, "labelWidth": label.frame.width,
                                    "natural": ceil(label.intrinsicContentSize.width), "truncated": label.lineBreakMode == .byTruncatingTail,
                                    "x": box.minX, "y": top, "height": box.height, "referenceWidth": reference.bounds.width,
                                    "textEnd": box.minX + label.frame.maxX, "fadeLeading": fadeLeading, "fadeTrailing": fadeTrailing(travel)]
        if let archive { state["archiveLeft"] = reference.convert(archive.bounds, from: archive).minX }
        return state
    }
}
