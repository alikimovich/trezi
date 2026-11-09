import AppKit

/// LKM-618: the one line under the selected project while its open-chat list is still being read
/// (`chatsLoading` from `shell-controller.ts`). It stands in for the whole list, so it implies no
/// count, and it is not a chat: not selectable, no Archive, no context menu, no click.
///
/// The preview's pixel cat (`CatArtwork`, its two run frames) runs from the status slot under
/// the project's icon to the row's trailing inset and back, facing the way it runs. All motion is
/// Core Animation on one shape layer (position, facing and frames), so no app timer runs and
/// nothing is laid out per frame; a removed, re-hosted or resized row re-adds the animations from
/// its own width. With Reduce Motion the cat sits still at the start of the row. VoiceOver reads
/// one static "Loading chats".
final class SidebarChatsLoaderCell: NSTableCellView {
    static let catSize: CGFloat = 16
    /// Points per second: one pass across a 200-point sidebar takes about four seconds.
    static let speed: CGFloat = 44
    static let label = "Loading chats"
    /// Test seam; nil reads the system setting.
    static var reduceMotionOverride: Bool?
    static var reduceMotion: Bool { reduceMotionOverride ?? NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
    /// The run art leans left (its ears sit left of centre), so it is mirrored while running right.
    static let runsLeft = true

    let track = NSView()
    let cat = CAShapeLayer()
    /// The cat's travel in points last laid out; -1 before the first layout.
    private(set) var travel: CGFloat = -1
    private(set) var mode = "none"
    private var reduceMotionObserver: NSObjectProtocol?

    init(row: ShellRow) {
        super.init(frame: .zero)
        identifier = NSUserInterfaceItemIdentifier(row.id)
        track.wantsLayer = true
        track.translatesAutoresizingMaskIntoConstraints = false
        addSubview(track)
        NSLayoutConstraint.activate([
            track.leadingAnchor.constraint(equalTo: leadingAnchor, constant: SourceList.iconLeading),
            track.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            track.centerYAnchor.constraint(equalTo: centerYAnchor),
            track.heightAnchor.constraint(equalToConstant: Self.catSize)
        ])
        cat.bounds = CGRect(x: 0, y: 0, width: Self.catSize, height: Self.catSize)
        track.layer?.addSublayer(cat)
        toolTip = Self.label
        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
        setAccessibilityLabel(Self.label)
        recolor()
        reduceMotionObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.restart(force: true) }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    deinit { if let reduceMotionObserver { NSWorkspace.shared.notificationCenter.removeObserver(reduceMotionObserver) } }

    override func layout() { super.layout(); restart(force: false) }
    override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); restart(force: true) }
    override func viewDidHide() { super.viewDidHide(); restart(force: true) }
    override func viewDidUnhide() { super.viewDidUnhide(); restart(force: true) }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); recolor() }

    /// Monochrome and quiet: the tertiary label colour of the current appearance.
    private func recolor() {
        var color = NSColor.tertiaryLabelColor.cgColor
        effectiveAppearance.performAsCurrentDrawingAppearance { color = NSColor.tertiaryLabelColor.cgColor }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        cat.fillColor = color
        CATransaction.commit()
    }

    /// One 32×32 artwork frame as a path in the cat layer's (unflipped) coordinates.
    static func path(_ pixels: [[Double]]) -> CGPath {
        let path = CGMutablePath(), scale = catSize / 32
        for pixel in pixels where pixel.count == 4 {
            path.addRect(CGRect(x: pixel[0] * scale, y: catSize - (pixel[1] + pixel[3]) * scale,
                                width: pixel[2] * scale, height: pixel[3] * scale))
        }
        return path
    }

    /// Re-adds the motion for the current width, or holds the cat still. Without a window, or while
    /// hidden, no animation is attached at all.
    func restart(force: Bool) {
        let span = max(0, track.bounds.width - Self.catSize)
        let moving = window != nil && !isHiddenOrHasHiddenAncestor && !Self.reduceMotion && span > 0
        let next = window == nil || isHiddenOrHasHiddenAncestor ? "none" : moving ? "run" : "still"
        guard force || span != travel || next != mode else { return }
        travel = span; mode = next
        let run = CatArtwork.frames["run"] ?? []
        let rest = CatArtwork.frames["rest"]?.first?.pixels ?? run.first?.pixels ?? []
        CATransaction.begin(); CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        cat.removeAllAnimations()
        cat.position = CGPoint(x: Self.catSize / 2, y: track.bounds.midY)
        cat.transform = CATransform3DIdentity
        guard moving, !run.isEmpty else { cat.path = Self.path(rest); return }
        cat.path = Self.path(run[0].pixels)
        let now = CACurrentMediaTime()
        // There and back at a steady speed; the phase follows the clock, so a rebuilt row resumes
        // where the old one was instead of jumping back to the start.
        let leg = Double(span / Self.speed), period = leg * 2
        let move = CAKeyframeAnimation(keyPath: "position.x")
        move.values = [Self.catSize / 2, Self.catSize / 2 + span, Self.catSize / 2]
        move.keyTimes = [0, 0.5, 1]
        move.calculationMode = .linear
        let facing = CAKeyframeAnimation(keyPath: "transform.scale.x")
        // Discrete: one more key time than values. Running right first.
        facing.values = Self.runsLeft ? [-1, 1] : [1, -1]
        facing.keyTimes = [0, 0.5, 1]
        facing.calculationMode = .discrete
        for animation in [move, facing] {
            animation.duration = period; animation.repeatCount = .infinity
            animation.timeOffset = now.truncatingRemainder(dividingBy: period)
        }
        let total = run.reduce(0) { $0 + max(0.04, $1.duration / 1000) }
        var elapsed = 0.0, times: [NSNumber] = []
        for frame in run { times.append(NSNumber(value: elapsed / total)); elapsed += max(0.04, frame.duration / 1000) }
        let frames = CAKeyframeAnimation(keyPath: "path")
        frames.values = run.map { Self.path($0.pixels) }
        frames.keyTimes = times + [1]
        frames.calculationMode = .discrete
        frames.duration = total; frames.repeatCount = .infinity
        frames.timeOffset = now.truncatingRemainder(dividingBy: total)
        cat.add(move, forKey: "travel"); cat.add(facing, forKey: "facing"); cat.add(frames, forKey: "run")
    }

    /// For the fixture and the native checks.
    func inspect() -> [String: Any] {
        let move = cat.animation(forKey: "travel") as? CAKeyframeAnimation
        let facing = cat.animation(forKey: "facing") as? CAKeyframeAnimation
        let frames = cat.animation(forKey: "run") as? CAKeyframeAnimation
        let origin = track.convert(CGPoint.zero, to: self)
        return ["mode": mode, "travel": travel, "trackX": origin.x, "trackWidth": track.bounds.width, "cellWidth": bounds.width,
                "catSize": Self.catSize, "animations": cat.animationKeys() ?? [],
                "from": (move?.values?.first as? NSNumber)?.doubleValue ?? -1, "to": (move?.values?[1] as? NSNumber)?.doubleValue ?? -1,
                "period": move?.duration ?? 0, "repeats": move?.repeatCount == .infinity,
                "facing": facing?.values?.compactMap { ($0 as? NSNumber)?.doubleValue } ?? [], "facingKeys": facing?.keyTimes?.map(\.doubleValue) ?? [],
                "frames": frames?.values?.count ?? 0, "frameKeys": frames?.keyTimes?.map(\.doubleValue) ?? [],
                "painted": !(cat.path?.boundingBoxOfPath.isEmpty ?? true),
                "label": accessibilityLabel() ?? "", "role": accessibilityRole()?.rawValue ?? "",
                "element": isAccessibilityElement(), "childElements": track.isAccessibilityElement()]
    }
}

extension NativeShell {
    /// The loading lines as the outline shows them, for the integration checks.
    func sidebarChatsLoadingInspect() -> [[String: Any]] {
        (0..<outline.numberOfRows).compactMap { index in
            guard let row = outline.item(atRow: index) as? ShellRow, row.kind == "chats-loading",
                  let cell = outline.view(atColumn: 0, row: index, makeIfNecessary: true) as? SidebarChatsLoaderCell else { return nil }
            cell.layoutSubtreeIfNeeded()
            return cell.inspect().merging(["id": row.id, "project": row.project, "parent": (outline.parent(forItem: row) as? ShellRow)?.id ?? "",
                                           "selectable": outlineView(outline, shouldSelectItem: row),
                                           "menu": sidebarRowMenu(row).map(\.title)]) { $1 }
        }
    }
}
