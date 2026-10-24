import Foundation

/// LKM-338: a Send whose draft has not left the composer 1.5 s after the press shows that it
/// is sending: the Send beam, read-only faded content, and Stop while the chat controller can
/// still cancel it. A send that leaves sooner changes nothing. AppKit-free for its unit fixture.
final class ComposerSending {
    static let delay: TimeInterval = 1.5
    static let contentAlpha = 0.55
    /// Increasing across chats: an attempt a chat remembers never matches a newer press.
    private static var attempts = 0
    /// The Send the composer emitted and has not yet seen leave, be refused or be cancelled.
    private(set) var pending: Int?
    /// The delay passed with that send still pending.
    private(set) var shown = false
    /// The controller holds the send before its draft leaves, so Stop can still cancel it.
    private(set) var cancellable = false
    /// The delay passed: the composer applies `look` outside a snapshot.
    var changed: (() -> Void)?
    private var timer: DispatchWorkItem?
    private let schedule: (TimeInterval, DispatchWorkItem) -> Void

    init(schedule: @escaping (TimeInterval, DispatchWorkItem) -> Void = { DispatchQueue.main.asyncAfter(deadline: .now() + $0, execute: $1) }) {
        self.schedule = schedule
    }

    /// A Send (or a Return that may send): its attempt number for the controller to echo.
    func begin() -> Int {
        Self.attempts += 1
        let attempt = Self.attempts
        timer?.cancel()
        pending = attempt; cancellable = false
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.pending == attempt, !self.shown else { return }
            self.shown = true
            self.changed?()
        }
        timer = work
        schedule(Self.delay, work)
        return attempt
    }

    /// A snapshot's `composer.sending`: the last attempt the controller handled and whether
    /// it still holds that draft. Handled and not held: it left, was refused or was cancelled.
    func update(_ value: [String: Any]?) {
        guard let pending else { return }
        let handled = value?["attempt"] as? Int ?? 0
        let active = value?["active"] as? Bool ?? false
        if handled >= pending && !active { reset() } else { cancellable = handled == pending && active }
    }

    /// Another chat, or the send ended.
    func reset() {
        timer?.cancel(); timer = nil
        pending = nil; shown = false; cancellable = false
    }

    struct Look: Equatable {
        let stop: Bool
        let label: String
        let symbol: String
        let contentAlpha: Double
    }

    /// What the composer shows while sending; nil leaves the snapshot's own controls.
    var look: Look? {
        guard shown else { return nil }
        return cancellable
            ? Look(stop: true, label: "Stop sending", symbol: "stop.fill", contentAlpha: Self.contentAlpha)
            : Look(stop: false, label: "Sending…", symbol: "arrow.up", contentAlpha: Self.contentAlpha)
    }

    deinit { timer?.cancel() }
}
