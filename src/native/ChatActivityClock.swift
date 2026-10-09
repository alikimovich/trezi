import Foundation

/// The live status line's clock (LKM-147): the current step's elapsed time and the
/// "No activity" hint, computed from the snapshot's epoch-ms stamps against the local
/// clock each second, so the line ticks without the backend sending anything.
enum ChatActivityClock {
    /// A step shorter than this shows no timer (a quick read would only flicker).
    static let timerAfter: TimeInterval = 2
    /// Heartbeats arrive about every 5 s; this long without any event means they stopped.
    static let idleAfter: TimeInterval = 60

    static func seconds(_ ms: Double?, _ now: Date) -> TimeInterval? {
        guard let ms, ms > 0 else { return nil }
        return max(0, now.timeIntervalSince1970 - ms / 1000)
    }

    /// `m:ss`, or `h:mm:ss` past an hour (like `formatDuration` in `run-stats.ts`).
    static func duration(_ seconds: TimeInterval) -> String {
        let total = Int(seconds.rounded(.down)), h = total / 3600, m = total / 60 % 60, s = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }

    /// "Running bun test · 1:24": the label without its trailing ellipsis, then the
    /// step's elapsed time; the bare label for a step just started or without a clock.
    static func label(_ label: String, since: Double?, now: Date) -> String {
        guard let elapsed = seconds(since, now), elapsed >= timerAfter else { return label }
        let base = label.hasSuffix("…") ? String(label.dropLast()) : label
        return "\(base) · \(duration(elapsed))"
    }

    /// "No activity for 2 min" once nothing (not even a heartbeat) arrived for `idleAfter`.
    static func idle(aliveAt: Double?, now: Date) -> String? {
        guard let quiet = seconds(aliveAt, now), quiet >= idleAfter else { return nil }
        return "No activity for \(Int(quiet / 60)) min"
    }
}
