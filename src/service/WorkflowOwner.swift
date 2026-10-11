import Foundation
import Darwin

/// The workflow owner (S13, LKM-100): the Swift application service for Trezi's
/// side-effecting workflows outside a chat turn:
/// - publication: Publish (merge or PR), the notes handoff PR and a saved run's PR,
///   with the remote reconciliation, PR creation/reuse and merge (`WorkflowPublish`);
/// - remote Git actions: Connect to GitHub, fetch, pull and remote branch switches
///   (`WorkflowRemote`);
/// - project setup: the instrumentation helpers under `.trezi/`, their removal, and
///   new projects (files, first commit, dependency install) (`WorkflowSetup`);
/// - Trezi's own update (pull, install, build) and the diagnosis memory.
/// Each run is a durable record (`WorkflowJournal`): the intent of every step is on
/// disk before its effect and its receipt after, so a reply lost after a remote effect,
/// a crash or a retry never repeats a PR, a merge or an update; an uncertain step is
/// reconciled from what GitHub and Git actually hold. Effects run in the repository's
/// lane (`RepositoryOwner.serialize`). Bun keeps the JS helpers that only propose
/// bounded results: PR descriptions, framework detection and helper sources, project
/// templates, diagnoses; and the sheets that collect the user's explicit intent.
final class WorkflowOwner: @unchecked Sendable {
    static let service = "workflow"

    struct Options {
        var profile: String
        var environment: [String: String]
        /// The Bun executable that runs Trezi (Trezi's own install and build).
        var bun: String?
        /// Test hook: named points between an effect and its receipt (a fixture crashes there).
        var fault: (@Sendable (String) -> Void)?
        var gitTimeout: TimeInterval = 300
        var ghTimeout: TimeInterval = 120
        var installTimeout: TimeInterval = 600
        var buildTimeout: TimeInterval = 900
        var skillsTimeout: TimeInterval = 120
    }

    /// method → (required, optional, intent it must carry)
    static let methods: [String: (required: Set<String>, optional: Set<String>, intent: String?)] = [
        "workflows": ([], [], nil), "diagnosis": (["root", "signature"], [], nil),
        "publish": (["root", "mode", "intent"], ["leases"], "publish"),
        "handoff": (["root", "title", "notes", "intent"], ["leases"], "publish"),
        "branchPr": (["root", "branch", "intent"], ["leases"], "publish"),
        "describe": (["workflow"], ["title", "body", "error", "leases"], nil),
        "cancel": (["kind", "root"], [], nil),
        "dismiss": (["workflow", "intent"], [], "dismiss"),
        "connect": (["root", "name", "owner", "private", "intent"], ["leases"], "connect"),
        "remoteStatus": (["root", "fetch"], ["leases"], nil),
        "remoteUpdate": (["root", "action", "ref", "expectedBranch", "busy", "intent"], ["leases"], "update"),
        "setup": (["root", "files", "intent"], ["leases"], "setup"),
        "uninstall": (["root", "intent"], ["leases"], "uninstall"),
        "createProject": (["root", "files", "install", "intent"], [], "create"),
        "update": (["root", "intent"], [], "update"),
        "feedback": (["root", "title", "body", "intent"], [], "feedback"),
        "ciRerun": (["root", "commit", "intent"], ["leases"], "rerun"),
        "skills": (["root", "packId", "scope", "repo", "skills", "title", "intent"], [], "skills"),
        "updateCheck": (["root"], ["leases"], nil),
        "remember": (["root", "diagnosis"], [], nil),
        "diagnosisStatus": (["root", "signature", "status"], [], nil),
    ]
    static let reads: Set<String> = ["workflows", "diagnosis"]
    /// Workflows that are durable records (the rest answer directly).
    static let recorded: Set<String> = ["publish", "handoff", "branchPr", "connect", "remoteUpdate", "setup", "uninstall", "createProject", "update", "feedback", "skills", "ciRerun"]
    /// One open publication per repository, as the legacy publish lock allowed.
    static let exclusive: Set<String> = ["publish", "handoff", "branchPr", "connect"]
    static let busyMessage = "A publish is already in progress for this repository."

    let options: Options
    let journal: WorkflowJournal
    let diagnoses: WorkflowDiagnoses
    private let send: @Sendable (Data) -> Void
    private let repository: RepositoryOwner
    private let intake = DispatchQueue(label: "dev.trezi.workflow.intake")
    private let lock = NSLock()
    private var closed = false
    private var journalFailure: String?
    private let inflight = DispatchGroup()
    /// Frames waiting for an operation still running (a re-sent request joins it).
    private var waiting: [String: [PipeFrame]] = [:]
    private var cancelled: Set<String> = []
    private var processes: [String: Set<pid_t>] = [:]
    private var progress: [String: String] = [:]
    /// The step a publish is on (LKM-187), in memory: `workflows` reports it to the
    /// toolbar and every step's time goes to the product log.
    private var phases: [String: (step: String, since: Date, at: String, began: Date)] = [:]

    init(options: Options, repository: RepositoryOwner, send: @escaping @Sendable (Data) -> Void) {
        self.options = options; self.repository = repository; self.send = send
        journal = WorkflowJournal(profile: options.profile)
        do { try journal.open() } catch { journalFailure = "\(error)" }
        journal.prune()
        diagnoses = WorkflowDiagnoses(profile: options.profile)
    }

    // MARK: Requests (from the backend reader thread, in pipe order)

    func submit(_ line: Data) {
        let frame: PipeFrame
        do { frame = try PipeFrame(line, service: Self.service, maxDepth: 16) } catch {
            let code = error as? ServiceContractFailure ?? .invalidRequest
            send(SourceOwner.reply(service: Self.service, id: (try? JSValue.parse(line, maxDepth: 16))?["id"] ?? .null, frame: nil,
                                   result: .failed(RepositoryOwner.fail(code, "Invalid workflow request."))))
            return
        }
        lock.lock()
        let refused = closed
        if !refused { inflight.enter() }
        lock.unlock()
        if refused { return answer(frame, .failed(Self.stopping), counted: false) }
        intake.async {
            do { try self.accept(frame) } catch { self.answer(frame, .failed(Self.failure(error))) }
        }
    }

    private func accept(_ frame: PipeFrame) throws {
        guard frame.expectedRevision == nil, let rule = Self.methods[frame.method],
              frame.mode == (Self.reads.contains(frame.method) ? "read" : "mutation") else { throw ServiceContractFailure.invalidRequest }
        let body = try Body(frame, required: rule.required, optional: rule.optional)
        if let intent = rule.intent, try body.string("intent") != intent { throw ServiceContractFailure.invalidRequest }
        switch frame.method {
        case "workflows": return answer(frame, .succeeded(.array(journal.all().map { $0.summary(progress: progressOf($0.id), step: phaseOf($0.id)) })))
        case "diagnosis":
            return answer(frame, .succeeded(try diagnoses.recall(root: try body.path("root"), signature: try Self.signature(body))))
        case "remember":
            guard case .object? = body.value("diagnosis") else { throw ServiceContractFailure.invalidRequest }
            try diagnoses.remember(root: try body.path("root"), diagnosis: body.value("diagnosis")!)
            return answer(frame, .succeeded(.object([])))
        case "diagnosisStatus":
            let status = try body.string("status")
            guard status == "applied" || status == "dismissed" else { throw ServiceContractFailure.invalidRequest }
            try diagnoses.setStatus(root: try body.path("root"), signature: try Self.signature(body), status: status)
            return answer(frame, .succeeded(.object([])))
        case "cancel": return answer(frame, .succeeded(try cancel(kind: try body.string("kind"), root: try body.path("root"))))
        case "dismiss":
            let id = try body.string("workflow")
            guard let record = journal.record(id), WorkflowRecord.resumable.contains(record.state) else {
                throw RepositoryRefusal(.conflict, "Only an interrupted, failed or cancelled workflow can be dismissed.")
            }
            try journal.update(id) { $0.state = "dismissed" }
            return answer(frame, .succeeded(.object([])))
        case "remoteStatus":
            let root = try body.path("root"), fetch = try body.bool("fetch")
            return lane(frame, root: root, leases: try body.strings("leases")) {
                try WorkflowRemote(context: self.context(id: nil, root: root)).status(fetch: fetch)
            }
        case "updateCheck":
            let root = try body.path("root")
            return lane(frame, root: root, leases: try body.strings("leases")) {
                WorkflowRemote(context: self.context(id: nil, root: root)).updateCheck()
            }
        default: break
        }
        if let failure = journalFailure { throw RepositoryRefusal(.recoveryRequired, "The workflow journal is unavailable: \(failure)") }
        // A request re-sent after a lost reply: answer from its receipt, or join it.
        if let done = journal.answered(frame.operationID), let payload = done.reply(frame.operationID) {
            return answer(frame, .succeeded(payload))
        }
        lock.lock()
        if waiting[frame.operationID] != nil { waiting[frame.operationID]!.append(frame); lock.unlock(); return }
        lock.unlock()
        if frame.method == "describe" { return try describe(frame, body) }
        guard Self.recorded.contains(frame.method) else { throw ServiceContractFailure.invalidRequest }
        let root = try body.path("root")
        let kind = frame.method
        let params = try Self.params(kind, body)
        let leases = try body.strings("leases")
        let key = repository.effects.lane(root)
        let open = journal.all().filter { WorkflowRecord.open.contains($0.state) && $0.lane == key }
        if Self.exclusive.contains(kind), open.contains(where: { Self.exclusive.contains($0.kind) }) {
            return answer(frame, .succeeded(Self.object([("stage", .string(JSText("done"))),
                ("result", Self.object([("ok", .bool(false)), ("error", .string(JSText(Self.busyMessage)))]))])))
        }
        // The run this request may resume: same repository (or the same folder, for a
        // project that became a repository in that run).
        let prior = journal.all().last { ($0.lane == key || $0.root == root) && $0.kind == kind && WorkflowRecord.resumable.contains($0.state) && !$0.steps.isEmpty }
        let record = WorkflowRecord(id: UUID().uuidString.lowercased(), kind: kind, root: root, lane: key, params: params,
                                    state: "running", started: WorkflowJournal.now())
        try journal.save(record)
        lock.lock(); waiting[frame.operationID] = [frame]; lock.unlock()
        let scheduled = repository.serialize(root: root, leases: leases) { self.run(record.id, operation: frame.operationID, prior: prior) }
        if !scheduled { settle(record.id, operation: frame.operationID, failure: Self.stopping) }
    }

    /// Phase two of a publication: Bun's description helper proposed a title and body,
    /// or reports why it could not (`error`; the workflow then undoes what the legacy
    /// route undid and answers its message).
    private func describe(_ frame: PipeFrame, _ body: Body) throws {
        let id = try body.string("workflow")
        var fields: [(String, JSValue)]
        if body.has("error") {
            guard !body.has("title"), !body.has("body") else { throw ServiceContractFailure.invalidRequest }
            fields = [("describeError", .string(JSText(String(try body.string("error").prefix(4000)))))]
        } else {
            let title = try body.string("title"), text = try body.string("body")
            guard !title.isEmpty, title.utf16.count <= 256, text.utf16.count <= 60_000 else { throw ServiceContractFailure.invalidRequest }
            fields = [("prTitle", .string(JSText(title))), ("prBody", .string(JSText(text)))]
        }
        let leases = try body.strings("leases")
        guard let record = journal.record(id), record.state == "describe" else {
            throw RepositoryRefusal(.conflict, "This publish is no longer waiting for its description.")
        }
        try journal.update(id) { $0.state = "running"; $0.params = Self.merge($0.params, fields) }
        lock.lock(); waiting[frame.operationID] = [frame]; lock.unlock()
        let scheduled = repository.serialize(root: record.root, leases: leases) {
            self.run(id, operation: frame.operationID, prior: nil)
        }
        if !scheduled { settle(id, operation: frame.operationID, failure: Self.stopping) }
    }

    // MARK: Running (inside the lane)

    func context(id: String?, root: String) -> WorkflowContext { WorkflowContext(owner: self, id: id, root: root) }

    private func run(_ id: String, operation: String, prior: WorkflowRecord?) {
        lock.lock(); let refused = closed; lock.unlock()
        if refused { return settle(id, operation: operation, failure: Self.stopping) }
        guard let record = journal.record(id) else { return settle(id, operation: operation, failure: Self.stopping) }
        let context = self.context(id: id, root: record.root)
        var outcome: WorkflowOutcome
        do {
            if let prior { try journal.update(prior.id) { $0.state = "superseded" } }
            switch record.kind {
            case "publish", "handoff", "branchPr": outcome = try WorkflowPublish(context: context).run(record, prior: prior)
            case "connect": outcome = try WorkflowRemote(context: context).connect(record, prior: prior)
            case "remoteUpdate": outcome = try WorkflowRemote(context: context).update(record)
            case "setup": outcome = try WorkflowSetup(context: context).setup(record)
            case "uninstall": outcome = try WorkflowSetup(context: context).uninstall(record)
            case "createProject": outcome = try WorkflowSetup(context: context).create(record, prior: prior)
            case "update": outcome = try WorkflowSetup(context: context).update(record, prior: prior)
            case "feedback": outcome = try WorkflowTools(context: context).feedback(record, prior: prior)
            case "ciRerun": outcome = try WorkflowTools(context: context).ciRerun(record, prior: prior)
            case "skills": outcome = try WorkflowTools(context: context).skills(record)
            default: throw ServiceContractFailure.invalidRequest
            }
        } catch let cancel as WorkflowCancelled {
            outcome = .failed(Self.object([("ok", .bool(false)), ("error", .string(JSText(cancel.message))), ("cancelled", .bool(true))]), state: "cancelled")
        } catch {
            outcome = .failed(Self.object([("ok", .bool(false)), ("error", .string(JSText(WorkflowJournal.redact("\(error)"))))]), state: "failed")
        }
        // A publish waits for its description as a step of its own; a failure names its step.
        if record.kind == "publish" {
            switch outcome {
            case .describe: phase(id, "describe")
            case .done: endPhase(id, state: "done")
            case .failed(let result, let failed):
                if let step = endPhase(id, state: failed) { outcome = .failed(Self.merge(result, [("step", .string(JSText(step)))]), state: failed) }
            }
        }
        let payload: JSValue, state: String
        switch outcome {
        case .done(let result): payload = Self.object([("workflow", .string(JSText(id))), ("stage", .string(JSText("done"))), ("result", result)]); state = "done"
        case .failed(let result, let failed): payload = Self.object([("workflow", .string(JSText(id))), ("stage", .string(JSText("done"))), ("result", result)]); state = failed
        case .describe(let fields): payload = Self.object([("workflow", .string(JSText(id))), ("stage", .string(JSText("describe")))] + fields); state = "describe"
        }
        do {
            try journal.update(id) { record in
                record.replies.append((operation, payload)); record.state = state
                if state != "describe" { record.result = payload["result"] }
            }
        } catch {
            return settle(id, operation: operation, failure: RepositoryOwner.fail(.ioFailure, "The workflow journal could not be written: \(error)"))
        }
        lock.lock(); cancelled.remove(id); processes.removeValue(forKey: id); lock.unlock()
        if state != "describe" { journal.prune() }
        settle(id, operation: operation, payload: payload)
    }

    private func settle(_ id: String, operation: String, payload: JSValue? = nil, failure: ServiceFailure? = nil) {
        if failure != nil, let record = journal.record(id), record.state == "running" {
            _ = try? journal.update(id) { $0.state = $0.steps.isEmpty ? "failed" : "interrupted" }
            if phaseOf(id) != nil { endPhase(id, state: "interrupted") }
        }
        lock.lock(); let frames = waiting.removeValue(forKey: operation) ?? []; lock.unlock()
        for frame in frames { answer(frame, payload.map { .succeeded($0) } ?? .failed(failure!)) }
    }

    /// Runs a direct (unrecorded) request in the repository lane.
    private func lane(_ frame: PipeFrame, root: String, leases: [String], _ effect: @escaping @Sendable () throws -> JSValue) {
        let scheduled = repository.serialize(root: root, leases: leases) {
            self.lock.lock(); let refused = self.closed; self.lock.unlock()
            if refused { return self.answer(frame, .failed(Self.stopping)) }
            do { self.answer(frame, .succeeded(try effect())) } catch { self.answer(frame, .failed(Self.failure(error))) }
        }
        if !scheduled { answer(frame, .failed(Self.stopping)) }
    }

    // MARK: Cancellation and processes

    /// Cancels the open workflow of `kind` on `root`'s repository: no further step
    /// starts, a running local step (install, build) is stopped; a remote step
    /// already sent finishes and is recorded. A publication waiting for its
    /// description ends at once (its branch stays pushed, no PR is created).
    private func cancel(kind: String, root: String) throws -> JSValue {
        let key = repository.effects.lane(root)
        guard let record = journal.all().last(where: { $0.kind == kind && $0.lane == key && WorkflowRecord.open.contains($0.state) }) else {
            return Self.object([("cancelled", .bool(false))])
        }
        if record.state == "describe" {
            try journal.update(record.id) { $0.state = "cancelled"
                $0.result = Self.object([("ok", .bool(false)), ("error", .string(JSText("Publishing was cancelled before the pull request was created."))), ("cancelled", .bool(true))]) }
            if phaseOf(record.id) != nil { endPhase(record.id, state: "cancelled") }
            return Self.object([("cancelled", .bool(true)), ("workflow", .string(JSText(record.id)))])
        }
        lock.lock()
        cancelled.insert(record.id)
        let pids = processes[record.id] ?? []
        lock.unlock()
        for pid in pids { kill(-pid, SIGTERM) }
        return Self.object([("cancelled", .bool(true)), ("workflow", .string(JSText(record.id)))])
    }

    func isCancelled(_ id: String) -> Bool { lock.lock(); defer { lock.unlock() }; return cancelled.contains(id) }

    /// An observer for a step's command: an interruptible one registers its group for
    /// cancellation; every one feeds the workflow's progress tail.
    func observer(_ id: String, interruptible: Bool) -> ToolObserver {
        ToolObserver(started: { [weak self] pid in
            guard let self, interruptible else { return }
            self.lock.lock(); self.processes[id, default: []].insert(pid); let stop = self.cancelled.contains(id); self.lock.unlock()
            if stop { kill(-pid, SIGTERM) }
        }, output: { [weak self] chunk in
            guard let self else { return }
            self.lock.lock()
            let text = (self.progress[id] ?? "") + String(decoding: chunk, as: UTF8.self)
            self.progress[id] = String(text.suffix(16_000))
            self.lock.unlock()
        })
    }

    func finishedProcess(_ id: String) { lock.lock(); processes[id] = []; lock.unlock() }

    private func progressOf(_ id: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        return progress[id].map { WorkflowJournal.redact($0).split(separator: "\n").suffix(4).joined(separator: "\n") }
    }

    // MARK: Publish steps (LKM-187)

    /// The publish moved to `step`; the product log gets the time the previous one took.
    func phase(_ id: String, _ step: String) {
        let now = Date()
        lock.lock()
        let previous = phases[id]
        if previous?.step != step { phases[id] = (step, now, WorkflowJournal.now(), previous?.began ?? now) }
        lock.unlock()
        guard previous?.step != step else { return }
        if let previous {
            ProductLog.info("publish", "Publish step step=\(previous.step) ms=\(Self.ms(previous.since, now)) workflow=\(id.prefix(8))")
        } else {
            ProductLog.info("publish", "Publish started workflow=\(id.prefix(8))")
        }
    }

    /// Ends a publish's step tracking with its last step's and the whole run's time.
    @discardableResult
    func endPhase(_ id: String, state: String) -> String? {
        let now = Date()
        lock.lock(); let last = phases.removeValue(forKey: id); lock.unlock()
        let timing = last.map { " ms=\(Self.ms($0.since, now)) total=\(Self.ms($0.began, now))" } ?? ""
        ProductLog.write(state == "done" ? "info" : "warn", "publish",
                         "Publish \(state) step=\(last?.step ?? "none")\(timing) workflow=\(id.prefix(8))")
        return last?.step
    }

    private func phaseOf(_ id: String) -> (name: String, since: String)? {
        lock.lock(); defer { lock.unlock() }
        return phases[id].map { ($0.step, $0.at) }
    }

    private static func ms(_ from: Date, _ to: Date) -> Int { Int((to.timeIntervalSince(from) * 1000).rounded()) }

    // MARK: Drain

    func refuse() { lock.lock(); closed = true; lock.unlock() }

    /// Refuses new requests and lets running workflows finish (bounded). One cut short
    /// is `interrupted` in the journal at the next launch and reconciled when resumed.
    @discardableResult
    func close(timeout: TimeInterval) -> Bool {
        refuse()
        return inflight.wait(timeout: .now() + timeout) == .success
    }

    // MARK: Values

    static func params(_ kind: String, _ body: Body) throws -> JSValue {
        switch kind {
        case "publish":
            let mode = try body.string("mode")
            guard mode == "merge" || mode == "pr" else { throw ServiceContractFailure.invalidRequest }
            return object([("mode", .string(JSText(mode)))])
        case "handoff":
            guard case .number(let notes)? = body.value("notes"), notes >= 0, notes.rounded() == notes else { throw ServiceContractFailure.invalidRequest }
            let title = try body.string("title")
            guard title.utf16.count <= 256 else { throw ServiceContractFailure.invalidRequest }
            return object([("title", .string(JSText(title))), ("notes", .number(notes))])
        case "branchPr":
            let branch = try body.string("branch")
            guard !branch.isEmpty, !branch.hasPrefix("-"), branch.utf16.count <= 255 else { throw ServiceContractFailure.invalidRequest }
            return object([("branch", .string(JSText(branch)))])
        case "connect":
            let name = try body.string("name"), owner = try body.string("owner").trimmingCharacters(in: .whitespaces)
            guard name.range(of: #"^[a-z0-9._-]{1,100}$"#, options: .regularExpression) != nil,
                  owner.isEmpty || owner.range(of: #"^[A-Za-z0-9][A-Za-z0-9-]{0,38}$"#, options: .regularExpression) != nil else {
                throw ServiceContractFailure.invalidRequest
            }
            return object([("name", .string(JSText(name))), ("owner", .string(JSText(owner))), ("private", .bool(try body.bool("private")))])
        case "remoteUpdate":
            let action = try body.string("action"), ref = try body.string("ref")
            guard ref.hasPrefix("refs/remotes/"), !ref.contains("..") else { throw ServiceContractFailure.invalidRequest }
            let expected: JSValue = body.value("expectedBranch") == .null ? .null : .string(JSText(try body.string("expectedBranch")))
            return object([("action", .string(JSText(action))), ("ref", .string(JSText(ref))), ("expectedBranch", expected), ("busy", .bool(try body.bool("busy")))])
        case "setup": return object([("files", try WorkflowSetup.helperFiles(body.value("files")))])
        case "createProject":
            let install: JSValue = body.value("install") == .null ? .null : .string(JSText(try body.string("install")))
            guard install == .null || install == .string(JSText("bun")) || install == .string(JSText("npm")) else { throw ServiceContractFailure.invalidRequest }
            return object([("files", try WorkflowSetup.projectFiles(body.value("files"))), ("install", install)])
        case "feedback": return try WorkflowTools.feedbackParams(body)
        case "ciRerun":
            let commit = try body.string("commit")
            guard commit.range(of: #"^[0-9a-f]{40}$"#, options: .regularExpression) != nil else { throw ServiceContractFailure.invalidRequest }
            return object([("commit", .string(JSText(commit)))])
        case "skills": return try WorkflowTools.skillsParams(body)
        default: return .object([])
        }
    }

    static func signature(_ body: Body) throws -> String {
        let signature = try body.string("signature")
        guard signature.range(of: #"^[0-9a-f]{1,16}$"#, options: .regularExpression) != nil else { throw ServiceContractFailure.invalidRequest }
        return signature
    }

    static func merge(_ value: JSValue, _ fields: [(String, JSValue)]) -> JSValue {
        guard case .object(var existing) = value else { return value }
        for (key, item) in fields {
            existing.removeAll { $0.0 == JSText(key) }
            existing.append((JSText(key), item))
        }
        return .object(existing)
    }

    static func object(_ fields: [(String, JSValue)]) -> JSValue { RepositoryOwner.object(fields) }

    static func failure(_ error: Error) -> ServiceFailure {
        if let code = error as? ServiceContractFailure { return RepositoryOwner.fail(code, "Invalid workflow request.") }
        if let refusal = error as? RepositoryRefusal { return RepositoryOwner.fail(refusal.code, refusal.message) }
        return RepositoryOwner.fail(.ioFailure, WorkflowJournal.redact("\(error)"))
    }

    static let stopping = RepositoryOwner.fail(.unavailable, "The service is stopping; the workflow did not start or will resume when asked again.", retryable: true)

    private func answer(_ frame: PipeFrame, _ result: PreferencesOwner.Answer, counted: Bool = true) {
        send(SourceOwner.reply(service: Self.service, id: frame.id, frame: frame, result: result))
        if counted { inflight.leave() }
    }
}
