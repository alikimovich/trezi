import Foundation

/// Agent Git effects are serialized with landings and journaled by RepositoryOwner.
/// The validated worktree is always a linked chat checkout, never the live tree.
extension RepositoryEffects {
    func gitSyncBase(_ c: RepositoryContext, _ wt: RepositoryWorktree, ref: String)
        throws -> (merged: Bool, conflicted: [String], head: String) {
        try linked(c, wt)
        guard ref.hasPrefix("origin/"), ref.count > "origin/".count,
              !ref.contains(".."), !ref.contains(" "), !ref.contains("~"), !ref.contains("^"),
              !ref.contains(":"), !ref.contains("\\"), !ref.hasSuffix("/"),
              git.succeeds(wt.path, ["check-ref-format", "refs/remotes/\(ref)"]) else {
            throw RepositoryRefusal(.invalidRequest, "The base must be an origin branch, such as origin/main.")
        }
        guard git.revision(wt.path, "MERGE_HEAD") == nil else {
            throw RepositoryRefusal(.conflict, "A merge is in progress. Use git_merge_continue or git_merge_abort.")
        }
        // Keep the agent's current edits in a Trezi-owned commit before merging.
        _ = try commitWorktree(c, wt, message: "Save chat work before syncing \(ref)")
        let original = try head(wt.path)
        let branch = String(ref.dropFirst("origin/".count))
        try git.data(wt.path, ["fetch", "--no-tags", "origin", "+refs/heads/\(branch):refs/remotes/origin/\(branch)"])
        guard let target = git.revision(wt.path, "refs/remotes/\(ref)") else {
            throw RepositoryRefusal(.notFound, "The base branch \(ref) was not fetched.")
        }
        if isAncestor(wt.path, target, original) { return (true, [], original) }
        _ = try c.preserve(original, label: "chat-before-base")
        _ = try c.preserve(target, label: "publish-base")
        do {
            try git.data(wt.path, ["-c", "user.name=Trezi", "-c", "user.email=trezi@local", "merge", "--no-ff", "--no-edit", "-m", "Merge \(ref) into chat work", target])
            return (true, [], try head(wt.path))
        } catch {
            guard git.revision(wt.path, "MERGE_HEAD") != nil else { throw error }
            let files = try git.paths(wt.path, ["diff", "--name-only", "--diff-filter=U", "-z"])
            return (false, files, original)
        }
    }

    func gitMergeContinue(_ c: RepositoryContext, _ wt: RepositoryWorktree) throws -> String {
        try linked(c, wt)
        guard git.revision(wt.path, "MERGE_HEAD") != nil else {
            throw RepositoryRefusal(.conflict, "There is no merge to continue.")
        }
        try git.data(wt.path, ["add", "-A"])
        try RepositoryPaths.unstageExcluded(git, wt.path)
        let unresolved = try git.paths(wt.path, ["diff", "--name-only", "--diff-filter=U", "-z"])
        guard unresolved.isEmpty else {
            throw RepositoryRefusal(.conflict, "Resolve these files first: \(unresolved.joined(separator: ", "))")
        }
        let staged = try git.paths(wt.path, ["diff", "--cached", "--name-only", "-z"])
        guard staged.allSatisfy({ !RepositoryPaths.hasConflictMarkers(FileManager.default.contents(atPath: wt.path + "/" + $0) ?? Data()) }) else {
            throw RepositoryRefusal(.conflict, "Remove every conflict marker before continuing the merge.")
        }
        try git.data(wt.path, ["-c", "user.name=Trezi", "-c", "user.email=trezi@local", "commit", "--no-verify", "--no-edit"])
        return try head(wt.path)
    }

    func gitMergeAbort(_ c: RepositoryContext, _ wt: RepositoryWorktree) throws -> String {
        try linked(c, wt)
        guard let target = git.revision(wt.path, "MERGE_HEAD") else {
            throw RepositoryRefusal(.conflict, "There is no merge to abort.")
        }
        _ = try c.preserve(try head(wt.path), label: "chat-before-abort")
        _ = try c.preserve(target, label: "base-before-abort")
        try git.data(wt.path, ["merge", "--abort"])
        return try head(wt.path)
    }
}
