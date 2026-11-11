import AppKit
import WebKit

// LKM-644: ⌘Z / ⇧⌘Z with the focus in the real views, in AppKit's own key order (the key
// window's views, then the main menu, then the responder chain's keyDown). The Edit menu's
// Undo and Redo items are the ones HostMenus builds, and their action asks `EditUndo` who
// answers, as Host does. One JSON report on stdout.
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let window = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: 900, height: 600), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
let content = window.contentView!
let composer = NSTextView(frame: NSRect(x: 0, y: 0, width: 300, height: 80)); composer.allowsUndo = true; content.addSubview(composer)
let sourceScroll = NSScrollView(frame: NSRect(x: 300, y: 0, width: 300, height: 200)), source = NSTextView(frame: sourceScroll.bounds)
source.allowsUndo = true; sourceScroll.documentView = source; content.addSubview(sourceScroll)
/// The inspector island and one of its Styles fields.
let island = NSView(frame: NSRect(x: 600, y: 200, width: 300, height: 400)); content.addSubview(island)
let styleField = NSTextField(frame: NSRect(x: 10, y: 10, width: 200, height: 24)); island.addSubview(styleField)
/// A text field outside the island (the address bar).
let address = NSTextField(frame: NSRect(x: 0, y: 500, width: 300, height: 24)); content.addSubview(address)
/// The preview page: a field and a plain focusable box; every ⌘ key-down is reported.
final class PageKeys: NSObject, WKScriptMessageHandler {
    var keys: [String] = []
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) { keys.append("\(message.body)") }
}
let pageKeys = PageKeys(), configuration = WKWebViewConfiguration()
configuration.userContentController.add(pageKeys, name: "keys")
let preview = WKWebView(frame: NSRect(x: 0, y: 200, width: 600, height: 300), configuration: configuration); content.addSubview(preview)

final class Target: NSObject {
    var visual: [String] = [], text: [String] = [], page: [String] = []
    /// Host.editUndo's routing, recorded instead of emitted.
    @objc func menuAction(_ item: NSMenuItem) {
        let undo = item.representedObject as? String == "undo", step = undo ? "undo" : "redo"
        currentEvents.append(NSApp.currentEvent.map { "\($0.type.rawValue):\($0.charactersIgnoringModifiers ?? "")" } ?? "none")
        guard let responder = window.firstResponder else { visual.append(step); return }
        switch EditUndo.route(responder, island: island, preview: preview, key: pressing) {
        case .text: text.append(step); EditUndo.perform(responder, undo: undo)
        case .page: page.append(step)
        case .visual: visual.append(step)
        }
    }
}
/// Host reads `NSApp.currentEvent?.type == .keyDown` (a menu click's is the mouse event).
/// Direct dispatch here sets no current event, so the fixture says whether a key is in flight.
var pressing = false
var currentEvents: [String] = []
let target = Target(), menu = NSMenu(), editItem = NSMenuItem(), edit = NSMenu(title: "Edit")
editItem.submenu = edit; menu.addItem(editItem)
let undoItem = NSMenuItem(title: "Undo", action: #selector(Target.menuAction(_:)), keyEquivalent: "z"); undoItem.target = target; undoItem.representedObject = "undo"; edit.addItem(undoItem)
let redoItem = NSMenuItem(title: "Redo", action: #selector(Target.menuAction(_:)), keyEquivalent: "Z"); redoItem.target = target; redoItem.representedObject = "redo"
redoItem.keyEquivalentModifierMask = [.command]; edit.addItem(redoItem)
app.mainMenu = menu

func spin(_ seconds: Double = 0.05) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }
func key(_ characters: String, _ code: UInt16, _ flags: NSEvent.ModifierFlags, plain: String? = nil) -> NSEvent {
    NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                     context: nil, characters: characters, charactersIgnoringModifiers: plain ?? characters, isARepeat: false, keyCode: code)!
}
let qwerty: KeyShortcut.Layout = { code, shift in KeyShortcut.ansi[code].map { shift ? $0.1 : $0.0 } }
/// NSApplication's key-down order for the key window, after `KeyShortcut`'s Latin re-read.
func dispatch(_ raw: NSEvent, latinLayout: Bool = true) -> String {
    let event = KeyShortcut.latinEvent(raw, layout: qwerty, latinLayout: latinLayout) ?? raw
    pressing = true
    if window.performKeyEquivalent(with: event) { return "view" }
    if menu.performKeyEquivalent(with: event) { return "menu" }
    window.sendEvent(event); return "keyDown"
}
let commandZ = { key("z", 6, .command) }, shiftCommandZ = { key("Z", 6, [.command, .shift], plain: "Z") }
/// One press with `focus`: who answered, and what the focused text holds afterwards.
func press(_ event: @autoclosure () -> NSEvent, focus: NSResponder?, latinLayout: Bool = true) -> [String: Any] {
    if window.firstResponder !== focus { window.makeFirstResponder(focus) }
    spin()
    let visual = target.visual.count, text = target.text.count, page = target.page.count
    pressing = true
    let route = dispatch(event(), latinLayout: latinLayout); spin(0.3); pressing = false
    return ["route": route, "visual": Array(target.visual[visual...]), "text": Array(target.text[text...]), "page": Array(target.page[page...])]
}
func type(_ view: NSTextView, _ text: String) {
    window.makeFirstResponder(view); view.insertText(text, replacementRange: view.selectedRange()); view.breakUndoCoalescing()
}
var report: [String: Any] = [:]

// Nothing focused: the visual draft takes both keys.
report["none.undo"] = press(commandZ(), focus: nil)
report["none.redo"] = press(shiftCommandZ(), focus: nil)
// The composer and the code editor keep their typing Undo/Redo, with or without a step left.
type(composer, "hello")
report["composer.undo"] = press(commandZ(), focus: composer)
report["composer.afterUndo"] = composer.string
report["composer.redo"] = press(shiftCommandZ(), focus: composer)
report["composer.afterRedo"] = composer.string
composer.undoManager?.removeAllActions()
report["composer.empty"] = press(commandZ(), focus: composer)
type(source, "let a = 1")
report["source.undo"] = press(commandZ(), focus: source)
report["source.after"] = source.string
// An inspector Styles field: typing not committed yet is the field's; a committed one is visual.
window.makeFirstResponder(styleField); spin()
let fieldEditor = window.firstResponder as? NSTextView
report["field.isEditor"] = fieldEditor?.isFieldEditor == true && (fieldEditor?.delegate as? NSView) === styleField
fieldEditor?.insertText("0.75rem", replacementRange: fieldEditor?.selectedRange() ?? NSRange()); fieldEditor?.breakUndoCoalescing()
InspectorTyping.dirty = true
report["field.typing"] = press(commandZ(), focus: fieldEditor)
report["field.typingAfter"] = fieldEditor?.string ?? ""
fieldEditor?.string = "0.75rem"
InspectorTyping.dirty = false // committed (Return)
report["field.committed"] = press(commandZ(), focus: fieldEditor)
report["field.committedRedo"] = press(shiftCommandZ(), focus: fieldEditor)
report["field.committedAfter"] = fieldEditor?.string ?? ""
report["field.stillFocused"] = window.firstResponder === fieldEditor
// The address bar is a text field outside the island: always its own.
window.makeFirstResponder(address); spin()
report["address"] = press(commandZ(), focus: window.firstResponder)
// The edit menu's titles and state for the focus (Host.validateMenuItem).
window.makeFirstResponder(nil)
let noneValid = EditUndo.validate(undoItem, undo: true, responder: window.firstResponder, island: island, visual: true)
report["validate.none"] = ["enabled": noneValid, "title": undoItem.title]
type(composer, "x")
let composerValid = EditUndo.validate(redoItem, undo: false, responder: composer, island: island, visual: true)
report["validate.composerRedo"] = ["enabled": composerValid, "title": redoItem.title]
undoItem.title = "Undo"; redoItem.title = "Redo"
// A non-Latin layout (Russian "я" on the Z key): the Latin re-read reaches the same items.
report["russian.undo"] = press(key("я", 6, .command), focus: nil, latinLayout: false)
report["russian.redo"] = press(key("Я", 6, [.command, .shift], plain: "Я"), focus: nil, latinLayout: false)
// ⌥⌘Z and ⌃⌘Z are not Undo.
report["optionZ"] = press(key("Ω", 6, [.command, .option], plain: "z"), focus: nil)

// The preview page: a focused WKWebView claims ⌘Z for the page first. Like the preview
// script, the page takes ⌘Z outside its fields (preventDefault, reported as the visual
// step) and leaves it to a focused field; WebKit re-sends an unhandled ⌘ key to the menu.
preview.loadHTMLString("""
<input id="field"><div id="box" tabindex="0" style="width:200px;height:100px">box</div>
<script>addEventListener('keydown', e => {
  if (!e.metaKey) return
  const field = e.target instanceof HTMLInputElement
  if (!field) e.preventDefault()
  webkit.messageHandlers.keys.postMessage((e.shiftKey ? 'shift+' : '') + e.key + '@' + (document.activeElement && document.activeElement.id) + (field ? '' : ':taken'))
}, true)</script>
""", baseURL: nil)
for _ in 0..<100 where preview.isLoading { spin(0.05) }
spin(0.2)
window.makeFirstResponder(preview); spin(0.2)
preview.evaluateJavaScript("document.getElementById('box').focus()") { _, _ in }; spin(0.2)
report["preview.undo"] = press(commandZ(), focus: preview)
report["preview.redo"] = press(shiftCommandZ(), focus: preview)
for _ in 0..<40 where pageKeys.keys.count < 2 { spin(0.05) }
report["preview.pageKeys"] = pageKeys.keys
preview.evaluateJavaScript("document.getElementById('field').focus()") { _, _ in }; spin(0.2)
let seen = currentEvents.count
report["previewField.undo"] = press(commandZ(), focus: preview)
report["previewField.currentEvent"] = Array(currentEvents[seen...])
for _ in 0..<40 where pageKeys.keys.count < 3 { spin(0.05) }
report["previewField.pageKeys"] = Array(pageKeys.keys.dropFirst(2))
// A menu click (no key event) with the page focused is the visual step.
window.makeFirstResponder(preview); spin()
let clicks = target.visual.count
target.menuAction(undoItem)
report["preview.menuClick"] = Array(target.visual[clicks...])
// AppKit's own text commands: none bound to ⌘Z or ⇧⌘Z (an unhandled key becomes no command).
let bindings = NSDictionary(contentsOfFile: "/System/Library/Frameworks/AppKit.framework/Resources/StandardKeyBinding.dict")
report["textBindings"] = ["read": bindings != nil, "bound": (bindings?.allKeys as? [String] ?? []).filter { ["@z", "@Z", "@$z", "@$Z", "$@z"].contains($0) }] as [String: Any]

let data = try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
