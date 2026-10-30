import AppKit

/// LKM-380 test seam: ⌘. (or Escape) as the keyboard sends it, with the focus in one of
/// the window's inputs. The key-down and key-up are posted to the app's event queue, so
/// they take the real dispatch: the key-down monitors, the key window's views, the main
/// menu and the responder chain. Nothing calls the menu action directly.
extension Host {
    func toggleUIKey(_ c: [String: Any]) -> [String: Any] {
        let focus = c["focus"] as? String ?? "none", escape = c["key"] as? String == "escape"
        var result = toggleUIInspect()
        if c["inspect"] as? Bool == true { return result }
        let target: NSResponder?
        switch focus {
        case "composer": target = composer.isHidden ? nil : composer.text
        case "preview": target = views["preview"]
        case "source": target = dockedSource?.code
        case "address": target = shell.address
        default: target = nil
        }
        if focus != "none" && target == nil { return ["error":"No \(focus) to focus", "state":result] }
        let owner = (target as? NSView)?.window ?? window!
        guard owner.makeFirstResponder(target) else { return ["error":"\(focus) refused the focus", "state":result] }
        // The keyboard sends to the key window, whatever holds the focus inside it.
        let number = NSApp.keyWindow?.windowNumber ?? window.windowNumber
        let (characters, code): (String, UInt16) = escape ? ("\u{1b}", 53) : (".", 47)
        let flags: NSEvent.ModifierFlags = escape ? [] : .command
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            guard let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: number,
                                               context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code) else { return ["error":"No event"] }
            NSApp.postEvent(event, atStart: false)
        }
        result["focused"] = focus; result["posted"] = escape ? "Escape" : "Command-."
        result["firstResponder"] = toggleUIResponder(owner.firstResponder)
        return result
    }
    func toggleUIInspect() -> [String: Any] {
        let item = NSApp.mainMenu?.items.lazy.compactMap { $0.submenu }.flatMap { $0.items }.first { $0.representedObject as? String == "toggle-chat" }
        return ["fullScreen":window.styleMask.contains(.fullScreen), "transition":previewOverlay.fullScreenTransition,
                "keyWindow":NSApp.keyWindow === window, "active":NSApp.isActive, "firstResponder":toggleUIResponder(window.firstResponder),
                "menu":["title":item?.title ?? "", "key":item?.keyEquivalent ?? "", "command":item?.keyEquivalentModifierMask == .command,
                        "menu":item?.menu?.title ?? "", "enabled":item?.isEnabled ?? false]]
    }
    private func toggleUIResponder(_ responder: NSResponder?) -> String {
        guard let responder else { return "none" }
        if responder === composer.text { return "composer" }
        if responder === views["preview"] { return "preview" }
        if let code = dockedSource?.code, responder === code { return "source" }
        if let text = responder as? NSTextView, text.isFieldEditor, text.delegate === shell.address { return "address" }
        if responder === window { return "window" }
        return String(describing: type(of: responder))
    }
}
