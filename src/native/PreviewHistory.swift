import AppKit
import WebKit

/// Preview Back/Forward (LKM-219), without toolbar buttons: View → Back (⌘[) and Forward
/// (⌘]), ⌘← / ⌘→ outside text fields, and WebKit's two-finger swipe. The history is the
/// preview's `backForwardList`, so client-side `pushState` routes are in it. Two kinds of
/// entry are never stepped to: another project's origin (the one preview view serves every
/// project, so a step stops there) and a page Trezi loaded for an agent (`open_preview`
/// into the visible preview, marked when it commits).
final class PreviewHistory: NSObject, NSMenuItemValidation {
    weak var host: Host?
    var agentItems: [WKBackForwardListItem] = []
    /// The agent load not committed yet.
    var agentNavigation: WKNavigation?
    /// The item our own step goes to; a swipe that would land on an agent's page is redirected.
    var stepping: WKBackForwardListItem?
    var steps = 0
    var view: WKWebView? { host?.views["preview"] }
    init(host: Host) { self.host = host; super.init() }

    /// The nearest entry in that direction that is the project's and not an agent's.
    func target(_ back: Bool) -> WKBackForwardListItem? {
        guard let list = view?.backForwardList, let base = host?.targets["preview"] else { return nil }
        for item in back ? list.backList.reversed() : list.forwardList {
            guard item.url.scheme == base.scheme, item.url.host == base.host, item.url.port == base.port else { return nil }
            if !agentItems.contains(where: { $0 === item }) { return item }
        }
        return nil
    }
    @discardableResult func go(_ back: Bool) -> Bool {
        guard let view, let item = target(back) else { return false }
        stepping = item; steps += 1
        ProductLog.info("preview", "Preview \(back ? "back" : "forward") to \(Host.logURL(item.url))")
        view.go(to: item)
        return true
    }
    @objc func goBack(_ sender: Any?) { go(true) }
    @objc func goForward(_ sender: Any?) { go(false) }
    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        switch item.action {
        case #selector(goBack(_:)): return target(true) != nil
        case #selector(goForward(_:)): return target(false) != nil
        default: return true
        }
    }
    /// View menu items. The editor answers ⌘[ / ⌘] itself while it has focus (`SourceEditor`).
    func menuItems() -> [NSMenuItem] {
        [("Back", #selector(goBack(_:)), "["), ("Forward", #selector(goForward(_:)), "]")].map { title, action, key in
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key); item.target = self; return item
        }
    }
    func committed(_ navigation: WKNavigation?) {
        guard let list = view?.backForwardList else { return }
        if let navigation, navigation === agentNavigation, let item = list.currentItem { agentItems.append(item); agentNavigation = nil }
        let live = list.backList + list.forwardList + [list.currentItem].compactMap { $0 }
        agentItems.removeAll { item in !live.contains { $0 === item } }
    }
    /// A swipe steps through WebKit's own list: a step onto an agent's page becomes ours.
    func redirect(_ action: WKNavigationAction) -> Bool {
        guard action.navigationType == .backForward, let list = view?.backForwardList, let url = action.request.url else { return false }
        if stepping?.url == url { stepping = nil; return false }
        for (back, item) in [(true, list.backItem), (false, list.forwardItem)] {
            guard let item, item.url == url, agentItems.contains(where: { $0 === item }) else { continue }
            DispatchQueue.main.async { [weak self] in self?.go(back) }
            return true
        }
        return false
    }
    /// ⌘← / ⌘→ in the main window outside text fields and the code editor. With the page
    /// focused the preview script decides (`src/preview/history-keys.ts`): WebKit gives
    /// the host no way to know whether a page field has focus.
    func arrow(_ event: NSEvent) -> Bool {
        guard event.type == .keyDown, event.modifierFlags.intersection(KeyShortcut.shortcutModifiers) == .command, [123, 124].contains(event.keyCode),
              let host, let window = host.window, event.windowNumber == window.windowNumber, window.attachedSheet == nil else { return false }
        let responder = window.firstResponder
        if responder is WKWebView || responder is NSTextField || (responder as? NSTextView)?.isEditable == true { return false }
        if let focus = responder as? NSView, host.sourceEditors.values.contains(where: { focus.isDescendant(of: $0) }) { return false }
        return go(event.keyCode == 123)
    }
    func install() {
        NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { [weak self] event in self?.arrow(event) == true ? nil : event }
    }
    func inspect() -> [String: Any] {
        let list = view?.backForwardList
        var menu: [String: Any] = [:]
        if let viewMenu = NSApp.mainMenu?.items.first(where: { $0.title == "View" })?.submenu {
            viewMenu.update()
            for item in viewMenu.items where item.target === self {
                menu[item.title] = ["enabled":item.isEnabled, "key":item.keyEquivalent, "modifiers":Int(item.keyEquivalentModifierMask.rawValue)]
            }
        }
        return ["canBack":target(true) != nil, "canForward":target(false) != nil, "url":view?.url?.absoluteString ?? "",
                "back":list?.backList.map { $0.url.absoluteString } ?? [], "forward":list?.forwardList.map { $0.url.absoluteString } ?? [],
                "agentItems":agentItems.map { $0.url.absoluteString }, "gestures":view?.allowsBackForwardNavigationGestures ?? false,
                "steps":steps, "menu":menu]
    }
    /// Test profile: a ⌘ key through the Latin remap, the window's key equivalents and the
    /// main menu, as AppKit dispatches it (focus outside the page and fields), or ⌘← / ⌘→
    /// through `arrow` with the focus in the composer or nowhere.
    func test(_ c: [String: Any]) -> [String: Any] {
        guard let host, let window = host.window else { return ["error":"No window"] }
        let code = UInt16(c["keyCode"] as? Int ?? 0), arrowKey = [123, 124].contains(code)
        let characters = arrowKey ? String(UnicodeScalar(UInt16(code == 123 ? NSLeftArrowFunctionKey : NSRightArrowFunctionKey))!) : c["characters"] as? String ?? ""
        window.makeFirstResponder(c["focus"] as? String == "composer" ? host.composer.text : nil)
        let flags: NSEvent.ModifierFlags = arrowKey ? [.command, .numericPad, .function] : .command
        guard let raw = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                         context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code) else { return ["error":"No event"] }
        if arrowKey { return ["handled":arrow(raw)] }
        // The U.S. positions, so the check does not depend on this Mac's Latin layout.
        let event = KeyShortcut.latinEvent(raw, layout: { key, shift in KeyShortcut.ansi[key].map { shift ? $0.1 : $0.0 } }) ?? raw
        let handled = window.performKeyEquivalent(with: event) || NSApp.mainMenu?.performKeyEquivalent(with: event) == true
        return ["handled":handled, "latin":event.charactersIgnoringModifiers ?? ""]
    }
}

extension Host {
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if webView === views["preview"] { previewHistory.committed(navigation) }
    }
}
