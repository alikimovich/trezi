import Foundation
import Darwin

/// Explicit landings and reconciliation, discards, live commits, branch switching
/// and startup recovery (S07), ported from the retired TS `applyToWorkingTree`,
/// `applyParked`, `stageResolve`, `discardParked`, `commitLiveTurn`,
/// `checkoutBranch`/`switchBranch`, `pruneOrphans` and `pruneIntegratedChatBranches`.
extension RepositoryEffects {
    /// `conflicted`: files the merge fallback left with markers or, for a binary file
    /// changed on both sides, kept as they were. `problems`: Git's parsed reasons for
    /// a patch it refused (`error` is their user-facing text).
    struct Applied {
        var ok: Bool; var conflict: Bool; var error: String?; var empty = false; var conflicted: [String] = []
        var problems: [GitMessages.ApplyProblem] = []
    }

    /// Plain `git apply` (tolerates dirty work, atomic), else a three-way apply
    /// through a PRIVATE index seeded from a snapshot of the checkout, so the user's
    /// real index is never read or written. `beforeThreeWay` receives that snapshot
    /// before the three-way apply can write conflict markers. When Git refuses the
    /// patch as a whole (add/add, modify/delete, a renamed file's source gone) and the
    /// commits it came from are known (`merge`), a per-file three-way merge lays the
    /// change instead (`mergeChange`). Only a patch Git cannot read stays an error.
    func applyToWorkingTree(_ c: RepositoryContext, _ directory: String, patch: Data, merge: (base: String, tip: String)? = nil,
                            binary: BinaryPolicy = .live, beforeThreeWay: (String) throws -> Void = { _ in }) throws -> Applied {
        if String(decoding: patch, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return Applied(ok: true, conflict: false)
        }
        try FileManager.default.createDirectory(atPath: scratch, withIntermediateDirectories: true)
        let patchFile = scratch + "/apply-\(UUID().uuidString).patch"
        guard Self.write(patch, to: patchFile) else {
            throw RepositoryRefusal(.ioFailure, "Could not write the patch to apply (\(String(cString: strerror(errno))), \(patchFile)).")
        }
        defer { unlink(patchFile) }
        if git.succeeds(directory, ["apply", "--whitespace=nowarn", patchFile]) { return Applied(ok: true, conflict: false) }
        let live = try RepositoryPaths.snapshot(git, directory, index: c.index(), message: "trezi: spawn base (WIP snapshot)")
        try beforeThreeWay(live)
        let applyIndex = c.index()
        defer { unlink(applyIndex); unlink(applyIndex + ".lock") }
        let env = ["GIT_INDEX_FILE": applyIndex]
        do {
            try git.data(directory, ["read-tree", live], env: env)
            try git.data(directory, ["update-index", "--refresh"], env: env)
            try git.data(directory, ["apply", "--3way", "--whitespace=nowarn", patchFile], env: env)
            return Applied(ok: true, conflict: false)
        } catch let failure as GitFailure {
            // `git apply --3way` exits non-zero on overlap but still writes the markers
            // and records the paths unmerged in the private index; a patch it refused as
            // a whole wrote nothing. The index tells the two apart, not Git's wording,
            // which changes between versions (LKM-150).
            if let unmerged = try? git.data(directory, ["ls-files", "--unmerged", "-z"], env: env), !unmerged.isEmpty {
                return Applied(ok: false, conflict: true, error: GitMessages.scrub(failure.description, patchFile: patchFile))
            }
            log("Trezi repository: git apply --3way refused a patch in \(directory) (\(c.kind) \(c.operationID)):\n\(failure.description)\(failure.stdout)")
            let problems = GitMessages.applyProblems(failure.stderr, patchFile: patchFile, patch: patch)
            guard let merge, !problems.contains(where: \.unreadable), isRepoRoot(directory) else {
                return Applied(ok: false, conflict: false, error: Self.bounded(GitMessages.applyReason(problems, stderr: failure.stderr, patchFile: patchFile)),
                               problems: problems)
            }
            do {
                let merged = try mergeChange(directory, base: merge.base, tip: merge.tip, live: live, binary: binary)
                let conflicted = merged.conflicted + merged.kept
                if conflicted.isEmpty { return Applied(ok: true, conflict: false) }
                let kept = merged.kept.isEmpty ? "" : "; binary on both sides, kept the project's version: " + merged.kept.joined(separator: ", ")
                return Applied(ok: false, conflict: true, error: Self.bounded("conflicts in " + merged.conflicted.joined(separator: ", ") + kept),
                               conflicted: conflicted)
            } catch {
                log("Trezi repository: the three-way merge fallback failed in \(directory): \(error)")
                return Applied(ok: false, conflict: false, error: Self.bounded("\(error)"))
            }
        }
    }

    static func bounded(_ text: String, limit: Int = 600) -> String { text.count <= limit ? text : String(text.prefix(limit - 1)) + "…" }

    /// The explicit "Apply" of a parked chat: its cumulative diff, three-way onto the
    /// live checkout. The chat's tip and the live pre-image are kept until it is clean.
    func applyParked(_ c: RepositoryContext, _ wt: RepositoryWorktree) throws -> (applied: Applied, files: [String], newBase: String?) {
        try linked(c, wt)
        let patch = try git.data(wt.path, ["diff", "--full-index", "--binary", "\(wt.baseSha)..HEAD"])
        let files = try git.paths(wt.path, ["diff", "--name-only", "--no-renames", "-z", "\(wt.baseSha)..HEAD"])
        let chatHead = try head(wt.path)
        let tip = try c.preserve(chatHead, label: "target")
        var before: String?
        let result = try applyToWorkingTree(c, c.root, patch: patch, merge: (wt.baseSha, chatHead)) { before = try c.preserve($0, label: "live") }
        guard result.ok else { return (result, files, nil) }
        c.release(tip); before.map(c.release)
        return (result, files, try head(wt.path))
    }

    /// A spawn branch's own change (`branch^..branch`) onto the live checkout.
    func applyBranch(_ c: RepositoryContext, branch: String) throws -> Applied {
        guard git.revision(c.root, "refs/heads/\(branch)") != nil else {
            throw RepositoryRefusal(.notFound, "That branch no longer exists.")
        }
        let patch = (try? git.data(c.root, ["diff", "--full-index", "--binary", "\(branch)^..\(branch)"])) ?? Data()
        if String(decoding: patch, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return Applied(ok: false, conflict: false, error: nil, empty: true)
        }
        var before: String?
        let merge: (base: String, tip: String)? = git.revision(c.root, "refs/heads/\(branch)^")
            .flatMap { base in git.revision(c.root, "refs/heads/\(branch)").map { (base, $0) } }
        let result = try applyToWorkingTree(c, c.root, patch: patch, merge: merge) { before = try c.preserve($0, label: "live") }
        if result.ok { before.map(c.release) }
        return result
    }

    /// Stages both sides of a parked chat in its worktree (live snapshot, then the
    /// chat's diff three-way on top). The parked tip gets a recovery ref first: after
    /// the reset it is otherwise reachable from nothing but the reflog.
    func stageResolve(_ c: RepositoryContext, _ wt: RepositoryWorktree)
        throws -> (conflicted: [String], files: [String], baseSha: String) {
        try linked(c, wt)
        guard (try RepositoryPaths.meaningfulChanges(git, wt.path)).isEmpty else {
            throw RepositoryRefusal(.conflict, "the chat worktree changed after it was parked; finish this turn first, then prepare the cumulative conflict on the next turn")
        }
        let chatHead = try head(wt.path)
        let patch = try git.data(wt.path, ["diff", "--full-index", "--binary", "\(wt.baseSha)..HEAD"])
        let files = try git.paths(wt.path, ["diff", "--name-only", "--no-renames", "-z", "\(wt.baseSha)..HEAD"])
        try c.preserve(chatHead, label: "parked")
        let live = try RepositoryPaths.snapshot(git, c.root, index: c.index(), message: "trezi: spawn base (WIP snapshot)")
        try git.data(wt.path, RepositoryPaths.cleanArguments)
        try git.data(wt.path, ["reset", "--hard", live])
        c.point("resolve.reset")
        let laid = try applyToWorkingTree(c, wt.path, patch: patch, merge: (wt.baseSha, chatHead), binary: .chat)
        if !laid.ok && !laid.conflict {
            _ = git.succeeds(wt.path, ["reset", "--hard", chatHead])
            // `laid.error` is already bounded and names the path; the service log has Git's full output.
            let detail = laid.error.map { ": " + $0 } ?? ""
            throw RepositoryRefusal(.conflict, "couldn't re-apply this chat's changes onto the current project state\(detail)")
        }
        var conflicted: [String] = []
        // The merge fallback may put markers outside `files` (a file live renamed).
        var seen = Set<String>()
        for rel in files + laid.conflicted where Self.relative(rel) && seen.insert(rel).inserted {
            guard let current = FileManager.default.contents(atPath: wt.path + "/" + rel) else { continue }
            let text = String(decoding: current, as: UTF8.self)
            if text.contains("<<<<<<<") && text.contains(">>>>>>>") { conflicted.append(rel); continue }
            // A binary file cannot carry markers: keep the chat's version by policy.
            guard let target = try? git.data(wt.path, ["show", "\(chatHead):\(rel)"]), target.contains(0) else { continue }
            if current != target { _ = Self.write(target, to: wt.path + "/" + rel) }
        }
        return (conflicted, files, live)
    }

    /// The explicit "Discard" of a parked chat. Explicit intent, and still recoverable:
    /// the discarded state gets a recovery ref before the reset.
    func discardParked(_ c: RepositoryContext, _ wt: RepositoryWorktree) throws {
        try linked(c, wt)
        try preserveUnlanded(c, wt, label: "discarded")
        _ = git.succeeds(wt.path, ["reset", "--hard", wt.baseSha])
        _ = git.succeeds(wt.path, RepositoryPaths.cleanArguments)
    }

    // MARK: Live checkout

    /// One commit of exactly these files on the live checkout: a pathspec (partial)
    /// commit, so the user's own staged work elsewhere stays staged. Only at a
    /// repository's top level. Any Git refusal (an external index lock, a moved ref
    /// mid-commit, a hook) leaves the landed files in the working tree, uncommitted.
    func commitLive(_ c: RepositoryContext, files: [String], title: String, body: String?, mergeParent: String? = nil) -> (sha: String?, files: [String]) {
        var seen = Set<String>(), paths: [String] = []
        for rel in files where Self.relative(rel) && !RepositoryPaths.excluded(rel) && seen.insert(rel).inserted { paths.append(rel) }
        guard (try? git.line(c.root, ["rev-parse", "--is-inside-work-tree"])) == "true",
              (try? git.line(c.root, ["rev-parse", "--show-cdup"])) == "" else { return (nil, []) }
        do {
            let before = try head(c.root)
            let parent = mergeParent.flatMap { git.revision(c.root, $0) }
            let unseen = parent.flatMap { p in try? git.text(c.root, ["log", "--format=%ae", "\(before)..\(p)"]) } ?? ""
            let newMerge = parent != nil && !isAncestor(c.root, parent!, before) && (
                ((try? git.line(c.root, ["rev-list", "--count", "--merges", "\(before)..\(parent!)"])) ?? "0") != "0"
                || unseen.split(separator: "\n").contains(where: { $0 != "trezi@local" })
            )
            if !paths.isEmpty { try git.data(c.root, ["add", "--"] + paths) }
            let staged = paths.isEmpty ? [] : try git.paths(c.root, ["diff", "--cached", "--name-only", "-z", "--"] + paths)
            if staged.isEmpty && !newMerge { return (nil, []) }
            if !staged.isEmpty {
                c.point("commit.staged")
                try git.data(c.root, ["-c", "user.name=Trezi", "-c", "user.email=trezi@local", "commit", "--no-verify", "-m", title]
                             + (body.map { ["-m", $0] } ?? []) + ["--"] + paths)
            }
            if newMerge, let parent, let branch = currentBranch(c.root) {
                let current = try head(c.root)
                let tree = try git.line(c.root, ["rev-parse", "HEAD^{tree}"])
                // A pathspec commit, when needed, makes the index match this tree.
                // Replace it with a two-parent commit before exposing the landing.
                let guardRef = current == before ? nil : try c.preserve(current, label: "pre-merge-landing")
                let merge = try git.line(c.root, ["-c", "user.name=Trezi", "-c", "user.email=trezi@local", "commit-tree", tree,
                                                  "-p", before, "-p", parent, "-m", title] + (body.map { ["-m", $0] } ?? []))
                try git.data(c.root, ["update-ref", "refs/heads/\(branch)", merge, current])
                guardRef.map(c.release)
                return (merge, staged)
            }
            return (try head(c.root), staged)
        } catch { return (nil, []) }
    }

    func isRepoRoot(_ root: String) -> Bool {
        guard let top = try? git.line(root, ["rev-parse", "--show-toplevel"]), !top.isEmpty else { return false }
        return RepositoryPaths.realpath(top) == RepositoryPaths.realpath(root)
    }

    func branchResult(repo: Bool, branch: String?, created: Bool, files: [String]? = nil, error: String? = nil) -> JSValue {
        var fields: [(JSText, JSValue)] = [(JSText("isRepo"), .bool(repo)), (JSText("branch"), branch.map { .string(JSText($0)) } ?? .null),
                                           (JSText("created"), .bool(created))]
        if let files { fields.append((JSText("files"), .array(files.map { .string(JSText($0)) }))) }
        if let error { fields.append((JSText("error"), .string(JSText(error)))) }
        return .object(fields)
    }

    private func changedSince(_ root: String, _ before: String?) -> [String]? {
        guard let before else { return nil }
        return try? git.paths(root, ["diff", "--name-only", "-z", before, "HEAD"])
    }

    /// Checks out an existing LOCAL branch. Git refuses a switch that would overwrite
    /// local changes; a name that is not a local branch is refused before Git could
    /// read it as a path (which would discard that file's changes).
    func checkout(_ c: RepositoryContext, branch: String) -> JSValue {
        guard git.revision(c.root, "refs/heads/\(branch)") != nil else {
            return branchResult(repo: true, branch: currentBranch(c.root) ?? branch, created: false, error: "\(branch) is not a local branch.")
        }
        let before = git.revision(c.root, "HEAD")
        do {
            try git.data(c.root, ["checkout", branch, "--"])
            return branchResult(repo: true, branch: branch, created: false, files: changedSince(c.root, before))
        } catch {
            return branchResult(repo: true, branch: currentBranch(c.root) ?? branch, created: false, error: "\(error)")
        }
    }

    /// Switches to (creating if needed) a `trezi/*` branch; uncommitted changes come along.
    /// An existing branch is joined only when no commit of the checkout would be left
    /// behind (`joinBranch`, LKM-185).
    func switchBranch(_ c: RepositoryContext, name: String) -> JSValue {
        guard isRepoRoot(c.root) else { return branchResult(repo: false, branch: nil, created: false) }
        let current = currentBranch(c.root)
        if current == name { return branchResult(repo: true, branch: name, created: false) }
        let existed = git.revision(c.root, "refs/heads/\(name)") != nil
        let before = git.revision(c.root, "HEAD")
        do {
            if existed { try joinBranch(c, name, from: current) }
            try git.data(c.root, existed ? ["checkout", name, "--"] : ["checkout", "-b", name])
            return branchResult(repo: true, branch: name, created: !existed, files: changedSince(c.root, before))
        } catch {
            return branchResult(repo: true, branch: current, created: false, error: "\(error)")
        }
    }

    // MARK: Startup recovery

    struct Reclaimed { let id: String; let dirty: Bool; let branch: String?; let repoRoot: String? }

    /// Leftover checkouts not in `skip`: dirty work is committed to its branch (a
    /// detached one also gets a recovery ref), then the checkout is removed. An
    /// orphan of ANOTHER repository is left for that repository's own lane; a folder
    /// that is no worktree is moved aside (Trezi's own `.`-prefixed scratch removed).
    func pruneOrphans(_ c: RepositoryContext, directory: String, skip: Set<String>, parked: Set<String>) throws -> [Reclaimed] {
        guard inside(directory, legacy: true) else { throw RepositoryRefusal(.unauthorized, "Worktrees must live in the Trezi profile.") }
        _ = git.succeeds(c.root, ["worktree", "prune"])
        let entries = ((try? FileManager.default.contentsOfDirectory(atPath: directory)) ?? []).sorted()
        var reclaimed: [Reclaimed] = []
        for id in entries where !skip.contains(id) && !id.hasPrefix(".recovered-") {
            let path = directory + "/" + id
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue else { continue }
            let common = (try? git.line(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).flatMap { $0.isEmpty ? nil : $0 }
            let isWorktree = common != nil && (try? git.line(path, ["rev-parse", "--show-toplevel"])).flatMap(RepositoryPaths.realpath) == RepositoryPaths.realpath(path)
            guard let common, isWorktree else {
                if id.hasPrefix(".") { try? FileManager.default.removeItem(atPath: path) } else { moveAside(path) }
                reclaimed.append(Reclaimed(id: id, dirty: false, branch: nil, repoRoot: nil))
                continue
            }
            if "git:" + (RepositoryPaths.realpath(common) ?? common) != c.lane { continue }
            let branch = (try? git.line(path, ["rev-parse", "--abbrev-ref", "HEAD"])).flatMap { $0.isEmpty ? nil : $0 }
            let ownRoot = ((common as NSString).deletingLastPathComponent)
            let dirty = !(((try? git.text(path, ["status", "--porcelain"])) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            // The checkout is only removed once its work is reachable from a ref or a
            // commit on its branch. Anything short of that leaves it on disk (moved
            // aside when it is still dirty), never force-removed.
            var removable = true
            if dirty {
                do {
                    removable = try recoverOrphan(c, path, id: id, branch: branch, folded: RepositoryPaths.isChatBranch(branch ?? "") && parked.contains(id))
                } catch {
                    // A ref that could not be made (or a Git error): keep everything as found.
                    reclaimed.append(Reclaimed(id: id, dirty: true, branch: branch, repoRoot: ownRoot))
                    continue
                }
            }
            c.point("prune.committed")
            if !removable { moveAside(path) }
            else if !git.succeeds(c.root, ["worktree", "remove", "--force", path]) { moveAside(path) }
            reclaimed.append(Reclaimed(id: id, dirty: dirty, branch: branch, repoRoot: ownRoot))
        }
        _ = git.succeeds(c.root, ["worktree", "prune"])
        return reclaimed
    }

    /// Makes a dirty orphan's work durable before its checkout goes: recovery refs on
    /// its HEAD and on a private-index snapshot of the dirty state, then the recovery
    /// commit on its branch (folded into a parked chat's cumulative squash). Returns
    /// false, with the branch put back as found, when the commit could not be made
    /// (a signing hook, a Git error); the refs still hold the work then.
    private func recoverOrphan(_ c: RepositoryContext, _ path: String, id: String, branch: String?, folded: Bool) throws -> Bool {
        let original = try head(path)
        try c.preserve(original, label: "orphan-head")
        let snapshot = try RepositoryPaths.snapshot(git, path, index: c.index(), message: "Trezi recovery: orphaned worktree \(id)")
        if snapshot != original { try c.preserve(snapshot, label: "orphan-dirty") }
        c.point("prune.preserved")
        // A parked chat's tip is its cumulative squash: fold the recovery commit into it.
        let fold = folded && branch != nil && git.succeeds(path, ["reset", "--soft", "HEAD^"])
        func abandon() -> Bool { if fold { _ = git.succeeds(path, ["reset", "--soft", original]) }; return false }
        guard git.succeeds(path, ["add", "-A"]) else { return abandon() }
        try? RepositoryPaths.unstageExcluded(git, path)
        if !git.succeeds(path, ["diff", "--cached", "--quiet"]) || fold {
            // Nothing staged and not folded means only excluded paths were dirty: no commit is needed.
            guard git.succeeds(path, ["-c", "user.name=Trezi", "-c", "user.email=trezi@local", "commit", "--no-verify", "-m",
                                      "Trezi: recovered orphaned worktree"]) else { return abandon() }
        }
        return true
    }

    /// Deletes local `trezi/chat-*` refs whose tip is already on the live branch
    /// (ancestry, or an equal patch id for Trezi's separate live commits). Protected
    /// (parked) ids, refs checked out anywhere and unique tips are kept.
    func pruneBranches(_ c: RepositoryContext, protected: Set<String>) -> (deleted: [String], preserved: [String]) {
        var deleted: [String] = [], preserved: [String] = []
        guard let listing = try? git.text(c.root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/trezi/chat-*", "refs/heads/praxis/chat-*"]) else {
            return ([], [])
        }
        for branch in listing.split(separator: "\n").map({ $0.trimmingCharacters(in: .whitespaces) }).filter({ !$0.isEmpty }) {
            let id = branch.replacingOccurrences(of: #"^(trezi|praxis)/chat-"#, with: "", options: .regularExpression)
            if id.isEmpty || protected.contains(id) { preserved.append(branch); continue }
            let paths = try? git.text(c.root, ["for-each-ref", "--format=%(worktreepath)", "refs/heads/\(branch)"])
            if paths.map({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) ?? true { preserved.append(branch); continue }
            var integrated = isAncestor(c.root, branch, "HEAD")
            if !integrated, let cherry = try? git.text(c.root, ["cherry", "HEAD", branch, "\(branch)^"]) {
                let lines = cherry.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                integrated = !lines.isEmpty && lines.allSatisfy { $0.hasPrefix("- ") }
            }
            guard integrated, git.succeeds(c.root, ["branch", "-D", "--", branch]) else { preserved.append(branch); continue }
            deleted.append(branch)
        }
        return (deleted, preserved)
    }
}
