import Foundation
import Darwin

/// The repository coordinator (S07, LKM-95): the only writer of Git state that
/// Trezi changes in a user's repository under the Swift launch — chat and spawn
/// worktrees, their branches, landings onto the live checkout, live commits, branch
/// switches and startup recovery. Bun asks over the private pipe
/// (`{"service":"repository",…}`) and keeps the decisions that belong to other
/// slices (chat state, park records, Undo history, setup helpers).
///
/// Serialization: one FIFO lane per repository common directory. A request runs in
/// its lane, or inside a lease Bun holds on that lane (`acquire`/`release`, the
/// Swift form of `enqueueRepoWrite`), so every Trezi Git effect on one repository is
/// ordered, whichever chat, worktree or future slice asks.
/// Durability: each mutation's intent is journaled before its first effect; recovery
/// refs are created (and journaled) before anything could make work unreachable.
/// Removing, discarding and landing work each require their explicit intent.
final class RepositoryOwner: @unchecked Sendable {
    static let service = "repository"

    struct Options {
        var profile: String
        var environment: [String: String]
        /// Test hook: named points inside effects (a fixture crashes there).
        var fault: (@Sendable (String) -> Void)?
        var gitTimeout: TimeInterval = 60
        /// Where worktrees may live; the profile unless a fixture widens it.
        var worktreesRoot: String?
        /// The service log (the host's diagnostics under XPC, stderr in a fixture).
        var log: @Sendable (String) -> Void = { fputs($0 + "\n", stderr) }
    }

    /// method → (required body fields, optional fields, required intent values)
    static let methods: [String: (required: Set<String>, optional: Set<String>, intents: Set<String>?)] = [
        "createWorktree": (["root", "worktreesDir", "id", "branch", "linkNodeModules"], ["leases"], nil),
        "syncWorktree": (["root", "worktree"], ["leases"], nil),
        "attachBranch": (["root", "worktree"], ["leases"], nil),
        "retireBranch": (["root", "worktree"], ["leases"], nil),
        "commitWorktree": (["root", "worktree", "message"], ["leases"], nil),
        "autoApply": (["root", "worktree", "files", "intent"], ["leases"], ["land"]),
        "completeTurn": (["root", "worktree", "message", "intent"], ["keepHistory", "leases"], ["land", "park"]),
        "applyParked": (["root", "worktree", "intent"], ["leases"], ["land"]),
        "applyBranch": (["root", "branch", "intent"], ["leases"], ["land"]),
        "stageResolve": (["root", "worktree", "intent"], ["leases"], ["reconcile"]),
        "gitSyncBase": (["root", "worktree", "ref", "intent"], ["leases"], ["sync"]),
        "gitMergeContinue": (["root", "worktree", "intent"], ["leases"], ["continue"]),
        "gitMergeAbort": (["root", "worktree", "intent"], ["leases"], ["abort"]),
        "discardParked": (["root", "worktree", "intent"], ["leases"], ["discard"]),
        "removeWorktree": (["root", "worktree", "keepBranch", "intent"], ["leases"], ["landed", "release", "abandon"]),
        "reclaimWorktree": (["root", "worktree", "intent"], ["leases"], ["idle"]),
        "deleteBranch": (["root", "branch", "intent"], ["leases"], ["discard", "integrated"]),
        "pruneOrphans": (["root", "worktreesDir", "skip", "parked", "intent"], ["leases"], ["recover"]),
        "pruneBranches": (["root", "protected", "intent"], ["leases"], ["integrated"]),
        "removeLegacyFolder": (["root", "intent"], ["leases"], ["legacy"]),
        "deleteRecoveryRefs": (["root", "refs", "shas", "intent"], ["leases"], ["discard"]),
        "commitLive": (["root", "files", "title"], ["body", "mergeParent", "leases"], nil),
        "checkout": (["root", "branch"], ["leases"], nil),
        "switchBranch": (["root", "branch"], ["leases"], nil),
        "restoreLandings": (["root", "branch", "tip", "intent"], ["leases"], ["restore"]),
    ]

    final class Lease: Sendable { let id: String, key: String; let queue: DispatchQueue
        init(id: String, key: String) { self.id = id; self.key = key; queue = DispatchQueue(label: "dev.trezi.repository.lease") } }

    let options: Options
    let effects: RepositoryEffects
    let journal: RepositoryJournal
    private let send: @Sendable (Data) -> Void
    private let lanes = RepositoryLanes()
    /// Pipe order in, lane order out: keys are computed here, one frame at a time.
    private let intake = DispatchQueue(label: "dev.trezi.repository.intake")
    private let work = DispatchQueue(label: "dev.trezi.repository.work", attributes: .concurrent)
    private let lock = NSLock()
    private var leases: [String: Lease] = [:]
    private var closed = false
    private var journalFailure: String?
    private let inflight = DispatchGroup()

    init(options: Options, send: @escaping @Sendable (Data) -> Void) {
        self.options = options; self.send = send
        journal = RepositoryJournal(profile: options.profile)
        do { try journal.open() } catch { journalFailure = "\(error)" }
        let scratch = URL(fileURLWithPath: options.profile).appendingPathComponent("service/repository/scratch").path
        // Private indexes and patches only; nothing in here is anyone's work.
        try? FileManager.default.removeItem(atPath: scratch)
        try? FileManager.default.createDirectory(atPath: scratch, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        effects = RepositoryEffects(git: RepositoryGit(environment: options.environment, timeout: options.gitTimeout), journal: journal,
                                    scratch: scratch, worktreesRoot: RepositoryPaths.realpath(options.worktreesRoot ?? options.profile) ?? options.profile,
                                    legacyRoots: RepositoryEffects.legacyWorktreeRoots(profile: options.profile),
                                    fault: options.fault, log: options.log)
    }

    // MARK: Requests (from the backend reader thread, in pipe order)

    func submit(_ line: Data) {
        let frame: PipeFrame
        do { frame = try PipeFrame(line, service: Self.service, maxDepth: 8) } catch {
            let code = error as? ServiceContractFailure ?? .invalidRequest
            send(Self.reply(id: (try? JSValue.parse(line, maxDepth: 8))?["id"] ?? .null, frame: nil,
                            result: .failed(Self.fail(code, "Invalid repository request."))))
            return
        }
        lock.lock()
        let refused = closed
        if !refused { inflight.enter() }
        lock.unlock()
        if refused { return answer(frame, .failed(Self.stopping), counted: false) }
        intake.async { self.accept(frame) }
    }

    private func accept(_ frame: PipeFrame) {
        do {
            guard frame.expectedRevision == nil else { throw ServiceContractFailure.invalidRequest }
            switch (frame.method, frame.mode) {
            case ("status", "read"):
                _ = try Body(frame, required: [], optional: [])
                // Reads Git (the recovered refs), so off the intake queue.
                work.async { self.answer(frame, .succeeded(self.status())) }
            case ("recoveryRefs", "read"):
                let body = try Body(frame, required: [], optional: ["roots"])
                let roots = try body.strings("roots")
                guard roots.count <= 1_000 else { throw ServiceContractFailure.invalidRequest }
                work.async { self.answer(frame, .succeeded(self.recoveryRefs(roots))) }
            case ("strandedLandings", "read"):
                let root = try Body(frame, required: ["root"], optional: []).path("root")
                work.async {
                    let (current, stranded) = self.effects.strandedLandings(root)
                    self.answer(frame, .succeeded(Self.object([("current", current.map { .string(JSText($0)) } ?? .null),
                        ("branches", .array(stranded.map { Self.object([("branch", .string(JSText($0.branch))), ("tip", .string(JSText($0.tip))),
                                                                        ("count", .number(Double($0.count)))]) }))])))
                }
            case ("acknowledge", "mutation"):
                let body = try Body(frame, required: ["operationID", "intent"], optional: [])
                guard try body.string("intent") == "acknowledge" else { throw ServiceContractFailure.invalidRequest }
                let found = try journal.acknowledge(try body.string("operationID"))
                return answer(frame, found ? .succeeded(.object([])) : .failed(Self.fail(.notFound, "No such interrupted repository operation.")))
            case ("acquire", "mutation"):
                let body = try Body(frame, required: ["root"], optional: ["held"])
                let key = effects.lane(try body.path("root"))
                if let lease = held(try body.strings("held"), key: key) {
                    return answer(frame, .succeeded(Self.object([("lease", .string(JSText(lease.id))), ("reentrant", .bool(true))])))
                }
                lanes.enter(key) {
                    let lease = Lease(id: UUID().uuidString, key: key)
                    self.lock.lock(); self.leases[lease.id] = lease; let refused = self.closed; self.lock.unlock()
                    if refused { self.drop(lease.id); return self.answer(frame, .failed(Self.stopping)) }
                    self.answer(frame, .succeeded(Self.object([("lease", .string(JSText(lease.id))), ("reentrant", .bool(false))])))
                }
            case ("release", "mutation"):
                let body = try Body(frame, required: ["lease"], optional: [])
                guard drop(try body.string("lease")) else { throw ServiceContractFailure.notFound }
                answer(frame, .succeeded(.object([])))
            case (let method, "mutation") where Self.methods[method] != nil:
                let rule = Self.methods[method]!
                let body = try Body(frame, required: rule.required, optional: rule.optional)
                var intent = method
                if let intents = rule.intents {
                    intent = try body.string("intent")
                    guard intents.contains(intent) else { throw ServiceContractFailure.invalidRequest }
                }
                if let failure = journalFailure { throw RepositoryRefusal(.recoveryRequired, failure) }
                let root = try body.path("root")
                let key = effects.lane(root)
                let chosen = intent
                let run: @Sendable () -> Void = { self.run(frame, body: body, method: method, intent: chosen, root: root, key: key) }
                if let lease = held(try body.strings("leases"), key: key) { lease.queue.async(execute: run) }
                else { lanes.enter(key) { self.work.async { run(); self.lanes.leave(key) } } }
            default: throw ServiceContractFailure.invalidRequest
            }
        } catch let refusal as RepositoryRefusal {
            answer(frame, .failed(Self.fail(refusal.code, refusal.message)))
        } catch {
            answer(frame, .failed(Self.fail(error as? ServiceContractFailure ?? .invalidRequest, "Invalid repository request.")))
        }
    }

    /// S08: runs `body` in `root`'s lane, or inside a lease the caller holds on it, so
    /// source transactions are ordered with every Git effect on that repository.
    /// Returns false (without running it) once the coordinator is closed.
    func serialize(root: String, leases: [String], _ body: @escaping @Sendable () -> Void) -> Bool {
        lock.lock(); let refused = closed; lock.unlock()
        if refused { return false }
        let key = effects.lane(root)
        if let lease = held(leases, key: key) { lease.queue.async(execute: body) }
        else { lanes.enter(key) { self.work.async { body(); self.lanes.leave(key) } } }
        return true
    }

    private func held(_ ids: [String], key: String) -> Lease? {
        lock.lock(); defer { lock.unlock() }
        return ids.lazy.compactMap { self.leases[$0] }.first { $0.key == key }
    }

    /// Releases the lane after every operation already queued inside the lease.
    @discardableResult
    private func drop(_ id: String) -> Bool {
        lock.lock()
        let lease = leases.removeValue(forKey: id)
        lock.unlock()
        guard let lease else { return false }
        lease.queue.async { self.lanes.leave(lease.key) }
        return true
    }

    /// `recovered` is this launch's one report of the entries the journal closed at open,
    /// each with the journaled refs that are not in its repository (a crash between
    /// naming a ref and creating it, before the effect it guards; or the user deleted
    /// it). `closedEarlier` counts open entries of an older journal closed silently.
    private func status() -> JSValue {
        let (active, interrupted) = journal.snapshot()
        let recovered: [JSValue] = journal.recovered.map { entry in
            let readable = effects.git.succeeds(entry.root, ["rev-parse", "--git-common-dir"])
            let missing = readable ? entry.refs.filter { effects.git.revision(entry.root, $0) == nil } : entry.refs
            guard case .object(var fields) = entry.value() else { return entry.value() }
            fields.append((JSText("missing"), Self.strings(missing)))
            if !readable { fields.append((JSText("unreadable"), .bool(true))) }
            return .object(fields)
        }
        var fields: [(String, JSValue)] = [("active", .array(active.map { $0.value() })), ("interrupted", .array(interrupted.map { $0.value() })),
                                           ("recovered", .array(recovered)), ("closedEarlier", .number(Double(journal.closedEarlier)))]
        if let journalFailure { fields.append(("journal", .string(JSText(journalFailure)))) }
        return Self.object(fields)
    }

    /// Every recovery ref in `roots` and in the journal's repositories, one entry per
    /// repository (its common directory), for the user to view or delete.
    private func recoveryRefs(_ roots: [String]) -> JSValue {
        var seen = Set<String>(), repositories: [JSValue] = []
        for root in roots + journal.snapshot().interrupted.map(\.root) where root.hasPrefix("/") {
            guard effects.git.succeeds(root, ["rev-parse", "--git-common-dir"]) else { continue }
            guard seen.insert(effects.lane(root)).inserted, let refs = RecoveryRefs.describe(effects.git, root), !refs.isEmpty else { continue }
            repositories.append(Self.object([("root", .string(JSText(root))), ("refs", .array(refs))]))
        }
        return .array(repositories)
    }

    // MARK: Operations (inside the lane or lease)

    private func run(_ frame: PipeFrame, body: Body, method: String, intent: String, root: String, key: String) {
        lock.lock(); let refused = closed; lock.unlock()
        if refused { return answer(frame, .failed(Self.stopping)) }
        let context = RepositoryContext(operationID: frame.operationID, kind: method, lane: key, root: root, effects: effects)
        let worktree = try? body.worktree()
        let entry = RepositoryEntry(operationID: frame.operationID, kind: method, intent: intent, lane: key, root: root,
                                    worktree: worktree?.path, branch: worktree?.branch ?? (try? body.string("branch")),
                                    started: ISO8601DateFormatter().string(from: Date()))
        do {
            try journal.begin(entry)
        } catch {
            return answer(frame, .failed(Self.fail(.ioFailure, "\(error)")))
        }
        do {
            let result = try perform(context, body: body, method: method, intent: intent)
            journal.finish(frame.operationID)
            answer(frame, .succeeded(result))
        } catch {
            // An effect that failed after preserving work is reported as interrupted
            // (with its refs); one that failed before any effect simply settles.
            if journal.snapshot().active.first(where: { $0.operationID == frame.operationID })?.refs.isEmpty == false {
                journal.interrupt(frame.operationID)
            } else { journal.finish(frame.operationID) }
            if let refusal = error as? RepositoryRefusal { return answer(frame, .failed(Self.fail(refusal.code, refusal.message))) }
            if let code = error as? ServiceContractFailure { return answer(frame, .failed(Self.fail(code, "Invalid repository request."))) }
            answer(frame, .failed(Self.fail(.ioFailure, "\(error)")))
        }
    }

    private func perform(_ c: RepositoryContext, body: Body, method: String, intent: String) throws -> JSValue {
        let e = effects
        switch method {
        case "createWorktree":
            let id = try body.string("id"), branch = try body.string("branch")
            guard id.range(of: #"^[A-Za-z0-9_-]{1,64}$"#, options: .regularExpression) != nil, try validBranch(c.root, branch) else {
                throw ServiceContractFailure.invalidRequest
            }
            return try e.createWorktree(c, directory: try body.path("worktreesDir"), id: id, branch: branch,
                                        linkNodeModules: try body.bool("linkNodeModules")).value()
        case "syncWorktree":
            let (synced, base) = try e.syncWorktree(c, try worktree(body, c))
            return Self.object([("synced", .bool(synced)), ("baseSha", .string(JSText(base)))])
        case "attachBranch": try e.linked(c, try worktree(body, c)); try e.attach(c, try worktree(body, c)); return .object([])
        case "retireBranch": try e.linked(c, try worktree(body, c)); try e.retire(c, try worktree(body, c)); return .object([])
        case "commitWorktree":
            let (committed, files) = try e.commitWorktree(c, try worktree(body, c), message: try body.string("message"))
            return Self.object([("committed", .bool(committed)), ("files", Self.strings(files))])
        case "autoApply":
            let (applied, edits) = try e.autoApply(c, try worktree(body, c), files: try body.strings("files"))
            return Self.object([("applied", .bool(applied)), ("edits", Self.edits(edits))])
        case "completeTurn":
            let turn = try e.completeTurn(c, try worktree(body, c), message: try body.string("message"), land: intent == "land",
                                          keepHistory: body.has("keepHistory") ? try body.bool("keepHistory") : false)
            var fields: [(String, JSValue)] = [("outcome", .string(JSText("\(turn.outcome)"))), ("files", Self.strings(turn.files)), ("edits", Self.edits(turn.edits))]
            if let base = turn.newBase { fields.append(("newBase", .string(JSText(base)))) }
            return Self.object(fields)
        case "applyParked":
            let (applied, files, base) = try e.applyParked(c, try worktree(body, c))
            var fields = Self.applied(applied) + [("files", Self.strings(files))]
            if let base { fields.append(("newBase", .string(JSText(base)))) }
            return Self.object(fields)
        case "applyBranch":
            let branch = try body.string("branch")
            guard RepositoryPaths.isWorkBranch(branch), try validBranch(c.root, branch) else { throw ServiceContractFailure.invalidRequest }
            return Self.object(Self.applied(try e.applyBranch(c, branch: branch)))
        case "stageResolve":
            let (conflicted, files, base) = try e.stageResolve(c, try worktree(body, c))
            return Self.object([("conflicted", Self.strings(conflicted)), ("files", Self.strings(files)), ("clean", .bool(conflicted.isEmpty)),
                                ("baseSha", .string(JSText(base)))])
        case "gitSyncBase":
            let result = try e.gitSyncBase(c, try worktree(body, c), ref: try body.string("ref"))
            return Self.object([("merged", .bool(result.merged)), ("conflicted", Self.strings(result.conflicted)),
                                ("head", .string(JSText(result.head)))])
        case "gitMergeContinue":
            return Self.object([("head", .string(JSText(try e.gitMergeContinue(c, try worktree(body, c)))))])
        case "gitMergeAbort":
            return Self.object([("head", .string(JSText(try e.gitMergeAbort(c, try worktree(body, c)))))])
        case "discardParked": try e.discardParked(c, try worktree(body, c)); return .object([])
        case "removeWorktree":
            let wt = try body.worktree()
            guard wt.repoRoot == c.root else { throw ServiceContractFailure.invalidRequest }
            try e.removeWorktree(c, wt, keepBranch: try body.bool("keepBranch"), intent: intent)
            return .object([])
        case "reclaimWorktree":
            let (removed, dirty, ref) = try e.reclaimWorktree(c, try worktree(body, c))
            return Self.object([("removed", .bool(removed)), ("dirty", .bool(dirty)), ("ref", ref.map { .string(JSText($0)) } ?? .null)])
        case "deleteBranch":
            let branch = try body.string("branch")
            guard RepositoryPaths.isWorkBranch(branch), try validBranch(c.root, branch) else { throw ServiceContractFailure.invalidRequest }
            let deleted = try e.deleteBranch(c, branch, keep: nil, preserveAlways: intent == "discard")
            return Self.object([("deleted", .bool(deleted))])
        case "pruneOrphans":
            let reclaimed = try e.pruneOrphans(c, directory: try body.path("worktreesDir"), skip: Set(try body.strings("skip")),
                                               parked: Set(try body.strings("parked")))
            return .array(reclaimed.map { item in Self.object([("id", .string(JSText(item.id))), ("dirty", .bool(item.dirty)),
                ("branch", item.branch.map { .string(JSText($0)) } ?? .null), ("repoRoot", item.repoRoot.map { .string(JSText($0)) } ?? .null)]) })
        case "removeLegacyFolder": return Self.object([("removed", .bool(try e.removeLegacyFolder(c.root)))])
        case "pruneBranches":
            let (deleted, preserved) = e.pruneBranches(c, protected: Set(try body.strings("protected")))
            return Self.object([("deleted", Self.strings(deleted)), ("preserved", Self.strings(preserved))])
        case "deleteRecoveryRefs":
            let (deleted, kept) = try RecoveryRefs.delete(e.git, c.root, refs: try body.strings("refs"), shas: try body.strings("shas"))
            return Self.object([("deleted", Self.strings(deleted)), ("kept", Self.strings(kept))])
        case "commitLive":
            let (sha, files) = e.commitLive(c, files: try body.strings("files"), title: try body.string("title"),
                                            body: body.has("body") ? try body.string("body") : nil,
                                            mergeParent: body.has("mergeParent") ? try body.string("mergeParent") : nil)
            var fields: [(String, JSValue)] = [("committed", .bool(sha != nil))]
            if let sha { fields.append(("sha", .string(JSText(sha)))) }
            fields.append(("files", Self.strings(files)))
            return Self.object(fields)
        case "checkout":
            let branch = try body.string("branch")
            guard !branch.hasPrefix("-"), !branch.isEmpty else { throw ServiceContractFailure.invalidRequest }
            return e.checkout(c, branch: branch)
        case "switchBranch":
            let branch = try body.string("branch")
            guard branch.hasPrefix("trezi/"), try validBranch(c.root, branch) else { throw ServiceContractFailure.invalidRequest }
            return e.switchBranch(c, name: branch)
        case "restoreLandings":
            let branch = try body.string("branch"), tip = try body.string("tip")
            guard try validBranch(c.root, branch), tip.range(of: #"^([0-9a-f]{40}|[0-9a-f]{64})$"#, options: .regularExpression) != nil else {
                throw ServiceContractFailure.invalidRequest
            }
            let restored = try e.restoreLandings(c, branch: branch, tip: tip)
            return Self.object([("merged", .bool(restored.merged)), ("files", Self.strings(restored.files)),
                                ("conflictFiles", Self.strings(restored.conflicted)), ("recoveryRefs", Self.strings(restored.refs))])
        default: throw ServiceContractFailure.invalidRequest
        }
    }

    /// The body's worktree, which must belong to the request's root.
    private func worktree(_ body: Body, _ c: RepositoryContext) throws -> RepositoryWorktree {
        let wt = try body.worktree()
        guard wt.repoRoot == c.root else { throw ServiceContractFailure.invalidRequest }
        return wt
    }

    private func validBranch(_ root: String, _ branch: String) throws -> Bool {
        !branch.hasPrefix("-") && effects.git.succeeds(root, ["check-ref-format", "--branch", branch])
    }

    // MARK: Drain

    /// Refuses new requests, releases Bun's leases (Bun has exited), lets running
    /// operations finish (bounded). One still running is interrupted in the journal.
    @discardableResult
    func close(timeout: TimeInterval) -> Bool {
        lock.lock()
        closed = true
        let held = Array(leases.keys)
        lock.unlock()
        for id in held { drop(id) }
        return inflight.wait(timeout: .now() + timeout) == .success
    }

    // MARK: Frames

    private func answer(_ frame: PipeFrame, _ result: PreferencesOwner.Answer, counted: Bool = true) {
        send(Self.reply(id: frame.id, frame: frame, result: result))
        if counted { inflight.leave() }
    }

    static let stopping = fail(.unavailable, "The service is stopping; the repository was not changed.", retryable: true)

    static func fail(_ code: ServiceContractFailure, _ message: String, retryable: Bool = false) -> ServiceFailure {
        PreferencesOwner.fail(code, message, retryable: retryable)
    }

    static func object(_ fields: [(String, JSValue)]) -> JSValue { .object(fields.map { (JSText($0.0), $0.1) }) }
    static func strings(_ values: [String]) -> JSValue { .array(values.map { .string(JSText($0)) }) }
    static func applied(_ a: RepositoryEffects.Applied) -> [(String, JSValue)] {
        var fields: [(String, JSValue)] = [("ok", .bool(a.ok)), ("conflict", .bool(a.conflict))]
        if a.empty { fields.append(("empty", .bool(true))) }
        if let error = a.error { fields.append(("error", .string(JSText(error)))) }
        return fields
    }
    static func edits(_ edits: [RepositoryEffects.Edit]) -> JSValue {
        .array(edits.map { edit in object([("file", .string(JSText(edit.file))),
            ("before", .string(JSText(String(decoding: edit.before, as: UTF8.self)))),
            ("after", .string(JSText(String(decoding: edit.after, as: UTF8.self))))]) })
    }

    static func reply(id: JSValue, frame: PipeFrame?, result: PreferencesOwner.Answer) -> Data {
        let body: JSValue
        switch result {
        case .succeeded(let payload): body = object([("kind", .string(JSText("succeeded"))), ("payload", payload)])
        case .failed(let failure): body = object([("kind", .string(JSText("failed"))), ("payload", PreferencesOwner.value(failure))])
        }
        var reply: [(String, JSValue)] = []
        if let frame {
            reply = [("connection", .string(JSText(frame.connection))), ("requestID", .string(JSText(frame.requestID))),
                     ("operationID", .string(JSText(frame.operationID))), ("scope", .object([]))]
        }
        reply.append(("result", body))
        return object([("event", .string(JSText("service-reply"))), ("service", .string(JSText(service))), ("id", id), ("reply", object(reply))]).utf8()
    }
}

/// Immutable once parsed; handed from the intake queue to the lane that runs it.
extension PipeFrame: @unchecked Sendable {}

/// A request body: exactly the allowed fields, each well-formed.
struct Body: Sendable {
    private let fields: [String: JSValue]

    init(_ frame: PipeFrame, required: Set<String>, optional: Set<String>) throws {
        var fields: [String: JSValue] = [:]
        for (name, value) in frame.body {
            let key = name.string
            guard required.union(optional).contains(key), fields[key] == nil else { throw ServiceContractFailure.invalidRequest }
            fields[key] = value
        }
        guard required.isSubset(of: Set(fields.keys)) else { throw ServiceContractFailure.invalidRequest }
        self.fields = fields
    }

    func has(_ key: String) -> Bool { fields[key] != nil }
    func value(_ key: String) -> JSValue? { fields[key] }

    /// Well-formed text (no lone surrogate), no NUL, at most 64 Ki UTF-16 units.
    static func text(_ value: JSValue?) throws -> String {
        guard let text = value?.text, text.count <= 65_536, !text.contains(0), JSText(text.string) == text else {
            throw ServiceContractFailure.invalidRequest
        }
        return text.string
    }

    func string(_ key: String) throws -> String { try Self.text(fields[key]) }

    func path(_ key: String) throws -> String {
        let value = try string(key)
        guard value.hasPrefix("/"), value.utf16.count <= 4096 else { throw ServiceContractFailure.invalidRequest }
        return value
    }

    func bool(_ key: String) throws -> Bool {
        guard case .bool(let value)? = fields[key] else { throw ServiceContractFailure.invalidRequest }
        return value
    }

    /// An absent optional list is empty.
    func strings(_ key: String) throws -> [String] {
        guard let value = fields[key] else { return [] }
        guard case .array(let items) = value, items.count <= 100_000 else { throw ServiceContractFailure.invalidRequest }
        return try items.map { try Self.text($0) }
    }

    func worktree() throws -> RepositoryWorktree {
        guard case .object(let parts)? = fields["worktree"], parts.count == 5,
              Set(parts.map { $0.0.string }) == ["id", "repoRoot", "path", "branch", "baseSha"],
              let value = fields["worktree"] else { throw ServiceContractFailure.invalidRequest }
        let wt = RepositoryWorktree(id: try Self.text(value["id"]), repoRoot: try Self.text(value["repoRoot"]), path: try Self.text(value["path"]),
                                    branch: try Self.text(value["branch"]), baseSha: try Self.text(value["baseSha"]))
        guard wt.path.hasPrefix("/"), wt.repoRoot.hasPrefix("/"), RepositoryPaths.isWorkBranch(wt.branch),
              wt.baseSha.range(of: #"^([0-9a-f]{40}|[0-9a-f]{64})$"#, options: .regularExpression) != nil else {
            throw ServiceContractFailure.invalidRequest
        }
        return wt
    }
}
