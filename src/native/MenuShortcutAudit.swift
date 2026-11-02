import AppKit

/// LKM-430: every key equivalent in a menu tree, for the shortcut collision audit.
///
/// LKM-432: AppKit's own rows are not collected. It adds Start Dictation… (`startDictation:`)
/// and Emoji & Symbols (`orderFrontCharacterPalette:`) to any menu titled "Edit", each with
/// hidden twins on Globe keys, and which keys they carry (Dictation shows `d` in the app,
/// none in a headless probe) depends on the system, not on Trezi's bindings. The cost: a Trezi
/// item bound to either selector is not audited. Trezi binds neither; `MenuShortcutAudit.system`
/// is the list to extend if AppKit adds another such row.
enum MenuShortcutAudit {
    static let system: Set<String> = ["startDictation:", "orderFrontCharacterPalette:"]
    static func collect(_ menu: NSMenu?) -> [[String: Any]] {
        (menu?.items ?? []).flatMap { item -> [[String: Any]] in
            let names: [(NSEvent.ModifierFlags, String)] = [(.control, "control"), (.option, "option"), (.shift, "shift"), (.command, "command")]
            // An upper-case key equivalent means Shift whether or not the mask says so.
            let upper = item.keyEquivalent != item.keyEquivalent.lowercased()
            let appKit = system.contains(item.action.map(NSStringFromSelector) ?? "")
            let own: [[String: Any]] = item.keyEquivalent.isEmpty || appKit ? [] : [["title":item.title, "key":item.keyEquivalent.lowercased(), "menu":menu?.title ?? "",
                "modifiers":names.filter { item.keyEquivalentModifierMask.contains($0.0) || (upper && $0.0 == .shift) }.map(\.1)]]
            return own + collect(item.submenu)
        }
    }
}
