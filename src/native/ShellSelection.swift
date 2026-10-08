import AppKit

/// LKM-204: a picked project row stays highlighted until a shell state answers the pick.
/// Each pick carries a growing generation; Bun echoes the newest one it applied as
/// `selection`, so a state rendered before the click reached Bun (still naming the old
/// project) cannot move the highlight back. It also records, for the integration check,
/// the projects the sidebar highlighted and the window showed, in order.
final class ShellSelection {
    private(set) var picked = 0
    private(set) var sidebar: [String] = []
    private(set) var window: [String] = []
    func pick() -> Int { picked += 1; return picked }
    /// A state without `selection` (a backend that has seen no pick) answers every pick.
    func answers(_ state: [String: Any]) -> Bool { (state["selection"] as? Int).map { $0 >= picked } ?? true }
    func note(sidebar highlighted: String?, window shown: String?) {
        Self.append(highlighted ?? "", to: &sidebar); Self.append(shown ?? "", to: &window)
    }
    func reset() { sidebar = []; window = [] }
    var inspect: [String: Any] { ["selectionPicked":picked, "sidebarTrail":sidebar, "windowTrail":window] }
    private static func append(_ value: String, to trail: inout [String]) {
        if trail.last != value { trail.append(value) }
        if trail.count > 64 { trail.removeFirst(trail.count - 64) }
    }
}
