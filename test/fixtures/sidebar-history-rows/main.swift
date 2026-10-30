import AppKit

// LKM-384: the real `ShellRow.layoutNested`, fed the row data Bun sends, for each History state.
// Prints the outline's nested rows as JSON for test/sidebar-history-rows.mjs. `NativeShell` and
// `emit` stand in for the host, which only `ProjectCell.swift`'s drag-and-drop code touches.
_ = NSApplication.shared

final class NativeShell: NSObject { var rows: [ShellRow] = [] }
func emit(_ value: [String: Any]) {}

func project(closed: Int) -> ShellRow {
    ShellRow(["id": "project:p", "kind": "project", "project": "p", "title": "Project",
              "recent": [["id": "chat:b", "kind": "chat", "project": "p", "title": "B"],
                         ["id": "chat:a", "kind": "chat", "project": "p", "title": "A"]],
              "children": [["id": "chat:b", "kind": "chat", "project": "p", "title": "B"],
                           ["id": "chat:a", "kind": "chat", "project": "p", "title": "A"]]
                  + (0..<closed).map { ["id": "history:\($0)", "kind": "history", "project": "p", "title": "Closed \($0)", "detail": "\($0 + 1)d"] }])
}

var report: [String: Any] = [:]
for closed in [0, 1, 3, 4, 7] {
    for (name, open, all) in [("closed", false, false), ("open", true, false), ("all", true, true)] {
        let row = project(closed: closed)
        row.layoutNested(open: open, all: all)
        report["\(closed)-\(name)"] = row.nested.map { ["id": $0.id, "kind": $0.kind, "title": $0.title, "detail": $0.detail] }
    }
}
let compact = ShellRow(["id": "project:q", "kind": "project", "project": "q", "title": "Other",
                        "children": [["id": "history:0", "kind": "history", "project": "q", "title": "Closed"]]])
compact.layoutNested(open: true, all: true)
report["unselected"] = compact.nested.map { ["id": $0.id] }

// LKM-388: the real menu item and toggle, as `NativeShell.sidebarHistoryItem` uses them.
func item(_ state: SidebarHistoryState, _ row: ShellRow, selected: Bool = true) -> [String: Any] {
    let entry = state.menuItem(row, selected: selected)
    return ["title": entry.title, "enabled": entry.enabled]
}
let full = project(closed: 4), none = project(closed: 0)
var state = SidebarHistoryState()
var states: [String: Any] = ["hidden": item(state, full), "empty": item(state, none),
                             "emptyUnselected": item(state, none, selected: false)]
state.toggle("p")
states["revealed"] = item(state, full)
states["emptied"] = item(state, none)
states["revealedUnselected"] = item(state, none, selected: false)
let other = ShellRow(["id": "project:q", "kind": "project", "project": "q", "title": "Other", "recent": [["id": "chat:b", "kind": "chat", "project": "q", "title": "B"], ["id": "chat:a", "kind": "chat", "project": "q", "title": "A"]],
                      "children": [["id": "history:0", "kind": "history", "project": "q", "title": "Closed"]]])
other.layoutNested(open: state.open.contains("q"), all: state.all.contains("q"))
states["isolated"] = ["p": item(state, full), "q": item(state, other), "open": state.open.sorted(),
                      "rowsOfOther": other.nested.map { $0.id.replacingOccurrences(of: "q", with: "p") }]
state.all.insert("p")
state.toggle("p")
states["hiddenAgain"] = item(state, full).merging(["open": state.open.sorted(), "all": state.all.sorted()]) { $1 }
report["states"] = states
let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
