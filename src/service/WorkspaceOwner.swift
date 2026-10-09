import Foundation

/// The single writer of `<profile>/workspace.json` when the Swift service owns the
/// profile (S04 domain `workspace`): project identity (canonical root → key),
/// membership, order, the selected project and recents. Per-project metadata owned
/// by legacy Bun slices (sessions, servers, Git, display) arrives through the typed
/// `update` adapter and is persisted, never interpreted. The file keeps its legacy
/// format; this is its only writer since LKM-111.
///
/// Same commit protocol as preferences, inside the ledger's FIFO lane: re-read (an
/// external edit conflicts and is adopted), apply, write a 0600 temp file and
/// `F_FULLFSYNC` it, `beginEffect` (records the target digest), rename, sync the
/// directory, install, receipt. An operation that changes nothing writes nothing.
actor WorkspaceOwner: PipeDomainOwner {
    static let domain = "workspace"
    static let format = "trezi-workspace-v1"

    let disk: PreferencesDisk
    let ledger: OperationLedger?
    /// Milliseconds since the epoch (`Date.now()`), stamped on `touchedAt` and recents.
    let now: @Sendable () -> Double
    let resolve: @Sendable (JSText) -> String?
    private var document = WorkspaceDocument.empty
    private var digest = PreferencesDisk.absent
    private var revision = ServiceRevision(epoch: "", counter: "0")
    private var failure: ServiceFailure? = fail(.unavailable, "The workspace is not open yet.", retryable: true)
    private var closed = false
    private var externalChange = false
    private var changed: (@Sendable (Data) -> Void)?

    init(disk: PreferencesDisk, ledger: OperationLedger?, now: @escaping @Sendable () -> Double = { (Date().timeIntervalSince1970 * 1000).rounded(.down) },
         resolve: @escaping @Sendable (JSText) -> String? = { resolveWorkspaceRoot($0) }) {
        self.disk = disk; self.ledger = ledger; self.now = now; self.resolve = resolve
    }

    func onChange(_ handler: @escaping @Sendable (Data) -> Void) { changed = handler }
    func close() { closed = true }

    // MARK: Opening: import, reconcile, adopt

    /// Imports the newest file as the domain's checkpoint. A file that is not a
    /// workspace is never replaced: the domain stays unavailable and the file untouched.
    func open() async {
        guard let ledger else {
            failure = Self.fail(.recoveryRequired, "The operation ledger could not be opened, so the workspace cannot be saved. Quit and relaunch Trezi.")
            return
        }
        let data: Data?, parsed: WorkspaceDocument
        do { data = try disk.read() }
        catch { failure = Self.fail(.ioFailure, "workspace.json could not be read (\(error)).", retryable: true); return }
        do { parsed = try data.map(WorkspaceDocument.decode) ?? .empty }
        catch { failure = Self.fail(.recoveryRequired, "workspace.json is not a valid saved workspace. It was left untouched; fix or remove it, then relaunch."); return }
        let found = PreferencesDisk.digest(data)
        guard await ledger.register(domain: Self.domain, checkpoint: Self.checkpoint(found)) != nil else {
            failure = Self.fail(.ioFailure, "The workspace domain could not be recorded.", retryable: true); return
        }
        await reconcile(found: found)
        guard let current = await ledger.snapshot(domain: Self.domain), current.value["digest"]?.string != nil else { return }
        guard !(await ledger.recoveries().contains { $0.domain == Self.domain }) else {
            failure = Self.fail(.recoveryRequired, "An earlier workspace write could not be reconciled.")
            return
        }
        document = parsed
        digest = current.value["digest"]?.string ?? PreferencesDisk.absent
        revision = current.revision
        failure = nil
        // Changed since the last checkpoint (e.g. an edit made while the service was down
        // saved newer projects): adopted as a new revision, never overwritten.
        if let problem = await adopt() { failure = problem }
    }

    /// Uncertain writes are resolved by what the file holds, never replayed: the
    /// target digest means applied, the prior checkpoint means not applied,
    /// anything else was superseded by an external edit.
    private func reconcile(found: String) async {
        guard let ledger, let prior = await ledger.snapshot(domain: Self.domain)?.value["digest"]?.string else { return }
        for op in await ledger.recoveries() where op.domain == Self.domain {
            let resolution: LedgerResolution
            if let target = op.pending?["digest"]?.string, target == found {
                var result = op.pending ?? [:]
                result["digest"] = .string(target)
                resolution = .applied(result: .object(result), checkpoint: Self.checkpoint(target))
            } else if found == prior {
                resolution = .notApplied(Self.fail(.ioFailure, "The change did not reach workspace.json.", retryable: true, operationID: op.id))
            } else {
                resolution = .notApplied(Self.fail(.conflict, "workspace.json changed outside Trezi before this change was confirmed.", operationID: op.id))
            }
            _ = await ledger.reconcile(op.id, resolution)
        }
    }

    private func adopt() async -> ServiceFailure? {
        guard let ledger else { return Self.fail(.recoveryRequired, "The operation ledger is unavailable.") }
        for _ in 0..<3 {
            let data: Data?
            do { data = try disk.read() } catch { return Self.fail(.ioFailure, "workspace.json could not be read.", retryable: true) }
            let found = PreferencesDisk.digest(data)
            if found == digest { return nil }
            guard let parsed = try? data.map(WorkspaceDocument.decode) ?? .empty else {
                return Self.fail(.recoveryRequired, "workspace.json was changed outside Trezi and is not a valid saved workspace. It was left untouched; fix or remove it, then try again.")
            }
            let request = ServiceRequest(connection: UUID().uuidString.lowercased(), requestID: UUID().uuidString.lowercased(),
                operationID: UUID().uuidString.lowercased(), scope: PreferencesOwner.global, mode: .mutation, expectedRevision: revision,
                timeoutMilliseconds: nil, service: Self.domain, method: "adopt", body: ["digest": .string(found)])
            let outcome = await ledger.perform(request, domain: Self.domain) { context in
                try await self.adoptEffect(context, parsed: parsed, found: found)
            }
            switch outcome.result {
            case .succeeded: announce(); return nil
            case .failed(let failure) where failure.code == .conflict: continue
            case .failed(let failure): return failure
            }
        }
        return Self.fail(.busy, "workspace.json keeps changing outside Trezi.", retryable: true)
    }

    private func adoptEffect(_ context: LedgerEffectContext, parsed: WorkspaceDocument, found: String) throws -> LedgerCommit {
        guard context.revision == revision else { throw LedgerEffectError.notApplied(Self.fail(.conflict, "The workspace changed.")) }
        guard (try? PreferencesDisk.digest(disk.read())) == found else {
            throw LedgerEffectError.notApplied(Self.fail(.conflict, "workspace.json changed again while it was read."))
        }
        install(parsed, digest: found, revision: context.reserved)
        return LedgerCommit(result: .object(["digest": .string(found), "adopted": .bool(true)]), checkpoint: Self.checkpoint(found))
    }

    // MARK: Requests

    func handle(_ line: Data) async -> Data {
        let frame: PipeFrame, operation: WorkspaceOperation?
        do {
            frame = try PipeFrame(line, service: Self.domain, maxDepth: 64)
            switch (frame.method, frame.mode) {
            case ("snapshot", "read"):
                guard frame.body.isEmpty, frame.expectedRevision == nil else { throw ServiceContractFailure.invalidRequest }
                operation = nil
            case (let method, "mutation") where WorkspaceOperation.methods.contains(method):
                guard frame.expectedRevision != nil else { throw ServiceContractFailure.invalidRequest }
                operation = try WorkspaceOperation(method: method, body: frame.body)
            default: throw ServiceContractFailure.invalidRequest
            }
        } catch {
            let code = error as? ServiceContractFailure ?? .invalidRequest
            return Self.reply(id: (try? JSValue.parse(line, maxDepth: 8))?["id"] ?? .null, frame: nil,
                result: .failed(Self.fail(code, code == .unauthorized ? "The workspace is global; a scoped request is refused." : "Invalid workspace request.")), snapshot: nil)
        }
        if closed { return Self.reply(id: frame.id, frame: frame, result: .failed(Self.stopping), snapshot: nil) }
        if let failure { return Self.reply(id: frame.id, frame: frame, result: .failed(failure), snapshot: nil) }
        guard let operation else { return Self.reply(id: frame.id, frame: frame, result: .succeeded(snapshotValue()), snapshot: nil) }
        let result = await mutate(frame.request(service: Self.domain), operation)
        return Self.reply(id: frame.id, frame: frame, result: result, snapshot: failure == nil ? snapshotValue() : nil)
    }

    func mutate(_ request: ServiceRequest, _ operation: WorkspaceOperation) async -> PreferencesOwner.Answer {
        guard let ledger else { return .failed(Self.fail(.recoveryRequired, "The operation ledger is unavailable.")) }
        externalChange = false
        var outcome = await ledger.perform(request, domain: Self.domain) { context in
            try await self.effect(context, operation)
        }
        // Only a failed journal write leaves a live operation uncertain; settle it now.
        if case .operation(let op) = outcome, op.phase == .uncertain {
            if let found = try? PreferencesDisk.digest(disk.read()) { await reconcile(found: found) }
            if case .operation(let settled) = await ledger.status(op.id) { outcome = .operation(settled) }
        }
        if externalChange, let problem = await adopt() { return .failed(problem) }
        switch outcome.result {
        case .succeeded(let result):
            guard case .operation(let op) = outcome, case .object(let fields) = result else { return .succeeded(PreferencesOwner.value(result)) }
            var payload: [(JSText, JSValue)] = [(JSText("revision"), PreferencesOwner.value(op.reserved))]
            for name in ["digest", "key", "created"] { if let value = fields[name] { payload.append((JSText(name), PreferencesOwner.value(value))) } }
            return .succeeded(.object(payload))
        case .failed(let failure): return .failed(failure)
        }
    }

    private func effect(_ context: LedgerEffectContext, _ operation: WorkspaceOperation) async throws -> LedgerCommit {
        guard context.revision == revision, context.checkpoint["digest"]?.string == digest else {
            throw LedgerEffectError.notApplied(Self.fail(.recoveryRequired, "The workspace is out of step with the ledger; relaunch Trezi."))
        }
        let current: Data?
        do { current = try disk.read() }
        catch { throw LedgerEffectError.notApplied(Self.fail(.ioFailure, "workspace.json could not be read.", retryable: true)) }
        guard PreferencesDisk.digest(current) == digest else {
            externalChange = true
            throw LedgerEffectError.notApplied(Self.fail(.conflict, "workspace.json changed outside Trezi. The change was not saved; try again.", operationID: context.operationID))
        }
        var next = document
        let applied: WorkspaceDocument.Applied
        do { applied = try next.apply(operation, now: now(), resolve: resolve) }
        catch WorkspaceError.tooMany { throw LedgerEffectError.notApplied(Self.fail(.busy, "Too many open projects; close one first.", operationID: context.operationID)) }
        catch { throw LedgerEffectError.notApplied(Self.fail(.notFound, "That project is no longer open.", operationID: context.operationID)) }
        var result: [String: ServiceJSON] = [:]
        if let key = applied.key { result["key"] = .string(key.string) }
        if let created = applied.created { result["created"] = .bool(created) }
        guard applied.changed else {
            result["digest"] = .string(digest)
            revision = context.reserved
            return LedgerCommit(result: .object(result), checkpoint: Self.checkpoint(digest))
        }
        let bytes = next.encoded()
        let target = PreferencesDisk.digest(bytes)
        func notSaved(_ error: Error) -> LedgerEffectError {
            .notApplied(Self.fail(.ioFailure, "The workspace could not be saved (\(error)). Nothing was changed.", retryable: true, operationID: context.operationID))
        }
        do { try disk.prepare(bytes) } catch { throw notSaved(error) }
        // The pending record also carries the answer, so a reconciled write can return it.
        result["digest"] = .string(target)
        do { try await context.beginEffect(pending: result) }
        catch { unlink(disk.temporaryPath); throw error }
        do { try disk.replace() } catch { throw notSaved(error) }
        // Readers already see the new file; a later open adopts it if the rename did not persist.
        try? disk.syncDirectory()
        install(next, digest: target, revision: context.reserved)
        return LedgerCommit(result: .object(result), checkpoint: Self.checkpoint(target))
    }

    private func install(_ next: WorkspaceDocument, digest: String, revision: ServiceRevision) {
        document = next; self.digest = digest; self.revision = revision
    }

    /// Only for changes Bun did not ask for (adopted external edits).
    private func announce() {
        changed?(JSValue.object([(JSText("event"), .string(JSText("service-event"))), (JSText("service"), .string(JSText(Self.domain))),
            (JSText("name"), .string(JSText("workspace.changed"))), (JSText("snapshot"), snapshotValue())]).utf8())
    }

    // MARK: Encoding

    static let stopping = fail(.unavailable, "The service is stopping; the workspace was not saved.", retryable: true)
    static func checkpoint(_ digest: String) -> [String: ServiceJSON] { ["digest": .string(digest), "format": .string(format)] }
    static func fail(_ code: ServiceContractFailure, _ message: String, retryable: Bool = false, operationID: String? = nil) -> ServiceFailure {
        PreferencesOwner.fail(code, message, retryable: retryable, operationID: operationID)
    }
    static func stoppingReply(id: JSValue) -> Data { reply(id: id, frame: nil, result: .failed(stopping), snapshot: nil) }

    /// Projects (valid entries, as stored), the selected key (null unless it names a
    /// project) and valid recents. Display state and drafts are never part of it.
    func snapshotValue() -> JSValue {
        .object([(JSText("revision"), PreferencesOwner.value(revision)), (JSText("digest"), .string(JSText(digest))),
                 (JSText("projects"), .array(document.entries().map(\.entry))),
                 (JSText("activeKey"), document.activeKey.map(JSValue.string) ?? .null),
                 (JSText("recents"), .array(document.recents))])
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
        var out: [(JSText, JSValue)] = [(JSText("event"), .string(JSText("service-reply"))), (JSText("service"), .string(JSText(domain))),
                                        (JSText("id"), id), (JSText("reply"), .object(reply))]
        if let snapshot { out.append((JSText("snapshot"), snapshot)) }
        return JSValue.object(out).utf8()
    }
}
