import AppKit

/// LKM-389: the in-chat status line's shimmer (`ChatActivity`) on a sidebar chat title, with the
/// same band and timing. The chat lays a primary copy of its text over a secondary one and masks
/// the copy; here the label is the only text, so it keeps its vibrancy, selection colour,
/// truncation and marquee. Its mask dims it to `resting` and lets it through under the band.
/// The band's phase comes from the clock, as in the chat, so a row rebuilt by a state change
/// carries on where it was. Reduce Motion holds the dimmed title, as the chat holds its secondary
/// text. Nothing runs without a window, and an idle row has no shimmer at all.
final class SidebarTitleShimmer: NSObject {
    static let period: CFTimeInterval = 2
    static let bandWidth: CGFloat = 55
    /// The dimmed title's opacity: the most the sweep can show with the title still readable
    /// on its row (`test/sidebar-shimmer.mjs` measures the contrast).
    static func resting(emphasized: Bool) -> CGFloat { emphasized ? 0.9 : 0.72 }

    let label: NSTextField
    let mask = CALayer()
    let band = CAGradientLayer()
    /// "sweep", "still" (Reduce Motion) or "off" (no window).
    private(set) var mode = "off"
    private var width: CGFloat = 0
    var emphasized = false { didSet { if emphasized != oldValue { refresh() } } }

    init(label: NSTextField) {
        self.label = label
        super.init()
        band.colors = [CGColor.clear, CGColor(gray: 0, alpha: 1), CGColor.clear]
        band.startPoint = CGPoint(x: 0, y: 0.5); band.endPoint = CGPoint(x: 1, y: 0.5)
        mask.addSublayer(band)
        label.postsFrameChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(resized), name: NSView.frameDidChangeNotification, object: label)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(refresh), name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil)
        refresh()
    }

    /// Follows the window, the row's selection and Reduce Motion.
    @objc func refresh() {
        band.removeAnimation(forKey: "shimmer")
        guard label.window != nil else { show("off"); return }
        if SidebarMarqueeTitle.reduceMotion { show("still"); return }
        show("sweep")
        sweep()
    }

    private func show(_ next: String) {
        mode = next
        label.alphaValue = next == "still" ? Self.resting(emphasized: emphasized) : 1
        if next != "sweep" { label.layer?.mask = nil }
    }

    /// The hover's Archive, a sidebar resize and the marquee all change the label's width.
    @objc private func resized() {
        guard mode == "sweep", label.bounds.width != width else { return }
        sweep()
    }

    private func sweep() {
        width = label.bounds.width
        label.wantsLayer = true
        CATransaction.begin(); CATransaction.setDisableActions(true)
        mask.frame = label.bounds
        mask.backgroundColor = CGColor(gray: 0, alpha: Self.resting(emphasized: emphasized))
        band.frame = CGRect(x: -Self.bandWidth, y: 0, width: Self.bandWidth, height: label.bounds.height)
        CATransaction.commit()
        if label.layer?.mask !== mask { label.layer?.mask = mask }
        let move = CABasicAnimation(keyPath: "position.x")
        move.fromValue = -Self.bandWidth / 2
        move.toValue = width + Self.bandWidth * 1.5
        move.duration = Self.period
        move.timeOffset = Date().timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: Self.period)
        move.repeatCount = .infinity
        move.timingFunction = CAMediaTimingFunction(name: .linear)
        move.isRemovedOnCompletion = false
        band.add(move, forKey: "shimmer")
    }

    func inspect() -> [String: Any] {
        ["mode": mode, "resting": Self.resting(emphasized: emphasized), "alpha": label.alphaValue,
         "masked": label.layer?.mask === mask, "animated": band.animation(forKey: "shimmer") != nil]
    }
}
