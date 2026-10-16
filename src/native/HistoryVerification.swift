import AppKit
import ScreenCaptureKit

/// Test-broker command for the chat header's history menu (LKM-268). The menu opens through the
/// same `popUp` the segmented control uses, so AppKit's real tracking loop runs. The pipe never
/// waits on it: `open` schedules the blocking `popUp` on the run loop and replies, and later commands (rows
/// changing, a capture, a key, `close`) arrive while the menu tracks. Nothing here changes a system
/// setting: Reduce Motion and the menu's appearance are overridden for this one menu only.
extension NativeShell {
    @MainActor func historyBroker(_ c: [String: Any]) async throws -> [String: Any] {
        guard let menu = chatActions.historyMenu else { throw historyError("The history menu has not been built") }
        switch c["op"] as? String {
        case "open":
            let name = c["appearance"] as? String
            menu.appearance = name == "dark" ? NSAppearance(named: .darkAqua) : name == "light" ? NSAppearance(named: .aqua) : nil
            // `popUp` must not run inside a main-queue block: that serial queue would stay busy for the whole
            // tracking and the pipe's commands would never run. A run-loop timer returns to the loop first.
            // The watchdog dismisses a menu a failed test left open, so the host cannot stay wedged.
            historyWatchdog?.invalidate()
            let opener = Timer(timeInterval: 0.05, repeats: false) { [weak self] _ in
                guard let self else { return }
                let watchdog = Timer(timeInterval: 45, repeats: false) { _ in menu.cancelTracking() }
                RunLoop.main.add(watchdog, forMode: .common)
                self.historyWatchdog = watchdog
                menu.popUp(positioning: nil, at: NSPoint(x: 0, y: -4), in: self.chatActions)
                watchdog.invalidate()
                // The forced appearance belongs to this opening only: the persistent menu goes back to the app's.
                menu.appearance = nil
            }
            RunLoop.main.add(opener, forMode: .common)
            return [:]
        case "close":
            menu.cancelTracking()
            return [:]
        case "reduce-motion":
            reduceMotionOverride = c["value"] as? Bool
            updateHistoryMenu()
            return [:]
        case "key":
            let down = c["key"] as? String != "up"
            let code: UInt16 = down ? 125 : 126
            let character = String(UnicodeScalar(UInt32(down ? NSDownArrowFunctionKey : NSUpArrowFunctionKey))!)
            if c["via"] as? String == "cgevent" {
                for pressed in [true, false] { CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: pressed)?.postToPid(getpid()) }
            } else {
                for type in [NSEvent.EventType.keyDown, .keyUp] {
                    guard let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [.function, .numericPad], timestamp: ProcessInfo.processInfo.systemUptime,
                                                       windowNumber: 0, context: nil, characters: character, charactersIgnoringModifiers: character, isARepeat: false, keyCode: code) else { continue }
                    NSApp.postEvent(event, atStart: false)
                }
            }
            return [:]
        case "capture":
            return try await captureHistoryMenu()
        default:
            throw historyError("Unknown history menu operation")
        }
    }

    private func historyError(_ message: String) -> NSError {
        NSError(domain: "HistoryVerification", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    /// The open menu's own pixels (this process's pop-up-level window), through WindowServer.
    @MainActor private func captureHistoryMenu() async throws -> [String: Any] {
        guard #available(macOS 14.4, *) else { throw historyError("Menu capture requires macOS 14.4 or later") }
        let level = Int(CGWindowLevelForKey(.popUpMenuWindow))
        let content = try await SCShareableContent.currentProcess
        guard let menuWindow = content.windows.filter({ $0.windowLayer == level && $0.isOnScreen }).max(by: { $0.frame.height < $1.frame.height }) else {
            throw historyError("No open menu window in current-process capture content")
        }
        let filter = SCContentFilter(desktopIndependentWindow: menuWindow)
        let configuration = SCStreamConfiguration()
        configuration.width = Int((filter.contentRect.width * CGFloat(filter.pointPixelScale)).rounded())
        configuration.height = Int((filter.contentRect.height * CGFloat(filter.pointPixelScale)).rounded())
        configuration.ignoreShadowsSingleWindow = true
        configuration.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { throw historyError("Menu screenshot encoding failed") }
        return ["png": png.base64EncodedString(), "width": image.width, "height": image.height,
                "frame": ["x": Double(menuWindow.frame.minX), "y": Double(menuWindow.frame.minY), "width": Double(menuWindow.frame.width), "height": Double(menuWindow.frame.height)]]
    }
}
