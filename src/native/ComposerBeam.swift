import AppKit
import SwiftUI

/// A thin, full-perimeter energy rim for generation, and a quieter, even
/// breath when a chat becomes ready. Both stay on the existing native surface.
struct ComposerBeam: View {
    static let readyDuration = 2.4
    let radius: CGFloat
    let started: Date
    let once: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { timeline in
            let elapsed = max(0, timeline.date.timeIntervalSince(started))
            // Overlapping smooth waves feel alive without random frame-to-frame flicker.
            let energy = reduceMotion ? 0.7 : 0.70 + 0.16 * sin(elapsed * 3.1)
                + 0.09 * sin(elapsed * 5.3 + 0.8) + 0.05 * sin(elapsed * 8.7 + 1.9)
            let readyPhase = min(1, elapsed / Self.readyDuration)
            let fade = once ? pow(sin(readyPhase * .pi), 2) : min(1, elapsed / 0.25)
            let violet = Color(red: 0.65, green: 0.32, blue: 1)
            let blue = Color(red: 0.26, green: 0.55, blue: 1)
            let cyan = Color(red: 0.32, green: 0.90, blue: 1)
            let peak = colorScheme == .dark ? Color(red: 0.80, green: 0.91, blue: 1) : blue
            // Keep the full rim lit while its 135° highlight rotates every 2.4 seconds.
            let angle = reduceMotion || once ? 0 : elapsed / 2.4 * 360
            let gradient = AngularGradient(stops: once ? [
                .init(color: blue, location: 0),
                .init(color: violet, location: 0.33),
                .init(color: cyan, location: 0.67),
                .init(color: blue, location: 1)
            ] : [
                .init(color: blue.opacity(0.45), location: 0),
                .init(color: violet.opacity(0.65), location: 0.16),
                .init(color: violet.opacity(0.9), location: 0.27),
                .init(color: peak, location: 0.375),
                .init(color: cyan.opacity(0.9), location: 0.48),
                .init(color: blue.opacity(0.55), location: 0.66),
                .init(color: violet.opacity(0.4), location: 0.84),
                .init(color: blue.opacity(0.45), location: 1)
            ], center: .center, startAngle: .degrees(angle), endAngle: .degrees(angle + 360))
            let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
            ZStack {
                shape.stroke(gradient, lineWidth: once ? 3 : 2)
                    .blur(radius: once ? 4 : 2.5)
                    .opacity(once ? 0.22 : 0.25 + energy * 0.3)
                shape.stroke(gradient, lineWidth: once ? 1.5 : 1.4)
                    .blur(radius: 1)
                    .opacity(once ? 0.25 : energy * 0.55)
                shape.stroke(gradient, lineWidth: once ? 0.8 : 0.9)
                    .opacity(once ? 0.45 : 0.55 + energy * 0.4)
            }
            .padding(8)
            .opacity(reduceMotion ? (once ? 0.4 : 0.75) : fade * (once ? 1 : energy))
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The overlay never intercepts input, and removes its timeline entirely at rest.
final class ComposerBeamHost: NSHostingView<AnyView> {
    private(set) var active = false
    private var expiry: DispatchWorkItem?
    init() {
        super.init(rootView: AnyView(EmptyView()))
        sizingOptions = []
        setAccessibilityElement(false)
    }
    required init(rootView: AnyView) { fatalError("init(rootView:) has not been implemented") }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    func show(_ visible: Bool, radius: CGFloat, once: Bool = false) {
        guard visible != active else { return }
        expiry?.cancel(); expiry = nil
        active = visible
        // Same accessibility source as the conversation (system unless overridden in tests).
        rootView = visible ? AnyView(ComposerBeam(radius: radius, started: Date(), once: once)
            .modifier(ChatAccessibilityEnvironment(accessibility: ChatSystemEnvironment.shared.accessibility))) : AnyView(EmptyView())
        if visible && once {
            let work = DispatchWorkItem { [weak self] in self?.show(false, radius: radius) }
            expiry = work
            DispatchQueue.main.asyncAfter(deadline: .now() + ComposerBeam.readyDuration, execute: work)
        }
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { show(false, radius: 0) }
    }
    deinit { expiry?.cancel() }
}
