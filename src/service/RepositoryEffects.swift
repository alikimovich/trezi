import Foundation
import Darwin

/// A refusal with a code and the message Bun shows (or rethrows unchanged).
struct RepositoryRefusal: Error, CustomStringConvertible {
    let code: ServiceContractFailure
    let message: String
    init(_ code: ServiceContractFailure, _ message: String) { self.code = code; self.message = message }
    var description: String { message }
}

/// `{id, repoRoot, path, branch, baseSha}`, as `Worktree` in `src/main/worktrees.ts`.
struct RepositoryWorktree {
    var id: String, repoRoot: String, path: String, branch: String, baseSha: String
    func value() -> JSValue {
        .object([("id", id), ("repoRoot", repoRoot), ("path", path), ("branch", branch), ("baseSha", baseSha)]
            .map { (JSText($0.0), .string(JSText($0.1))) })
    }
}

/// One accepted operation: its identity, lane, journal entry and scratch files.
final class RepositoryContext {
    let operationID: String, kind: String, lane: String, root: String
    let effects: RepositoryEffects
    init(operationID: String, kind: String, lane: String, root: String, effects: RepositoryEffects) {
        self.operationID = operationID; self.kind = kind; self.lane = lane; self.root = root; self.effects = effects
    }
    var git: RepositoryGit { effects.git }

    /// Names the ref in the journal first, then creates it: a crash in between leaves
    /// a journal line naming a ref that does not exist, never an unrecorded ref.
    @discardableResult
    func preserve(_ commit: String, label: String) throws -> String {
        let name = RecoveryRefs.name(kind: kind, operationID: operationID, label: label)
        try effects.journal.addRef(operationID, name)
        try git.data(root, ["update-ref", name, commit])
        return name
    }

    /// Only for a ref whose guarded effect completed and left the work reachable.
    func release(_ ref: String) { _ = git.succeeds(root, ["update-ref", "-d", ref]) }

    func index() -> String { effects.scratch + "/index-\(UUID().uuidString)" }
    func point(_ name: String) { effects.fault?(name) }
}

/// The Git effects (S07): the Swift twins of the mutating functions in
/// `worktrees.ts`, `chat-worktrees.ts`, `live-commit.ts` and `git.ts`. Every call runs
/// inside its repository's lane. Nothing here resets, removes or deletes work that is
/// not already reachable elsewhere without first pointing a recovery ref at it.
final class RepositoryEffects: @unchecked Sendable {
    static let maxEditBytes = 16 * 1024 * 1024
    let git: RepositoryGit
    let journal: RepositoryJournal
    let scratch: String
    /// Resolved profile: every worktree this owner touches lives under it.
    let worktreesRoot: String
    /// Earlier profiles' worktree folders (`legacyWorktreeRoots`): orphan recovery only.
    let legacyRoots: [String]
    let fault: (@Sendable (String) -> Void)?
    /// The service log: full Git output that the user-facing messages only summarize.
    let log: @Sendable (String) -> Void

    init(git: RepositoryGit, journal: RepositoryJournal, scratch: String, worktreesRoot: String, legacyRoots: [String] = [],
         fault: (@Sendable (String) -> Void)?, log: @escaping @Sendable (String) -> Void = { fputs($0 + "\n", stderr) }) {
        self.git = git; self.journal = journal; self.scratch = scratch; self.worktreesRoot = worktreesRoot; self.legacyRoots = legacyRoots
        self.fault = fault; self.log = log
    }

    // MARK: Validation

    /// The lane key: the resolved common directory, or the resolved folder outside Git.
    func lane(_ root: String) -> String {
        if let common = try? git.line(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), !common.isEmpty,
           let resolved = RepositoryPaths.realpath(common) { return "git:" + resolved }
        return "path:" + (RepositoryPaths.realpath(root) ?? root)
    }

    /// A linked worktree of this lane's repository under the profile. Never the
    /// user's main checkout, and never a folder chosen by path alone.
    func linked(_ c: RepositoryContext, _ wt: RepositoryWorktree) throws {
        guard let real = RepositoryPaths.realpath(wt.path), RepositoryPaths.contains(worktreesRoot, real) else {
            throw RepositoryRefusal(.unauthorized, "Not a Trezi worktree: \(wt.path)")
        }
        let dirs = (try? git.text(wt.path, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]))?
            .split(separator: "\n").map { RepositoryPaths.realpath(String($0)) ?? String($0) } ?? []
        guard dirs.count == 2, dirs[0] != dirs[1], "git:" + dirs[1] == c.lane else {
            throw RepositoryRefusal(.unauthorized, "Not a linked worktree of this repository: \(wt.path)")
        }
    }

    /// A directory at or below the profile (it may not exist yet), or with `legacy`, also
    /// at or below an earlier profile's worktree folder.
    func inside(_ path: String, legacy: Bool = false) -> Bool {
        guard path.hasPrefix("/"), !path.split(separator: "/").contains("..") else { return false }
        var probe = path
        while !FileManager.default.fileExists(atPath: probe) { probe = (probe as NSString).deletingLastPathComponent }
        guard let real = RepositoryPaths.realpath(probe) else { return false }
        if RepositoryPaths.contains(worktreesRoot, real) { return true }
        return legacy && legacyRoots.compactMap(RepositoryPaths.realpath).contains { RepositoryPaths.contains($0, real) }
    }

    static func relative(_ rel: String) -> Bool {
        !rel.isEmpty && !rel.hasPrefix("/") && !rel.contains("\0") && !rel.split(separator: "/").contains("..")
    }

    func head(_ directory: String) throws -> String { try git.line(directory, ["rev-parse", "HEAD"]) }
    func isAncestor(_ root: String, _ a: String, _ b: String) -> Bool { git.succeeds(root, ["merge-base", "--is-ancestor", a, b]) }
    func currentBranch(_ root: String) -> String? {
        guard let name = try? git.line(root, ["rev-parse", "--abbrev-ref", "HEAD"]), !name.isEmpty, name != "HEAD" else { return nil }
        return name
    }

    // MARK: Worktree lifecycle

    func createWorktree(_ c: RepositoryContext, directory: String, id: String, branch: String, linkNodeModules: Bool) throws -> RepositoryWorktree {
        guard inside(directory) else { throw RepositoryRefusal(.unauthorized, "Worktrees must live in the Trezi profile.") }
        let path = directory + "/" + id
        guard !FileManager.default.fileExists(atPath: path) else { throw RepositoryRefusal(.conflict, "A worktree already exists at \(path).") }
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let base = try RepositoryPaths.snapshot(git, c.root, index: c.index(), message: "trezi: spawn base (WIP snapshot)")
        try git.data(c.root, ["worktree", "add", "-b", branch, path, base])
        c.point("create.added")
        // Never an unignored symlink: it would become part of the next patch.
        for name in RepositoryPaths.runtimeDeps where name != "node_modules" || linkNodeModules {
            if git.succeeds(c.root, ["check-ignore", "-q", "--", name]) { _ = symlink(c.root + "/" + name, path + "/" + name) }
        }
        return RepositoryWorktree(id: id, repoRoot: c.root, path: path, branch: branch, baseSha: base)
    }

    /// Before anything that moves this checkout: dirty work and a HEAD that never
    /// landed (HEAD differs from the recorded fork point) get a recovery ref.
    func preserveUnlanded(_ c: RepositoryContext, _ wt: RepositoryWorktree, label: String) throws {
        if !(try RepositoryPaths.meaningfulChanges(git, wt.path)).isEmpty {
            let snapshot = try RepositoryPaths.snapshot(git, wt.path, index: c.index(), message: "Trezi recovery: \(c.kind) \(wt.branch)")
            try c.preserve(snapshot, label: label)
        } else if let head = try? head(wt.path), head != wt.baseSha {
            try c.preserve(head, label: label)
        }
    }

    func syncWorktree(_ c: RepositoryContext, _ wt: RepositoryWorktree) throws -> (synced: Bool, baseSha: String) {
        try linked(c, wt)
        let live = try RepositoryPaths.snapshot(git, c.root, index: c.index(), message: "trezi: spawn base (WIP snapshot)")
        let liveTree = try git.line(c.root, ["rev-parse", "\(live)^{tree}"])
        let worktreeTree = try git.line(wt.path, ["rev-parse", "HEAD^{tree}"])
        if liveTree == worktreeTree {
            try attach(c, wt)
            return (false, wt.baseSha)
        }
        try preserveUnlanded(c, wt, label: "worktree")
        try git.data(wt.path, RepositoryPaths.cleanArguments)
        try git.data(wt.path, ["reset", "--hard", live])
        var moved = wt
        moved.baseSha = live
        try attach(c, moved)
        return (true, live)
    }

    func attach(_ c: RepositoryContext, _ wt: RepositoryWorktree) throws {
        if (try? git.line(wt.path, ["branch", "--show-current"])) == wt.branch { return }
        let head = try head(wt.path)
        // `checkout -B` moves an existing branch: keep a tip it would orphan.
        if let tip = git.revision(c.root, "refs/heads/\(wt.branch)"), tip != head, !isAncestor(c.root, tip, head) {
            try c.preserve(tip, label: "branch")
        }
        try git.data(wt.path, ["checkout", "-B", wt.branch, "HEAD"])
    }

    func retire(_ c: RepositoryContext, _ wt: RepositoryWorktree) throws {
        if (try? git.line(wt.path, ["branch", "--show-current"])) == wt.branch {
            try git.data(wt.path, ["checkout", "--detach", "HEAD"])
        }
        try deleteBranch(c, wt.branch, keep: try? head(wt.path), preserveAlways: false)
    }

    /// Deletes a work branch. Its tip gets a recovery ref first unless it is `keep`
    /// (still checked out, detached, in the worktree) or contained in it.
    @discardableResult
    func deleteBranch(_ c: RepositoryContext, _ branch: String, keep: String?, preserveAlways: Bool) throws -> Bool {
        guard let tip = git.revision(c.root, "refs/heads/\(branch)") else { return false }
        if preserveAlways || keep.map({ tip != $0 && !isAncestor(c.root, tip, $0) }) ?? true {
            try c.preserve(tip, label: "branch")
        }
        return git.succeeds(c.root, ["branch", "-D", "--", branch])
    }

    /// Removes a worktree checkout. Dirty work always gets a recovery ref; so does
    /// an unlanded HEAD, unless the caller declared it landed. A folder that is not
    /// a worktree any more is moved aside, never deleted.
    func removeWorktree(_ c: RepositoryContext, _ wt: RepositoryWorktree, keepBranch: Bool, intent: String) throws {
        guard inside(wt.path) else { throw RepositoryRefusal(.unauthorized, "Not a Trezi worktree: \(wt.path)") }
        var head: String?
        if FileManager.default.fileExists(atPath: wt.path) {
            if (try? linked(c, wt)) != nil {
                head = try? self.head(wt.path)
                if !(try RepositoryPaths.meaningfulChanges(git, wt.path)).isEmpty {
                    let snapshot = try RepositoryPaths.snapshot(git, wt.path, index: c.index(), message: "Trezi recovery: remove \(wt.branch)")
                    try c.preserve(snapshot, label: "worktree")
                } else if !keepBranch, intent != "landed", let head, head != wt.baseSha {
                    try c.preserve(head, label: "worktree")
                }
                c.point("remove.preserved")
                if !git.succeeds(c.root, ["worktree", "remove", "--force", wt.path]) { moveAside(wt.path) }
            } else { moveAside(wt.path) }
        }
        _ = git.succeeds(c.root, ["worktree", "prune"])
        if !keepBranch, RepositoryPaths.isWorkBranch(wt.branch) {
            try deleteBranch(c, wt.branch, keep: intent == "landed" ? (head ?? git.revision(c.root, "refs/heads/\(wt.branch)")) : head,
                             preserveAlways: false)
        }
    }

    /// `<dir>/.recovered-<name>-<time>`: kept for the user, skipped by orphan recovery.
    func moveAside(_ path: String) {
        let parent = (path as NSString).deletingLastPathComponent, name = (path as NSString).lastPathComponent
        _ = rename(path, parent + "/.recovered-\(name)-\(Int(Date().timeIntervalSince1970))")
    }

    // MARK: Turns

    func commitWorktree(_ c: RepositoryContext, _ wt: RepositoryWorktree, message: String, keepHistory: Bool = false) throws -> (committed: Bool, files: [String]) {
        try linked(c, wt)
        let preserveHistory = keepHistory || ((try? git.line(wt.path, ["rev-list", "--count", "--merges", "\(wt.baseSha)..HEAD"])) ?? "0") != "0"
        if preserveHistory {
            // A resolved base merge must retain its two parents. Never squash this
            // history; later edits become ordinary child commits on the same branch.
            try git.data(wt.path, ["add", "-A"])
            try RepositoryPaths.unstageExcluded(git, wt.path)
            let staged = try git.paths(wt.path, ["diff", "--cached", "--name-only", "-z"])
            if !staged.isEmpty {
                try git.data(wt.path, ["-c", "user.name=Trezi", "-c", "user.email=trezi@local", "commit", "--no-verify", "-m", message])
            }
            let files = try git.paths(wt.path, ["diff", "--name-only", "--no-renames", "-z", "\(wt.baseSha)..HEAD"])
            return (try head(wt.path) != wt.baseSha, files)
        }
        // Collapse everything since the fork point (including the agent's own commits)
        // into one commit. The soft reset keeps index and files; the ref keeps the
        // agent's commits reachable until the new commit exists.
        var guardRef: String?
        if let head = try? head(wt.path), head != wt.baseSha, !isAncestor(wt.path, head, wt.baseSha) {
            guardRef = try c.preserve(head, label: "commits")
        }
        _ = git.succeeds(wt.path, ["reset", "--soft", wt.baseSha])
        try git.data(wt.path, ["add", "-A"])
        try RepositoryPaths.unstageExcluded(git, wt.path)
        // Both names of a rename (LKM-130): the old one is a deletion the landing must see.
        let staged = try git.paths(wt.path, ["diff", "--cached", "--name-only", "--no-renames", "-z"])
        if staged.isEmpty { if let guardRef { c.release(guardRef) }; return (false, []) }
        try git.data(wt.path, ["-c", "user.name=Trezi", "-c", "user.email=trezi@local", "commit", "--no-verify", "-m",
                               message.isEmpty ? "Trezi comment edit" : message])
        if let guardRef { c.release(guardRef) }
        return (true, staged)
    }

    struct Edit { let file: String; let before: Data; let after: Data; let existed: Bool }

    /// Writes a finished change's files onto the live checkout, only where safe: the
    /// live file still equals the fork point or already equals the target. Any drift,
    /// binary, deleted or oversized change refuses the whole batch before anything is
    /// written. A write failure restores the files already written.
    func autoApply(_ c: RepositoryContext, _ wt: RepositoryWorktree, files: [String]) throws -> (applied: Bool, edits: [Edit]) {
        try linked(c, wt)
        let refused: (Bool, [Edit]) = (false, [])
        guard let liveReal = RepositoryPaths.realpath(c.root) else { return refused }
        var edits: [Edit] = [], bytes = 0
        for rel in files {
            guard Self.relative(rel), let after = FileManager.default.contents(atPath: wt.path + "/" + rel), !after.contains(0) else { return refused }
            let base = (try? git.data(c.root, ["show", "\(wt.baseSha):\(rel)"])) ?? Data()
            let target = c.root + "/" + rel
            var info = stat()
            let existed = lstat(target, &info) == 0
            if existed && info.st_mode & S_IFMT != S_IFREG { return refused } // never write through a symlink
            var parent = (target as NSString).deletingLastPathComponent
            while !FileManager.default.fileExists(atPath: parent) { parent = (parent as NSString).deletingLastPathComponent }
            guard let resolved = RepositoryPaths.realpath(parent), RepositoryPaths.contains(liveReal, resolved) else { return refused }
            let before = existed ? (FileManager.default.contents(atPath: target) ?? Data()) : Data()
            if before != base && before != after { return refused }
            bytes += before.count + after.count
            guard bytes <= Self.maxEditBytes else { return refused }
            edits.append(Edit(file: target, before: before, after: after, existed: existed))
        }
        let changes = edits.filter { $0.before != $0.after }
        guard !changes.isEmpty else { return (false, edits) }
        // An interrupted landing is recoverable: the target commit stays reachable.
        let target = try c.preserve(try head(wt.path), label: "target")
        var written: [Edit] = []
        for edit in changes {
            if Self.write(edit.after, to: edit.file) {
                written.append(edit)
                c.point("land.write")
                continue
            }
            for done in written.reversed() where FileManager.default.contents(atPath: done.file) == done.after {
                if done.existed { _ = Self.write(done.before, to: done.file) } else { unlink(done.file) }
            }
            return refused
        }
        c.release(target)
        return (true, edits)
    }

    /// In place (the file keeps its inode and mode), never following a symlink.
    static func write(_ data: Data, to path: String) -> Bool {
        try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        let fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC | O_NOFOLLOW, 0o644)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var offset = 0
        return data.withUnsafeBytes { buffer in
            while offset < buffer.count {
                let count = Darwin.write(fd, buffer.baseAddress! + offset, buffer.count - offset)
                if count < 0 && errno == EINTR { continue }
                if count <= 0 { return false }
                offset += count
            }
            return true
        }
    }

    enum TurnOutcome { case noop, merged, parked }

    func completeTurn(_ c: RepositoryContext, _ wt: RepositoryWorktree, message: String, land: Bool, keepHistory: Bool = false)
        throws -> (outcome: TurnOutcome, files: [String], edits: [Edit], newBase: String?) {
        try linked(c, wt)
        if git.revision(wt.path, "MERGE_HEAD") != nil {
            let files = try git.paths(wt.path, ["diff", "--name-only", "--diff-filter=U", "-z"])
            return (.parked, files, [], nil)
        }
        let (committed, files) = try commitWorktree(c, wt, message: message, keepHistory: keepHistory)
        if !committed { return (.noop, [], [], try head(wt.path)) }
        // Failed/interrupted turns stay on their branch; they never land automatically.
        if !land { return (.parked, files, [], nil) }
        if !conflictMarkerFiles(wt, files).isEmpty { return (.parked, files, [], nil) }
        let preserveHistory = keepHistory || ((try? git.line(wt.path, ["rev-list", "--count", "--merges", "\(wt.baseSha)..HEAD"])) ?? "0") != "0"
        if preserveHistory && files.isEmpty { return (.merged, [], [], try head(wt.path)) }
        let (applied, edits) = try autoApply(c, wt, files: files)
        if applied { return (.merged, files, edits, try head(wt.path)) }
        if preserveHistory && edits.isEmpty && files.allSatisfy({ rel in
            FileManager.default.contents(atPath: wt.path + "/" + rel) == FileManager.default.contents(atPath: c.root + "/" + rel)
        }) { return (.merged, files, [], try head(wt.path)) }
        if edits.isEmpty { return (.parked, files, [], nil) }
        return (.noop, files, [], try head(wt.path))
    }

    func conflictMarkerFiles(_ wt: RepositoryWorktree, _ files: [String]) -> [String] {
        files.filter { rel in FileManager.default.contents(atPath: wt.path + "/" + rel).map(RepositoryPaths.hasConflictMarkers) ?? false }
    }
}
