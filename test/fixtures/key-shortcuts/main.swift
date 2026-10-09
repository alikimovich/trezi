import AppKit

// Layout-independent shortcut matching (LKM-219) with synthetic key events; no window.
func key(_ characters: String, _ keyCode: UInt16, _ modifiers: NSEvent.ModifierFlags = .command, ignoring: String? = nil) -> NSEvent {
    NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: 0, windowNumber: 0, context: nil,
                     characters: characters, charactersIgnoringModifiers: ignoring ?? characters, isARepeat: false, keyCode: keyCode)!
}
func check(_ ok: Bool, _ what: String) { precondition(ok, what); print("ok - \(what)") }
// The ASCII-capable layout is the machine's; the U.S. table makes these deterministic.
let qwerty: KeyShortcut.Layout = { code, shift in KeyShortcut.ansi[code].map { shift ? $0.1 : $0.0 } }
let dvorak: KeyShortcut.Layout = { code, shift in [33: ("/", "?"), 30: ("=", "+"), 15: ("p", "P"), 1: ("o", "O")][code].map { shift ? $0.1 : $0.0 } }
let none: KeyShortcut.Layout = { _, _ in nil }

// Russian (ЙЦУКЕН and Russian-PC): ⌘ on the [ and ] keys reads "х" / "ъ".
check(KeyShortcut.matches(key("х", 33), "[", .command, layout: qwerty), "⌘ + keyCode 33 \"х\" is ⌘[ (Back)")
check(KeyShortcut.matches(key("ъ", 30), "]", .command, layout: qwerty), "⌘ + keyCode 30 \"ъ\" is ⌘] (Forward)")
check(!KeyShortcut.matches(key("х", 33), "]", .command, layout: qwerty), "⌘х is not Forward")
check(KeyShortcut.matches(key("х", 33), "[", .command, layout: none), "no ASCII layout: the U.S. key position")
let back = KeyShortcut.latinEvent(key("х", 33), layout: qwerty)
check(back?.charactersIgnoringModifiers == "[" && back?.characters == "[" && back?.keyCode == 33 && back?.modifierFlags.contains(.command) == true,
      "the remapped event carries \"[\" on the same key")
// Letters: ⌘S, ⌘R, ⌘L, ⇧⌘R, ⌃G, ⌃⇧S, ⌥⌘I with Russian, Ukrainian, Hebrew and Greek characters.
check(KeyShortcut.matches(key("ы", 1), "s", .command, layout: qwerty), "Russian ⌘ы is ⌘S")
check(KeyShortcut.matches(key("і", 1), "s", .command, layout: qwerty), "Ukrainian ⌘і is ⌘S")
check(KeyShortcut.matches(key("ר", 15), "r", .command, layout: qwerty), "Hebrew ⌘ר is ⌘R")
check(KeyShortcut.matches(key("λ", 37), "l", .command, layout: qwerty), "Greek ⌘λ is ⌘L")
check(KeyShortcut.matches(key("К", 15, [.command, .shift]), "R", [.command, .shift], layout: qwerty), "Russian ⇧⌘К is ⇧⌘R")
check(KeyShortcut.latinEvent(key("К", 15, [.command, .shift]), layout: qwerty)?.charactersIgnoringModifiers == "R", "⇧⌘R remaps to uppercase R")
let grid = KeyShortcut.latinEvent(key("п", 5, .control), layout: qwerty)
check(grid?.charactersIgnoringModifiers == "g" && grid?.characters == "\u{07}", "Russian ⌃п is ⌃G with its control character")
check(KeyShortcut.matches(key("Ы", 1, [.control, .shift]), "s", [.control, .shift], layout: qwerty), "Russian ⌃⇧Ы is ⌃⇧S (slow motion)")
check(KeyShortcut.matches(key("ˆ", 34, [.command, .option], ignoring: "ш"), "i", [.command, .option], layout: qwerty), "Russian ⌥⌘ш is ⌥⌘I")
check(KeyShortcut.matches(key("ζ", 6), "z", .command, layout: qwerty), "Greek ⌘ζ is ⌘Z")
// Latin layouts are left alone: Dvorak's own characters are its key equivalents.
check(KeyShortcut.latinEvent(key("[", 27), layout: dvorak, latinLayout: true) == nil, "Dvorak ⌘[ (on the - key) needs no remap")
check(KeyShortcut.matches(key("[", 27), "[", .command, layout: dvorak, latinLayout: true), "Dvorak ⌘[ matches by character")
check(!KeyShortcut.matches(key("/", 33), "[", .command, layout: dvorak, latinLayout: true), "Dvorak ⌘/ on the U.S. [ key is not Back")
check(KeyShortcut.matches(key("х", 33), "/", .command, layout: dvorak, latinLayout: true), "Russian with Dvorak as the Latin layout follows Dvorak")
// Typing is never remapped: plain and ⌥ keys keep the user's layout.
check(KeyShortcut.latinEvent(key("х", 33, []), layout: qwerty) == nil, "plain х is typed as х")
check(KeyShortcut.latinEvent(key("х", 33, .option), layout: qwerty) == nil, "⌥х is typed as is")
check(KeyShortcut.latinEvent(key("[", 33), layout: qwerty, latinLayout: true) == nil, "U.S. ⌘[ is untouched")
// A non-Latin layout is read by position even where it types ASCII: Russian "." is on the U.S. "/" key.
check(KeyShortcut.latinEvent(key(".", 44), layout: qwerty, latinLayout: false)?.charactersIgnoringModifiers == "/", "Russian ⌘. on the / key is ⌘/")
check(KeyShortcut.matches(key("ю", 47), ".", .command, layout: qwerty, latinLayout: false), "Russian ⌘ю is ⌘. (Toggle UI)")
check(KeyShortcut.latinEvent(key("1", 18), layout: qwerty, latinLayout: false) == nil, "Russian digits are the U.S. digits")
// Arrows and function keys keep their characters (⌘← stays ⌘←).
let left = String(UnicodeScalar(UInt16(NSLeftArrowFunctionKey))!)
check(KeyShortcut.latinEvent(key(left, 123, [.command, .numericPad, .function]), layout: qwerty) == nil, "⌘← is not remapped")
check(KeyShortcut.latin(key(left, 123, [.command, .function]), layout: qwerty) == left, "⌘← reads as the arrow")
check(KeyShortcut.latinEvent(key("§", 10), layout: qwerty) == nil, "a key with no Latin character is left alone")
// The machine's own ASCII-capable layout always yields a printable Latin character.
check(KeyShortcut.printable(KeyShortcut.asciiCapable(33, false)), "the current ASCII-capable layout maps keyCode 33")
if KeyShortcut.asciiCapable(0, false) == "a" && KeyShortcut.asciiCapable(12, false) == "q" {
    check(KeyShortcut.latinEvent(key("х", 33))?.charactersIgnoringModifiers == "[", "QWERTY machine: ⌘х → ⌘[ through TIS")
}
print("KEY-SHORTCUTS PASS")
