import AppKit
import ScreenCaptureKit

/// LKM-321: in full screen AppKit hosts the toolbar in its own window (`NSToolbarFullScreenWindow`,
/// LKM-229), which slides down with the menu bar while AppKit lays the toolbar out again. The
/// address layout measured only views in the main window, so in full screen it never measured,
/// and nothing observed that window: the widths stayed those from before the relayout, and the
/// address and "…" stayed in the overflow menu. Toolbar frames now go through the screen into the
/// main window's coordinates, and the toolbar is measured again whenever its window moves or resizes.
extension NativeShell {
    /// The window holding the toolbar's item views: the main window, or AppKit's toolbar window in full screen.
    var toolbarWindow: NSWindow? {
        let views: [NSView?] = [rightGroup, chatHeader, addressHeader]
        return views.lazy.compactMap { $0?.window }.first ?? window
    }
    /// `rect` (default: the view's bounds) in the main window's coordinates, through the screen
    /// when the view is in another window; nil while the view is in no window.
    func mainFrame(_ view: NSView?, rect: NSRect? = nil) -> NSRect? {
        guard let view, let source = view.window else { return nil }
        let frame = view.convert(rect ?? view.bounds, to: nil)
        guard let window, source !== window else { return frame }
        return window.convertFromScreen(source.convertToScreen(frame))
    }
    /// Laid-out toolbar item frames in the main window's coordinates.
    var toolbarFrames: [String: NSRect] { toolbarItemFrames(toolbarWindow, in: window) }
    /// Lays out the main window, then the toolbar's own window when it has one.
    func layoutToolbar() {
        window?.contentView?.superview?.layoutSubtreeIfNeeded()
        guard let host = toolbarWindow, host !== window else { return }
        (host.contentView?.superview ?? host.contentView)?.layoutSubtreeIfNeeded()
    }
    func observeToolbarWindow(_ window: NSWindow) {
        // Any window: AppKit creates the full-screen toolbar window on entering full screen.
        for name in [NSWindow.didMoveNotification, NSWindow.didResizeNotification] {
            NotificationCenter.default.addObserver(self, selector: #selector(toolbarWindowMoved(_:)), name: name, object: nil)
        }
        for name in [NSWindow.didEnterFullScreenNotification, NSWindow.didExitFullScreenNotification] {
            NotificationCenter.default.addObserver(self, selector: #selector(fullScreenChanged(_:)), name: name, object: window)
        }
    }
    /// The toolbar's own window moved or resized (the menu bar slid in or out): measure the toolbar as AppKit laid it out there.
    @objc private func toolbarWindowMoved(_ notification: Notification) {
        guard let moved = notification.object as? NSWindow, moved !== window, moved === toolbarWindow else { return }
        DispatchQueue.main.async { [weak self] in self?.layoutToolbar(); self?.measureToolbar() }
    }
    @objc private func fullScreenChanged(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in self?.layoutToolbar(); self?.measureToolbar() }
    }
    /// For checks: where the toolbar lives and whether the menu bar and the window buttons show.
    func toolbarWindowInspect() -> [String: Any] {
        let host = toolbarWindow, close = window?.standardWindowButton(.closeButton)
        let buttons = close.flatMap { button in button.isHiddenOrHasHiddenAncestor || button.alphaValue == 0 ? nil : mainFrame(button) }
        return ["toolbarInMainWindow":host === window, "toolbarWindowClass":host.map { NSStringFromClass(type(of: $0)) } ?? "",
                "toolbarWindowFrame":host.map { NSStringFromRect($0.frame) } ?? "", "menuBarVisible":NSMenu.menuBarVisible(),
                "windowButtonsShown":buttons != nil, "windowButtonsFrame":buttons.map { NSStringFromRect($0) } ?? ""]
    }
}

/// A foreground capture of one of this process's windows through WindowServer, e.g. AppKit's
/// full-screen toolbar window, which a capture of the main window does not contain.
@MainActor
func captureOwnWindow(_ window: NSWindow) async throws -> [String: Any] {
    guard window.isVisible, NSApp.isActive else {
        throw NSError(domain: "ToolbarCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "Toolbar window is not in the foreground"])
    }
    guard #available(macOS 14.4, *) else {
        throw NSError(domain: "ToolbarCapture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Window capture requires macOS 14.4 or later"])
    }
    let content = try await SCShareableContent.currentProcess
    guard let own = content.windows.first(where: { $0.windowID == CGWindowID(window.windowNumber) }) else {
        throw NSError(domain: "ToolbarCapture", code: 3, userInfo: [NSLocalizedDescriptionKey: "Toolbar window is missing from current-process capture content"])
    }
    let filter = SCContentFilter(desktopIndependentWindow: own), configuration = SCStreamConfiguration()
    configuration.width = Int((filter.contentRect.width * CGFloat(filter.pointPixelScale)).rounded())
    configuration.height = Int((filter.contentRect.height * CGFloat(filter.pointPixelScale)).rounded())
    configuration.ignoreShadowsSingleWindow = true
    configuration.showsCursor = false
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
        throw NSError(domain: "ToolbarCapture", code: 4, userInfo: [NSLocalizedDescriptionKey: "Toolbar window capture failed"])
    }
    return ["png":png.base64EncodedString(), "width":image.width, "height":image.height, "window":NSStringFromClass(type(of: window))]
}
