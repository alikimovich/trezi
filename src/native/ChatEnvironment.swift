import AppKit
import SwiftUI

/// macOS accessibility display options the chat renders with.
struct ChatAccessibility: Equatable {
    var increaseContrast = false
    var reduceTransparency = false
    var reduceMotion = false
    static func system(_ workspace: NSWorkspace = .shared) -> ChatAccessibility {
        ChatAccessibility(increaseContrast: workspace.accessibilityDisplayShouldIncreaseContrast,
                          reduceTransparency: workspace.accessibilityDisplayShouldReduceTransparency,
                          reduceMotion: workspace.accessibilityDisplayShouldReduceMotion)
    }
    var dictionary: [String: Bool] {
        ["increaseContrast": increaseContrast, "reduceTransparency": reduceTransparency, "reduceMotion": reduceMotion]
    }
}

/// Scroller style and accessibility options for the conversation. Production
/// reads macOS live. The ephemeral acceptance harness overrides them in-process
/// (Host `chatAcceptance`), so verification never changes system settings.
/// Overridden values reach the probe's scroller style and the SwiftUI
/// environment keys the real settings populate. AppKit's own high-contrast
/// drawing cannot be forced per view (NSAppearance maps the accessibility
/// names back to Aqua/DarkAqua), so native controls keep following macOS.
final class ChatSystemEnvironment: ObservableObject {
    static let shared = ChatSystemEnvironment()
    static let didChange = Notification.Name("TreziChatSystemEnvironmentDidChange")
    let systemAccessibility: () -> ChatAccessibility
    let systemScrollerStyle: () -> NSScroller.Style
    @Published private(set) var accessibilityOverride: ChatAccessibility?
    @Published private(set) var scrollerStyleOverride: NSScroller.Style?
    // Bumped when macOS reports a change, so observers re-read system values.
    @Published private(set) var systemRevision = 0
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    init(systemAccessibility: @escaping () -> ChatAccessibility = { .system() },
         systemScrollerStyle: @escaping () -> NSScroller.Style = { NSScroller.preferredScrollerStyle }) {
        self.systemAccessibility = systemAccessibility
        self.systemScrollerStyle = systemScrollerStyle
        let sources: [(NotificationCenter, Notification.Name)] = [
            (NSWorkspace.shared.notificationCenter, NSWorkspace.accessibilityDisplayOptionsDidChangeNotification),
            (.default, NSScroller.preferredScrollerStyleDidChangeNotification)]
        for (center, name) in sources {
            observers.append((center, center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.systemRevision += 1
                self?.changed()
            }))
        }
    }
    deinit { observers.forEach { $0.0.removeObserver($0.1) } }
    var accessibility: ChatAccessibility { accessibilityOverride ?? systemAccessibility() }
    var scrollerStyle: NSScroller.Style { scrollerStyleOverride ?? systemScrollerStyle() }
    var isOverridden: Bool { accessibilityOverride != nil || scrollerStyleOverride != nil }
    /// Test-only: nil leaves that part on the system value.
    func override(accessibility: ChatAccessibility?, scrollerStyle: NSScroller.Style?) {
        accessibilityOverride = accessibility
        scrollerStyleOverride = scrollerStyle
        changed()
    }
    func clearOverrides() { override(accessibility: nil, scrollerStyle: nil) }
    private func changed() { NotificationCenter.default.post(name: Self.didChange, object: self) }
}

/// Feeds the chat's accessibility options into the SwiftUI environment keys
/// that its views (activity, streaming text, beam, materials) already read.
struct ChatAccessibilityEnvironment: ViewModifier {
    let accessibility: ChatAccessibility
    func body(content: Content) -> some View {
        content
            .environment(\._colorSchemeContrast, accessibility.increaseContrast ? .increased : .standard)
            .environment(\._accessibilityReduceTransparency, accessibility.reduceTransparency)
            .environment(\._accessibilityReduceMotion, accessibility.reduceMotion)
    }
}

/// Reports what SwiftUI views under the chat actually read, for verification.
struct ChatAccessibilityEcho: View {
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let report: (ChatAccessibility) -> Void
    private var value: ChatAccessibility {
        ChatAccessibility(increaseContrast: contrast == .increased, reduceTransparency: reduceTransparency, reduceMotion: reduceMotion)
    }
    var body: some View {
        Color.clear.allowsHitTesting(false)
            .onAppear { report(value) }
            .onChange(of: value) { report($0) }
    }
}
