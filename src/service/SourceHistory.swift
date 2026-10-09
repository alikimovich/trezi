import Foundation

/// Grouped Undo/redo for every Trezi source edit (S08), ported from the retired
/// `edit-history.ts` (the sole history since LKM-111): one pair of stacks per resolved
/// project root, rapid edits of one target coalesced, a group (a comment spawn, a chat
/// turn, a linked-padding gesture) undone as one step. Held for the service's lifetime.
/// Undo and redo themselves are transactions (`SourceStore.transact`), so an
/// interrupted one is rolled back, never left half-applied.
final class SourceHistory: @unchecked Sendable {
    struct Entry: Sendable {
        /// The path as the caller recorded it (answered back, like the legacy history).
        let display: String
        /// The real file.
        let file: String
        var before: Data
        var after: Data
        let key: String?
        let group: String?
        var at: Date
        /// A gesture group coalesces for as long as the gesture lasts.
        let gesture: Bool
    }
    struct Stacks { var undo: [Entry] = []; var redo: [Entry] = [] }

    static let coalesce: TimeInterval = 0.5
    static let limit = 200

    private let lock = NSLock()
    private var stacks: [String: Stacks] = [:]

    func record(root: String, _ entry: Entry) {
        guard entry.before != entry.after else { return }
        lock.lock(); defer { lock.unlock() }
        var s = stacks[root] ?? Stacks()
        s.redo.removeAll()
        if var last = s.undo.last, let key = entry.key, last.key == key, last.file == entry.file, last.after == entry.before,
           entry.gesture || entry.at.timeIntervalSince(last.at) < Self.coalesce {
            // Keep the original before (one undo reverts the burst), advance the after.
            last.after = entry.after; last.at = entry.at
            s.undo[s.undo.count - 1] = last
        } else {
            s.undo.append(entry)
            if s.undo.count > Self.limit { s.undo.removeFirst() }
        }
        stacks[root] = s
    }

    /// The contiguous run of top entries sharing the top's group (one entry without a group).
    func top(root: String, undo: Bool) -> [Entry] {
        lock.lock(); defer { lock.unlock() }
        let from = undo ? stacks[root]?.undo ?? [] : stacks[root]?.redo ?? []
        guard let last = from.last else { return [] }
        guard let group = last.group else { return [last] }
        return Array(from.reversed().prefix { $0.group == group })
    }

    /// Moves `count` entries between the stacks once their files were written.
    func moved(root: String, undo: Bool, count: Int) {
        lock.lock(); defer { lock.unlock() }
        var s = stacks[root] ?? Stacks()
        for _ in 0..<count {
            if undo, let entry = s.undo.popLast() { s.redo.append(entry) }
            else if !undo, let entry = s.redo.popLast() { s.undo.append(entry) }
        }
        stacks[root] = s
    }

    func group(root: String, _ group: String) -> [Entry] {
        lock.lock(); defer { lock.unlock() }
        return stacks[root]?.undo.filter { $0.group == group } ?? []
    }

    /// An addressable revert leaves the undo stack and never enters redo.
    func reverted(root: String, _ group: String) {
        lock.lock(); defer { lock.unlock() }
        stacks[root]?.undo.removeAll { $0.group == group }
    }

    func available(root: String) -> (undo: Bool, redo: Bool) {
        lock.lock(); defer { lock.unlock() }
        return (!(stacks[root]?.undo.isEmpty ?? true), !(stacks[root]?.redo.isEmpty ?? true))
    }

    func clear(root: String) {
        lock.lock(); defer { lock.unlock() }
        stacks[root] = nil
    }
}
