import Foundation
import Darwin

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
        return try snapshot().value
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
        let changes = try context.git.text(root, ["status", "--porcelain", "-z"]).split(separator: "\0").map(String.init).filter { !$0.isEmpty }
        // Runtime sidecars stay outside commits; anything else blocks the update.
        if changes.contains(where: { !$0.hasPrefix("?? ") || !RepositoryPaths.excluded(String($0.dropFirst(3))) }) {
            throw Self.refuse("Commit or stash the project’s uncommitted changes before pulling or switching branches.")
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
        do {
            try requireRoot()
            guard action == "pull" || action == "checkout" else { throw Self.refuse("Unknown Git action.") }
            func ready() throws {
                if busy { throw Self.refuse("Wait for this project’s agents to finish before pulling or switching branches.") }
                guard let expected, context.currentBranch() == expected else { throw Self.refuse("The current branch changed. Refresh Git updates and try again.") }
                try requireClean()
            }
            try ready()
            guard let requested = try snapshot().branches.first(where: { $0.ref == ref }) else {
                throw Self.refuse("Fetch updates and choose an available remote branch.")
            }
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
