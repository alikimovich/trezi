import AppKit
import Carbon.HIToolbox

/// Keyboard-layout-independent shortcuts (LKM-219). Under a non-Latin layout (Russian,
/// Ukrainian, Hebrew, Greek) a ⌘ or ⌃ key event carries the layout's own characters:
/// ⌘ on the "[" key reads "х", and no menu item, `performKeyEquivalent` override or
/// SwiftUI `.keyboardShortcut` matches it. Such an event is re-read through the user's
/// ASCII-capable layout (the one macOS uses for Latin input: ABC, U.S., Dvorak…), else
/// the U.S. ANSI key positions, before AppKit dispatches it. A Latin layout's event is
/// left alone, so Dvorak keeps its own key equivalents and menu titles keep the standard
/// symbols. Pure apart from the TIS lookup, so `test/key-shortcuts.mjs` drives it with
/// synthetic events.
enum KeyShortcut {
    /// U.S. ANSI characters by virtual key code (`kVK_ANSI_*`), unshifted and shifted.
    static let ansi: [UInt16: (String, String)] = [
        0: ("a", "A"), 1: ("s", "S"), 2: ("d", "D"), 3: ("f", "F"), 4: ("h", "H"), 5: ("g", "G"), 6: ("z", "Z"), 7: ("x", "X"),
        8: ("c", "C"), 9: ("v", "V"), 11: ("b", "B"), 12: ("q", "Q"), 13: ("w", "W"), 14: ("e", "E"), 15: ("r", "R"),
        16: ("y", "Y"), 17: ("t", "T"), 18: ("1", "!"), 19: ("2", "@"), 20: ("3", "#"), 21: ("4", "$"), 22: ("6", "^"),
        23: ("5", "%"), 24: ("=", "+"), 25: ("9", "("), 26: ("7", "&"), 27: ("-", "_"), 28: ("8", "*"), 29: ("0", ")"),
        30: ("]", "}"), 31: ("o", "O"), 32: ("u", "U"), 33: ("[", "{"), 34: ("i", "I"), 35: ("p", "P"), 37: ("l", "L"),
        38: ("j", "J"), 39: ("'", "\""), 40: ("k", "K"), 41: (";", ":"), 42: ("\\", "|"), 43: (",", "<"), 44: ("/", "?"),
        45: ("n", "N"), 46: ("m", "M"), 47: (".", ">"), 50: ("`", "~")
    ]
    typealias Layout = (_ keyCode: UInt16, _ shift: Bool) -> String?
    static let shortcutModifiers: NSEvent.ModifierFlags = [.command, .shift, .option, .control]

    /// The character the current ASCII-capable layout types on this key, ignoring every
    /// modifier but Shift; nil when there is none.
    static func asciiCapable(_ keyCode: UInt16, _ shift: Bool) -> String? {
        guard let source = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue(),
              let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
        let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
        return data.withUnsafeBytes { buffer -> String? in
            guard let layout = buffer.bindMemory(to: UCKeyboardLayout.self).baseAddress else { return nil }
            var dead: UInt32 = 0, length = 0, chars = [UniChar](repeating: 0, count: 4)
            let state = shift ? UInt32(shiftKey >> 8) & 0xFF : 0
            let status = UCKeyTranslate(layout, keyCode, UInt16(kUCKeyActionDown), state, UInt32(LMGetKbdType()),
                                        OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, chars.count, &length, &chars)
            return status == noErr && length > 0 ? String(utf16CodeUnits: chars, count: length) : nil
        }
    }
    /// Whether the selected keyboard layout types Latin (U.S., ABC, Dvorak, German…).
    static func currentIsLatin() -> Bool {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let raw = TISGetInputSourceProperty(source, kTISPropertyInputSourceIsASCIICapable) else { return true }
        return CFBooleanGetValue(Unmanaged<CFBoolean>.fromOpaque(raw).takeUnretainedValue())
    }
    /// One printable ASCII character, the only kind a Trezi shortcut uses.
    static func printable(_ text: String?) -> Bool {
        guard let text, text.unicodeScalars.count == 1, let scalar = text.unicodeScalars.first else { return false }
        return scalar.value >= 0x20 && scalar.value < 0x7F
    }
    /// The Latin key an event means for shortcut matching: its own characters on a Latin
    /// layout, else the ASCII-capable layout's (or U.S. ANSI) character on the same key.
    /// A non-Latin layout is read by position even where it types ASCII (Russian types "."
    /// on the U.S. "/" key). Arrows, F-keys, Return, Tab, Delete and Escape keep theirs.
    /// `latinLayout` nil asks TIS, and only when the answer matters (an ASCII character).
    static func latin(_ event: NSEvent, layout: Layout = asciiCapable, latinLayout: Bool? = nil) -> String? {
        guard [.keyDown, .keyUp].contains(event.type), let own = event.charactersIgnoringModifiers, !own.isEmpty else { return nil }
        if own.unicodeScalars.contains(where: { (0xF700...0xF8FF).contains($0.value) || $0.value < 0x20 || $0.value == 0x7F }) { return own }
        if own.unicodeScalars.allSatisfy(\.isASCII) && (latinLayout ?? currentIsLatin()) { return own }
        let shift = event.modifierFlags.contains(.shift)
        if let mapped = layout(event.keyCode, shift), printable(mapped) { return mapped }
        return ansi[event.keyCode].map { shift ? $0.1 : $0.0 } ?? own
    }
    /// Whether the event is `key` with exactly `modifiers` (of ⌘⇧⌥⌃), on any layout.
    /// Letters compare case-insensitively, like AppKit's key equivalents.
    static func matches(_ event: NSEvent, _ key: String, _ modifiers: NSEvent.ModifierFlags, layout: Layout = asciiCapable, latinLayout: Bool? = nil) -> Bool {
        event.modifierFlags.intersection(shortcutModifiers) == modifiers && latin(event, layout: layout, latinLayout: latinLayout)?.lowercased() == key.lowercased()
    }
    /// A copy of a ⌘ or ⌃ key-down carrying the Latin key in place of a non-Latin layout's
    /// character; nil when the event needs no change. Plain and ⌥ typing is never
    /// touched, so text keeps the user's layout.
    static func latinEvent(_ event: NSEvent, layout: Layout = asciiCapable, latinLayout: Bool? = nil) -> NSEvent? {
        guard event.type == .keyDown, !event.modifierFlags.intersection([.command, .control]).isEmpty,
              let own = event.charactersIgnoringModifiers, let key = latin(event, layout: layout, latinLayout: latinLayout),
              key != own, printable(key) else { return nil }
        // ⌃ on a letter types its control character, as on a Latin layout (⌃G is "\u{07}").
        var characters = key
        if event.modifierFlags.contains(.control), !event.modifierFlags.contains(.command),
           let scalar = key.lowercased().unicodeScalars.first, ("a"..."z").contains(scalar) {
            characters = String(UnicodeScalar(UInt8(scalar.value - 0x60)))
        }
        return NSEvent.keyEvent(with: .keyDown, location: event.locationInWindow, modifierFlags: event.modifierFlags, timestamp: event.timestamp,
                                windowNumber: event.windowNumber, context: nil, characters: characters, charactersIgnoringModifiers: key,
                                isARepeat: event.isARepeat, keyCode: event.keyCode)
    }
    /// Re-reads every ⌘/⌃ key-down before menus, views and WebKit see it (once, at launch).
    static func install() {
        NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { event in latinEvent(event) ?? event }
    }
}
