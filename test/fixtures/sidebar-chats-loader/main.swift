import AppKit

// LKM-618: the real `SidebarChatsLoaderCell` and the real `ShellRow` nesting, in a window that is
// never ordered in. The cat's frames are the build's own `cat.json` (argv[1]). Prints JSON for
// test/sidebar-chats-loader.mjs.
_ = NSApplication.shared

final class NativeShell: NSObject {
    var rows: [ShellRow] = []
    var sidebarDecipherStarts: [String: CFTimeInterval] = [:]
    var currentProject: String?
    var selectedID: String?
    var sidebarHistory = SidebarHistoryState()
    var applying = false
    let outline = NSOutlineView()
    let sidebar = NSViewController()
    func projectMenu(_ row: ShellRow) -> NSMenu { NSMenu() }
    @objc func contextAction(_ sender: Any?) {}
}
func emit(_ value: [String: Any]) {}

let assets = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
CatArtwork.frames = try JSONDecoder().decode([String: [CatFrame]].self, from: assets)
// Never nil: the run must not depend on the host's Reduce Motion setting.
SidebarChatsLoaderCell.reduceMotionOverride = false

let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 200), styleMask: [.borderless], backing: .buffered, defer: false)
let root = NSView(frame: window.contentLayoutRect)
root.wantsLayer = true
window.contentView = root
var report: [String: Any] = [:]

// Nesting: one line after the known chats, before History; none without `chatsLoading`.
let project = ShellRow(["id":"project:p", "kind":"project", "project":"p", "title":"P", "chatsLoading":true,
                        "recent":[["id":"chat:a", "kind":"chat", "project":"p", "title":"Cached"]],
                        "children":[["id":"chat:a", "kind":"chat", "project":"p", "title":"Cached"],
                                    ["id":"history:h", "kind":"history", "project":"p", "title":"Old", "detail":"3d"]]])
let shell = NativeShell()
shell.rows = [project]; shell.currentProject = "p"; shell.selectedID = "chat:a"
report["nested"] = project.nested.map(\.id)
project.layoutNested(open: true, all: false)
report["nestedHistory"] = project.nested.map(\.id)
report["plain"] = ShellRow(["id":"project:q", "kind":"project", "project":"q", "title":"Q", "recent":[[String: Any]]()]).nested.map(\.id)
let line = project.nested.first { $0.kind == "chats-loading" }!
report["interaction"] = ["selectable": shell.outlineView(shell.outline, shouldSelectItem: line), "menu": shell.sidebarRowMenu(line).map(\.title),
                         "archive": shell.canArchive(line), "target": shell.sidebarTarget()?.id ?? ""]

func make(width: CGFloat) -> SidebarChatsLoaderCell {
    let cell = SidebarChatsLoaderCell(row: line)
    cell.frame = NSRect(x: 0, y: 0, width: width, height: SidebarRowStyle.height)
    root.addSubview(cell)
    cell.layoutSubtreeIfNeeded()
    return cell
}
let cell = make(width: 200)
report["wide"] = cell.inspect()
cell.frame.size.width = 120; cell.layoutSubtreeIfNeeded()
report["resized"] = cell.inspect()
cell.frame.size.width = 20; cell.layoutSubtreeIfNeeded()
report["cramped"] = cell.inspect()
cell.frame.size.width = 200; cell.layoutSubtreeIfNeeded()
let firstOffset = (cell.cat.animation(forKey: "travel") as? CAKeyframeAnimation)?.timeOffset ?? -1
let rebuilt = make(width: 200)
report["offsets"] = [firstOffset, (rebuilt.cat.animation(forKey: "travel") as? CAKeyframeAnimation)?.timeOffset ?? -1]
rebuilt.removeFromSuperview()
SidebarChatsLoaderCell.reduceMotionOverride = true
cell.restart(force: true)
report["reduced"] = cell.inspect()
SidebarChatsLoaderCell.reduceMotionOverride = false
cell.restart(force: true)
report["restored"] = cell.inspect()
cell.isHidden = true
report["hidden"] = cell.inspect()
cell.isHidden = false
report["unhidden"] = cell.inspect()
// The list loaded: the row is discarded. Nothing runs on, nothing keeps the cell.
weak var gone: SidebarChatsLoaderCell?
var detached: [String: Any] = [:]
autoreleasepool {
    let transient = make(width: 200)
    gone = transient
    transient.removeFromSuperview()
    detached = transient.inspect()
}
report["detached"] = detached
report["released"] = gone == nil
cell.removeFromSuperview()

print(String(data: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), encoding: .utf8)!)
