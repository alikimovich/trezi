import Foundation
import Darwin

/// Publication (S13): Publish (merge or PR only), the notes handoff and a saved run's PR
/// (`agent:spawn-pr`), the sole owner since LKM-111 removed the TS twin. Each runs in two phases around Bun's description helper:
/// phase one commits and pushes (answering `describe` with the pushed range), phase
/// two creates or reuses the PR, merges and cleans up. Remote steps are journaled and
/// reconciled from GitHub before anything is repeated: an open PR for the branch is
/// adopted, never duplicated; a merge is checked on the PR number the journal holds.
struct WorkflowPublish {
    let context: WorkflowContext
    var root: String { context.root }

    func run(_ record: WorkflowRecord, prior: WorkflowRecord?) throws -> WorkflowOutcome {
        let described = record.params["prTitle"] != nil || record.params["describeError"] != nil
        switch record.kind {
        case "publish": return try described ? shipFinish(record) : ship(record, prior: prior)
        case "handoff": return try described ? handoffFinish(record) : handoff(record, prior: prior)
        default: return try described ? branchFinish(record) : branch(record, prior: prior)
        }
    }

    private func remember(_ fields: [(String, JSValue)]) throws {
        guard let id = context.id else { return }
        try context.owner.journal.update(id) { $0.params = WorkflowOwner.merge($0.params, fields) }
    }

    private static func text(_ value: String) -> JSValue { .string(JSText(value)) }

    private func describe(base: String, head: String, branch: String) -> WorkflowOutcome {
        .describe([("base", Self.text(base)), ("head", Self.text(head)), ("branch", Self.text(branch))])
    }

    // MARK: Publish (ship to main, or PR only)

    private func ship(_ record: WorkflowRecord, prior: WorkflowRecord?) throws -> WorkflowOutcome {
        guard context.succeeds(["rev-parse", "--is-inside-work-tree"]), let head = try? context.run(["rev-parse", "--abbrev-ref", "HEAD"]) else {
            return WorkflowContext.fail("Not a git repository.")
        }
        let branch = head
        if branch == "HEAD" { return WorkflowContext.fail("Detached HEAD — check out a branch first.") }
        let existing = conflictFiles()
        if !existing.isEmpty { return Self.conflict(existing, []) }
        let base = context.defaultBase()
        // Bun moves a checkout on its base branch onto a work branch first (ensureBranch).
        if branch == base { return WorkflowContext.fail("You're on \(base) and Trezi couldn't create a work branch.") }
        guard context.hasOrigin() else { return WorkflowContext.fail("No \"origin\" remote — add one, then publish.") }
        guard context.ghInstalled() else { return WorkflowContext.fail("GitHub CLI (gh) not found — install it to publish.") }

        // An earlier run of this publish stopped after asking GitHub to merge: finish
        // it from what GitHub holds instead of pushing the merged branch again.
        if let prior, prior.param("branch") == branch, let merge = prior.step("merge"), let pr = prior.step("pr"),
           let number = pr.receipt["number"].flatMap(Self.integer), let priorHead = prior.param("head") {
            if merge.state == "done" || state(of: String(number)) == "MERGED" {
                try context.inherit(pr)
                try context.inherit(WorkflowStep(name: "merge", state: "done", receipt: WorkflowOwner.object([("adopted", .bool(merge.state != "done"))]),
                                                 at: WorkflowJournal.now()))
                try remember([("branch", Self.text(branch)), ("base", Self.text(prior.param("base") ?? base)), ("head", Self.text(priorHead))])
                let url = pr.receipt["url"]?.text?.string ?? ""
                var notice: String?
                do {
                    if prior.step("cleanup")?.state != "done" { notice = try cleanup(branch: branch, base: prior.param("base") ?? base, head: priorHead) }
                } catch {
                    return WorkflowContext.fail(WorkflowContext.lines(error, 4))
                }
                return .done(Self.published(branch: branch, url: url, notice: notice))
            }
        }
        do {
            context.phase("commit")
            try context.begin("commit")
            try context.run(["add", "-A"])
            let staged = try context.run(["diff", "--cached", "--name-only"])
            if !staged.isEmpty { try context.run(["commit", "-m", "Prepare project changes for publishing"]) }
            try context.done("commit", [("committed", .bool(!staged.isEmpty))])
            let ahead = (try? context.run(["rev-list", "--count", "\(base)..\(branch)"])) ?? "0"
            // A branch synced with a squash-merged base is ahead by commits that change nothing.
            if staged.isEmpty && (ahead == "0" || context.succeeds(["diff", "--quiet", base, branch])) {
                return WorkflowContext.fail("Nothing to publish — no changes since \(base).")
            }
            try context.begin("push")
            let pushed = try pushReconciled(branch)
            if !pushed.ok {
                context.failed("push", "conflict")
                return Self.conflict(pushed.files, pushed.refs)
            }
            let sha = try context.run(["rev-parse", "HEAD"])
            try context.done("push", [("action", Self.text(pushed.action)), ("attempts", .number(Double(pushed.attempts))),
                                      ("recoveryRefs", RepositoryOwner.strings(pushed.refs)), ("head", Self.text(sha))])
            try remember([("branch", Self.text(branch)), ("base", Self.text(base)), ("head", Self.text(sha))])
            // A cancel during the push stops here, before the description is written.
            try context.check()
            return describe(base: base, head: sha, branch: branch)
        } catch let cancel as WorkflowCancelled {
            throw cancel
        } catch {
            return WorkflowContext.fail(WorkflowContext.lines(error, 4))
        }
    }

    private func shipFinish(_ record: WorkflowRecord) throws -> WorkflowOutcome {
        guard let branch = record.param("branch"), let base = record.param("base"), let head = record.param("head") else {
            throw ServiceContractFailure.invalidRequest
        }
        if let error = record.param("describeError") {
            return WorkflowContext.fail(String(error.split(separator: "\n", omittingEmptySubsequences: false).prefix(4).joined(separator: "\n")))
        }
        let title = record.param("prTitle") ?? "", body = record.param("prBody") ?? ""
        do {
            try context.check()
            context.phase("pr")
            try context.begin("pr")
            var url = "", number: Int?
            if let open = openPullRequest(branch) {
                url = open.url; number = open.number
                try gh(["pr", "edit", branch, "--title", title, "--body", body])
                try context.done("pr", Self.pr(url, number, reused: true))
            } else {
                do {
                    let out = try gh(["pr", "create", "--base", base, "--head", branch, "--title", title, "--body", body])
                    context.fault("publish.pr")
                    url = Self.urlLine(out) ?? ""
                } catch {
                    guard let open = openPullRequest(branch) else { context.failed("pr", "\(error)"); throw error }
                    url = open.url
                    try gh(["pr", "edit", branch, "--title", title, "--body", body])
                }
                number = Self.number(url)
                try context.done("pr", Self.pr(url, number, reused: false))
            }
            if record.param("mode") == "pr" { return .done(Self.published(branch: branch, url: url)) }
            context.phase("merge")
            try context.begin("merge")
            if let number, state(of: String(number)) == "MERGED" {
                try context.done("merge", [("adopted", .bool(true))])
            } else {
                // No --delete-branch: gh would switch the live checkout to the base and
                // force-delete the work branch with any landing that arrived meanwhile.
                try gh(["pr", "merge", branch, "--squash", "--subject",
                        number.map { "\(title) (#\($0))" } ?? title, "--body", body])
                context.fault("publish.merge")
                try context.done("merge", [("adopted", .bool(false))])
            }
            let notice = try cleanup(branch: branch, base: base, head: head)
            return .done(Self.published(branch: branch, url: url, notice: notice))
        } catch let cancel as WorkflowCancelled {
            throw cancel
        } catch {
            return WorkflowContext.fail(WorkflowContext.lines(error, 4))
        }
    }

    /// After the merge the live checkout stays on `branch`, which keeps every landed
    /// commit (LKM-185); nothing here checks out, deletes or recreates a branch. The
    /// merged remote branch is deleted only while it is still at the pushed `head`.
    /// `branch` fast-forwards to the merged base when that includes it, else merges it
    /// with both tips kept at recovery refs; an overlap keeps `branch` as it was and
    /// answers a notice that offers the sync instead.
    private func cleanup(branch: String, base: String, head: String) throws -> String? {
        context.phase("cleanup")
        try context.begin("cleanup")
        _ = try? context.run(["push", "--force-with-lease=refs/heads/\(branch):\(head)", "origin", "--delete", branch])
        let merged = "refs/remotes/origin/\(base)"
        guard context.currentBranch() == branch, (try? context.run(["fetch", "--prune", "origin"])) != nil,
              let target = context.git.revision(root, merged) else {
            try context.done("cleanup", [("skipped", .bool(true))])
            return nil
        }
        if let local = context.git.revision(root, "refs/heads/\(base)"), local != target,
           context.succeeds(["merge-base", "--is-ancestor", local, target]) {
            _ = try? context.run(["branch", "-f", base, target])
        }
        var action = "up-to-date", refs: [String] = [], notice: String?
        if !context.succeeds(["merge-base", "--is-ancestor", target, "HEAD"]) {
            refs = try recoveryRefs(branch, remote: merged)
            let fastForward = context.succeeds(["merge-base", "--is-ancestor", "HEAD", target])
            do {
                try context.run(fastForward ? ["merge", "--ff-only", target]
                    : ["merge", "--no-ff", "--no-edit", "-m", "Sync \(branch) with the merged \(base)", target])
                action = fastForward ? "fast-forwarded" : "merged"
            } catch {
                if context.succeeds(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]) { _ = try? context.run(["merge", "--abort"]) }
                action = "kept"
                notice = "Published. Trezi couldn't merge the updated \(base) into \(branch) cleanly, so \(branch) was kept as it was "
                    + "(every chat change is still on it). Open Git updates and pull origin/\(base) when you are ready."
            }
        }
        try context.done("cleanup", [("skipped", .bool(false)), ("action", Self.text(action)),
                                     ("recoveryRefs", RepositoryOwner.strings(refs))])
        return notice
    }

    // MARK: Handoff (notes → a new branch and PR)

    private func handoff(_ record: WorkflowRecord, prior: WorkflowRecord?) throws -> WorkflowOutcome {
        guard context.succeeds(["rev-parse", "--is-inside-work-tree"]), let original = try? context.run(["rev-parse", "--abbrev-ref", "HEAD"]) else {
            return WorkflowContext.fail("Not a git repository.")
        }
        if original == "HEAD" { return WorkflowContext.fail("You’re on a detached HEAD — check out a branch first.") }
        guard context.hasOrigin() else { return WorkflowContext.fail("No “origin” remote — add one, then publish.") }
        guard context.ghInstalled() else { return WorkflowContext.fail("GitHub CLI (gh) not found — install it to publish a PR.") }
        // An earlier handoff pushed this branch and may have opened its PR: adopt it.
        if let prior, let branch = prior.param("branch"), branch == original, prior.step("push")?.state == "done" {
            if let open = openPullRequest(branch) {
                try context.inherit(WorkflowStep(name: "pr", state: "done", receipt: WorkflowOwner.object(Self.pr(open.url, open.number, reused: true)), at: WorkflowJournal.now()))
                return .done(WorkflowOwner.object([("ok", .bool(true)), ("url", Self.text(open.url))]))
            }
            let fields = ["branch", "original", "committed", "base", "head"].compactMap { key in prior.params[key].map { (key, $0) } }
            try remember(fields)
            return describe(base: prior.param("base") ?? context.defaultBase(), head: prior.param("head") ?? "HEAD", branch: branch)
        }
        let notes = Int(record.params["notes"].flatMap(Self.integer) ?? 0)
        let changed = changedSince()
        if changed.isEmpty && notes == 0 { return WorkflowContext.fail("Nothing to publish — no changes or notes yet.") }
        let branch = "trezi/handoff-" + String(Int(Date().timeIntervalSince1970 * 1000), radix: 36)
        var committed = false
        do {
            try context.begin("branch")
            try context.run(["checkout", "-b", branch])
            try context.run(["add", "-u"])
            try context.run(["add", "--", ".trezi"])
            let staged = try context.run(["diff", "--cached", "--name-only"])
            if staged.isEmpty && aheadOfBase(context.defaultBase()) == 0 {
                try context.run(["checkout", original])
                try context.run(["branch", "-D", branch])
                try context.done("branch", [("removed", .bool(true))])
                return WorkflowContext.fail("Nothing to publish — no changes or notes yet.")
            }
            if !staged.isEmpty {
                try context.run(["commit", "-m", record.param("title") ?? "trezi: design handoff"])
                committed = true
            }
            try context.done("branch", [("branch", Self.text(branch)), ("committed", .bool(committed))])
            try remember([("branch", Self.text(branch)), ("original", Self.text(original)), ("committed", .bool(committed))])
            try context.begin("push")
            try context.run(["push", "-u", "origin", branch])
            let sha = try context.run(["rev-parse", "HEAD"])
            try context.done("push", [("head", Self.text(sha))])
            let base = context.defaultBase()
            try remember([("base", Self.text(base)), ("head", Self.text(sha))])
            return describe(base: base, head: sha, branch: branch)
        } catch let cancel as WorkflowCancelled {
            throw cancel
        } catch {
            return handoffFailure(error: WorkflowContext.lines(error, 3), branch: branch, original: original, committed: committed)
        }
    }

    private func handoffFinish(_ record: WorkflowRecord) throws -> WorkflowOutcome {
        guard let branch = record.param("branch"), let original = record.param("original") else { throw ServiceContractFailure.invalidRequest }
        let committed = record.params["committed"] == .bool(true)
        if let error = record.param("describeError") {
            return handoffFailure(error: String(error.split(separator: "\n", omittingEmptySubsequences: false).prefix(3).joined(separator: "\n")),
                                  branch: branch, original: original, committed: committed)
        }
        do {
            try context.check()
            try context.begin("pr")
            let out = try gh(["pr", "create", "--title", record.param("title") ?? "trezi: design handoff", "--body", record.param("prBody") ?? ""])
            context.fault("publish.pr")
            let url = Self.urlLine(out)
            try context.done("pr", Self.pr(url ?? "", url.flatMap(Self.number), reused: false))
            var fields: [(String, JSValue)] = [("ok", .bool(true))]
            if let url { fields.append(("url", Self.text(url))) }
            return .done(WorkflowOwner.object(fields))
        } catch let cancel as WorkflowCancelled {
            throw cancel
        } catch {
            context.failed("pr", "\(error)")
            return handoffFailure(error: WorkflowContext.lines(error, 3), branch: branch, original: original, committed: committed)
        }
    }

    /// Back to the user's branch; the handoff branch is kept only if it holds a commit.
    private func handoffFailure(error: String, branch: String, original: String, committed: Bool) -> WorkflowOutcome {
        if (try? context.run(["checkout", original])) != nil, !committed { _ = try? context.run(["branch", "-D", branch]) }
        return WorkflowContext.fail(committed ? "Committed to \(branch), but couldn’t finish: \(error)" : error)
    }

    // MARK: A saved run's branch → PR

    private func branch(_ record: WorkflowRecord, prior: WorkflowRecord?) throws -> WorkflowOutcome {
        guard let branch = record.param("branch") else { throw ServiceContractFailure.invalidRequest }
        guard context.enclosingRoot() == "" else { return WorkflowContext.fail("Not a git repository.") }
        guard context.succeeds(["rev-parse", "--verify", "--quiet", "refs/heads/\(branch)"]) else { return WorkflowContext.fail("That branch no longer exists.") }
        guard context.hasOrigin() else { return WorkflowContext.fail("No “origin” remote — add one, then open a PR.") }
        guard context.ghInstalled() else { return WorkflowContext.fail("GitHub CLI (gh) not found — install it to open a PR.") }
        if let prior, prior.param("branch") == branch, prior.step("pr") != nil, let open = openPullRequest(branch) {
            try context.inherit(WorkflowStep(name: "pr", state: "done", receipt: WorkflowOwner.object(Self.pr(open.url, open.number, reused: true)), at: WorkflowJournal.now()))
            return .done(WorkflowOwner.object([("ok", .bool(true)), ("prUrl", Self.text(open.url))]))
        }
        do {
            try context.begin("push")
            try context.run(["push", "-u", "origin", branch])
            let sha = try context.run(["rev-parse", "refs/heads/\(branch)"])
            try context.done("push", [("head", Self.text(sha))])
            let base = context.defaultBase()
            try remember([("base", Self.text(base)), ("head", Self.text(sha))])
            return describe(base: base, head: sha, branch: branch)
        } catch let cancel as WorkflowCancelled {
            throw cancel
        } catch {
            return WorkflowContext.fail(WorkflowJournal.redact("\(error)"))
        }
    }

    private func branchFinish(_ record: WorkflowRecord) throws -> WorkflowOutcome {
        guard let branch = record.param("branch") else { throw ServiceContractFailure.invalidRequest }
        if let error = record.param("describeError") { return WorkflowContext.fail(error) }
        do {
            try context.check()
            try context.begin("pr")
            let out = try gh(["pr", "create", "--head", branch, "--title", record.param("prTitle") ?? "", "--body", record.param("prBody") ?? ""])
            context.fault("publish.pr")
            let url = Self.urlLine(out) ?? out.trimmingCharacters(in: .whitespacesAndNewlines)
            try context.done("pr", Self.pr(url, Self.number(url), reused: false))
            return .done(WorkflowOwner.object([("ok", .bool(true)), ("prUrl", Self.text(url))]))
        } catch let cancel as WorkflowCancelled {
            throw cancel
        } catch {
            context.failed("pr", "\(error)")
            return WorkflowContext.fail(WorkflowJournal.redact("\(error)"))
        }
    }

    // MARK: Reconciled push

    struct Pushed { var ok: Bool; var action = ""; var attempts = 0; var refs: [String] = []; var files: [String] = [] }

    /// Fetch, preserve both tips under `refs/trezi/recovery/…`, reconcile without
    /// rewriting either history, push; a non-fast-forward race retries (bounded).
    /// A content conflict stays in the checkout for per-file resolution.
    func pushReconciled(_ branch: String, maxAttempts: Int = 3) throws -> Pushed {
        var refs: [String] = []
        for attempt in 1...maxAttempts {
            try context.check()
            context.phase("sync")
            var result = try reconcileOnce(branch, attempt: attempt, refs: &refs)
            if !result.ok { return result }
            do {
                try context.check()
                context.phase("push")
                try context.run(["push", "-u", "origin", branch])
                result.attempts = attempt; result.refs = refs
                return result
            } catch {
                let failure = error as? GitFailure
                let text = "\(error)\n\(failure?.stdout ?? "")"
                if attempt == maxAttempts || !GitMessages.pushRejected(text) { throw error }
            }
        }
        throw RepositoryRefusal(.conflict, "Publish retry limit reached for \(branch).")
    }

    private func reconcileOnce(_ branch: String, attempt: Int, refs: inout [String]) throws -> Pushed {
        try context.run(["fetch", "--prune", "origin"])
        let remoteRef = "refs/remotes/origin/\(branch)"
        let hasRemote = context.succeeds(["show-ref", "--verify", "--quiet", remoteRef])
        refs += try recoveryRefs(branch, remote: hasRemote ? remoteRef : nil)
        if !hasRemote { return Pushed(ok: true, action: "created") }
        let local = try context.run(["rev-parse", "HEAD"]), remote = try context.run(["rev-parse", remoteRef])
        if local == remote { return Pushed(ok: true, action: "up-to-date") }
        if context.succeeds(["merge-base", "--is-ancestor", remoteRef, "HEAD"]) { return Pushed(ok: true, action: "ahead") }
        if context.succeeds(["merge-base", "--is-ancestor", "HEAD", remoteRef]) {
            try context.run(["merge", "--ff-only", remoteRef])
            return Pushed(ok: true, action: "fast-forwarded")
        }
        do {
            try context.run(["merge", "--no-ff", "-m", "Reconcile local and remote Trezi publish histories", remoteRef])
            return Pushed(ok: true, action: "merged")
        } catch {
            let files = conflictFiles()
            if !files.isEmpty { return Pushed(ok: false, attempts: attempt, refs: refs, files: files) }
            throw error
        }
    }

    private static let counter = RecoveryCounter()
    final class RecoveryCounter: @unchecked Sendable {
        private let lock = NSLock(); private var value = 0
        func next() -> Int { lock.lock(); defer { value += 1; lock.unlock() }; return value }
    }

    private func recoveryRefs(_ branch: String, remote: String?) throws -> [String] {
        let safe = branch.split(separator: "/", omittingEmptySubsequences: false).map { part -> String in
            var cleaned = String(part).replacingOccurrences(of: "[^A-Za-z0-9._-]+", with: "-", options: .regularExpression)
            cleaned = cleaned.replacingOccurrences(of: #"^\.+|\.+$"#, with: "", options: .regularExpression)
            return cleaned.isEmpty ? "branch" : cleaned
        }.joined(separator: "/")
        let prefix = "refs/trezi/recovery/\(safe)/\(Int(Date().timeIntervalSince1970 * 1000))-\(Self.counter.next())"
        try context.run(["update-ref", "\(prefix)-local", "HEAD"])
        var refs = ["\(prefix)-local"]
        if let remote {
            try context.run(["update-ref", "\(prefix)-remote", remote])
            refs.append("\(prefix)-remote")
        }
        return refs
    }

    // MARK: Git and GitHub reads

    func conflictFiles() -> [String] {
        ((try? context.run(["diff", "--name-only", "--diff-filter=U", "--"])) ?? "").split(separator: "\n").map(String.init).filter { !$0.isEmpty }
    }

    /// Tracked files this branch changed, committed work included (publish-scope.ts).
    private func changedSince() -> [String] {
        let flags = ["-c", "core.quotePath=false", "diff", "--name-only"]
        var out: String
        if let base = try? context.run(["merge-base", "HEAD", context.defaultBase()]) {
            out = (try? context.run(flags + [base])) ?? ""
        } else { out = (try? context.run(flags + ["HEAD"])) ?? "" }
        return out.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    private func aheadOfBase(_ base: String) -> Int {
        for ref in [base, "origin/\(base)"] {
            if let count = try? context.run(["rev-list", "--count", "\(ref)..HEAD"]), let value = Int(count) { return value }
        }
        return 0
    }

    @discardableResult
    private func gh(_ arguments: [String]) throws -> String { try context.gh.text(root, arguments) }

    /// The branch's OPEN pull request, if GitHub has one (reconciliation never
    /// adopts a merged or closed one).
    func openPullRequest(_ branch: String) -> (url: String, number: Int?)? {
        guard let out = try? context.gh.data(root, ["pr", "view", branch, "--json", "number,state,url"]),
              let value = try? JSValue.parse(out, maxDepth: 8), value["state"]?.text?.string == "OPEN",
              let url = value["url"]?.text?.string, !url.isEmpty else { return nil }
        return (url, value["number"].flatMap(Self.integer))
    }

    func state(of selector: String) -> String? {
        guard let out = try? context.gh.data(root, ["pr", "view", selector, "--json", "state"]),
              let value = try? JSValue.parse(out, maxDepth: 8) else { return nil }
        return value["state"]?.text?.string
    }

    static func urlLine(_ out: String) -> String? {
        out.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n").map(String.init)
            .first { $0.range(of: #"^https?://"#, options: .regularExpression) != nil }
    }

    static func number(_ url: String) -> Int? {
        guard let range = url.range(of: #"/pull/(\d+)"#, options: .regularExpression) else { return nil }
        return Int(url[range].dropFirst("/pull/".count))
    }

    static func integer(_ value: JSValue) -> Int? {
        guard case .number(let n) = value, n.rounded() == n, n >= 0, n < 1e15 else { return nil }
        return Int(n)
    }

    static func pr(_ url: String, _ number: Int?, reused: Bool) -> [(String, JSValue)] {
        [("url", text(url)), ("number", number.map { .number(Double($0)) } ?? .null), ("reused", .bool(reused))]
    }

    static func published(branch: String, url: String, notice: String? = nil) -> JSValue {
        var fields: [(String, JSValue)] = [("ok", .bool(true)), ("branch", text(branch))]
        if !url.isEmpty { fields.append(("url", text(url))) }
        if let notice { fields.append(("notice", text(notice))) }
        return WorkflowOwner.object(fields)
    }

    static func conflict(_ files: [String], _ refs: [String]) -> WorkflowOutcome {
        let message = "Publish paused because local and remote changes overlap in \(files.count) \(files.count == 1 ? "file" : "files"). " +
            "Resolve each file, commit the merge, then Publish again."
        return .failed(WorkflowOwner.object([("ok", .bool(false)), ("error", text(message)), ("conflictFiles", RepositoryOwner.strings(files)),
                                             ("recoveryRefs", RepositoryOwner.strings(refs))]), state: "failed")
    }
}
