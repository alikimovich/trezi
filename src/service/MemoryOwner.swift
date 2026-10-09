import Foundation

typealias MemoryChannel = DomainChannel<MemoryOwner>

/// The single writer of project memory when the Swift service owns the profile
/// (S05, LKM-93): `<profile>/trezi/project-memories/<id>.json`, one ledger domain
/// `memory/<id>` per project, so each project has its own revision and FIFO lane.
///
/// `save` is the editor's manual save and `propose` a generated evaluation. Both
/// commit only on the revision they name, so a proposal evaluated against memory
/// that a manual save (or an adopted external edit) has since replaced is refused
/// as `conflict` and never overwrites it; Bun retries the manual save as an intent
/// and re-evaluates the proposal. Evaluation itself stays in Bun as a bounded
/// helper with no write authority. Nothing here touches Git, a worktree or `.trezi/`.
///
/// Same commit protocol as workspace/preferences: re-read (an external edit
/// conflicts and is adopted), write a 0600 temp file and `F_FULLFSYNC` it,
/// `beginEffect` (records the target digest), rename, sync the directory, receipt.
/// A damaged file is never replaced: its project answers `recoveryRequired`.
actor MemoryOwner: PipeDomainOwner {
    static let service = "memory"
    static let prefix = "memory/"
    static let format = "trezi-project-memory-v1"

    let store: MemoryStore
    let ledger: OperationLedger?
    /// Milliseconds since the epoch (`Date.now()`), stamped on `updatedAt`.
    let now: @Sendable () -> Double
    private var failure: ServiceFailure? = fail(.unavailable, "Project memory is not open yet.", retryable: true)
    private var closed = false
    private var externalChanges = Set<String>()

    init(store: MemoryStore, ledger: OperationLedger?, now: @escaping @Sendable () -> Double = { (Date().timeIntervalSince1970 * 1000).rounded(.down) }) {
        self.store = store; self.ledger = ledger; self.now = now
    }

    /// Memory has no events: every read is answered from the file as it is now.
    func onChange(_ handler: @escaping @Sendable (Data) -> Void) {}
    func close() { closed = true }

    static func domain(_ id: String) -> String { prefix + id }

    /// Settles writes a crash cut off before anything is served. A project whose
    /// write cannot be reconciled stays blocked alone; the others are unaffected.
    func open() async {
        guard let ledger else {
            failure = Self.fail(.recoveryRequired, "The operation ledger could not be opened, so project memory cannot be saved. Quit and relaunch Trezi.")
            return
        }
        for id in Set(await ledger.recoveries().map(\.domain).filter { $0.hasPrefix(Self.prefix) }.map { String($0.dropFirst(Self.prefix.count)) }) {
            await reconcile(id)
        }
        failure = nil
    }

    /// Uncertain writes are resolved by what the file holds, never replayed: the
    /// target digest means applied, the prior checkpoint means not applied,
    /// anything else was superseded by an external edit.
    private func reconcile(_ id: String) async {
        guard let ledger, Self.validID(id), let prior = await ledger.snapshot(domain: Self.domain(id))?.value["digest"]?.string,
              let found = try? PreferencesDisk.digest(store.disk(id).read()) else { return }
        for op in await ledger.recoveries() where op.domain == Self.domain(id) {
            let resolution: LedgerResolution
            if let target = op.pending?["digest"]?.string, target == found {
                resolution = .applied(result: .object(op.pending ?? [:]), checkpoint: Self.checkpoint(target))
            } else if found == prior {
                resolution = .notApplied(Self.fail(.ioFailure, "The change did not reach project memory.", retryable: true, operationID: op.id))
            } else {
                resolution = .notApplied(Self.fail(.conflict, "Project memory changed outside Trezi before this change was confirmed.", operationID: op.id))
            }
            _ = await ledger.reconcile(op.id, resolution)
        }
    }

    struct State { let revision: ServiceRevision; let digest: String; let record: MemoryRecord }
    enum Ensured { case ready(State), failed(ServiceFailure) }

    /// The project's domain, registered on first use from the file as found, and
    /// the record it holds. A file changed since the checkpoint (an external edit,
    /// or a write made while the service was down) is adopted as a new revision, never rewritten.
    private func ensure(_ id: String) async -> Ensured {
        guard let ledger else { return .failed(Self.fail(.recoveryRequired, "The operation ledger is unavailable.")) }
        let disk = store.disk(id), domain = Self.domain(id)
        for attempt in 0..<4 {
            let data: Data?
            do { data = try disk.read() } catch { return .failed(Self.fail(.ioFailure, "Project memory could not be read (\(error)).", retryable: true)) }
            let found = PreferencesDisk.digest(data)
            if attempt == 0 {
                guard await ledger.register(domain: domain, checkpoint: Self.checkpoint(found)) != nil else {
                    return .failed(Self.fail(.ioFailure, "The project memory domain could not be recorded.", retryable: true))
                }
                if await ledger.recoveries().contains(where: { $0.domain == domain }) { await reconcile(id); continue }
            }
            guard !(await ledger.recoveries().contains { $0.domain == domain }) else {
                return .failed(Self.fail(.recoveryRequired, "An earlier project memory write could not be reconciled."))
            }
            guard let snapshot = await ledger.snapshot(domain: domain) else { return .failed(Self.fail(.ioFailure, "Unknown project memory.")) }
            let record: MemoryRecord
            do { record = try MemoryRecord.decode(data) } catch { return .failed(Self.damaged(id)) }
            if snapshot.value["digest"]?.string == found { return .ready(State(revision: snapshot.revision, digest: found, record: record)) }
            let request = ServiceRequest(connection: UUID().uuidString.lowercased(), requestID: UUID().uuidString.lowercased(),
                operationID: UUID().uuidString.lowercased(), scope: PreferencesOwner.global, mode: .mutation, expectedRevision: snapshot.revision,
                timeoutMilliseconds: nil, service: Self.service, method: "adopt", body: ["digest": .string(found)])
            let outcome = await ledger.perform(request, domain: domain) { _ in
                guard (try? PreferencesDisk.digest(disk.read())) == found else {
                    throw LedgerEffectError.notApplied(Self.fail(.conflict, "Project memory changed again while it was read."))
                }
                return LedgerCommit(result: .object(["digest": .string(found), "adopted": .bool(true)]), checkpoint: Self.checkpoint(found))
            }
            if case .failed(let failure) = outcome.result, failure.code != .conflict { return .failed(failure) }
        }
        return .failed(Self.fail(.busy, "Project memory keeps changing outside Trezi.", retryable: true))
    }

    /// The record as committed, without adopting anything (for reply snapshots).
    private func committed(_ id: String) async -> State? {
        guard let ledger, let snapshot = await ledger.snapshot(domain: Self.domain(id)) else { return nil }
        let data: Data?
        do { data = try store.disk(id).read() } catch { return nil }
        let found = PreferencesDisk.digest(data)
        guard snapshot.value["digest"]?.string == found, let record = try? MemoryRecord.decode(data) else { return nil }
        return State(revision: snapshot.revision, digest: found, record: record)
    }

    // MARK: Requests

    func handle(_ line: Data) async -> Data {
        let frame: PipeFrame, operation: MemoryOperation?, root: JSText
        do {
            frame = try PipeFrame(line, service: Self.service, maxDepth: 8)
            switch (frame.method, frame.mode) {
            case ("read", "read"):
                guard frame.expectedRevision == nil, frame.body.count == 1, frame.body[0].0 == JSText("root"),
                      let value = frame.body[0].1.text, MemoryRecord.validRoot(value) else { throw ServiceContractFailure.invalidRequest }
                root = value; operation = nil
            case (let method, "mutation") where MemoryOperation.methods.contains(method):
                guard frame.expectedRevision != nil else { throw ServiceContractFailure.invalidRequest }
                let parsed = try MemoryOperation(method: method, body: frame.body)
                root = parsed.root; operation = parsed
            default: throw ServiceContractFailure.invalidRequest
            }
        } catch {
            let code = error as? ServiceContractFailure ?? .invalidRequest
            return Self.reply(id: (try? JSValue.parse(line, maxDepth: 8))?["id"] ?? .null, frame: nil,
                result: .failed(Self.fail(code, code == .unauthorized ? "Project memory is addressed by root; a scoped request is refused." : "Invalid project memory request.")), snapshot: nil)
        }
        if closed { return Self.reply(id: frame.id, frame: frame, result: .failed(Self.stopping), snapshot: nil) }
        if let failure { return Self.reply(id: frame.id, frame: frame, result: .failed(failure), snapshot: nil) }
        let id = MemoryRecord.fileID(root: root)
        let state: State
        switch await ensure(id) {
        case .failed(let failure): return Self.reply(id: frame.id, frame: frame, result: .failed(failure), snapshot: nil)
        case .ready(let value): state = value
        }
        guard let operation else { return Self.reply(id: frame.id, frame: frame, result: .succeeded(Self.snapshotValue(state)), snapshot: nil) }
        let result = await mutate(frame.request(service: Self.service), operation, id: id)
        return Self.reply(id: frame.id, frame: frame, result: result, snapshot: await committed(id).map(Self.snapshotValue))
    }

    func mutate(_ request: ServiceRequest, _ operation: MemoryOperation, id: String) async -> PreferencesOwner.Answer {
        guard let ledger else { return .failed(Self.fail(.recoveryRequired, "The operation ledger is unavailable.")) }
        externalChanges.remove(id)
        var outcome = await ledger.perform(request, domain: Self.domain(id)) { context in
            try await self.effect(context, operation, id: id)
        }
        // Only a failed journal write leaves a live operation uncertain; settle it now.
        if case .operation(let op) = outcome, op.phase == .uncertain {
            await reconcile(id)
            if case .operation(let settled) = await ledger.status(op.id) { outcome = .operation(settled) }
        }
        if externalChanges.remove(id) != nil, case .failed(let problem) = await ensure(id) { return .failed(problem) }
        switch outcome.result {
        case .succeeded(let result):
            guard case .operation(let op) = outcome, case .object(let fields) = result else { return .succeeded(PreferencesOwner.value(result)) }
            var payload: [(JSText, JSValue)] = [(JSText("revision"), PreferencesOwner.value(op.reserved))]
            for name in ["digest", "updatedAt", "changed"] { if let value = fields[name] { payload.append((JSText(name), PreferencesOwner.value(value))) } }
            return .succeeded(.object(payload))
        case .failed(let failure): return .failed(failure)
        }
    }

    private func effect(_ context: LedgerEffectContext, _ operation: MemoryOperation, id: String) async throws -> LedgerCommit {
        let disk = store.disk(id)
        let current: Data?
        do { current = try disk.read() }
        catch { throw LedgerEffectError.notApplied(Self.fail(.ioFailure, "Project memory could not be read.", retryable: true, operationID: context.operationID)) }
        let found = PreferencesDisk.digest(current)
        guard context.checkpoint["digest"]?.string == found else {
            externalChanges.insert(id)
            throw LedgerEffectError.notApplied(Self.fail(.conflict, "Project memory changed outside Trezi. The change was not saved; try again.", operationID: context.operationID))
        }
        let record: MemoryRecord
        do { record = try MemoryRecord.decode(current) } catch { throw LedgerEffectError.notApplied(Self.damaged(id)) }
        let content = MemoryRecord.normalize(operation.content)
        guard content != record.content else {
            return LedgerCommit(result: .object(["digest": .string(found), "updatedAt": .number(record.updatedAt), "changed": .bool(false)]),
                                checkpoint: Self.checkpoint(found))
        }
        let next = MemoryRecord(content: content, updatedAt: now())
        let bytes = next.encoded()
        let target = PreferencesDisk.digest(bytes)
        func notSaved(_ error: Error) -> LedgerEffectError {
            .notApplied(Self.fail(.ioFailure, "Project memory could not be saved (\(error)). Nothing was changed.", retryable: true, operationID: context.operationID))
        }
        do { try store.prepareDirectory() }
        catch MemoryError.sessionStoreNotReady {
            throw LedgerEffectError.notApplied(Self.fail(.unavailable, "Trezi's session store is not ready yet; project memory was not saved.", retryable: true, operationID: context.operationID))
        } catch { throw notSaved(error) }
        do { try disk.prepare(bytes) } catch { throw notSaved(error) }
        // The pending record carries the answer, so a reconciled write can return it.
        let result: [String: ServiceJSON] = ["digest": .string(target), "updatedAt": .number(next.updatedAt), "changed": .bool(true)]
        do { try await context.beginEffect(pending: result) }
        catch { unlink(disk.temporaryPath); throw error }
        do { try disk.replace() } catch { throw notSaved(error) }
        // Readers already see the new file; a later read adopts it if the rename did not persist.
        try? disk.syncDirectory()
        return LedgerCommit(result: .object(result), checkpoint: Self.checkpoint(target))
    }

    // MARK: Encoding

    static let stopping = fail(.unavailable, "The service is stopping; project memory was not saved.", retryable: true)
    static func checkpoint(_ digest: String) -> [String: ServiceJSON] { ["digest": .string(digest), "format": .string(format)] }
    static func validID(_ id: String) -> Bool { id.count == 64 && id.allSatisfy { $0.isHexDigit && !$0.isUppercase } }
    static func damaged(_ id: String) -> ServiceFailure {
        fail(.recoveryRequired, "Project memory (project-memories/\(id).json) is not a valid saved memory. It was left untouched; fix or remove it, then try again.")
    }
    static func fail(_ code: ServiceContractFailure, _ message: String, retryable: Bool = false, operationID: String? = nil) -> ServiceFailure {
        PreferencesOwner.fail(code, message, retryable: retryable, operationID: operationID)
    }
    static func stoppingReply(id: JSValue) -> Data { reply(id: id, frame: nil, result: .failed(stopping), snapshot: nil) }

    static func snapshotValue(_ state: State) -> JSValue {
        .object([(JSText("revision"), PreferencesOwner.value(state.revision)), (JSText("digest"), .string(JSText(state.digest))),
                 (JSText("content"), .string(state.record.content)), (JSText("updatedAt"), .number(state.record.updatedAt))])
    }

    static func reply(id: JSValue, frame: PipeFrame?, result: PreferencesOwner.Answer, snapshot: JSValue?) -> Data {
        let body: JSValue
        switch result {
        case .succeeded(let payload): body = .object([(JSText("kind"), .string(JSText("succeeded"))), (JSText("payload"), payload)])
        case .failed(let failure): body = .object([(JSText("kind"), .string(JSText("failed"))), (JSText("payload"), PreferencesOwner.value(failure))])
        }
        var reply: [(JSText, JSValue)] = []
        if let frame {
            reply = [(JSText("connection"), .string(JSText(frame.connection))), (JSText("requestID"), .string(JSText(frame.requestID))),
                     (JSText("operationID"), .string(JSText(frame.operationID))), (JSText("scope"), .object([]))]
        }
        reply.append((JSText("result"), body))
        var out: [(JSText, JSValue)] = [(JSText("event"), .string(JSText("service-reply"))), (JSText("service"), .string(JSText(service))),
                                        (JSText("id"), id), (JSText("reply"), .object(reply))]
        if let snapshot { out.append((JSText("snapshot"), snapshot)) }
        return JSValue.object(out).utf8()
    }
}
