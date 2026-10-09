import Foundation
import Darwin

/// One repository operation's durable intent. Written (and synced) before the first
/// effect and removed when the operation settles. An entry still `active` when a new
/// service opens the journal was interrupted: it moves to `interrupted` with its
/// recovery refs, and nothing is replayed, reset or deleted on its behalf. It is
/// reported once, at the launch that finds it, and `resolved` from then on.
struct RepositoryEntry: Equatable {
    var operationID: String
    var kind: String
    var intent: String
    var lane: String
    var root: String
    var worktree: String?
    var branch: String?
    var refs: [String]
    var started: String
    /// When a launch closed (reported) the interrupted entry; nil while still open.
    var resolved: String?

    func value() -> JSValue {
        var fields: [(JSText, JSValue)] = [("operationID", operationID), ("kind", kind), ("intent", intent), ("lane", lane), ("root", root)]
            .map { (JSText($0.0), .string(JSText($0.1))) }
        if let worktree { fields.append((JSText("worktree"), .string(JSText(worktree)))) }
        if let branch { fields.append((JSText("branch"), .string(JSText(branch)))) }
        fields.append((JSText("refs"), .array(refs.map { .string(JSText($0)) })))
        fields.append((JSText("started"), .string(JSText(started))))
        if let resolved { fields.append((JSText("resolved"), .string(JSText(resolved)))) }
        return .object(fields)
    }

    init(operationID: String, kind: String, intent: String, lane: String, root: String, worktree: String?, branch: String?,
         refs: [String] = [], started: String, resolved: String? = nil) {
        self.operationID = operationID; self.kind = kind; self.intent = intent; self.lane = lane; self.root = root
        self.worktree = worktree; self.branch = branch; self.refs = refs; self.started = started; self.resolved = resolved
    }

    init?(_ value: JSValue) {
        guard let operationID = value["operationID"]?.text?.string, let kind = value["kind"]?.text?.string,
              let intent = value["intent"]?.text?.string, let lane = value["lane"]?.text?.string,
              let root = value["root"]?.text?.string, let started = value["started"]?.text?.string else { return nil }
        var refs: [String] = []
        if case .array(let items)? = value["refs"] { refs = items.compactMap { $0.text?.string } }
        self.init(operationID: operationID, kind: kind, intent: intent, lane: lane, root: root,
                  worktree: value["worktree"]?.text?.string, branch: value["branch"]?.text?.string, refs: refs, started: started,
                  resolved: value["resolved"]?.text?.string)
    }
}

enum RepositoryJournalError: Error, CustomStringConvertible {
    case damaged(String), write(String)
    var description: String {
        switch self {
        case .damaged(let path): return "The repository journal at \(path) is damaged; it was left untouched."
        case .write(let step): return "The repository journal could not be written (\(step))."
        }
    }
}

/// `<profile>/service/repository/journal.json`, service-private: Bun
/// never reads or writes it, and recovery refs stay until the user resolves them.
final class RepositoryJournal: @unchecked Sendable {
    static let maxInterrupted = 200
    /// 2 (LKM-134): interrupted entries carry `resolved` once reported. A version 1
    /// journal reported every interrupted entry again at each launch.
    static let version = 2
    let path: String
    private let lock = NSLock()
    private(set) var active: [RepositoryEntry] = []
    private(set) var interrupted: [RepositoryEntry] = []
    /// This launch's report: the entries `open` closed, each reported here once.
    private(set) var recovered: [RepositoryEntry] = []
    /// Open entries of a version 1 journal, closed without a new report: every earlier
    /// launch already reported them.
    private(set) var closedEarlier = 0
    /// Test hook: called after each durable write with the entry's kind and phase.
    var afterWrite: (@Sendable (String, String) -> Void)?

    init(profile: String) {
        path = URL(fileURLWithPath: profile).appendingPathComponent("service/repository/journal.json").path
    }

    /// Reads the previous owner's journal. Its active entries were interrupted. Every
    /// open interrupted entry is resolved here, durably, before anything reports it,
    /// so it is reported at most once however often Trezi restarts. A damaged file is
    /// refused (left as found) and no mutation is accepted.
    func open() throws {
        lock.lock(); defer { lock.unlock() }
        guard FileManager.default.fileExists(atPath: path) else { return }
        guard let data = FileManager.default.contents(atPath: path), let value = try? JSValue.parse(data, maxDepth: 16),
              case .array(let activeItems)? = value["active"], case .array(let interruptedItems)? = value["interrupted"] else {
            throw RepositoryJournalError.damaged(path)
        }
        let legacy: Bool
        if case .number(let version)? = value["version"] { legacy = version < Double(Self.version) } else { legacy = true }
        let now = ISO8601DateFormatter().string(from: Date())
        var report: [RepositoryEntry] = [], closed = 0
        let earlier = interruptedItems.compactMap(RepositoryEntry.init).map { entry -> RepositoryEntry in
            guard entry.resolved == nil else { return entry }
            var entry = entry
            entry.resolved = now
            // Interrupted mid-session under this version: not reported yet.
            if legacy { closed += 1 } else { report.append(entry) }
            return entry
        }
        let previous = activeItems.compactMap(RepositoryEntry.init).map { entry -> RepositoryEntry in
            var entry = entry
            entry.resolved = now
            return entry
        }
        interrupted = earlier + previous
        if interrupted.count > Self.maxInterrupted { interrupted.removeFirst(interrupted.count - Self.maxInterrupted) }
        active = []
        if legacy || closed > 0 || !report.isEmpty || !previous.isEmpty { try persist() }
        recovered = report + previous
        closedEarlier = closed
    }

    func begin(_ entry: RepositoryEntry) throws {
        lock.lock(); defer { lock.unlock() }
        active.append(entry)
        do { try persist() } catch { active.removeAll { $0.operationID == entry.operationID }; throw error }
        afterWrite?(entry.kind, "intent")
    }

    /// Records a recovery ref BEFORE the effect it guards.
    func addRef(_ operationID: String, _ ref: String) throws {
        lock.lock(); defer { lock.unlock() }
        guard let index = active.firstIndex(where: { $0.operationID == operationID }) else { return }
        active[index].refs.append(ref)
        try persist()
        afterWrite?(active[index].kind, "ref")
    }

    func finish(_ operationID: String) {
        lock.lock(); defer { lock.unlock() }
        guard let index = active.firstIndex(where: { $0.operationID == operationID }) else { return }
        let kind = active[index].kind
        active.remove(at: index)
        // Best effort: an entry that stays on disk is reported as interrupted, never replayed.
        try? persist()
        afterWrite?(kind, "done")
    }

    /// An effect failed after preserving work: report it (and its refs) as interrupted.
    func interrupt(_ operationID: String) {
        lock.lock(); defer { lock.unlock() }
        guard let index = active.firstIndex(where: { $0.operationID == operationID }) else { return }
        interrupted.append(active.remove(at: index))
        if interrupted.count > Self.maxInterrupted { interrupted.removeFirst(interrupted.count - Self.maxInterrupted) }
        try? persist()
    }

    /// Explicit intent only: forgets an interrupted entry. Its refs stay in the repository.
    func acknowledge(_ operationID: String) throws -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let index = interrupted.firstIndex(where: { $0.operationID == operationID }) else { return false }
        let removed = interrupted.remove(at: index)
        do { try persist() } catch { interrupted.insert(removed, at: index); throw error }
        return true
    }

    func snapshot() -> (active: [RepositoryEntry], interrupted: [RepositoryEntry]) {
        lock.lock(); defer { lock.unlock() }
        return (active, interrupted)
    }

    private func persist() throws {
        let body = JSValue.object([(JSText("version"), .number(Double(Self.version))),
                                   (JSText("active"), .array(active.map { $0.value() })),
                                   (JSText("interrupted"), .array(interrupted.map { $0.value() }))])
        let data = body.utf8()
        let directory = (path as NSString).deletingLastPathComponent
        do { try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
        catch { throw RepositoryJournalError.write("directory") }
        let temporary = path + ".tmp"
        let fd = Darwin.open(temporary, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw RepositoryJournalError.write("open") }
        var offset = 0
        let complete: Bool = data.withUnsafeBytes { buffer in
            while offset < buffer.count {
                let written = write(fd, buffer.baseAddress! + offset, buffer.count - offset)
                if written < 0 && errno == EINTR { continue }
                if written <= 0 { return false }
                offset += written
            }
            return fsync(fd) == 0
        }
        close(fd)
        guard complete, rename(temporary, path) == 0 else { unlink(temporary); throw RepositoryJournalError.write("replace") }
        let directoryFD = Darwin.open(directory, O_RDONLY | O_CLOEXEC)
        if directoryFD >= 0 { _ = fsync(directoryFD); close(directoryFD) }
    }
}

/// Recovery refs: `refs/trezi/recovery/<UTC time>-<kind>-<operation>[-<label>]`, in the
/// repository's common directory (shared by every worktree), created before an
/// effect that could otherwise make work unreachable. They are never deleted on
/// rollback, and never pruned automatically: they are the only handle on work an
/// operation moved out of its checkout, so only the user deletes them.
enum RecoveryRefs {
    static let namespace = "refs/trezi/recovery/"

    static func name(kind: String, operationID: String, label: String? = nil) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let short = String(operationID.lowercased().filter { $0.isHexDigit }.prefix(12))
        // Unique per ref: several refs with one kind and label in one operation (each
        // orphan of a recovery sweep) must never overwrite one another.
        let unique = String(UUID().uuidString.lowercased().filter { $0.isHexDigit }.prefix(6))
        return namespace + "\(formatter.string(from: Date()))-\(kind)-\(short)-\(unique)" + (label.map { "-\($0)" } ?? "")
    }

    static func list(_ git: RepositoryGit, _ root: String) -> [String] {
        ((try? git.text(root, ["for-each-ref", "--format=%(refname)", namespace])) ?? "")
            .split(separator: "\n").map(String.init).filter { !$0.isEmpty }.sorted()
    }

    /// Every recovery ref of `root`'s repository with what it points at, for the user
    /// to inspect (nil: not a readable repository).
    static func describe(_ git: RepositoryGit, _ root: String) -> [JSValue]? {
        guard let text = try? git.text(root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(creatordate:iso-strict)%00%(subject)", namespace])
        else { return nil }
        return text.split(separator: "\n").compactMap { line -> JSValue? in
            let parts = line.split(separator: "\0", omittingEmptySubsequences: false).map(String.init)
            guard parts.count >= 4 else { return nil }
            return .object([("ref", parts[0]), ("sha", parts[1]), ("date", parts[2]), ("subject", parts[3...].joined(separator: " "))]
                .map { (JSText($0.0), .string(JSText($0.1))) })
        }
    }

    /// A name this owner could have made, and nothing else (never another namespace).
    static func valid(_ git: RepositoryGit, _ root: String, _ ref: String) -> Bool {
        ref.hasPrefix(namespace) && ref.count > namespace.count && !ref.contains("..") && !ref.hasPrefix("-")
            && git.succeeds(root, ["check-ref-format", ref])
    }

    /// Explicit user intent only: deletes each ref that still points at the commit the
    /// user saw. A ref that moved or is gone is left alone and reported.
    static func delete(_ git: RepositoryGit, _ root: String, refs: [String], shas: [String]) throws -> (deleted: [String], kept: [String]) {
        guard refs.count == shas.count, refs.count <= 10_000,
              shas.allSatisfy({ $0.range(of: #"^([0-9a-f]{40}|[0-9a-f]{64})$"#, options: .regularExpression) != nil }),
              refs.allSatisfy({ valid(git, root, $0) }) else { throw ServiceContractFailure.invalidRequest }
        var deleted: [String] = [], kept: [String] = []
        for (ref, sha) in zip(refs, shas) {
            if git.succeeds(root, ["update-ref", "-d", ref, sha]) { deleted.append(ref) } else { kept.append(ref) }
        }
        return (deleted, kept)
    }
}

/// FIFO serialization per repository common directory: the live checkout and every
/// linked worktree of it share one lane, because they share refs, the object store,
/// `.git/worktrees` admin state and (for the live checkout) one index and HEAD.
/// Unrelated repositories run concurrently. A lease holds a lane across several of
/// Bun's own steps (the legacy `enqueueRepoWrite` critical sections).
final class RepositoryLanes: @unchecked Sendable {
    private let lock = NSLock()
    private var busy = Set<String>()
    private var waiting: [String: [() -> Void]] = [:]

    /// `start` runs when the lane is granted (asynchronously if it had to wait).
    func enter(_ key: String, _ start: @escaping () -> Void) {
        lock.lock()
        if busy.contains(key) { waiting[key, default: []].append(start); lock.unlock(); return }
        busy.insert(key)
        lock.unlock()
        start()
    }

    func leave(_ key: String) {
        lock.lock()
        if var queue = waiting[key], !queue.isEmpty {
            let next = queue.removeFirst()
            waiting[key] = queue.isEmpty ? nil : queue
            lock.unlock()
            next()
            return
        }
        busy.remove(key)
        lock.unlock()
    }

    var idle: Bool { lock.lock(); defer { lock.unlock() }; return busy.isEmpty }
}
