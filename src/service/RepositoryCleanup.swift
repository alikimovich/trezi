import Foundation

/// Chat workspace cleanup (LKM-136). An idle chat's checkout is removed and Bun
/// recreates it on the chat's next turn. A checkout with uncommitted work is never
/// removed: the work gets a recovery ref and the checkout stays.
extension RepositoryEffects {
    /// `removed`: the checkout (and its retired branch) are gone; an unlanded HEAD got a
    /// recovery ref first. `dirty`: kept, with its uncommitted work at an `idle-<id>`
    /// recovery ref, made once per distinct content however often the sweep runs.
    func reclaimWorktree(_ c: RepositoryContext, _ wt: RepositoryWorktree) throws -> (removed: Bool, dirty: Bool, ref: String?) {
        guard inside(wt.path) else { throw RepositoryRefusal(.unauthorized, "Not a Trezi worktree: \(wt.path)") }
        if FileManager.default.fileExists(atPath: wt.path) {
            try linked(c, wt)
            if !(try RepositoryPaths.meaningfulChanges(git, wt.path)).isEmpty {
                let snapshot = try RepositoryPaths.snapshot(git, wt.path, index: c.index(), message: "Trezi recovery: idle \(wt.branch)")
                let tree = try git.line(c.root, ["rev-parse", "\(snapshot)^{tree}"])
                let valid = wt.id.range(of: #"^[A-Za-z0-9_-]{1,64}$"#, options: .regularExpression) != nil
                let label = valid ? "idle-\(wt.id)" : "idle"
                let kept = RecoveryRefs.list(git, c.root).first { ref in
                    ref.hasSuffix("-" + label) && (try? git.line(c.root, ["rev-parse", "--verify", "--quiet", "\(ref)^{tree}"])) == tree
                }
                return (false, true, try kept ?? c.preserve(snapshot, label: label))
            }
        }
        try removeWorktree(c, wt, keepBranch: false, intent: "idle")
        return (true, false, nil)
    }

    /// An old-name worktree folder once orphan recovery has emptied it, then its old-name
    /// parent when that is empty too. A folder holding anything but a `.DS_Store` stays;
    /// the profile's own worktree folder (or one that contains it) is refused.
    func removeLegacyFolder(_ directory: String) throws -> Bool {
        guard let real = RepositoryPaths.realpath(directory) else { return false }
        let parent = (real as NSString).deletingLastPathComponent
        guard inside(real, legacy: true), (real as NSString).lastPathComponent == "worktrees",
              ["praxis", "dsgn"].contains((parent as NSString).lastPathComponent),
              !RepositoryPaths.contains(real, worktreesRoot) else {
            throw RepositoryRefusal(.unauthorized, "Not an old-name worktree folder: \(directory)")
        }
        guard Self.removeIfEmpty(real) else { return false }
        _ = Self.removeIfEmpty(parent)
        return true
    }

    private static func removeIfEmpty(_ directory: String) -> Bool {
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: directory),
              entries.allSatisfy({ $0 == ".DS_Store" }) else { return false }
        if !entries.isEmpty { unlink(directory + "/.DS_Store") }
        // rmdir, not removeItem: anything that appeared since the listing keeps the folder.
        return rmdir(directory) == 0
    }

    /// Worktree folders of earlier profiles beside this one (`<support>/Praxis/praxis/worktrees`,
    /// `<support>/dsgn/dsgn/worktrees`): orphan recovery may empty them like the profile's own.
    static func legacyWorktreeRoots(profile: String) -> [String] {
        let support = ((RepositoryPaths.realpath(profile) ?? profile) as NSString).deletingLastPathComponent
        return ["Praxis", "dsgn"].flatMap { name in ["praxis", "dsgn"].map { "\(support)/\(name)/\($0)/worktrees" } }
    }
}
