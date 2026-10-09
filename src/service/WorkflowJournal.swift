import Foundation
import Darwin

/// One step of a workflow. `intent` is written (and synced) before the step's first
/// effect; `done` carries the receipt; a step found at `intent` after a crash becomes
/// `uncertain` and is reconciled from observed state before anything is repeated.
struct WorkflowStep: Sendable {
    var name: String
    var state: String
    var receipt: JSValue = .object([])
    var message: String?
    var at: String

    func value() -> JSValue {
        var fields: [(String, JSValue)] = [("name", .string(JSText(name))), ("state", .string(JSText(state))), ("receipt", receipt)]
        if let message { fields.append(("message", .string(JSText(message)))) }
        fields.append(("at", .string(JSText(at))))
        return RepositoryOwner.object(fields)
    }

    init(name: String, state: String, receipt: JSValue = .object([]), message: String? = nil, at: String) {
        self.name = name; self.state = state; self.receipt = receipt; self.message = message; self.at = at
    }

    init?(_ value: JSValue) {
        guard let name = value["name"]?.text?.string, let state = value["state"]?.text?.string, let at = value["at"]?.text?.string else { return nil }
        self.init(name: name, state: state, receipt: value["receipt"] ?? .object([]), message: value["message"]?.text?.string, at: at)
    }
}

/// A durable workflow (S13): publication, remote Git actions, project setup and
/// Trezi updates. `replies` maps every operation ID that asked for this workflow to
/// the answer it got, so a request re-sent after a lost reply is answered from the
/// receipt instead of repeating a side effect.
struct WorkflowRecord: Sendable {
    /// running (effects under way) · describe (waiting for Bun's description helper)
    /// · done · failed · cancelled · interrupted (found unfinished at launch)
    /// · superseded (a later request resumed or replaced it) · dismissed
    static let open: Set<String> = ["running", "describe"]
    static let resumable: Set<String> = ["interrupted", "failed", "cancelled"]

    var id: String
    var kind: String
    var root: String
    var lane: String
    var params: JSValue
    var state: String
    var steps: [WorkflowStep] = []
    var replies: [(String, JSValue)] = []
    var result: JSValue?
    var started: String
    var updated: String

    func step(_ name: String) -> WorkflowStep? { steps.last { $0.name == name } }
    func reply(_ operation: String) -> JSValue? { replies.first { $0.0 == operation }?.1 }
    func param(_ key: String) -> String? { params[key]?.text?.string }

    func value() -> JSValue {
        RepositoryOwner.object([("version", .number(1)), ("id", .string(JSText(id))), ("kind", .string(JSText(kind))),
            ("root", .string(JSText(root))), ("lane", .string(JSText(lane))), ("params", params), ("state", .string(JSText(state))),
            ("steps", .array(steps.map { $0.value() })),
            ("replies", .array(replies.map { RepositoryOwner.object([("operation", .string(JSText($0.0))), ("payload", $0.1)]) })),
            ("result", result ?? .null), ("started", .string(JSText(started))), ("updated", .string(JSText(updated)))])
    }

    /// What Bun (and the recovery UI) sees: no stored replies. `step` is the step a
    /// running publish is on and since when (LKM-187).
    func summary(progress: String?, step: (name: String, since: String)? = nil) -> JSValue {
        var fields: [(String, JSValue)] = [("id", .string(JSText(id))), ("kind", .string(JSText(kind))), ("root", .string(JSText(root))),
            ("params", params), ("state", .string(JSText(state))), ("steps", .array(steps.map { $0.value() })),
            ("result", result ?? .null), ("started", .string(JSText(started))), ("updated", .string(JSText(updated)))]
        if let progress { fields.append(("progress", .string(JSText(progress)))) }
        if let step, WorkflowRecord.open.contains(state) {
            fields.append(("step", .string(JSText(step.name)))); fields.append(("stepSince", .string(JSText(step.since))))
        }
        return RepositoryOwner.object(fields)
    }

    init(id: String, kind: String, root: String, lane: String, params: JSValue, state: String, started: String) {
        self.id = id; self.kind = kind; self.root = root; self.lane = lane; self.params = params; self.state = state
        self.started = started; updated = started
    }

    init?(_ value: JSValue) {
        guard value["version"] == .number(1), let id = value["id"]?.text?.string, let kind = value["kind"]?.text?.string,
              let root = value["root"]?.text?.string, let lane = value["lane"]?.text?.string, let state = value["state"]?.text?.string,
              case .object? = value["params"], case .array(let steps)? = value["steps"], case .array(let replies)? = value["replies"],
              let started = value["started"]?.text?.string, let updated = value["updated"]?.text?.string else { return nil }
        self.init(id: id, kind: kind, root: root, lane: lane, params: value["params"]!, state: state, started: started)
        self.updated = updated
        self.steps = steps.compactMap(WorkflowStep.init)
        self.replies = replies.compactMap { item in item["operation"]?.text.map { ($0.string, item["payload"] ?? .null) } }
        if let result = value["result"], result != .null { self.result = result }
    }
}

/// `<profile>/service/workflows/<id>.json`, one file per workflow, each transition
/// replaced atomically and synced before it is acted on or acknowledged. At launch
/// every workflow a crash left open is marked `interrupted` and its unfinished steps
/// `uncertain`. A damaged file is left untouched (and reported), never rewritten.
final class WorkflowJournal: @unchecked Sendable {
    static let keepFinished = 100
    static let keepResumable = 5
    static let keepRefused = 20
    static let keepSuperseded = 10

    let directory: URL
    private let lock = NSLock()
    private var records: [String: WorkflowRecord] = [:]
    private(set) var damaged: [String] = []

    init(profile: String) {
        directory = URL(fileURLWithPath: profile).appendingPathComponent("service/workflows")
    }

    func open() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path).filter { $0.hasSuffix(".json") && !$0.hasPrefix(".") }
        for name in names.sorted() {
            let url = directory.appendingPathComponent(name)
            guard let data = try? Data(contentsOf: url), let value = try? JSValue.parse(data, maxDepth: 64),
                  var record = WorkflowRecord(value), record.id + ".json" == name else { damaged.append(name); continue }
            if WorkflowRecord.open.contains(record.state) {
                record.state = "interrupted"
                for index in record.steps.indices where record.steps[index].state == "intent" { record.steps[index].state = "uncertain" }
                record.updated = Self.now()
                try write(record)
            }
            records[record.id] = record
        }
    }

    /// Milliseconds: records are ordered by when they started.
    static func now() -> String { WorkflowDiagnoses.now() }

    private func write(_ record: WorkflowRecord) throws {
        try SourcePaths.write(record.value().utf8(), to: directory.appendingPathComponent(record.id + ".json").path)
    }

    /// Creates or replaces a record; returns only once it is on disk.
    func save(_ record: WorkflowRecord) throws {
        lock.lock(); defer { lock.unlock() }
        var record = record
        record.updated = Self.now()
        try write(record)
        records[record.id] = record
    }

    /// Applies `change` to the stored record and persists it before returning.
    @discardableResult
    func update(_ id: String, _ change: (inout WorkflowRecord) -> Void) throws -> WorkflowRecord {
        lock.lock(); defer { lock.unlock() }
        guard var record = records[id] else { throw RepositoryRefusal(.notFound, "No such workflow.") }
        change(&record)
        record.updated = Self.now()
        try write(record)
        records[id] = record
        return record
    }

    func record(_ id: String) -> WorkflowRecord? { lock.lock(); defer { lock.unlock() }; return records[id] }

    func all() -> [WorkflowRecord] {
        lock.lock(); defer { lock.unlock() }
        return records.values.sorted { ($0.started, $0.id) < ($1.started, $1.id) }
    }

    /// The workflow an operation ID already asked for, if any.
    func answered(_ operation: String) -> WorkflowRecord? {
        lock.lock(); defer { lock.unlock() }
        return records.values.first { record in record.replies.contains { $0.0 == operation } }
    }

    /// Bounds the journal (never touches an open record):
    /// - a failed or cancelled run with no steps was refused before its first effect (not
    ///   signed in, dirty checkout, busy agents): nothing to reconcile, and `accept` never
    ///   picks one as `prior`. Only the newest `keepRefused` remain, so a lost reply to a
    ///   refusal can still be answered from its record;
    /// - runs that did something and stopped (interrupted, failed, cancelled) are kept as
    ///   receipts, the newest `keepResumable` per repository and kind (only the last is
    ///   ever resumed);
    /// - finished results keep the `keepFinished` most recent; superseded and dismissed
    ///   records only `keepSuperseded`.
    func prune() {
        lock.lock(); defer { lock.unlock() }
        var keep = Set<String>(), perKind: [String: Int] = [:], refused = 0
        for record in records.values.sorted(by: { ($0.updated, $0.id) > ($1.updated, $1.id) }) {
            guard !WorkflowRecord.open.contains(record.state), WorkflowRecord.resumable.contains(record.state) else { continue }
            if record.steps.isEmpty {
                if refused < Self.keepRefused { refused += 1; keep.insert(record.id) }
            } else {
                let key = record.lane + "\0" + record.kind
                if perKind[key, default: 0] < Self.keepResumable { perKind[key, default: 0] += 1; keep.insert(record.id) }
            }
        }
        // Finished runs: results (done) keep the newest `keepFinished`; superseded and
        // dismissed ones (a later request took over, or the user let go) only `keepSuperseded`.
        func newest(_ states: Set<String>, _ count: Int) -> [String] {
            records.values.filter { states.contains($0.state) }.sorted { ($0.updated, $0.id) > ($1.updated, $1.id) }.dropFirst(count).map(\.id)
        }
        var drop = Set(newest(["done"], Self.keepFinished) + newest(["superseded", "dismissed"], Self.keepSuperseded))
        for record in records.values where !WorkflowRecord.open.contains(record.state) && WorkflowRecord.resumable.contains(record.state) && !keep.contains(record.id) {
            drop.insert(record.id)
        }
        for id in drop {
            unlink(directory.appendingPathComponent(id + ".json").path)
            records.removeValue(forKey: id)
        }
    }

    /// Redacts credentials from text that is stored or returned: userinfo in URLs and
    /// GitHub tokens (git and gh echo remote URLs in their errors).
    static func redact(_ text: String) -> String {
        var out = text.replacingOccurrences(of: #"([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@\s]+@"#, with: "$1***@", options: .regularExpression)
        out = out.replacingOccurrences(of: #"\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})"#, with: "***", options: .regularExpression)
        return out
    }
}
