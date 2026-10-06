import AppKit
import CoreGraphics

/// A borderless 1×1 window that takes key status from the main window, standing in for
/// another app or a system dialog in the native smoke's focus-loss simulation.
private final class SmokeFocusThief: NSWindow {
    override var canBecomeKey: Bool { true }
}

/// LKM-176: the native smoke's focus guard (ephemeral test profile only). Counts the times
/// Trezi lost focus between calls — the app resigning active, or the simulation — and
/// restores focus only when it is missing. It activates the app and orders a window front;
/// it never reads or changes system settings.
final class SmokeFocus {
    static let shared = SmokeFocus()
    private var lost = 0
    private var observer: NSObjectProtocol?
    private var thief: NSWindow?

    func install(center: NotificationCenter = .default) {
        guard observer == nil else { return }
        observer = center.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: nil) { [weak self] _ in
            self?.lost += 1
        }
    }

    /// Active app with one of Trezi's own windows key (a sheet or panel counts; the thief does not).
    var focused: Bool {
        guard NSApp.isActive, let key = NSApp.keyWindow else { return false }
        return key !== thief
    }

    /// The simulation: an in-process window takes key status, so the main window resigns key.
    func lose() {
        let window = thief ?? SmokeFocusThief(contentRect: NSRect(x: 0, y: 0, width: 1, height: 1),
                                              styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        thief = window
        window.orderFrontRegardless()
        window.makeKey()
        lost += 1
    }

    func takeLost() -> Int { defer { lost = 0 }; return lost }

    func dismissThief() { thief?.orderOut(nil) }

    func describe(_ window: NSWindow?) -> String {
        guard let window else { return "none" }
        if window === thief { return "focus simulation window" }
        return "\(type(of: window)) '\(window.title)'"
    }
}

extension Host {
    /// `{lose: true}` runs the simulation; otherwise restores focus when it is missing or was
    /// lost since the previous call, waiting at most 2 s (activation is asked for again every
    /// 0.5 s, as the system may defer it), and reports `focused`, `restored`, `lost`, `reason`.
    @MainActor
    func smokeFocus(_ c: [String: Any]) async -> [String: Any] {
        let focus = SmokeFocus.shared
        focus.install()
        if c["lose"] as? Bool == true {
            focus.lose()
            return ["focused": focus.focused, "key": focus.describe(NSApp.keyWindow)]
        }
        let lost = focus.takeLost()
        let missing = !focus.focused
        if missing || lost > 0 {
            focus.dismissThief()
            for attempt in 0..<40 {
                if attempt % 10 == 0 { NSApp.activate(ignoringOtherApps: true) }
                // Activation brings back the previous key window (an open sheet stays key);
                // only when none came back is the main window made key.
                if attempt % 10 == 5, !focus.focused { window.makeKeyAndOrderFront(nil) }
                if focus.focused { break }
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
        }
        let asleep = CGDisplayIsAsleep(CGMainDisplayID()) != 0
        let focused = focus.focused && !asleep
        var report: [String: Any] = ["focused": focused, "restored": focused && (missing || lost > 0), "lost": lost > 0,
                                     "active": NSApp.isActive, "key": focus.describe(NSApp.keyWindow), "displayAsleep": asleep]
        if asleep { report["reason"] = "display asleep" } else if !focused {
            let front = NSWorkspace.shared.frontmostApplication
            report["reason"] = "Trezi did not become the active app with a key window within 2 s (frontmost: \(front?.localizedName ?? front?.bundleIdentifier ?? "unknown"), key window: \(focus.describe(NSApp.keyWindow)))"
        }
        return report
    }
}
