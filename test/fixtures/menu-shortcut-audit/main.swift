import AppKit

// LKM-432: the shortcut audit collects Trezi's rows and none of AppKit's own Edit-menu rows.
// A menu is built the way AppKit leaves an Edit menu (Start Dictation… and Emoji & Symbols
// with key equivalents, one of them on `d`) beside ordinary rows, one nested in a submenu.
// One JSON report on stdout: the collected rows.
_ = NSApplication.shared
final class Target: NSObject { @objc func act(_ item: NSMenuItem) {} }
let target = Target(), main = NSMenu(), editItem = NSMenuItem(), edit = NSMenu(title: "Edit")
editItem.submenu = edit; main.addItem(editItem)
func row(_ title: String, _ action: Selector, _ key: String, _ mask: NSEvent.ModifierFlags = .command, in menu: NSMenu = edit) {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
    item.keyEquivalentModifierMask = mask; item.target = target
    menu.addItem(item)
}
row("Find…", #selector(Target.act(_:)), "f")
row("Duplicate", #selector(Target.act(_:)), "d")
row("Start Dictation…", NSSelectorFromString("startDictation:"), "d", [])
row("Emoji & Symbols", NSSelectorFromString("orderFrontCharacterPalette:"), "e", [.control, .command])
row("Plain", #selector(Target.act(_:)), "")
let more = NSMenuItem(title: "More", action: nil, keyEquivalent: ""), nested = NSMenu(title: "More")
more.submenu = nested; edit.addItem(more)
row("Nested Dictation", NSSelectorFromString("startDictation:"), "n", [.command], in: nested)
row("Nested", #selector(Target.act(_:)), "G", [.command], in: nested)
let rows = MenuShortcutAudit.collect(main)
print(String(data: try! JSONSerialization.data(withJSONObject: ["rows": rows, "system": MenuShortcutAudit.system.sorted()], options: [.sortedKeys]), encoding: .utf8)!)
