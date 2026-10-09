import Foundation

/// intent → effect → committed | failed; intent → cancelled | abandoned (restart
/// before any effect); effect → uncertain (restart or unknown error after the effect
/// began) → committed | failed by explicit reconciliation, never by replay.
enum LedgerPhase: String, Codable, Sendable {
    case intent, effect, committed, failed, cancelled, abandoned, uncertain
    var isFinal: Bool { self == .committed || self == .failed || self == .cancelled || self == .abandoned }
}

struct LedgerOperation: Codable, Sendable {
    let id: String
    let digest: String
    let domain: String
    let service: String
    let method: String
    let scope: ServiceScope
    let expected: ServiceRevision
    let reserved: ServiceRevision
    var phase: LedgerPhase
    var result: ServiceJSON?
    var failure: ServiceFailure?
    let created: Double
    var updated: Double
    /// Recorded with the effect: what the owner needs to reconcile an uncertain
    /// outcome (for preferences, the digest of the file it was about to install).
    /// Optional, so journals written before it existed decode unchanged.
    var pending: [String: ServiceJSON]? = nil
}

struct LedgerDomain: Codable, Sendable {
    var revision: ServiceRevision
    var checkpoint: [String: ServiceJSON]
    /// An uncertain operation: no later mutation runs until it is reconciled.
    var blockedBy: String?
}

struct LedgerState: Codable, Sendable {
    var sequence: UInt64 = 0
    var domains: [String: LedgerDomain] = [:]
    var operations: [String: LedgerOperation] = [:]
    /// IDs pruned past the retry horizon (ID → last update); retries need status/recovery.
    var expired: [String: Double] = [:]
    var events: [ServiceEvent] = []
}

struct LedgerRecord: Codable {
    enum Kind: String, Codable { case domain, intent, effect, receipt, uncertain }
    var n: UInt64
    var kind: Kind
    var at: Double
    var domain: String? = nil
    var revision: ServiceRevision? = nil
    var checkpoint: [String: ServiceJSON]? = nil
    var operation: LedgerOperation? = nil
    var id: String? = nil
    var phase: LedgerPhase? = nil
    var result: ServiceJSON? = nil
    var failure: ServiceFailure? = nil
}

enum LedgerBoundary: String, Sendable { case intent, effect, receipt, uncertain, snapshot }

struct LedgerOptions: Sendable {
    /// Advertised: a completed ID is answered from its receipt for at least this
    /// long unless `maxOperations` forces earlier expiry. Older IDs are refused.
    var retryHorizon: Double = 7 * 24 * 3600
    var maxOperations = 4096
    var maxExpired = 65_536
    var eventWindow = 1024
    var compactEvery: UInt64 = 512
    var now: @Sendable () -> Double = { Date().timeIntervalSince1970 }
    /// Test seam: runs after each durable transition (fault injection).
    var boundary: (@Sendable (LedgerBoundary) -> Void)? = nil
}

enum LedgerOutcome: Sendable {
    case operation(LedgerOperation)   // recorded: a new receipt or the stable earlier one
    case rejected(ServiceFailure)     // nothing recorded
}

enum LedgerCancel: Sendable { case cancelled(LedgerOperation), tooLate(LedgerOperation), finished(LedgerOperation), notFound }
enum LedgerStatus: Sendable { case unknown, expired, operation(LedgerOperation) }
enum LedgerDelta: Sendable { case events([ServiceEvent]), snapshotRequired }
enum LedgerResolution: Sendable { case applied(result: ServiceJSON, checkpoint: [String: ServiceJSON]?), notApplied(ServiceFailure) }
struct LedgerCommit: Sendable { var result: ServiceJSON; var checkpoint: [String: ServiceJSON]? = nil }

enum LedgerEffectError: Error, Sendable {
    /// The effect is known not to have happened (safe to record as failed).
    case notApplied(ServiceFailure)
    /// Cancelled before its effect began; the effect must not run.
    case cancelled
}

/// Handed to a domain effect. Work before `beginEffect()` is cancellable preparation;
/// `beginEffect()` durably records that the outcome may now be uncertain.
struct LedgerEffectContext: Sendable {
    let ledger: OperationLedger
    let operationID: String
    let revision: ServiceRevision
    let reserved: ServiceRevision
    let checkpoint: [String: ServiceJSON]
    func beginEffect(pending: [String: ServiceJSON]? = nil) async throws { try await ledger.beginEffect(operationID, pending: pending) }
}

/// Durable operation ledger for Swift-owned domains. Each domain has one FIFO
/// mutation lane held across the effect's suspension, so commits never interleave.
actor OperationLedger {
    nonisolated let epoch: String
    nonisolated let options: LedgerOptions
    private let store: LedgerStore<LedgerState>
    private var state: LedgerState
    private var busy = Set<String>()
    private var waiters: [String: [CheckedContinuation<Void, Never>]] = [:]

    init(directory: URL, options: LedgerOptions = .init()) throws {
        let store = try LedgerStore<LedgerState>(directory: directory)
        let loaded = try store.load { (UUID().uuidString.lowercased(), LedgerState()) }
        if let boundary = options.boundary { store.afterSnapshotRename = { boundary(.snapshot) } }
        var state = loaded.state
        for data in loaded.records {
            guard let record = try? JSONDecoder().decode(LedgerRecord.self, from: data) else {
                throw LedgerOpenError.corrupt("record shape")
            }
            do { try Self.apply(record, to: &state, epoch: loaded.epoch, window: options.eventWindow) }
            catch { throw LedgerOpenError.corrupt("record \(record.n) does not apply") }
        }
        // Recovery. No process owns an in-flight operation any more: an intent never
        // reached its effect (abandon it), an effect's outcome is unknown (block).
        let now = options.now()
        for op in state.operations.values.sorted(by: { ($0.created, $0.id) < ($1.created, $1.id) }) where !op.phase.isFinal {
            switch op.phase {
            case .intent:
                try Self.persist(LedgerRecord(n: 0, kind: .receipt, at: now, id: op.id, phase: .abandoned,
                    failure: Self.abandoned(op.id)), store: store, state: &state, epoch: loaded.epoch, options: options)
            case .effect:
                try Self.persist(LedgerRecord(n: 0, kind: .uncertain, at: now, id: op.id),
                    store: store, state: &state, epoch: loaded.epoch, options: options)
            default: break
            }
        }
        let pruned = Self.pruned(state, now: now, options: options)
        if store.records >= options.compactEvery || pruned.operations.count != state.operations.count {
            try store.compact(state: pruned, epoch: loaded.epoch)
            state = pruned
        }
        self.store = store; self.state = state; self.epoch = loaded.epoch; self.options = options
    }

    // MARK: Registration and queries

    /// Creates a domain at counter 0 with its initial checkpoint; existing domains are
    /// returned unchanged (never reinitialized from a caller's older copy).
    func register(domain: String, checkpoint: [String: ServiceJSON] = [:]) -> ServiceSnapshot? {
        if state.domains[domain] == nil {
            guard !domain.isEmpty else { return nil }
            let revision = ServiceRevision(epoch: UUID().uuidString.lowercased(), counter: "0")
            guard (try? write(LedgerRecord(n: 0, kind: .domain, at: options.now(), domain: domain,
                revision: revision, checkpoint: checkpoint))) != nil else { return nil }
        }
        return snapshot(domain: domain)
    }

    /// Revision, checkpoint and cursor are read together, without suspension.
    func snapshot(domain: String) -> ServiceSnapshot? {
        guard let value = state.domains[domain] else { return nil }
        return ServiceSnapshot(scope: ServiceScope(project: nil, chat: nil, turn: nil, checkout: nil, document: nil),
            revision: value.revision, cursor: cursor, value: value.checkpoint)
    }

    var cursor: ServiceCursor { ServiceCursor(serviceEpoch: epoch, sequence: String(state.sequence)) }

    func status(_ id: String) -> LedgerStatus {
        if let op = state.operations[id] { return .operation(op) }
        return state.expired[id] == nil ? .unknown : .expired
    }

    /// Operations whose effect may or may not have happened; each blocks its domain.
    func recoveries() -> [LedgerOperation] {
        state.operations.values.filter { $0.phase == .uncertain }.sorted { ($0.created, $0.id) < ($1.created, $1.id) }
    }

    /// Deltas after `cursor`, or `snapshotRequired` for another epoch, a cursor from
    /// the future, or a gap older than the retained window.
    func events(after cursor: ServiceCursor) -> LedgerDelta {
        guard cursor.serviceEpoch == epoch, let from = UInt64(cursor.sequence), from <= state.sequence else { return .snapshotRequired }
        if from == state.sequence { return .events([]) }
        guard let first = state.events.first.flatMap({ UInt64($0.sequence) }), first <= from + 1 else { return .snapshotRequired }
        return .events(state.events.filter { (UInt64($0.sequence) ?? 0) > from })
    }

    // MARK: Mutation

    func perform(_ request: ServiceRequest, domain: String,
                 _ body: @Sendable (LedgerEffectContext) async throws -> LedgerCommit) async -> LedgerOutcome {
        guard request.mode == .mutation, let expected = request.expectedRevision,
              UUID(uuidString: request.operationID) != nil else {
            return .rejected(Self.failure(.invalidRequest, "A mutation needs an operation ID and an expected revision."))
        }
        let id = request.operationID
        let digest = Self.intentDigest(request, domain: domain)
        // Identity first: a successful retry must not conflict with the revision it advanced.
        if let known = recorded(id, digest) { return known }
        guard state.domains[domain] != nil else { return .rejected(Self.failure(.notFound, "Unknown domain.")) }
        await acquire(domain)
        defer { release(domain) }
        if let known = recorded(id, digest) { return known }
        guard let current = state.domains[domain] else { return .rejected(Self.failure(.notFound, "Unknown domain.")) }
        if let blocked = current.blockedBy {
            return .rejected(Self.failure(.recoveryRequired, "An earlier operation must be reconciled first.", recoveryID: blocked))
        }
        guard expected == current.revision else {
            return .rejected(Self.failure(.conflict, "The state changed.", operationID: id, revision: current.revision))
        }
        guard let counter = UInt64(current.revision.counter), counter < UInt64.max else {
            return .rejected(Self.failure(.recoveryRequired, "The domain revision cannot advance."))
        }
        let now = options.now()
        let reserved = ServiceRevision(epoch: current.revision.epoch, counter: String(counter + 1))
        let op = LedgerOperation(id: id, digest: digest, domain: domain, service: request.service, method: request.method,
            scope: request.scope, expected: expected, reserved: reserved, phase: .intent, created: now, updated: now)
        do { try write(LedgerRecord(n: 0, kind: .intent, at: now, operation: op)) }
        catch { return .rejected(Self.failure(.ioFailure, "The operation could not be recorded.", retryable: true)) }
        options.boundary?(.intent)

        let context = LedgerEffectContext(ledger: self, operationID: id, revision: current.revision,
            reserved: reserved, checkpoint: current.checkpoint)
        let outcome: Result<LedgerCommit, Error>
        do { outcome = .success(try await body(context)) } catch { outcome = .failure(error) }

        // Cancelled while running: the late result is discarded, never committed.
        guard let running = state.operations[id], !running.phase.isFinal else {
            return recorded(id, digest) ?? .rejected(Self.failure(.notFound, "Unknown operation."))
        }
        switch outcome {
        case .success(let commit):
            settle(LedgerRecord(n: 0, kind: .receipt, at: options.now(), checkpoint: commit.checkpoint, id: id,
                phase: .committed, result: commit.result))
        case .failure(let error):
            if case .notApplied(let failure)? = error as? LedgerEffectError {
                settle(LedgerRecord(n: 0, kind: .receipt, at: options.now(), id: id, phase: .failed, failure: failure))
            } else if running.phase == .intent {
                settle(LedgerRecord(n: 0, kind: .receipt, at: options.now(), id: id, phase: .failed,
                    failure: Self.failure(.ioFailure, "The operation failed before its effect.", operationID: id)))
            } else {
                settle(LedgerRecord(n: 0, kind: .uncertain, at: options.now(), id: id))
            }
        }
        return settled(id)
    }

    /// The gate between preparation and a non-idempotent effect.
    func beginEffect(_ id: String, pending: [String: ServiceJSON]? = nil) throws {
        guard let op = state.operations[id], op.phase == .intent || op.phase == .effect else { throw LedgerEffectError.cancelled }
        guard op.phase == .intent else { return }
        do { try write(LedgerRecord(n: 0, kind: .effect, at: options.now(), checkpoint: pending, id: id)) }
        catch { throw LedgerEffectError.notApplied(Self.failure(.ioFailure, "The effect could not be recorded.", operationID: id)) }
        options.boundary?(.effect)
    }

    /// Cancellation before the effect is final; afterwards it is too late.
    func cancel(_ id: String) -> LedgerCancel {
        guard let op = state.operations[id] else { return .notFound }
        switch op.phase {
        case .intent:
            settle(LedgerRecord(n: 0, kind: .receipt, at: options.now(), id: id, phase: .cancelled,
                failure: Self.failure(.cancelled, "Cancelled before its effect.", operationID: id)))
            let settled = state.operations[id]!
            return settled.phase == .cancelled ? .cancelled(settled) : .finished(settled)
        case .effect, .uncertain: return .tooLate(op)
        default: return .finished(op)
        }
    }

    /// The owner inspected the external world and says what happened.
    func reconcile(_ id: String, _ resolution: LedgerResolution) -> LedgerOutcome {
        guard let op = state.operations[id] else { return .rejected(Self.failure(.notFound, "Unknown operation.")) }
        guard op.phase == .uncertain else { return .operation(op) }
        let record: LedgerRecord
        switch resolution {
        case .applied(let result, let checkpoint):
            record = LedgerRecord(n: 0, kind: .receipt, at: options.now(), checkpoint: checkpoint, id: id, phase: .committed, result: result)
        case .notApplied(let failure):
            record = LedgerRecord(n: 0, kind: .receipt, at: options.now(), id: id, phase: .failed, failure: failure)
        }
        do { try write(record) } catch { return .rejected(Self.failure(.ioFailure, "The resolution could not be recorded.", retryable: true)) }
        return settled(id)
    }

    // MARK: Internals

    /// The operation as settled, captured before compaction may expire older receipts.
    private func settled(_ id: String) -> LedgerOutcome {
        let op = state.operations[id]
        compactIfNeeded()
        return op.map(LedgerOutcome.operation) ?? .rejected(Self.failure(.notFound, "Unknown operation."))
    }

    private func recorded(_ id: String, _ digest: String) -> LedgerOutcome? {
        if let op = state.operations[id] {
            return op.digest == digest ? .operation(op)
                : .rejected(Self.failure(.idempotencyMismatch, "This operation ID was used for a different request.", operationID: id))
        }
        if state.expired[id] != nil {
            return .rejected(Self.failure(.recoveryRequired, "This operation is older than the retry horizon.", operationID: id))
        }
        return nil
    }

    private func acquire(_ domain: String) async {
        if busy.insert(domain).inserted { return }
        await withCheckedContinuation { waiters[domain, default: []].append($0) }
    }

    private func release(_ domain: String) {
        // Direct hand-off keeps FIFO order: nothing can barge between waiters.
        if var queue = waiters[domain], !queue.isEmpty {
            let next = queue.removeFirst()
            waiters[domain] = queue.isEmpty ? nil : queue
            next.resume()
        } else {
            busy.remove(domain)
        }
    }

    private func write(_ record: LedgerRecord) throws {
        try Self.persist(record, store: store, state: &state, epoch: epoch, options: options)
    }

    /// Records a transition. If the journal fails, memory takes the state a restart
    /// would reach (intent → abandoned, effect → uncertain), never a guessed success.
    private func settle(_ record: LedgerRecord) {
        do { try write(record); return } catch {}
        guard let id = record.id, let op = state.operations[id], !op.phase.isFinal, op.phase != .uncertain else { return }
        let fallback = op.phase == .intent
            ? LedgerRecord(n: 0, kind: .receipt, at: options.now(), id: id, phase: .abandoned, failure: Self.abandoned(id))
            : LedgerRecord(n: 0, kind: .uncertain, at: options.now(), id: id)
        try? Self.apply(fallback, to: &state, epoch: epoch, window: options.eventWindow)
    }

    private func compactIfNeeded() {
        guard store.records >= options.compactEvery else { return }
        let pruned = Self.pruned(state, now: options.now(), options: options)
        // Best effort: the journal already holds every acknowledged transition.
        if (try? store.compact(state: pruned, epoch: epoch)) != nil { state = pruned }
    }

    private static func persist(_ record: LedgerRecord, store: LedgerStore<LedgerState>, state: inout LedgerState,
                                epoch: String, options: LedgerOptions) throws {
        var record = record
        record.n = store.records + 1
        var next = state
        try apply(record, to: &next, epoch: epoch, window: options.eventWindow)
        try store.append(try LedgerStore<LedgerState>.encode(record))
        state = next
        switch record.kind {
        case .receipt: options.boundary?(.receipt)
        case .uncertain: options.boundary?(.uncertain)
        default: break
        }
    }

    /// The only state transition function, shared by live writes and replay.
    static func apply(_ record: LedgerRecord, to state: inout LedgerState, epoch: String, window: Int) throws {
        switch record.kind {
        case .domain:
            guard let name = record.domain, let revision = record.revision, state.domains[name] == nil else { throw ServiceContractFailure.conflict }
            state.domains[name] = LedgerDomain(revision: revision, checkpoint: record.checkpoint ?? [:], blockedBy: nil)
        case .intent:
            guard let op = record.operation, state.operations[op.id] == nil, state.expired[op.id] == nil,
                  op.phase == .intent, state.domains[op.domain]?.revision == op.expected else { throw ServiceContractFailure.conflict }
            state.operations[op.id] = op
        case .effect:
            guard let id = record.id, state.operations[id]?.phase == .intent else { throw ServiceContractFailure.conflict }
            state.operations[id]!.phase = .effect
            state.operations[id]!.updated = record.at
            state.operations[id]!.pending = record.checkpoint
        case .uncertain:
            guard let id = record.id, let op = state.operations[id], op.phase == .effect else { throw ServiceContractFailure.conflict }
            state.operations[id]!.phase = .uncertain
            state.operations[id]!.updated = record.at
            state.domains[op.domain]!.blockedBy = id
        case .receipt:
            guard let id = record.id, let phase = record.phase, phase.isFinal, var op = state.operations[id],
                  !op.phase.isFinal, var domain = state.domains[op.domain] else { throw ServiceContractFailure.conflict }
            op.phase = phase; op.result = record.result; op.failure = record.failure; op.updated = record.at
            if phase == .committed {
                guard domain.revision == op.expected else { throw ServiceContractFailure.conflict }
                domain.revision = op.reserved
                if let checkpoint = record.checkpoint { domain.checkpoint = checkpoint }
                state.sequence += 1
                var value: [String: ServiceJSON] = ["domain": .string(op.domain), "result": record.result ?? .null]
                if let checkpoint = record.checkpoint { value["checkpoint"] = .object(checkpoint) }
                state.events.append(ServiceEvent(serviceEpoch: epoch, sequence: String(state.sequence), operationID: id,
                    scope: op.scope, revision: op.reserved, name: "operation.committed", value: value))
                if state.events.count > window { state.events.removeFirst(state.events.count - window) }
            }
            if domain.blockedBy == id { domain.blockedBy = nil }
            state.operations[id] = op
            state.domains[op.domain] = domain
        }
    }

    static func pruned(_ state: LedgerState, now: Double, options: LedgerOptions) -> LedgerState {
        var state = state
        let finished = state.operations.values.filter { $0.phase.isFinal }.sorted { ($0.updated, $0.id) < ($1.updated, $1.id) }
        let excess = finished.count - options.maxOperations
        for (index, op) in finished.enumerated() where index < excess || now - op.updated > options.retryHorizon {
            state.operations[op.id] = nil
            state.expired[op.id] = op.updated
        }
        if state.expired.count > options.maxExpired {
            for (id, _) in state.expired.sorted(by: { ($0.value, $0.key) < ($1.value, $1.key) }).prefix(state.expired.count - options.maxExpired) {
                state.expired[id] = nil
            }
        }
        return state
    }

    /// Operation identity: domain, mode, service, method, scope, expected revision
    /// and body. Connection, request ID and timeout are attempts, not intent.
    static func intentDigest(_ request: ServiceRequest, domain: String) -> String {
        var scope: [String: ServiceJSON] = [:]
        for (key, value) in [("project", request.scope.project), ("chat", request.scope.chat), ("turn", request.scope.turn),
                             ("checkout", request.scope.checkout), ("document", request.scope.document)] {
            if let value { scope[key] = .string(value) }
        }
        var intent: [String: ServiceJSON] = ["domain": .string(domain), "mode": .string(request.mode.rawValue),
            "service": .string(request.service), "method": .string(request.method),
            "scope": .object(scope), "body": .object(request.body)]
        if let revision = request.expectedRevision {
            intent["expectedRevision"] = .object(["epoch": .string(revision.epoch), "counter": .string(revision.counter)])
        }
        return ledgerDigest(Data(("trezi-operation-intent-1\n" + canonical(.object(intent))).utf8))
    }

    /// Byte-exact keys ordered by UTF-8; strings are never normalized; -0 == 0.
    static func canonical(_ value: ServiceJSON) -> String {
        func quote(_ string: String) -> String {
            let encoder = JSONEncoder(); encoder.outputFormatting = [.withoutEscapingSlashes]
            return String(decoding: (try? encoder.encode(string)) ?? Data("\"\"".utf8), as: UTF8.self)
        }
        switch value {
        case .null: return "null"
        case .bool(let value): return value ? "true" : "false"
        case .number(let value):
            if value == 0 { return "0" }
            if value.rounded() == value, abs(value) <= 9_007_199_254_740_991 { return String(Int64(value)) }
            return "\(value)"
        case .string(let value): return quote(value)
        case .array(let values): return "[" + values.map(canonical).joined(separator: ",") + "]"
        case .object(let fields):
            return "{" + fields.sorted { $0.key.utf8.lexicographicallyPrecedes($1.key.utf8) }
                .map { quote($0.key) + ":" + canonical($0.value) }.joined(separator: ",") + "}"
        }
    }

    static func abandoned(_ id: String) -> ServiceFailure {
        failure(.unavailable, "The service stopped before this operation took effect. Retry it as a new operation.",
                retryable: true, operationID: id)
    }

    static func failure(_ code: ServiceContractFailure, _ message: String, retryable: Bool = false, operationID: String? = nil,
                        revision: ServiceRevision? = nil, recoveryID: String? = nil) -> ServiceFailure {
        ServiceFailure(code: code, message: message, retryable: retryable, operationID: operationID,
                       currentRevision: revision, recoveryID: recoveryID)
    }
}

extension LedgerOutcome {
    /// Wire result for a reply: the same recorded operation always maps the same way.
    var result: ServiceResult {
        switch self {
        case .rejected(let failure): return .failed(failure)
        case .operation(let op):
            switch op.phase {
            case .committed: return .succeeded(op.result ?? .null)
            case .failed, .cancelled, .abandoned:
                return .failed(op.failure ?? OperationLedger.failure(.ioFailure, "The operation failed.", operationID: op.id))
            case .intent, .effect:
                return .failed(OperationLedger.failure(.busy, "The operation is still running.", retryable: true, operationID: op.id))
            case .uncertain:
                return .failed(OperationLedger.failure(.recoveryRequired, "The operation's outcome is being reconciled.",
                    operationID: op.id, recoveryID: op.id))
            }
        }
    }
}
