import Foundation
import Darwin
import CryptoKit

/// Remote Git actions (S13): the Swift twins of `src/main/github.ts` (Connect to
/// GitHub) and `src/main/git-remote.ts` (fetch, pull, switch to a remote branch), with
/// the same preconditions, Git sequence and messages. Creating the GitHub repository
/// is the one remote creation here: it is journaled, and a run that stopped after
/// asking for it adopts the repository it asked for instead of failing on "already
/// exists" (never one this workflow did not ask for).
struct WorkflowRemote {
    let context: WorkflowContext
    var root: String { context.root }

    private static func text(_ value: String) -> JSValue { .string(JSText(value)) }
    private static func refuse(_ message: String) -> RepositoryRefusal { RepositoryRefusal(.conflict, message) }

    // MARK: Connect to GitHub

    func connect(_ record: WorkflowRecord, prior: WorkflowRecord?) throws -> WorkflowOutcome {
        guard context.succeeds(["rev-parse", "--is-inside-work-tree"]), let current = try? context.run(["rev-parse", "--abbrev-ref", "HEAD"]) else {
            return WorkflowContext.fail("Not a git repository.")
        }
        if current == "HEAD" { return WorkflowContext.fail("Detached HEAD — check out a branch first.") }
        let name = record.param("name") ?? "", owner = record.param("owner") ?? ""
        let slug = "\(owner)/\(name)"
        // An earlier run asked GitHub for this very repository and stopped (or lost the reply).
        let resuming = prior.map { $0.param("owner") == owner && $0.param("name") == name && $0.step("repo") != nil } ?? false
        if !resuming && context.hasOrigin() { return WorkflowContext.fail("Already connected — this project has an \"origin\" remote.") }
        guard context.ghInstalled() else { return WorkflowContext.fail("GitHub CLI (gh) not found — install it to connect.") }
        guard context.gh.succeeds(root, ["auth", "status"]) else { return WorkflowContext.fail("Not signed in to GitHub — run `gh auth login`, then retry.") }
        if owner.isEmpty { return WorkflowContext.fail("Pick an owner for the repo.") }
        let plan = Self.plan(current) { base, branch in context.succeeds(["merge-base", "--is-ancestor", base, branch]) }
        do {
            if plan.fastForward && plan.defaultBranch != current {
                try context.begin("fastForward")
                try context.run(["branch", "-f", plan.defaultBranch, current])
                try context.done("fastForward")
            }
            try context.begin("repo")
            if resuming, let url = try? context.gh.line(root, ["repo", "view", slug, "--json", "url", "-q", ".url"]), !url.isEmpty {
                if !context.hasOrigin() { try context.run(["remote", "add", "origin", url + ".git"]) }
                try context.done("repo", [("slug", Self.text(slug)), ("adopted", .bool(true))])
            } else {
                do {
                    try context.gh.data(root, ["repo", "create", slug, record.params["private"] == .bool(true) ? "--private" : "--public",
                                               "--source", ".", "--remote", "origin"])
                } catch { context.failed("repo", "\(error)"); throw error }
                context.fault("connect.repo")
                try context.done("repo", [("slug", Self.text(slug)), ("adopted", .bool(false))])
            }
            try context.begin("push")
            for branch in plan.push { try context.run(["push", "-u", "origin", branch]) }
            try context.done("push", [("branches", RepositoryOwner.strings(plan.push))])
            _ = try? context.gh.data(root, ["repo", "edit", slug, "--default-branch", plan.defaultBranch])
            _ = try? context.run(["remote", "set-head", "origin", "-a"])
            let url = (try? context.gh.line(root, ["repo", "view", slug, "--json", "url", "-q", ".url"])) ?? ""
            return .done(WorkflowOwner.object([("ok", .bool(true)), ("url", Self.text(url.isEmpty ? "https://github.com/\(slug)" : url))]))
        } catch let cancel as WorkflowCancelled {
            throw cancel
        } catch {
            return WorkflowContext.fail(WorkflowContext.lines(error, 4))
        }
    }

    /// `planGitHubConnection` (src/shared/github.ts): a trezi work branch whose clean
    /// base is its ancestor fast-forwards the base and pushes both.
    static func plan(_ current: String, isAncestor: (String, String) -> Bool) -> (defaultBranch: String, fastForward: Bool, push: [String]) {
        let prefix = ["trezi/", "praxis/"].first { current.hasPrefix($0) }
        guard let prefix else { return (current, false, [current]) }
        let stripped = String(current.dropFirst(prefix.count))
        let base = stripped.isEmpty ? "main" : stripped
        if base != current && isAncestor(base, current) { return (base, true, [base, current]) }
        return (current, false, [current])
    }

    // MARK: Trezi's own update check

    /// The update check: after a fetch, how far HEAD trails its tracked
    /// upstream (`origin/main` when it has none). Every soft failure (not a checkout, no
    /// remote, offline) is `idle`, so a source install without a remote never nags.
    func updateCheck() -> JSValue {
        let git = context.tool("git", timeout: 15)
        func line(_ arguments: [String]) throws -> String { try git.text(root, arguments).trimmingCharacters(in: .whitespacesAndNewlines) }
        let idle = WorkflowOwner.object([("status", Self.text("idle")), ("behind", .number(0))])
        var upstream = (try? line(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])) ?? ""
        if upstream.isEmpty { upstream = "origin/main" }
        let slash = upstream.firstIndex(of: "/")
        let remote = slash.map { String(upstream[..<$0]) }.flatMap { $0.isEmpty ? nil : $0 } ?? "origin"
        let branch = slash.map { String(upstream[upstream.index(after: $0)...]) }.flatMap { $0.isEmpty ? nil : $0 } ?? "main"
        guard (try? line(["fetch", remote, branch])) != nil, let count = try? line(["rev-list", "--count", "HEAD..\(upstream)"]) else { return idle }
        guard let behind = Int(count), behind > 0 else { return idle }
        var fields: [(String, JSValue)] = [("status", Self.text("available")), ("behind", .number(Double(behind)))]
        if let subject = try? line(["log", "-1", "--format=%s", upstream]), !subject.isEmpty { fields.append(("subject", Self.text(subject))) }
        return WorkflowOwner.object(fields)
    }

    // MARK: Remote status and updates

    private func requireRoot() throws {
        guard context.enclosingRoot() == "" else { throw Self.refuse("Open the repository’s top-level folder to manage Git updates.") }
    }

    func status(fetch: Bool) throws -> JSValue {
        try requireRoot()
        if fetch { try context.run(["fetch", "--all", "--prune", "--no-recurse-submodules"]) }
        let base = try snapshot().value
        guard case .object(let fields) = base else { return base }
        let (changes, token) = try localChanges()
        return .object(fields + [(JSText("changes"), .array(changes.map { change in
            WorkflowOwner.object([("path", Self.text(change.path)), ("state", Self.text(change.state)), ("eligible", .bool(change.eligible)),
                                  ("preview", Self.text(change.preview))])
        })), (JSText("changeToken"), Self.text(token))])
    }

    private struct LocalChange { let path: String, state: String, eligible: Bool, preview: String }

    private func sensitive(_ path: String) -> Bool {
        let name = (path as NSString).lastPathComponent.lowercased()
        return name.contains("secret") || name.contains("credential") || name.hasSuffix(".pem") || name.hasSuffix(".key")
            || name == "id_rsa" || name == "id_ed25519" || name == ".npmrc" || name == ".pypirc"
    }

    /// An untracked directory entry is a nested repository: a commit would record a gitlink, not files.
    /// The secret-name heuristic guards paths entering history (untracked, index-added, renamed or
    /// copied targets); a path already in history stays eligible when it is only modified or deleted.
    private func committable(_ path: String, state: String) -> Bool {
        let entering = state == "??" || state.contains("A") || state.contains("R") || state.contains("C")
        return !RepositoryPaths.excluded(path) && !(entering && sensitive(path)) && !path.hasSuffix("/")
    }

    private func preview(_ path: String, untracked: Bool) -> String {
        let args = untracked
            ? ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", "/dev/null", path]
            : ["--literal-pathspecs", "diff", "HEAD", "--no-ext-diff", "--no-textconv", "--", path]
        guard let output = try? context.git.run(root, args), output.status == 0 || output.status == 1 else { return "Preview unavailable." }
        if output.stdout.count > 12_000 { return String(decoding: output.stdout.prefix(12_000), as: UTF8.self) + "\n… preview truncated" }
        return String(decoding: output.stdout, as: UTF8.self)
    }

    /// The displayed scope and its content fingerprint are sampled together in the
    /// repository lane. HEAD, index, tracked diffs and eligible new-file bytes all
    /// participate; a same-path edit after review cannot be committed silently.
    private func localChanges() throws -> ([LocalChange], String) {
        let raw = try context.git.text(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        let records = raw.split(separator: "\0").map(String.init)
        var changes: [LocalChange] = [], index = 0
        while index < records.count {
            let record = records[index]
            guard record.count >= 4 else { index += 1; continue }
            let path = String(record.dropFirst(3)), state = String(record.prefix(2))
            let eligible = committable(path, state: state)
            // Untracked runtime sidecars and .env files never block (see requireClean); every
            // other path that blocks an update is listed, committable or not.
            if eligible || state != "??" || !RepositoryPaths.excluded(path) { changes.append(LocalChange(path: path, state: state, eligible: eligible,
                preview: eligible ? preview(path, untracked: state == "??") : "Excluded from automatic commits.")) }
            if state.contains("R") || state.contains("C") {
                index += 1
                if index < records.count {
                    let source = records[index]
                    let allowed = committable(source, state: " D") // the source already is in history
                    changes.append(LocalChange(path: source, state: state + " source", eligible: allowed,
                        preview: allowed ? preview(source, untracked: false) : "Excluded from automatic commits."))
                }
            }
            index += 1
        }
        let head = try context.run(["rev-parse", "HEAD"])
        let staged = try context.git.data(root, ["diff", "--cached", "--binary", "--no-ext-diff"])
        let unstaged = try context.git.data(root, ["diff", "--binary", "--no-ext-diff"])
        var bytes = Data(head.utf8) + Data(raw.utf8) + staged + unstaged
        for change in changes where change.state == "??" {
            bytes.append(Data(change.path.utf8))
            // A nested repository or an unreadable entry has no blob to hash; its path still counts.
            if !change.path.hasSuffix("/"), let blob = try? context.git.data(root, ["hash-object", "--", change.path]) { bytes.append(blob) }
        }
        return (changes, SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined())
    }

    struct Snapshot {
        let current: String?
        let remotes: [String]
        let branches: [(ref: String, remote: String, branch: String, label: String)]
        let upstream: String?
        let local: [String]
        var value: JSValue {
            WorkflowOwner.object([("current", current.map { .string(JSText($0)) } ?? .null), ("remotes", RepositoryOwner.strings(remotes)),
                ("branches", .array(branches.map { WorkflowOwner.object([("ref", .string(JSText($0.ref))), ("remote", .string(JSText($0.remote))),
                                                                          ("branch", .string(JSText($0.branch))), ("label", .string(JSText($0.label)))]) })),
                ("upstream", upstream.map { .string(JSText($0)) } ?? .null), ("localBranches", RepositoryOwner.strings(local))])
        }
    }

    private func snapshot() throws -> Snapshot {
        let remotes = try context.run(["remote"]).split(separator: "\n").map(String.init).filter { !$0.isEmpty }
        let local = try context.run(["for-each-ref", "--format=%(refname:strip=2)", "refs/heads/"]).split(separator: "\n").map(String.init).filter { !$0.isEmpty }
        let refs = try context.run(["for-each-ref", "--format=%(refname)%09%(symref)", "refs/remotes/"])
        var branches: [(ref: String, remote: String, branch: String, label: String)] = []
        for line in refs.split(separator: "\n") {
            let parts = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
            guard let ref = parts.first, !ref.isEmpty, parts.count < 2 || parts[1].isEmpty else { continue }
            guard let remote = remotes.sorted(by: { $0.count > $1.count }).first(where: { ref.hasPrefix("refs/remotes/\($0)/") }) else { continue }
            let branch = String(ref.dropFirst("refs/remotes/\(remote)/".count))
            branches.append((ref, remote, branch, "\(remote)/\(branch)"))
        }
        let upstream = try? context.run(["rev-parse", "--symbolic-full-name", "@{upstream}"])
        return Snapshot(current: context.currentBranch(), remotes: remotes, branches: branches, upstream: upstream, local: local)
    }

    private func requireClean() throws {
        // The same listing as localChanges: what the sheet shows is exactly what blocks.
        let changes = try context.git.text(root, ["status", "--porcelain", "-z", "--untracked-files=all"]).split(separator: "\0").map(String.init).filter { !$0.isEmpty }
        // Runtime sidecars stay outside commits; anything else blocks the update.
        if changes.contains(where: { !$0.hasPrefix("?? ") || !RepositoryPaths.excluded(String($0.dropFirst(3))) }) {
            throw Self.refuse("Local changes block this update. Review and commit them in Git updates, then retry.")
        }
        for state in ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_START"] {
            let path = try context.run(["rev-parse", "--git-path", state])
            let absolute = path.hasPrefix("/") ? path : root + "/" + path
            if access(absolute, F_OK) == 0 { throw Self.refuse("Finish or abort the Git operation already in progress before updating this project.") }
        }
    }

    /// Pull keeps local commits (a conflicting merge is aborted back to the clean
    /// starting tree); a switch never resets or repoints an existing local branch.
    func update(_ record: WorkflowRecord) throws -> WorkflowOutcome {
        let action = record.param("action") ?? "", ref = record.param("ref") ?? ""
        let expected = record.param("expectedBranch"), busy = record.params["busy"] == .bool(true)
        let commitMessage = record.param("commitMessage"), changeToken = record.param("changeToken")
        do {
            try requireRoot()
            guard action == "pull" || action == "checkout" else { throw Self.refuse("Unknown Git action.") }
            func ready(clean: Bool = true) throws {
                if busy { throw Self.refuse("Wait for this project’s agents to finish before pulling or switching branches.") }
                guard let expected, context.currentBranch() == expected else { throw Self.refuse("The current branch changed. Refresh Git updates and try again.") }
                if clean { try requireClean() }
            }
            try ready(clean: commitMessage == nil)
            guard let requested = try snapshot().branches.first(where: { $0.ref == ref }) else {
                throw Self.refuse("Fetch updates and choose an available remote branch.")
            }
            if let commitMessage {
                guard let changeToken, !commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      commitMessage.utf16.count <= 256 else { throw Self.refuse("Enter a commit message and review the changes again.") }
                let (changes, currentToken) = try localChanges()
                guard currentToken == changeToken else { throw Self.refuse("Local changes changed since review. Refresh Git updates and try again.") }
                // Refused before anything is staged: a path Trezi will not commit would block the update afterwards.
                guard !changes.isEmpty, changes.allSatisfy(\.eligible) else {
                    throw Self.refuse("Some local changes cannot be committed by Trezi (excluded, secret or nested repository files). Move, ignore or unstage them, then refresh Git updates.")
                }
                let paths = Array(Set(changes.map(\.path))).sorted()
                try context.begin("commit")
                do {
                    try context.run(["--literal-pathspecs", "add", "-A", "--"] + paths)
                    try context.run(["--literal-pathspecs", "-c", "user.name=Trezi", "-c", "user.email=trezi@local", "commit", "--only", "-m", commitMessage, "--"] + paths)
                    try context.done("commit", [("head", Self.text(try context.run(["rev-parse", "HEAD"])))])
                } catch {
                    context.failed("commit", "\(error)")
                    throw Self.refuse("Commit failed. Your files are kept. \(WorkflowJournal.redact("\(error)"))")
                }
            }
            try ready()
            try context.begin("fetch")
            try context.run(["fetch", "--prune", "--no-recurse-submodules", "--", requested.remote])
            try context.done("fetch")
            try ready()
            let snapshot = try snapshot()
            guard let source = snapshot.branches.first(where: { $0.ref == ref }) else {
                throw Self.refuse("That remote branch is no longer available. Fetch updates and choose another branch.")
            }
            let before = try context.run(["rev-parse", "HEAD"])
            try context.begin(action)
            let existed = snapshot.local.contains(source.branch)
            if action == "checkout" {
                try context.run(["check-ref-format", "--branch", source.branch])
                if existed { try context.run(["switch", "--", source.branch]) }
                else { try context.run(["switch", "--create", source.branch, "--track", source.ref]) }
            } else {
                do {
                    try context.run(["merge", "--no-edit", "--no-autostash", source.ref])
                } catch {
                    context.failed(action, "\(error)")
                    if context.succeeds(["rev-parse", "--verify", "MERGE_HEAD"]) {
                        do { try context.run(["merge", "--abort"]) } catch {
                            throw Self.refuse("Pull stopped and Git could not abort the merge: \(WorkflowJournal.redact("\(error)"))")
                        }
                    }
                    throw Self.refuse("Could not merge \(source.label). Your existing commits are preserved. \(WorkflowJournal.redact("\(error)"))")
                }
            }
            let after = try context.run(["rev-parse", "HEAD"])
            try context.done(action, [("before", Self.text(before)), ("after", Self.text(after))])
            let files = try context.git.paths(root, ["diff", "--name-only", "-z", before, after])
            let message: String
            if action == "checkout" {
                message = existed ? "Switched to local \(source.branch). Use Pull updates to bring in \(source.label)."
                                  : "Switched to \(source.branch), tracking \(source.label)."
            } else {
                message = before == after ? "Already up to date with \(source.label)." : "Pulled \(source.label) into \(expected ?? "")."
            }
            return .done(Self.remoteResult(ok: true, branch: context.currentBranch(), files: files, changed: before != after, message: message))
        } catch let cancel as WorkflowCancelled {
            throw cancel
        } catch {
            return .failed(Self.remoteResult(ok: false, branch: context.currentBranch(), files: [], changed: false,
                                             message: WorkflowJournal.redact("\(error)")), state: "failed")
        }
    }

    static func remoteResult(ok: Bool, branch: String?, files: [String], changed: Bool, message: String) -> JSValue {
        WorkflowOwner.object([("ok", .bool(ok)), ("branch", branch.map { .string(JSText($0)) } ?? .null), ("files", RepositoryOwner.strings(files)),
                              ("changed", .bool(changed)), ("message", .string(JSText(message)))])
    }
}
