import AppKit

/// LKM-380: Actions → Toggle UI (⌘.) reaches the main menu before the focused view.
/// AppKit offers a ⌘ key to the key window's views first and the main menu last. A
/// focused WKWebView (the preview) claims every ⌘ key there to send it to the page,
/// and WebKit turns an unhandled ⌘. into `cancelOperation:`, the Escape command (inferred
/// from WebKit's source). Whether a text view's own key-down does the same depends on the
/// host's text input key binding and differs per key: macOS 27.0.1 turned both ⌘. and Escape
/// into it, GitHub's macOS 26.6.2 runner only Escape, and an earlier macOS 26 run neither. In
/// full screen that command ends at `NSWindow.doCommandBySelector:`, which exits full
/// screen (measured), so the first ⌘. left full screen and the menu never saw it.
/// `test/menu-first-shortcuts.mjs` drives this with the real views. Escape is not one of
/// these keys and keeps its own handling.
enum MenuFirstShortcut {
    /// The keys, as their menu items' key equivalents and modifiers.
    static let keys: [(key: String, modifiers: NSEvent.ModifierFlags)] = [(".", .command)]
    /// Whether `event` is one of the keys sent to `window` (or `also`, the full-screen
    /// toolbar's window) with no sheet attached, and the main menu performed it. The
    /// event is read on any keyboard layout (LKM-219).
    static func route(_ event: NSEvent, window: NSWindow?, also: NSWindow? = nil, menu: NSMenu?,
                      layout: KeyShortcut.Layout = KeyShortcut.asciiCapable, latinLayout: Bool? = nil) -> Bool {
        guard event.type == .keyDown, let window, let menu, window.attachedSheet == nil,
              [window, also].contains(where: { $0?.windowNumber == event.windowNumber }),
              keys.contains(where: { KeyShortcut.matches(event, $0.key, $0.modifiers, layout: layout, latinLayout: latinLayout) }) else { return false }
        return menu.performKeyEquivalent(with: KeyShortcut.latinEvent(event, layout: layout, latinLayout: latinLayout) ?? event)
    }
    /// The key-down monitor's body: nil when the menu took the key, else the event.
    /// `enabled` is false while a menu tracks, so an open menu keeps its own keys.
    static func filter(_ event: NSEvent, windows: () -> (NSWindow?, NSWindow?), enabled: () -> Bool, menu: NSMenu?,
                       layout: KeyShortcut.Layout = KeyShortcut.asciiCapable, latinLayout: Bool? = nil) -> NSEvent? {
        let (window, toolbar) = windows()
        return enabled() && route(event, window: window, also: toolbar, menu: menu, layout: layout, latinLayout: latinLayout) ? nil : event
    }
    /// Offers the keys to the main menu before the windows' views (once, at launch).
    static func install(windows: @escaping () -> (NSWindow?, NSWindow?), enabled: @escaping () -> Bool) {
        NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { filter($0, windows: windows, enabled: enabled, menu: NSApp.mainMenu) }
    }
}
