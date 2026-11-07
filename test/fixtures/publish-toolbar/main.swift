import AppKit

// The real Publish control and state writer, isolated from the host's GUI lifecycle.

final class NativeShell: NSObject {
    let publishControl = PublishToolbarControl()
    let publishSpinner = ToolbarPublishSpinner()
    var publishTitle = "Publish"
    let toolbar = NSToolbar(identifier: "PublishFixture")
    var toolbarFrames: [String: NSRect] = [:]
    weak var window: NSWindow?
    func republished(_ title: String, widthGrowth: CGFloat) { publishTitle = title }
    @objc func toolbarAction(_ item: NSToolbarItem) {}
    @objc func previewMenuAction(_ item: NSMenuItem) {}
}

let shell = NativeShell()
let item = NSMenuToolbarItem(itemIdentifier: NSToolbarItem.Identifier("publish"))
item.autovalidates = false
item.view = shell.publishControl
shell.publishControl.item = item
shell.updatePublish(item, state: ["publishLabel":"Publish", "publishMode":"pr"], ready: true)
precondition(!shell.publishControl.textFont.fontName.contains("Mono"), "Publish uses the system sans-serif UI font")
precondition(shell.publishControl.textFont.pointSize == NSFont.systemFontSize, "Publish keeps the system point size")
precondition(shell.publishControl.titleFits && shell.publishControl.isNativeGlass, "Publish label fits in native glass")
precondition(shell.publishControl.segments.usesGlassHover, "Publish uses the native glass hover treatment")
let insets = shell.publishControl.segments.alignmentRectInsets
precondition(insets.top == 0 && insets.left == 0 && insets.bottom == 0 && insets.right == 0, "Publish fills the glass frame")
shell.publishControl.segments.setGlassInteraction(hovered: true)
precondition(shell.publishControl.segments.cell?.isBordered == true, "Publish shows its native hover bezel")
shell.publishControl.segments.setGlassInteraction(hovered: false)
precondition(shell.publishControl.segments.cell?.isBordered == false, "Publish rests on glass without a second bezel")
precondition(item.action != nil && item.isEnabled && shell.publishControl.segments.isEnabled, "idle Publish stays actionable")
precondition(shell.publishInspect(item, state: [:])["publishEnabled"] as? Bool == true, "idle state is inspectable")
precondition(item.menu.items.map { $0.title } == ["Create PR and merge to main", "Create PR"], "Publish menu is unchanged")
precondition(shell.publishControl.segments.accessibilityLabel() == "Publish", "Publish keeps its spoken label")
shell.updatePublish(item, state: ["publishing":true, "publishLabel":"Pushing…", "publishCancellable":true], ready: true)
precondition(item.action == nil && shell.publishControl.titleFits && shell.publishSpinner.spinning, "busy Publish is menu-only and fits")
precondition(item.menu.items.filter { !$0.isSeparatorItem }.map { $0.title } == ["Pushing…", "Cancel Publish"], "busy menu is unchanged")
shell.updatePublish(item, state: ["publishLabel":"Publish"], ready: false)
precondition(!shell.publishControl.segments.isEnabled && !shell.publishSpinner.spinning &&
    item.menu.items.filter { !$0.isSeparatorItem }.allSatisfy { !$0.isEnabled },
    "disabled Publish stops and stays disabled")
shell.publishControl.segments.setGlassInteraction(hovered: true)
precondition(shell.publishControl.segments.cell?.isBordered == false, "disabled Publish stays unhighlighted")
precondition(shell.publishInspect(item, state: [:])["publishEnabled"] as? Bool == false, "disabled state is inspectable")
print("PUBLISH TOOLBAR PASS — monospace glass label, idle/menu-only/disabled semantics")
