import Foundation

/// The live checkout's branch (LKM-185). Landings go to the branch the live checkout
/// has checked out, and the preview serves that checkout. So no automatic path may move
/// it onto a branch that lacks its commits. Projects that a pre-fix publish left split
/// across two branches are checked on open (`strandedLandings`). Their earlier chat
/// changes are merged back only on the user's explicit "Bring them back"
/// (`restoreLandings`).
extension RepositoryEffects {
    /// The committer of every landing on the live checkout (`commitLive`).
    static let landingIdentity = "<trezi@local>"

    /// Branches whose Trezi commits are worktree work, not landings.
    static func isWorktreeBranch(_ branch: String) -> Bool {
        RepositoryPaths.isChatBranch(branch) || branch.hasPrefix("trezi/comment-")
    }

    /// Before an automatic switch onto the existing branch `name`, nothing the
    /// checkout has may become unreachable from it. A branch that already contains
    /// HEAD is fine. A branch behind HEAD fast-forwards to HEAD first, with its old tip
    /// kept at a recovery ref. A branch that diverged is refused and the checkout stays.
    func joinBranch(_ c: RepositoryContext, _ name: String, from current: String?) throws {
        guard let target = git.revision(c.root, "refs/heads/\(name)"), let here = git.revision(c.root, "HEAD") else { return }
        if target == here || isAncestor(c.root, here, target) { return }
        let place = current ?? "this checkout"
        guard isAncestor(c.root, target, here) else {
            throw RepositoryRefusal(.conflict, "\(name) has commits that are not on \(place), so Trezi stayed on \(place) "
                + "(switching would hide this checkout's chat changes from the preview). Use the branch menu to switch on purpose.")
        }
        try c.preserve(target, label: "branch")
        try git.data(c.root, ["update-ref", "refs/heads/\(name)", here, target])
    }

    struct Stranded { let branch: String; let tip: String; let count: Int }

    /// Local branches other than the checked-out one that hold landed chat commits
    /// whose changes the checkout does not have, most commits first. A branch whose
    /// changes are already in the checkout (a squash merge, a cherry-pick) is not listed.
    func strandedLandings(_ root: String) -> (current: String?, stranded: [Stranded]) {
        guard isRepoRoot(root), let current = currentBranch(root), let here = git.revision(root, "HEAD") else { return (nil, []) }
        let tree = try? git.line(root, ["rev-parse", "HEAD^{tree}"])
        let listing = (try? git.text(root, ["for-each-ref", "--format=%(refname:short)%00%(objectname)", "refs/heads/"])) ?? ""
        var found: [Stranded] = []
        for line in listing.split(separator: "\n") {
            let parts = line.split(separator: "\0", omittingEmptySubsequences: false).map(String.init)
            guard parts.count == 2, parts[0] != current, !Self.isWorktreeBranch(parts[0]), parts[1] != here else { continue }
            let counted = try? git.line(root, ["rev-list", "--count", "--author=\(Self.landingIdentity)", "--fixed-strings", parts[1], "^\(here)"])
            guard let count = counted.flatMap({ Int($0) }), count > 0 else { continue }
            // Exit 0 (no conflict) and the checkout's own tree: nothing would come back.
            if let merged = try? git.line(root, ["merge-tree", "--write-tree", here, parts[1]]), merged == tree { continue }
            found.append(Stranded(branch: parts[0], tip: parts[1], count: count))
        }
        return (current, found.sorted { $0.count > $1.count || ($0.count == $1.count && $0.branch < $1.branch) })
    }

    struct Restored { var merged: Bool; var files: [String]; var conflicted: [String]; var refs: [String] }

    /// "Bring them back": merges `branch` (still at `tip`) into the checked-out branch.
    /// Both tips get recovery refs first. A conflict stays in the checkout for per-file
    /// resolution, as a publish conflict does.
    func restoreLandings(_ c: RepositoryContext, branch: String, tip: String) throws -> Restored {
        guard isRepoRoot(c.root), let current = currentBranch(c.root) else {
            throw RepositoryRefusal(.conflict, "Check out a branch in the project's top-level folder first.")
        }
        guard current != branch else { throw RepositoryRefusal(.conflict, "\(branch) is already the checked-out branch.") }
        guard git.revision(c.root, "refs/heads/\(branch)") == tip else {
            throw RepositoryRefusal(.conflict, "\(branch) changed since Trezi checked it. Reopen the project to check again.")
        }
        guard !git.succeeds(c.root, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]) else {
            throw RepositoryRefusal(.conflict, "Finish or abort the merge already in progress, then try again.")
        }
        let before = try head(c.root)
        let refs = [try c.preserve(before, label: "live"), try c.preserve(tip, label: "stranded")]
        c.point("restore.preserved")
        do {
            try git.data(c.root, ["-c", "user.name=Trezi", "-c", "user.email=trezi@local", "merge", "--no-ff", "--no-edit",
                                  "-m", "Bring back earlier chat changes from \(branch)", tip])
        } catch let failure as GitFailure {
            let conflicted = (try? git.paths(c.root, ["diff", "--name-only", "--diff-filter=U", "-z"])) ?? []
            guard !conflicted.isEmpty else {
                throw RepositoryRefusal(.conflict, "Could not merge \(branch); nothing was changed. "
                    + Self.bounded(failure.description.trimmingCharacters(in: .whitespacesAndNewlines)))
            }
            return Restored(merged: false, files: conflicted, conflicted: conflicted, refs: refs)
        }
        return Restored(merged: true, files: try git.paths(c.root, ["diff", "--name-only", "-z", before, "HEAD"]), conflicted: [], refs: refs)
    }
}
