import Foundation
import Darwin

/// The source service's effects (S08): hash-bound multi-file transactions, Undo,
/// redo and revert over them, and the file tree's create/rename/delete. Callers run
/// every effect in the repository's lane (the serialization authority), so nothing
/// here races a Git effect or another Trezi write on the same repository.
final class SourceStore: @unchecked Sendable {
    struct Write: Sendable {
        let target: SourcePaths.Target
        /// The caller's path, answered back unchanged.
        let display: String
        /// SHA-256 of the bytes the proposal was computed from.
        let expected: String
        let content: Data
    }
    enum Outcome: Sendable {
        /// `previous`: the bytes each changed file held before (keyed by real path).
        case applied([SourcePaths.Target], previous: [String: Data])
        /// A file no longer holds the bytes the proposal (or the history) expected.
        case conflict(String)
    }

    let journal: SourceJournal
    let history = SourceHistory()
    private let fault: (@Sendable (String) -> Void)?

    init(journal: SourceJournal, fault: (@Sendable (String) -> Void)?) {
        self.journal = journal; self.fault = fault
    }

    /// All-or-nothing: every file is checked against its expected hash before anything
    /// is written; the pre-images are journaled; a write that fails puts back the files
    /// already written. No-op writes are skipped.
    func transact(kind: String, operationID: String, root: String, _ writes: [Write]) throws -> Outcome {
        var pending: [(Write, Data)] = []
        for write in writes {
            guard SourcePaths.isRegularFile(write.target.real), let current = try SourcePaths.read(write.target.real) else {
                return .conflict(write.display)
            }
            guard SourcePaths.hash(current) == write.expected else { return .conflict(write.display) }
            if current != write.content { pending.append((write, current)) }
        }
        guard !pending.isEmpty else { return .applied(writes.map(\.target), previous: [:]) }
        let entry = SourceJournal.Entry(operationID: operationID, kind: kind, root: root, started: ISO8601DateFormatter().string(from: Date()),
            files: pending.map { SourceJournal.File(path: $0.0.target.real, before: SourcePaths.hash($0.1), after: SourcePaths.hash($0.0.content)) })
        try journal.begin(entry, preimages: pending.map(\.1))
        for (index, (write, _)) in pending.enumerated() {
            do {
                fault?("\(kind).write.\(index)")
                try SourcePaths.write(write.content, to: write.target.real)
            } catch {
                let report = journal.rollback(entry)
                // A file changed under the rollback keeps its pre-image beside the report.
                if report.kept.isEmpty { journal.finish(operationID) }
                throw RepositoryRefusal(.ioFailure, "Could not write \(write.target.rel); the files already written were put back.")
            }
        }
        fault?("\(kind).written")
        journal.finish(operationID)
        return .applied(writes.map(\.target), previous: Dictionary(pending.map { ($0.0.target.real, $0.1) }, uniquingKeysWith: { a, _ in a }))
    }

    // MARK: Undo

    struct UndoResult { var ok = false, empty = false, conflict = false; var file: String? }

    /// Undo (`undo: true`) or redo the top batch of `root`'s history.
    func step(root: String, undo: Bool, operationID: String) throws -> UndoResult {
        let batch = history.top(root: root, undo: undo)
        guard let top = batch.first else { return UndoResult(empty: true) }
        let result = try restore(root: root, batch, toBefore: undo, kind: undo ? "undo" : "redo", operationID: operationID)
        if result.ok { history.moved(root: root, undo: undo, count: batch.count) }
        return result.ok ? UndoResult(ok: true, file: top.display) : result
    }

    /// Reverts one recorded group anywhere in the undo stack.
    func revert(root: String, group: String, operationID: String) throws -> UndoResult {
        let batch = history.group(root: root, group)
        guard let last = batch.last else { return UndoResult(empty: true) }
        // Newest first, so a file the group wrote twice ends at its oldest before.
        let result = try restore(root: root, batch.reversed(), toBefore: true, kind: "revert", operationID: operationID)
        if result.ok { history.reverted(root: root, group) }
        return result.ok ? UndoResult(ok: true, file: last.display) : result
    }

    func revertable(root: String, group: String) -> Bool {
        let batch = history.group(root: root, group)
        return !batch.isEmpty && batch.allSatisfy { entry in (try? SourcePaths.read(entry.file)).flatMap { $0 } == entry.after }
    }

    private func restore(root: String, _ batch: [SourceHistory.Entry], toBefore: Bool, kind: String, operationID: String) throws -> UndoResult {
        // One write per file: the batch's first entry for a file holds its expected bytes,
        // its last entry the bytes to put back.
        var writes: [Write] = []
        var index: [String: Int] = [:]
        for entry in batch {
            let target = SourcePaths.Target(rel: entry.display, lexical: entry.file, real: entry.file, exists: true)
            let content = toBefore ? entry.before : entry.after
            if let at = index[entry.file] {
                writes[at] = Write(target: target, display: writes[at].display, expected: writes[at].expected, content: content)
            } else {
                index[entry.file] = writes.count
                writes.append(Write(target: target, display: entry.display, expected: SourcePaths.hash(toBefore ? entry.after : entry.before), content: content))
            }
        }
        do {
            switch try transact(kind: kind, operationID: operationID, root: root, writes) {
            case .applied: return UndoResult(ok: true)
            case .conflict(let file): return UndoResult(conflict: true, file: file)
            }
        } catch let refusal as RepositoryRefusal where refusal.code == .ioFailure {
            // Like the legacy history: a failed write is a conflict, and nothing moved.
            return UndoResult(conflict: true, file: batch.first?.display)
        }
    }

    // MARK: File operations (outside the history, as before)

    struct FileResult { var ok: Bool; var path: String?; var error: String? }
    static let badPath = FileResult(ok: false, error: "That path is not allowed.")

    func create(_ t: SourcePaths.Target) -> FileResult {
        guard !exists(t.lexical) else { return FileResult(ok: false, error: "Something already exists at that path.") }
        do {
            try FileManager.default.createDirectory(atPath: (t.lexical as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
            // O_EXCL: fail rather than truncate if the path appeared since the check.
            let fd = open(t.lexical, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o644)
            guard fd >= 0 else { throw POSIXError(.EEXIST) }
            close(fd)
        } catch { return FileResult(ok: false, error: "Could not create that file.") }
        return FileResult(ok: true, path: t.rel)
    }

    func rename(_ from: SourcePaths.Target, _ to: SourcePaths.Target) -> FileResult {
        if from.rel == to.rel { return FileResult(ok: true, path: to.rel) }
        guard exists(from.lexical) else { return FileResult(ok: false, error: "That file no longer exists.") }
        guard SourcePaths.isRegularFile(from.lexical) else { return FileResult(ok: false, error: "Only files can be renamed.") }
        // A case-only rename "exists" on a case-insensitive volume; refusing it would make case fixes impossible.
        let caseOnly = from.rel.lowercased() == to.rel.lowercased()
        if !caseOnly, exists(to.lexical) { return FileResult(ok: false, error: "Something already exists at that path.") }
        do {
            try FileManager.default.createDirectory(atPath: (to.lexical as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
            guard Darwin.rename(from.lexical, to.lexical) == 0 else { throw POSIXError(.EIO) }
        } catch { return FileResult(ok: false, error: "Could not rename that file.") }
        return FileResult(ok: true, path: to.rel)
    }

    /// To the Trash when possible (the only undo a deletion has); removed outright otherwise.
    func delete(_ t: SourcePaths.Target) -> FileResult {
        guard exists(t.lexical) else { return FileResult(ok: false, error: "That file no longer exists.") }
        guard SourcePaths.isRegularFile(t.lexical) else { return FileResult(ok: false, error: "Only files can be deleted.") }
        if (try? FileManager.default.trashItem(at: URL(fileURLWithPath: t.lexical), resultingItemURL: nil)) != nil {
            return FileResult(ok: true, path: t.rel)
        }
        guard unlink(t.lexical) == 0 else { return FileResult(ok: false, error: "Could not delete that file.") }
        return FileResult(ok: true, path: t.rel)
    }

    private func exists(_ path: String) -> Bool { var info = stat(); return lstat(path, &info) == 0 }
}
