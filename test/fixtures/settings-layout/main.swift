import AppKit
import SwiftUI

var emitted: [[String: Any]] = []
func emit(_ event: [String: Any]) { emitted.append(event) }
func require(_ condition: Bool, _ message: String) {
    if !condition { fatalError(message) }
}
let app = NSApplication.shared
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 780, height: 600), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
window.contentMinSize = SectionedSheetContent.minimumSize
let sheets = NativeSheets(parent: window)
sheets.panel = window
let sections: [[String: Any]] = [
    ["id":"general", "label":"General", "symbol":"gearshape", "detail":"Changes save automatically."],
    ["id":"providers", "label":"AI Providers", "symbol":"sparkles", "detail":"Claude and Codex use your existing sign-ins."],
    ["id":"experimental", "label":"Experimental", "symbol":"testtube.2", "detail":"UI generation options apply to your next message."]
]
let generalFields: [[String: Any]] = [
    ["id":"default", "section":"general", "label":"Default model", "kind":"choice", "value":"last-used", "help":"New chats start with this model.", "choices":[["value":"last-used", "label":"Use last selected model"], ["value":"codex:default", "label":"Codex · Default"]]],
    ["id":"projectUi", "section":"experimental", "label":"Gen UI", "kind":"choice", "value":"false", "help":"Generate UI using your project’s existing components and styles. Experimental; supports React and Svelte.", "choices":[["value":"false", "label":"Off"], ["value":"true", "label":"On"]]],
    ["id":"engine", "section":"experimental", "label":"UI layout method", "kind":"choice", "value":"agent", "visibleWhen":["field":"projectUi", "value":"true"], "help":"Chat model uses your selected chat model to arrange components. Jev uses a separate layout model and requires an AI Gateway API key.", "choices":[["value":"agent", "label":"Chat model"], ["value":"jev", "label":"Jev layout engine"]]]
]
func settingsState(_ providers: [[String: Any]], _ actions: [[String: Any]]) throws -> SheetState {
    let raw: [String: Any] = ["id":"fixture", "title":"Settings", "detail":"", "busy":false, "autosave":true, "sections":sections, "section":"general",
                              "fields":generalFields + providers, "actions":actions]
    return try JSONDecoder().decode(SheetState.self, from: JSONSerialization.data(withJSONObject: raw))
}
let list: [[String: Any]] = [["id":"connection", "section":"providers", "draft":true, "label":"Provider", "kind":"choice", "value":"gw", "choices":[["value":"gw", "label":"AI Gateway · 2 models · API key saved"]]]]
let listActions: [[String: Any]] = [["id":"add", "label":"Add provider…", "section":"providers"], ["id":"edit", "label":"Edit…", "section":"providers"], ["id":"delete", "label":"Remove…", "section":"providers"]]
let state = try settingsState(list, listActions)
sheets.model.update(state)
// Match production: the split view with the source-list sidebar, installed the way NativeSheets does.
sheets.install(in: window)
window.setContentSize(NSSize(width: 780, height: 600))
func settle() {
    for _ in 0..<8 {
        window.contentView?.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.02))
    }
    require(!window.isVisible, "Windowless fixture must never show a window")
}
// Optional offscreen PNGs for layout review (no Liquid Glass; never shown on screen).
func snapshot(_ name: String) {
    guard let dir = ProcessInfo.processInfo.environment["SETTINGS_LAYOUT_PNG"], let view = window.contentView,
          let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
    view.cacheDisplay(in: view.bounds, to: bitmap)
    try? bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name + ".png"))
}
func report(_ command: [String: Any] = [:]) throws -> [String: Any] { try sheets.verifySettings(command) }
func ids() throws -> [String] {
    let result = try report()
    let controls = result["controls"] as! [[String:Any]]
    require(result["foreground"] as? Bool == false, "Hidden window must not qualify as foreground evidence")
    for control in controls {
        require(control["contained"] as? Bool == true, "Picker geometry must remain inside content")
        require(control["hitTarget"] as? Bool == true, "Picker must own its hit target")
        let id = control["id"] as! String
        let field = sheets.model.state!.fields.first { $0.id == id }!
        let label = field.choices!.first { $0.value == sheets.model.values[id] }!.label
        require(control["selected"] as? String == label, "Rendered picker label must match bound value")
    }
    return controls.map { $0["id"] as! String }.sorted()
}
func select(_ section: String) throws {
    _ = try report(["section": section]); settle()
    let result = try report()
    require(result["section"] as? String == section, "Sidebar row selection must switch the pane: \(section)")
    require(result["sidebarSelected"] as? Int == sections.firstIndex { $0["id"] as? String == section }, "Rendered sidebar selection")
    require(result["windowTitle"] as? String == sections.first { $0["id"] as? String == section }?["label"] as? String, "Window title follows the section")
}
settle()
require(window.contentMinSize.width == SectionedSheetContent.minimumSize.width, "The Settings minimum must hold with the split view: \(window.contentMinSize)")
let first = try report()
require(first["sidebarRows"] as? Int == 3 && first["section"] as? String == "general", "Seeded General pane with a three-row source list")
// A native split-view sidebar: NSSplitViewItem(.sidebar) with a .sourceList outline under the traffic lights.
let sourceList = first["sourceList"] as? [String: Any] ?? [:]
require(sourceList["style"] as? String == "sourceList" && sourceList["behavior"] as? String == "sidebar" && sourceList["fullHeight"] as? Bool == true, "Settings sidebar is a source list in a sidebar split item: \(sourceList)")
require(sourceList["rowHeight"] as? CGFloat == SidebarRowStyle.height, "Shared source-list row height")
let row = sourceList["row"] as? [String: Any] ?? [:]
require(row["iconWidth"] as? CGFloat == SidebarIconLayout.size && row["iconLeading"] as? CGFloat == SourceList.iconLeading && row["labelGap"] as? CGFloat == SidebarIconLayout.gap, "Shared source-list icon size and insets: \(row)")
require(first["fullSizeContent"] as? Bool == true && first["trafficLightsOverSidebar"] as? Bool == true && first["sidebarFullHeight"] as? Bool == true, "Full-height sidebar under the traffic lights: \(first)")
require(first["sidebarCollapsible"] as? Bool == false && first["sidebarMinimum"] as? CGFloat == 180 && first["sidebarMaximum"] as? CGFloat == 260, "Fixed sidebar range")
require(first["sidebarFocused"] as? Bool == true, "The outline takes keyboard focus")
require(first["windowTitle"] as? String == "General", "Window title shows the selected section")
// Arrow keys through the window move the outline selection, the pane and the title.
for (key, section, title) in [("down", "providers", "AI Providers"), ("down", "experimental", "Experimental"), ("up", "providers", "AI Providers"), ("up", "general", "General")] {
    _ = try report(["key": key]); settle()
    let result = try report()
    require(result["section"] as? String == section && result["windowTitle"] as? String == title, "Arrow \(key) selects \(section): \(result["section"] ?? "") \(result["windowTitle"] ?? "")")
    require(emitted.last?["action"] as? String == "section" && emitted.last?["section"] as? String == section, "Arrow selection tells Bun the section")
}
require(try ids() == ["default"], "General renders the default model picker only")
snapshot("general-780")
try select("providers")
require(emitted.last?["action"] as? String == "section" && emitted.last?["section"] as? String == "providers", "Selection tells Bun the section")
require(try ids() == ["connection"], "AI Providers renders its provider picker inline")
snapshot("providers-780")
sheets.model.setValue("connection", "gw")
require(emitted.last?["action"] as? String == "section", "Draft fields never autosave")
// The provider editor swaps the pane's fields in place: new fields are seeded, removed ones forgotten.
sheets.model.update(try settingsState([
    ["id":"label", "section":"providers", "draft":true, "label":"Provider name", "kind":"text", "value":"AI Gateway"],
    ["id":"url", "section":"providers", "draft":true, "label":"API base URL", "kind":"text", "value":"https://ai-gateway.vercel.sh/v1"],
    ["id":"key", "section":"providers", "draft":true, "label":"API key", "kind":"secure", "value":""],
    ["id":"models", "section":"providers", "draft":true, "label":"Model IDs (one per line)", "kind":"multiline", "value":""]
], [["id":"back", "label":"Back", "section":"providers"], ["id":"connect", "label":"Load models", "section":"providers"], ["id":"save-provider", "label":"Add provider", "primary":true, "section":"providers"]]))
settle()
require(sheets.model.values["label"] == "AI Gateway" && sheets.model.values["connection"] == nil && sheets.model.values["projectUi"] == "false", "In-place pane swap seeds and forgets only its own fields")
require(sheets.model.section == "providers", "An in-place update keeps the selected section")
snapshot("providers-editor-780")
sheets.model.update(state); settle()
try select("experimental")
let before = emitted.count
for width in [window.contentMinSize.width, SectionedSheetContent.defaultSize.width, 960] {
    window.setContentSize(NSSize(width: width, height: 600)); settle()
    require(abs(window.contentView!.bounds.width - width) <= 1, "Requested width must reach real content layout")
    require(window.contentMinSize.width == SectionedSheetContent.minimumSize.width, "Minimum must remain stable after resize")
    require(try ids() == ["projectUi"], "Off must have one rendered picker")
    snapshot("experimental-off-\(Int(width))")
    _ = try report(["field":"projectUi", "value":"true"]); settle()
    require(try ids() == ["engine", "projectUi"], "On must render engine picker")
    _ = try report(["field":"engine", "value":"jev"]); settle()
    _ = try ids()
    snapshot("experimental-on-\(Int(width))")
    require(sheets.model.values["engine"] == "jev", "Native picker target/action must update the real SwiftUI binding")
    _ = try report(["field":"projectUi", "value":"false"]); settle()
    require(try ids() == ["projectUi"], "Off must remove native engine picker")
    require(sheets.model.values["engine"] == "jev", "Hidden engine value must survive")
    do {
        _ = try report(["field":"engine", "value":"agent"])
        fatalError("Hidden picker must reject interaction")
    } catch {}
    _ = try report(["field":"projectUi", "value":"true"]); settle()
    _ = try report(["field":"engine", "value":"agent"]); settle()
    _ = try report(["field":"projectUi", "value":"false"]); settle()
}
let changes = emitted[before...]
require(changes.count == 18, "Every native choice must emit exactly one autosave action")
require(changes.allSatisfy { $0["action"] as? String == "change" && $0["section"] as? String == "experimental" }, "Picker must use the autosave path")
window.setContentSize(window.contentMinSize); settle()
for section in ["general", "providers"] { try select(section); snapshot("\(section)-min") }
print("NATIVE SETTINGS LAYOUT PASS — windowless sectioned Settings: real source-list selection, inline AI Providers pane with in-place editor and unsaved draft fields, picker bindings at minimum/780/960 points; hidden controls cannot be invoked; engine preservation and autosave emission")
