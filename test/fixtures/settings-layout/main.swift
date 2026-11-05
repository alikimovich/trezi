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
func settingsState(_ providers: [[String: Any]], _ actions: [[String: Any]], nested: Bool = false, navigationTitle: String = "Add a provider", draftContext: String? = nil, clearDraftFields: [String] = [], message: String? = nil) throws -> SheetState {
    let shownSections = sections.map { entry -> [String: Any] in
        var section = entry
        if entry["id"] as? String == "providers" {
            if nested { section["navigationTitle"] = navigationTitle }
            if let draftContext { section["draftContext"] = draftContext }
        }
        return section
    }
    var raw: [String: Any] = ["id":"fixture", "title":"Settings", "detail":"", "busy":false, "autosave":true, "sections":shownSections, "section":"general",
                              "fields":generalFields + providers, "actions":actions, "clearDraftFields":clearDraftFields]
    if let message { raw["message"] = message }
    return try JSONDecoder().decode(SheetState.self, from: JSONSerialization.data(withJSONObject: raw))
}
let list: [[String: Any]] = [["id":"connection", "section":"providers", "draft":true, "label":"Provider", "kind":"choice", "value":"gw", "choices":[["value":"gw", "label":"AI Gateway · 2 models · API key saved"]]], ["id":"connection-detail", "section":"providers", "draft":true, "label":"Selected provider", "kind":"readonly", "value":"", "action":"edit", "actionLabel":"Details…"]]
let listActions: [[String: Any]] = [["id":"add", "label":"Add provider…", "primary":true, "section":"providers"], ["id":"edit", "label":"Edit…", "section":"providers"]]
let state = try settingsState(list, listActions)
let skillDetail = try JSONDecoder().decode(SheetSection.self, from: JSONSerialization.data(withJSONObject: ["id":"skills", "label":"Skills", "symbol":"book.closed", "navigationTitle":"emil-design-eng"]))
require(!SectionedSheetContent.showsGroupHeading("emil-design-eng", in: skillDetail), "Nested skill context appears only in the pinned header")
require(SectionedSheetContent.showsGroupHeading("SKILL.md", in: skillDetail), "A distinct nested group heading remains visible")
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
let providerList = try report()
require((providerList["headerActions"] as! [[String: Any]]).map { $0["action"] as! String } == ["add"], "Only Add provider appears in the overview header")
require((providerList["rows"] as! [[String: Any]]).contains { $0["action"] as? String == "edit" && $0["contained"] as? Bool == true && $0["hitTarget"] as? Bool == true }, "Selected provider details are reachable from its row")
snapshot("providers-780")
sheets.model.setValue("connection", "gw")
require(emitted.last?["action"] as? String == "section", "Draft fields never autosave")
// The provider editor swaps the pane's fields in place: new fields are seeded, removed ones forgotten.
let editorFields: [[String: Any]] = [
    ["id":"label", "section":"providers", "draft":true, "label":"Provider name", "kind":"text", "value":"AI Gateway"],
    ["id":"url", "section":"providers", "draft":true, "label":"API base URL", "kind":"text", "value":"https://ai-gateway.vercel.sh/v1"],
    ["id":"key", "section":"providers", "draft":true, "label":"API key", "kind":"secure", "value":""],
    ["id":"models", "section":"providers", "draft":true, "label":"Model IDs (one per line)", "kind":"multiline", "value":""]
] + (0..<12).map { index in
    ["id":"provider-help-\(index)", "section":"providers", "label":"More information \(index)", "kind":"readonly", "value":"This long provider help stays in the scrolling form."]
}
let editorState = try settingsState(editorFields, [["id":"back", "label":"Back", "section":"providers"], ["id":"connect", "label":"Load models", "section":"providers"], ["id":"save-provider", "label":"Add provider", "primary":true, "section":"providers"]], nested: true, draftContext: "create")
sheets.model.update(editorState)
settle()
require(sheets.model.values["label"] == "AI Gateway" && sheets.model.values["connection"] == nil && sheets.model.values["projectUi"] == "false", "In-place pane swap seeds and forgets only its own fields")
require(sheets.model.section == "providers", "An in-place update keeps the selected section")
let header = try report()["headerActions"] as! [[String: Any]]
require(Set(header.compactMap { $0["action"] as? String }) == Set(["back", "connect", "save-provider"]), "Nested provider actions move to the pinned header")
require(header.allSatisfy { $0["contained"] as? Bool == true && $0["hitTarget"] as? Bool == true && $0["enabled"] as? Bool == true }, "Nested provider actions are visible and hittable")
require(header.first { $0["action"] as? String == "save-provider" }?["keyEquivalent"] as? String == "\r", "Safe primary action keeps Return")
_ = try report(["scrollFormToEnd":true]); settle()
let scrolled = try report()
require((scrolled["formScrollY"] as? CGFloat ?? 0) > 0, "The nested provider form actually scrolled")
let pinned = scrolled["headerActions"] as! [[String: Any]]
for action in ["back", "save-provider"] {
    guard let button = pinned.first(where: { $0["action"] as? String == action }) else { fatalError("Missing pinned \(action)") }
    require(button["contained"] as? Bool == true && button["hitTarget"] as? Bool == true && button["enabled"] as? Bool == true, "Pinned \(action) remains visible and hittable after scrolling")
}
// Validation and service errors must be adjacent to the pinned primary action,
// even when the form is scrolled to its end.
for message in ["Enter a provider name.", "Synthetic provider service unavailable."] {
    sheets.model.update(try settingsState(editorFields, [["id":"back", "label":"Back", "section":"providers"], ["id":"connect", "label":"Load models", "section":"providers"], ["id":"save-provider", "label":"Add provider", "primary":true, "section":"providers"]], nested: true, draftContext: "create", message: message))
    settle()
    _ = try report(["scrollFormToEnd":true]); settle()
    let result = try report()
    let notice = result["headerMessage"] as? [String: Any] ?? [:]
    let save = (result["headerActions"] as! [[String: Any]]).first { $0["action"] as? String == "save-provider" }!
    let noticeRect = NSRectFromString(notice["frame"] as? String ?? "")
    let saveRect = NSRectFromString(save["frame"] as? String ?? "")
    require((result["formScrollY"] as? CGFloat ?? 0) > 0 && notice["text"] as? String == message && notice["label"] as? String == message && notice["contained"] as? Bool == true, "The exact resulting message stays visible and accessible above the scrolled form")
    require(abs(noticeRect.midY - saveRect.midY) < 100 && save["contained"] as? Bool == true, "The resulting message stays adjacent to the pinned Save action")
}
let removalState = try settingsState(editorFields, [["id":"back", "label":"Back", "section":"providers"], ["id":"remove", "label":"Remove provider", "primary":true, "destructive":true, "section":"providers"]], nested: true)
sheets.model.update(removalState); settle()
let remove = try report()["headerActions"] as! [[String: Any]]
require(remove.first { $0["action"] as? String == "remove" }?["keyEquivalent"] as? String == "", "Destructive Remove must not become the Return action")
sheets.model.update(editorState); settle()
sheets.model.setValue("label", "Draft provider")
try select("general"); try select("providers")
require(sheets.model.values["label"] == "Draft provider", "Sidebar reentry preserves the unsaved provider draft")
_ = try report(["pressHeader":"back"])
require(emitted.last?["action"] as? String == "back" && emitted.last?["section"] as? String == "providers", "Rendered Back returns through the existing provider route")
sheets.model.update(state)
sheets.model.update(editorState)
require(sheets.model.values["label"] == "Draft provider", "Back and reentry preserve the unsaved editor draft")
snapshot("providers-editor-780")
sheets.model.perform("save-provider")
sheets.model.update(state)
sheets.model.update(editorState)
require(sheets.model.values["label"] == "AI Gateway", "A submitted provider edit clears the retained draft")
let selectedActions: [[String: Any]] = [["id":"back", "label":"Back", "section":"providers"], ["id":"connect", "label":"Load models", "section":"providers"], ["id":"delete", "label":"Remove…", "section":"providers"], ["id":"save-provider", "label":"Save provider", "primary":true, "section":"providers"]]
let selectedEditorState = try settingsState(editorFields, selectedActions, nested: true, navigationTitle: "Edit AI Gateway", draftContext: "provider:a")
let otherEditorFields = editorFields.map { original -> [String: Any] in
    var field = original
    if field["id"] as? String == "url" { field["value"] = "https://other.example/v1" }
    return field
}
let otherEditorState = try settingsState(otherEditorFields, selectedActions, nested: true, navigationTitle: "Edit AI Gateway", draftContext: "provider:b")
let removeConfirmState = try settingsState([["id":"remove-confirm", "section":"providers", "label":"Remove AI Gateway?", "kind":"readonly", "value":"Confirm removal"]], [["id":"back", "label":"Back", "section":"providers"], ["id":"remove", "label":"Remove provider", "primary":true, "destructive":true, "section":"providers"]], nested: true, navigationTitle: "Remove AI Gateway", draftContext: "provider:a")
sheets.model.update(selectedEditorState); settle()
let providerDraft = ["label":"Unsaved selected provider", "url":"https://draft.example/v1", "key":"synthetic-draft-key", "models":"draft-model"]
for (field, value) in providerDraft { sheets.model.setValue(field, value) }
sheets.model.perform("back")
sheets.model.update(state)
sheets.model.update(otherEditorState)
require(sheets.model.values["key"] == "" && sheets.model.values["url"] == "https://other.example/v1" && sheets.model.values["models"] == "" && sheets.model.values["label"] == "AI Gateway", "A same-label provider must not receive another provider's unsaved key, URL, models or name")
sheets.model.perform("save-provider")
let otherSubmission = emitted.last?["values"] as? [String: String] ?? [:]
require(otherSubmission["key"] == "" && otherSubmission["url"] == "https://other.example/v1" && otherSubmission["models"] == "", "Saving provider B cannot submit provider A's unsaved credentials or endpoint")
sheets.model.update(state)
sheets.model.update(selectedEditorState)
require(providerDraft.allSatisfy { sheets.model.values[$0.key] == $0.value }, "Provider A's own draft restores after same-label provider B is opened")
sheets.model.perform("delete")
require(emitted.last?["action"] as? String == "delete" && emitted.last?["section"] as? String == "providers", "Editor Remove uses its selected provider route")
sheets.model.update(removeConfirmState); settle()
try select("general"); try select("providers")
sheets.model.perform("back")
require(emitted.last?["action"] as? String == "back" && emitted.last?["section"] as? String == "providers", "Confirmation Back targets its immediate parent editor")
sheets.model.update(selectedEditorState); settle()
require(sheets.model.state?.sections?.first(where: { $0.id == "providers" })?.navigationTitle == "Edit AI Gateway", "Confirmation Back restores the exact selected provider context")
require(providerDraft.allSatisfy { sheets.model.values[$0.key] == $0.value }, "Confirmation Back restores the identical unsaved provider draft after section reentry")
// Exercise the successful removal transition without invoking a provider writer.
sheets.model.perform("delete")
sheets.model.update(removeConfirmState)
sheets.model.perform("remove")
sheets.model.update(state)
sheets.model.update(selectedEditorState)
require(sheets.model.values["label"] == "AI Gateway" && sheets.model.values["key"] == "", "Confirmed removal clears the obsolete editor draft")
// An unrelated selected provider keeps its own unsaved draft across the credential reset.
sheets.model.update(selectedEditorState)
sheets.model.setValue("key", "synthetic-own-provider-draft")
sheets.model.perform("back")
sheets.model.update(state)
// Removing a saved seat credential succeeds while the secure field still holds a typed
// replacement. The successful service response must clear both the live value and draft.
for (field, context) in [("token", "claude"), ("geminiKey", "gemini")] {
    let credentialFields: [[String: Any]] = [["id":field, "section":"providers", "draft":true, "label":"Synthetic credential", "kind":"secure", "value":""]]
    let credentialActions: [[String: Any]] = [["id":"back", "label":"Back", "section":"providers"], ["id":"save-provider", "label":"Save", "primary":true, "section":"providers"]]
    let credentialState = try settingsState(credentialFields, credentialActions, nested: true, navigationTitle: context, draftContext: context)
    sheets.model.update(state)
    sheets.model.update(credentialState)
    sheets.model.setValue(field, "synthetic-removed-\(context)")
    // A service rejection leaves the typed value alone; only a confirmed removal clears it.
    sheets.model.update(try settingsState(credentialFields, credentialActions, nested: true, navigationTitle: context, draftContext: context, message: "Synthetic removal failed."))
    require(sheets.model.values[field] == "synthetic-removed-\(context)", "A failed \(context) removal retains the unsaved credential")
    sheets.model.perform("back")
    sheets.model.update(state)
    sheets.model.update(credentialState)
    require(sheets.model.values[field] == "synthetic-removed-\(context)", "The own credential draft restores before successful removal")
    sheets.model.update(try settingsState(credentialFields, credentialActions, nested: true, navigationTitle: context, draftContext: context, clearDraftFields: [field], message: "Credential removed."))
    require(sheets.model.values[field] == "", "Successful \(context) removal clears the typed credential")
    sheets.model.perform("back")
    sheets.model.update(state)
    sheets.model.update(credentialState)
    require(sheets.model.values[field] == "", "Back and reopen must not restore the removed \(context) credential")
    sheets.model.perform("save-provider")
    require((emitted.last?["values"] as? [String: String])?[field] == "", "Reopened \(context) cannot resubmit the removed credential")
}
sheets.model.update(state)
sheets.model.update(selectedEditorState)
require(sheets.model.values["key"] == "synthetic-own-provider-draft", "Removing a seat credential does not erase an unrelated provider's own draft")
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
// Persisted read-only status must refresh in place when a skill is toggled, while
// draft editors above still preserve their unsaved values across section switches.
sheets.model.update(try settingsState([["id":"status", "section":"providers", "label":"Status", "kind":"readonly", "value":"Off"]], []))
sheets.model.update(try settingsState([["id":"status", "section":"providers", "label":"Status", "kind":"readonly", "value":"On"]], []))
require(sheets.model.values["status"] == "On", "An existing read-only row reflects a persisted state change")
print("NATIVE SETTINGS LAYOUT PASS — windowless sectioned Settings: real source-list selection, inline AI Providers pane with in-place editor and unsaved draft fields, picker bindings at minimum/780/960 points; hidden controls cannot be invoked; engine preservation and autosave emission")
