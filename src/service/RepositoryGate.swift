import Foundation
import Darwin

/// LOCAL-WEBKIT-3: the owner's half of the integration gate. Bun lands a change only
/// with the candidate tree its checks passed on (`candidate`, `src/main/source-tree.ts`);
/// here, under the repository lease and before any live write, the commit about to land
/// must have exactly that tree and the live checkout must still be exactly the commit's
/// fork point. Anything else holds the landing (nothing written, the commit and its
/// branch kept) with a reason Bun turns into a recheck or a reconciliation:
/// - `unchecked`: no candidate was given;
/// - `source-changed`: the commit's tree is not the checked one (the worktree changed
///   after its checks, or Git stored other bytes: a clean filter, line endings);
/// - `live-changed`: the live checkout moved since the fork point (a user edit, another
///   landing, a commit with other content); its files are listed.
/// The bytes written are then read from the commit, never from the worktree's files.
extension RepositoryEffects {
    struct Hold { let reason: String; let files: [String] }

    /// The candidate must be a full object id: a hold, never a guess, for anything else.
    static func validCandidate(_ candidate: String?) -> String? {
        guard let candidate, candidate.range(of: #"^([0-9a-f]{40}|[0-9a-f]{64})$"#, options: .regularExpression) != nil else { return nil }
        return candidate
    }

    /// Files that differ between two trees (empty when either cannot be read).
    func treeDiff(_ directory: String, _ a: String, _ b: String) -> [String] {
        (try? git.paths(directory, ["diff-tree", "-r", "--name-only", "--no-renames", "-z", a, b])) ?? []
    }

    /// Why `tip` (a commit in `directory`) may not land on the live checkout as the
    /// change from `base`, or nil when it may.
    func hold(_ c: RepositoryContext, directory: String, tip: String, base: String, candidate: String?) throws -> Hold? {
        guard let candidate = Self.validCandidate(candidate) else { return Hold(reason: "unchecked", files: []) }
        let tree = try git.line(directory, ["rev-parse", "\(tip)^{tree}"])
        if tree != candidate { return Hold(reason: "source-changed", files: treeDiff(directory, candidate, tree)) }
        let live = try RepositoryPaths.tree(git, c.root, index: c.index())
        let baseTree = try git.line(c.root, ["rev-parse", "\(base)^{tree}"])
        if live != baseTree {
            let files = treeDiff(c.root, baseTree, live)
            return Hold(reason: "live-changed", files: files)
        }
        return nil
    }

    /// The live checkout's tree after a landing, for the exactness record.
    func liveTree(_ c: RepositoryContext) -> String? { try? RepositoryPaths.tree(git, c.root, index: c.index()) }

    /// A regular file's bytes and exec bit at `tip`, or nil for anything else (deleted,
    /// a symlink, a submodule): those are refused, as before.
    func blob(_ directory: String, _ tip: String, _ rel: String) -> (data: Data, executable: Bool)? {
        guard let entry = try? git.data(directory, ["ls-tree", "-z", tip, "--", rel]), !entry.isEmpty else { return nil }
        let fields = String(decoding: entry, as: UTF8.self).split(separator: "\t", maxSplits: 1)[0].split(separator: " ")
        guard fields.count == 3, fields[1] == "blob", fields[0] == "100644" || fields[0] == "100755",
              let data = try? git.data(directory, ["cat-file", "blob", String(fields[2])]) else { return nil }
        return (data, fields[0] == "100755")
    }

    /// Gives a landed file the commit's exec bit (owner's bits; group/other read kept).
    static func setExecutable(_ path: String, _ executable: Bool) {
        var info = stat()
        guard lstat(path, &info) == 0, info.st_mode & S_IFMT == S_IFREG else { return }
        let current = info.st_mode & 0o777
        let wanted = executable ? current | ((current & 0o444) >> 2) : current & ~mode_t(0o111)
        if wanted != current { chmod(path, wanted) }
    }
}

extension RepositoryPaths {
    /// The tree of the checkout's full current state, as `snapshot` builds it, in a
    /// PRIVATE index and without a commit.
    static func tree(_ git: RepositoryGit, _ directory: String, index: String) throws -> String {
        var env = RepositoryGit.identity
        env["GIT_INDEX_FILE"] = index
        defer { unlink(index); unlink(index + ".lock") }
        try git.data(directory, ["read-tree", "HEAD"], env: env)
        try git.data(directory, ["add", "-A"], env: env)
        try unstageExcluded(git, directory, env: env)
        return try git.line(directory, ["write-tree"], env: env)
    }
}
