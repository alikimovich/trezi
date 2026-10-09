import Foundation
import Darwin

// The workflow owner's outcome type, cancellation and the per-run context (journal steps, Git
// and tool runners) that every workflow file (WorkflowPublish/Remote/Setup/Tools) works through.

enum WorkflowOutcome {
    /// Finished; `result` is what the legacy route returned.
    case done(JSValue)
    /// Finished without success; `state` is failed or cancelled.
    case failed(JSValue, state: String)
    /// Paused for Bun's description helper (phase two is `describe`).
    case describe([(String, JSValue)])
}

struct WorkflowCancelled: Error { let message: String }

/// One workflow's view of the journal and the tools, inside the lane.
final class WorkflowContext: @unchecked Sendable {
    let owner: WorkflowOwner
    let id: String?
    let root: String
    let git: RepositoryGit
    let gh: RepositoryGit

    init(owner: WorkflowOwner, id: String?, root: String) {
        self.owner = owner; self.id = id; self.root = root
        git = RepositoryGit(environment: owner.options.environment, timeout: owner.options.gitTimeout)
        gh = RepositoryGit(environment: owner.options.environment, timeout: owner.options.ghTimeout, tool: "gh")
    }

    var record: WorkflowRecord? { id.flatMap { owner.journal.record($0) } }

    /// A program (package manager, Trezi's Bun) with its own time bound.
    func tool(_ name: String, executable: String? = nil, timeout: TimeInterval) -> RepositoryGit {
        RepositoryGit(environment: owner.options.environment, timeout: timeout, tool: name, executable: executable)
    }

    func observer(interruptible: Bool) -> ToolObserver? { id.map { owner.observer($0, interruptible: interruptible) } }

    // Steps

    /// Stops before a step when the workflow was cancelled.
    func check() throws {
        if let id, owner.isCancelled(id) { throw WorkflowCancelled(message: "Cancelled; nothing further was changed.") }
    }

    /// The user-facing step a publish is on (LKM-187); in memory only, never journaled.
    func phase(_ step: String) { if let id { owner.phase(id, step) } }

    /// Records a step's intent (synced) before its first effect.
    func begin(_ name: String) throws {
        try check()
        guard let id else { return }
        try owner.journal.update(id) { $0.steps.append(WorkflowStep(name: name, state: "intent", at: WorkflowJournal.now())) }
    }

    /// Records a step's receipt.
    func done(_ name: String, _ receipt: [(String, JSValue)] = []) throws {
        guard let id else { return }
        try owner.journal.update(id) { record in
            guard let index = record.steps.lastIndex(where: { $0.name == name }) else { return }
            record.steps[index].state = "done"; record.steps[index].receipt = WorkflowOwner.object(receipt); record.steps[index].at = WorkflowJournal.now()
        }
        owner.finishedProcess(id)
    }

    func failed(_ name: String, _ message: String) {
        guard let id else { return }
        _ = try? owner.journal.update(id) { record in
            guard let index = record.steps.lastIndex(where: { $0.name == name }), record.steps[index].state == "intent" else { return }
            record.steps[index].state = "failed"; record.steps[index].message = WorkflowJournal.redact(message); record.steps[index].at = WorkflowJournal.now()
        }
    }

    /// Carries a finished (or verified) step over from a superseded record.
    func inherit(_ step: WorkflowStep) throws {
        guard let id else { return }
        try owner.journal.update(id) { $0.steps.append(step) }
    }

    func fault(_ point: String) { owner.options.fault?(point) }

    // Git

    @discardableResult
    func run(_ arguments: [String], observer: ToolObserver? = nil) throws -> String {
        try git.text(root, arguments, observer: observer).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func succeeds(_ arguments: [String]) -> Bool { git.succeeds(root, arguments) }

    /// The repo's default branch (origin/HEAD), `main` when it isn't set.
    func defaultBase() -> String {
        guard let head = try? run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) else { return "main" }
        let name = head.hasPrefix("origin/") ? String(head.dropFirst(7)) : head
        return name.isEmpty ? "main" : name
    }

    /// `rev-parse --abbrev-ref HEAD`, nil when detached or unreadable.
    func currentBranch() -> String? {
        guard let branch = try? run(["rev-parse", "--abbrev-ref", "HEAD"]), !branch.isEmpty, branch != "HEAD" else { return nil }
        return branch
    }

    /// '' when `root` is the top level, the enclosing top level otherwise, nil outside a repository.
    func enclosingRoot() -> String? {
        guard let top = try? run(["rev-parse", "--show-toplevel"]), !top.isEmpty else { return nil }
        return RepositoryPaths.realpath(top) == RepositoryPaths.realpath(root) ? "" : top
    }

    func hasOrigin() -> Bool { !((try? run(["remote", "get-url", "origin"])) ?? "").isEmpty }

    func ghInstalled() -> Bool { gh.succeeds(root, ["--version"]) }

    /// First `n` lines of a failure, redacted: the legacy routes' error text.
    static func lines(_ error: Error, _ n: Int) -> String {
        WorkflowJournal.redact("\(error)").split(separator: "\n", omittingEmptySubsequences: false).prefix(n).joined(separator: "\n")
    }

    static func fail(_ message: String, _ extra: [(String, JSValue)] = []) -> WorkflowOutcome {
        .failed(WorkflowOwner.object([("ok", .bool(false)), ("error", .string(JSText(message)))] + extra), state: "failed")
    }
}
