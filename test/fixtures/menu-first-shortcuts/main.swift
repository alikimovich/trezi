import AppKit
import WebKit

// LKM-380: ⌘. (Actions → Toggle UI) with the focus in the real views, in AppKit's own key
// order: the key window's views, then the main menu, then the responder chain's keyDown.
// The window is offscreen and reports full screen (AppKit's own `styleMask` and tile
// check), and records a full-screen exit instead of leaving. One JSON report on stdout.
final class Window: NSWindow {
    var full = true
    var exits = 0, cancels: [String] = []
    override var styleMask: NSWindow.StyleMask { get { full ? super.styleMask.union(.fullScreen) : super.styleMask } set { super.styleMask = newValue } }
    @objc func _fullScreenTileFillsScreen() -> Bool { full }
    @objc func exitFullScreenMode(_ sender: Any?) { exits += 1 }
    override func toggleFullScreen(_ sender: Any?) { exits += 1 }
    override func doCommand(by selector: Selector) { cancels.append(NSStringFromSelector(selector)); super.doCommand(by: selector) }
}
final class Target: NSObject {
    var toggles = 0
    @objc func menuAction(_ item: NSMenuItem) { if item.representedObject as? String == "toggle-chat" { toggles += 1 } }
}
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let target = Target(), menu = NSMenu(), actionsItem = NSMenuItem(), actions = NSMenu(title: "Actions")
actionsItem.submenu = actions; menu.addItem(actionsItem)
// The same item HostMenus builds: Actions → Toggle UI, ⌘., represented "toggle-chat".
let toggle = NSMenuItem(title: "Toggle UI", action: #selector(Target.menuAction(_:)), keyEquivalent: ".")
toggle.target = target; toggle.representedObject = "toggle-chat"; actions.addItem(toggle)
app.mainMenu = menu

let window = Window(contentRect: NSRect(x: -4000, y: -4000, width: 900, height: 600), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
let content = window.contentView!
let composer = NSTextView(frame: NSRect(x: 0, y: 0, width: 300, height: 80)); content.addSubview(composer)
let sourceScroll = NSScrollView(frame: NSRect(x: 300, y: 0, width: 300, height: 200)), source = NSTextView(frame: sourceScroll.bounds)
sourceScroll.documentView = source; content.addSubview(sourceScroll)
let field = NSTextField(frame: NSRect(x: 0, y: 500, width: 300, height: 24)); content.addSubview(field)
let preview = WKWebView(frame: NSRect(x: 0, y: 200, width: 600, height: 300)); content.addSubview(preview)
let focuses: [(String, NSResponder?)] = [("composer", composer), ("source", source), ("address", field), ("preview", preview), ("none", nil)]

func key(_ characters: String, _ code: UInt16, _ flags: NSEvent.ModifierFlags) -> NSEvent {
    NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                     context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code)!
}
let period = { key(".", 47, .command) }, escape = { key("\u{1b}", 53, []) }
let qwerty: KeyShortcut.Layout = { code, shift in KeyShortcut.ansi[code].map { shift ? $0.1 : $0.0 } }
/// NSApplication's key-down order for the key window, optionally behind the menu-first filter.
func dispatch(_ event: NSEvent, menuFirst: Bool) -> String {
    if menuFirst, MenuFirstShortcut.route(event, window: window, menu: menu, layout: qwerty, latinLayout: true) { return "menu-first" }
    if window.performKeyEquivalent(with: event) { return "view" }
    if menu.performKeyEquivalent(with: event) { return "menu" }
    window.sendEvent(event); return "keyDown"
}
func spin() { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
var report: [String: Any] = [:]
for full in [true, false] {
    window.full = full
    for menuFirst in [false, true] {
        for (name, responder) in focuses {
            window.makeFirstResponder(responder); spin()
            let toggles = target.toggles, exits = window.exits, cancels = window.cancels.count
            var routes: [String] = []
            // Three presses: repeated ⌘. toggles every time.
            for _ in 0..<3 { routes.append(dispatch(period(), menuFirst: menuFirst)); spin() }
            report["\(full ? "full" : "windowed").\(menuFirst ? "fixed" : "appkit").\(name)"] = [
                "toggles": target.toggles - toggles, "exits": window.exits - exits, "routes": routes,
                "cancels": Array(window.cancels[cancels...]), "focus": window.firstResponder === (responder === field ? field.currentEditor() : responder ?? window)
            ] as [String: Any]
        }
    }
}
// Escape is not routed to the menu, on its own or with ⌘, and is dispatched on to the responder
// chain (its cancel is measured with the key-down step below, `keyDownEscape`).
window.full = false
window.makeFirstResponder(composer)
let escapeToggles = target.toggles
report["escape.routed"] = MenuFirstShortcut.route(escape(), window: window, menu: menu, layout: qwerty, latinLayout: true)
report["escape.commandRouted"] = MenuFirstShortcut.route(key("\u{1b}", 53, .command), window: window, menu: menu, layout: qwerty, latinLayout: true)
report["escape.route"] = dispatch(escape(), menuFirst: true)
report["escape.toggles"] = target.toggles - escapeToggles
// Only exactly ⌘.: ⇧⌘. and ⌥⌘. are not Toggle UI; a sheet or another window keeps its keys.
report["shiftPeriod.routed"] = MenuFirstShortcut.route(key(">", 47, [.command, .shift]), window: window, menu: menu, layout: qwerty, latinLayout: true)
report["optionPeriod.routed"] = MenuFirstShortcut.route(key("≥", 47, [.command, .option]), window: window, menu: menu, layout: qwerty, latinLayout: true)
let other = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: 100, height: 100), styleMask: [.titled], backing: .buffered, defer: false)
let otherEvent = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: 0, windowNumber: other.windowNumber, context: nil,
                                  characters: ".", charactersIgnoringModifiers: ".", isARepeat: false, keyCode: 47)!
// Without a window server (a sandbox) every window number is 0, so this needs distinct ones.
report["otherWindow.distinct"] = window.windowNumber != other.windowNumber
report["otherWindow.routed"] = MenuFirstShortcut.route(otherEvent, window: window, menu: menu, layout: qwerty, latinLayout: true)
report["toolbarWindow.routed"] = MenuFirstShortcut.route(otherEvent, window: window, also: other, menu: menu, layout: qwerty, latinLayout: true)
// A non-Latin layout: ⌘ on the "." key (47) reads "ю" under Russian.
report["russian.routed"] = MenuFirstShortcut.route(key("ю", 47, .command), window: window, menu: menu, layout: qwerty, latinLayout: false)
// The monitor's body swallows ⌘. once it toggled, and passes it on while a menu tracks;
// Escape always passes.
func filtered(_ event: NSEvent, tracking: Bool) -> [String: Any] {
    let toggles = target.toggles
    let out = MenuFirstShortcut.filter(event, windows: { (window, nil) }, enabled: { !tracking }, menu: menu, layout: qwerty, latinLayout: true)
    return ["passed": out === event, "toggles": target.toggles - toggles]
}
report["filter.period"] = filtered(period(), tracking: false)
report["filter.tracking"] = filtered(period(), tracking: true)
report["filter.escape"] = filtered(escape(), tracking: false)
// The installed monitor is what NSApplication.sendEvent runs first.
var monitorCalls = 0
MenuFirstShortcut.install(windows: { (window, nil) }, enabled: { monitorCalls += 1; return true })
app.sendEvent(period())
report["monitor.calls"] = monitorCalls
// The bug's last steps, apart because they depend on different things. `cancelOperation:`
// reaching NSWindow is a full-screen exit in full screen and not windowed: that is AppKit's
// own and needs no key event, so it is measured directly (`link`) and through the text view's
// responder chain (`chain`). Whether a ⌘. key-down in a text view *becomes* `cancelOperation:`
// is the text input system's key binding (`keyDown`, and `keyDownEscape` for Escape): it differs
// per host and per key (GitHub macOS 26.6.2 turned Escape into it but not ⌘.; LKM-380), so the
// test checks each key against what `produced` says it did. `env` records the host.
let cancel = #selector(NSResponder.cancelOperation(_:))
func measure(_ full: Bool, _ focus: NSResponder?, _ act: () -> Void) -> [String: Any] {
    window.full = full; window.makeFirstResponder(focus); spin()
    let exits = window.exits, cancels = window.cancels.count
    act(); spin()
    let seen = Array(window.cancels[cancels...])
    return ["exits": window.exits - exits, "cancels": seen, "produced": !seen.isEmpty]
}
for full in [true, false] {
    let mode = full ? "full" : "windowed"
    report["\(mode).link"] = measure(full, composer) { window.doCommand(by: cancel) }
    report["\(mode).chain"] = measure(full, composer) { composer.doCommand(by: cancel) }
    report["\(mode).keyDown"] = measure(full, composer) { window.sendEvent(period()) }
    report["\(mode).keyDownEscape"] = measure(full, composer) { window.sendEvent(escape()) }
}
let os = ProcessInfo.processInfo.operatingSystemVersion
report["env"] = ["os": "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)", "inputContext": composer.inputContext != nil,
                 "active": app.isActive, "key": window.isKeyWindow, "policy": app.activationPolicy().rawValue] as [String: Any]
print(String(data: try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), encoding: .utf8)!)
