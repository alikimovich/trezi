import AppKit

// LKM-364: the editor's read-only Changes list, fed the real `branchDiff` JSON of a temp
// repository (argv: two projects' diff files, a non-Git project's, the expected base SHA).
func require(_ condition: Bool, _ message: String) {
    if !condition { fputs("FAIL: \(message)\n", stderr); exit(1) }
}
func load(_ path: String) -> [String: Any] {
    guard let data = FileManager.default.contents(atPath: path), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { fputs("FAIL: unreadable \(path)\n", stderr); exit(1) }
    return value
}
let args = CommandLine.arguments
let first = load(args[1]), second = load(args[2]), plain = load(args[3]), sha = args[4]
let list = SourceDiffList()
list.frame = NSRect(x: 0, y: 0, width: 300, height: 600)
var opened: [String] = [], refreshed = 0
list.open = { section, path, hunk in opened.append("\(section) \(path) \(hunk.map(String.init) ?? "file")") }
list.reload = { refreshed += 1 }
list.update(first, busy: false)
list.layoutSubtreeIfNeeded()
var seen = list.inspect()
let rows = seen["rows"] as? [[String: Any]] ?? []
func row(_ kind: String, _ section: String, _ path: String) -> [String: Any]? { rows.first { $0["kind"] as? String == kind && $0["section"] as? String == section && $0["path"] as? String == path } }
func text(_ value: [String: Any]?, _ key: String) -> String { value?[key] as? String ?? "" }

// The base: ref and short SHA, labelled; the branch above it.
let header = seen["base"] as? String ?? ""
require(header.contains("Branch feature @ ") && header.contains("Base: merge-base with origin/main @ \(sha)"), "Base label: \(header)")
// Committed and the uncommitted kinds are separate, labelled sections in order.
let sections = rows.filter { $0["kind"] as? String == "section" }
require(sections.map { text($0, "section") } == ["committed", "staged", "unstaged", "untracked"], "Sections: \(sections)")
require(text(sections[0], "title").hasPrefix("Committed since \(sha) (origin/main)") && text(sections[1], "title") == "Staged (uncommitted)" && text(sections[2], "title") == "Unstaged (uncommitted)" && text(sections[3], "title") == "Untracked (uncommitted)", "Section labels: \(sections.map { text($0, "title") })")
// +/− counts per file and per section; rename, delete and binary rows.
let changed = row("file", "committed", "a.txt")
require(text(changed, "status") == "M" && text(changed, "added") == "+2" && text(changed, "removed") == "−1", "a.txt counts: \(String(describing: changed))")
require(text(sections[0], "added") == "+2" && text(sections[0], "removed") == "−2", "Committed totals: \(sections[0])")
require(text(row("file", "committed", "new.txt"), "title") == "old.txt → new.txt" && text(row("file", "committed", "new.txt"), "status") == "R", "Rename row")
require(text(row("file", "committed", "gone.txt"), "status") == "D" && text(row("file", "committed", "gone.txt"), "removed") == "−1", "Delete row")
require(text(row("file", "committed", "img.bin"), "added") == "binary" && text(row("file", "committed", "img.bin"), "removed").isEmpty, "Binary row")
require(text(row("file", "staged", "b.txt"), "added") == "+1", "Staged row")
require(text(row("file", "unstaged", "c.txt"), "added") == "+1" && text(row("file", "unstaged", "c.txt"), "removed") == "−1", "Unstaged row")
require(text(row("file", "untracked", "new-file.txt"), "status") == "U" && text(row("file", "untracked", "new-file.txt"), "added") == "+3", "Untracked row")
require(rows.contains { $0["kind"] as? String == "hunk" && $0["path"] as? String == "a.txt" && $0["title"] as? String == "Lines 3–4" }, "Hunk row")

// Read-only: the list's one control is Refresh.
require(seen["controls"] as? [String] == ["diff-refresh"], "Controls: \(seen["controls"] ?? [])")
list.refresh.performClick(nil)
require(refreshed == 1, "Refresh asks the backend to re-read")

// A click on a file opens its first hunk; on a hunk, that hunk; section rows only fold.
func click(_ item: SourceDiffList.Node) { let index = list.outline.row(forItem: item); require(index >= 0, "\(item.title) is shown"); list.activate(row: index) }
let committed = list.sections[0]
let fileNode = committed.children.first { $0.path == "a.txt" }!
click(fileNode)
list.outline.expandItem(fileNode)
click(fileNode.children[0])
click(committed)
require(opened == ["committed a.txt file", "committed a.txt 0"], "Clicks: \(opened)")

// Another project's list replaces this one's wholly; nothing carries over.
list.update(second, busy: false)
seen = list.inspect()
let other = (seen["rows"] as? [[String: Any]] ?? []).filter { $0["kind"] as? String != "section" }
require(!other.contains { ["a.txt", "new.txt", "gone.txt", "img.bin", "b.txt", "c.txt", "new-file.txt"].contains(text($0, "path")) }, "No rows leak from the first project: \(other)")
require((seen["base"] as? String ?? "").contains("no default branch found"), "The no-upstream fallback is labelled: \(seen["base"] ?? "")")
require(other.contains { text($0, "path") == "t.txt" }, "The second project's change is listed")
// A non-Git project says so and lists nothing.
list.update(plain, busy: false)
seen = list.inspect()
require((seen["rows"] as? [Any])?.isEmpty == true && (seen["base"] as? String ?? "").contains("not in a Git repository"), "Non-Git: \(seen)")
list.update(nil, busy: true)
require(list.inspect()["base"] as? String == "Reading changes…", "First read shows progress")
print("DIFF-LIST PASS — labelled base and sections, +/- counts, rename/delete/binary, clicks open, Refresh only, no leak between projects, non-Git")
