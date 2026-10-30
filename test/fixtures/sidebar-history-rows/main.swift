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

var report: [String: [[String: String]]] = [:]
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
let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
