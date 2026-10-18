import Foundation

typealias SkillsChannel = DomainChannel<SkillsOwner>

/// The single writer of Trezi's app-scoped Skills registry (LKM-284), served to Bun
/// as the `skills` pipe domain and to other service owners through `pin`/`install`.
/// Every request runs alone, in arrival order (`serial`), whoever sends it.
///
/// One ledger domain, `skills`, guards `manifest.json` with the memory owner's commit
/// protocol: re-read (an external edit conflicts and is adopted), write and
/// `F_FULLFSYNC` a temp file, `beginEffect` (records the target digest), rename, sync,
/// receipt. A crash is reconciled from the file, never replayed. Packages are
/// content-addressed and immutable (`SkillsStore`), written before the manifest names
/// them; a session's `snapshot` pins revisions, so editing, removing or purging a skill
/// never changes what a running or resumed session reads. Nothing here executes a
/// package's files, touches a project, a provider's home or a grant. A damaged
/// manifest is never replaced: the registry answers `recoveryRequired`.
actor SkillsOwner: PipeDomainOwner {
    static let service = "skills"
    static let domain = "skills"

    let store: SkillsStore
    let ledger: OperationLedger?
    /// Milliseconds since the epoch.
    let now: @Sendable () -> Double
    private(set) var failure: ServiceFailure? = fail(.unavailable, "Skills are not open yet.", retryable: true)
    private(set) var closed = false
    private var externalChange = false
    private var tail: Task<Void, Never>?
    // GitHub import (LKM-285, `SkillsImport.swift`): fetches run outside `serial` (only
    // their final `install` is serialised), are answered later through `deliver`, and
    // stay cancellable until they start committing.
    let github: SkillsGitHubEndpoints
    let archiveLimits: SkillsArchiveLimits
    let importDeadline: TimeInterval
    var fetcher: SkillsGitHubFetcher?
    private(set) var deliver: (@Sendable (Data) -> Void)?
    struct Import { let connection: String; let task: Task<Data, Never>; var committing = false, expired = false }
    var imports: [String: Import] = [:]

    init(store: SkillsStore, ledger: OperationLedger?, now: @escaping @Sendable () -> Double = { (Date().timeIntervalSince1970 * 1000).rounded(.down) },
         github: SkillsGitHubEndpoints = .github, archiveLimits: SkillsArchiveLimits = SkillsArchiveLimits(),
         importDeadline: TimeInterval = SkillsGitHubFetcher.deadline) {
        self.store = store; self.ledger = ledger; self.now = now
        self.github = github; self.archiveLimits = archiveLimits; self.importDeadline = importDeadline
    }

    func onChange(_ handler: @escaping @Sendable (Data) -> Void) { deliver = handler }
    func close() {
        closed = true
        for job in imports.values where !job.committing { job.task.cancel() }
    }

    /// Settles a write a crash cut off, then removes what no record or pin keeps.
    func open() async {
        guard let ledger else {
            failure = Self.fail(.recoveryRequired, "The operation ledger could not be opened, so skills cannot be changed. Quit and relaunch Trezi.")
            return
        }
        if await ledger.recoveries().contains(where: { $0.domain == Self.domain }) { await reconcile() }
        failure = nil
        await serial { await self.collect() }
    }

    /// Runs jobs one at a time in call order, across suspensions.
    private func serial<T: Sendable>(_ job: @escaping @Sendable () async -> T) async -> T {
        let previous = tail
        let task = Task { await previous?.value; return await job() }
        tail = Task { _ = await task.value }
        return await task.value
    }

    nonisolated private func manifestBytes() throws -> Data? { try store.read(store.manifest.path, limit: SkillsLimits.maxManifestBytes) }

    private func reconcile() async {
        guard let ledger, let prior = await ledger.snapshot(domain: Self.domain)?.value["digest"]?.string,
              let found = try? PreferencesDisk.digest(manifestBytes()) else { return }
        for op in await ledger.recoveries() where op.domain == Self.domain {
            let resolution: LedgerResolution
            if let target = op.pending?["digest"]?.string, target == found {
                resolution = .applied(result: .object(op.pending ?? [:]), checkpoint: Self.checkpoint(target))
            } else if found == prior {
                resolution = .notApplied(Self.fail(.ioFailure, "The change did not reach the skills registry.", retryable: true, operationID: op.id))
            } else {
                resolution = .notApplied(Self.fail(.conflict, "The skills registry changed outside Trezi before this change was confirmed.", operationID: op.id))
            }
            _ = await ledger.reconcile(op.id, resolution)
        }
    }

    struct State: Sendable { let revision: ServiceRevision; let digest: String; let manifest: SkillsManifest }
    enum Ensured { case ready(State), failed(ServiceFailure) }

    /// The domain, registered on first use, and the manifest it holds. A valid file
    /// changed outside the service is adopted as a new revision, never rewritten.
    private func ensure() async -> Ensured {
        guard let ledger else { return .failed(Self.fail(.recoveryRequired, "The operation ledger is unavailable.")) }
        guard store.safe else { return .failed(Self.fail(.recoveryRequired, "The skills folder in Trezi’s data is not a plain folder. It was left untouched.")) }
        for attempt in 0..<4 {
            let data: Data?
            do { data = try manifestBytes() } catch { return .failed(Self.damaged) }
            let found = PreferencesDisk.digest(data)
            if attempt == 0 {
                guard await ledger.register(domain: Self.domain, checkpoint: Self.checkpoint(found)) != nil else {
                    return .failed(Self.fail(.ioFailure, "The skills domain could not be recorded.", retryable: true))
                }
                if await ledger.recoveries().contains(where: { $0.domain == Self.domain }) { await reconcile(); continue }
            }
            guard !(await ledger.recoveries().contains { $0.domain == Self.domain }) else {
                return .failed(Self.fail(.recoveryRequired, "An earlier skills change could not be reconciled."))
            }
            guard let snapshot = await ledger.snapshot(domain: Self.domain) else { return .failed(Self.fail(.ioFailure, "Unknown skills domain.")) }
            let manifest: SkillsManifest
            do { manifest = try SkillsManifest.decode(data) } catch { return .failed(Self.damaged) }
            if snapshot.value["digest"]?.string == found { return .ready(State(revision: snapshot.revision, digest: found, manifest: manifest)) }
            let request = Self.internalRequest(method: "adopt", revision: snapshot.revision, body: ["digest": .string(found)])
            let outcome = await ledger.perform(request, domain: Self.domain) { _ in
                guard (try? PreferencesDisk.digest(self.manifestBytes())) == found else {
                    throw LedgerEffectError.notApplied(Self.fail(.conflict, "The skills registry changed again while it was read."))
                }
                return LedgerCommit(result: .object(["digest": .string(found), "adopted": .bool(true)]), checkpoint: Self.checkpoint(found))
            }
            if case .failed(let failure) = outcome.result, failure.code != .conflict { return .failed(failure) }
        }
        return .failed(Self.fail(.busy, "The skills registry keeps changing outside Trezi.", retryable: true))
    }

    /// Removes leftovers and unkept revisions/objects; skipped while anything is unreadable.
    private func collect() async {
        guard case .ready(let state) = await ensure(), let pins = try? store.snapshots() else { return }
        let keep = state.manifest.skills.reduce(into: Set<String>()) { $0.formUnion($1.kept) }.union(pins.flatMap { $0.pins.map(\.revision) })
        store.sweep(keep: keep)
    }

    // MARK: Requests

    func handle(_ line: Data) async -> Data {
        let frame: PipeFrame, request: SkillsRequest
        do {
            frame = try PipeFrame(line, service: Self.service, maxDepth: 8)
            request = try SkillsRequest(method: frame.method, mode: frame.mode, expectsRevision: frame.expectedRevision != nil, body: frame.body)
        } catch {
            let code = error as? ServiceContractFailure ?? .invalidRequest
            return Self.reply(id: (try? JSValue.parse(line, maxDepth: 8))?["id"] ?? .null, frame: nil,
                result: .failed(Self.fail(code, code == .unauthorized ? "Skills are app-scoped; a scoped request is refused." : "Invalid skills request.")), snapshot: nil)
        }
        if closed { return Self.reply(id: frame.id, frame: frame, result: .failed(Self.stopping), snapshot: nil) }
        switch request {
        case .github(let url, let ref, let subpath, let replacing):
            return await startImport(frame, SkillsImportRequest(url: url, ref: ref, subpath: subpath, replacing: replacing))
        case .cancel(let operation):
            return Self.reply(id: frame.id, frame: frame, result: .succeeded(cancelImport(operation, connection: frame.connection)), snapshot: nil)
        default: return await serial { await self.answer(frame, request) }
        }
    }

    private func answer(_ frame: PipeFrame, _ request: SkillsRequest) async -> Data {
        if let failure { return Self.reply(id: frame.id, frame: frame, result: .failed(failure), snapshot: nil) }
        let result = await perform(frame.request(service: Self.service), request)
        let snapshot: JSValue? = request.mutatesManifest ? await committed().map(Self.listValue) : nil
        return Self.reply(id: frame.id, frame: frame, result: result, snapshot: snapshot)
    }

    /// For other service owners: a provider session's pins (created once per session key).
    func pin(session: String) async -> PreferencesOwner.Answer {
        guard SkillSnapshot.validSession(session) else { return .failed(Self.fail(.invalidRequest, "Invalid session key.")) }
        return await serial { await self.perform(nil, .snapshot(session: session)) }
    }

    /// For the service's GitHub import: stores a fetched package with its provenance,
    /// as a new skill or (`replacing`) as the new source revision of an existing one.
    func install(files: [SkillFile], source: SkillSource, replacing: String? = nil) async -> PreferencesOwner.Answer {
        await serial {
            guard case .ready(let state) = await self.ensure() else { return .failed(Self.fail(.unavailable, "Skills are not available.", retryable: true)) }
            let request = Self.internalRequest(method: "install", revision: state.revision, body: ["source": .string(source.value.serialized().string)])
            return await self.perform(request, .install(files: files, source: source, replacing: replacing))
        }
    }

    private func perform(_ request: ServiceRequest?, _ operation: SkillsRequest) async -> PreferencesOwner.Answer {
        let state: State
        switch await ensure() {
        case .failed(let failure): return .failed(failure)
        case .ready(let value): state = value
        }
        do {
            switch operation {
            case .list: return .succeeded(Self.listValue(state))
            case .read(let skill, let revision, let session):
                let (id, stored) = try resolve(state.manifest, skill: skill, revision: revision, session: session)
                guard let entry = stored.entry else { throw SkillsPackageError.damaged("revision") }
                let body = try SkillsPackage.text(SkillFile(path: entry.path, data: try store.readObject(entry)))
                return .succeeded(.object([(JSText("skill"), .string(JSText(skill))), (JSText("revision"), .string(JSText(id))),
                    (JSText("name"), .string(JSText(stored.name))), (JSText("description"), .string(JSText(stored.description))),
                    (JSText("body"), .string(JSText(body))),
                    (JSText("references"), .array(stored.files.filter { $0.path != SkillsPackage.entryFile }.map(Self.entryValue)))]))
            case .reference(let skill, let revision, let path):
                let (id, stored) = try resolve(state.manifest, skill: skill, revision: revision, session: nil)
                guard let entry = stored.files.first(where: { $0.path == path }) else { return .failed(Self.fail(.notFound, "The skill has no file \(path).")) }
                let text = try SkillsPackage.text(SkillFile(path: path, data: try store.readObject(entry)))
                return .succeeded(.object([(JSText("skill"), .string(JSText(skill))), (JSText("revision"), .string(JSText(id))),
                    (JSText("path"), .string(JSText(path))), (JSText("text"), .string(JSText(text)))]))
            case .pins(let session):
                guard let snapshot = try store.readSnapshot(session) else { return .failed(Self.fail(.notFound, "This session has no pinned skills.")) }
                return .succeeded(snapshot.value)
            case .snapshot(let session): return .succeeded(try snapshot(session, state.manifest))
            case .release(let session):
                return .succeeded(.object([(JSText("session"), .string(JSText(session))), (JSText("released"), .bool(try store.removeSnapshot(session)))]))
            default:
                guard let request, let ledger else { return .failed(Self.fail(.invalidRequest, "Invalid skills request.")) }
                return await mutate(request, operation, ledger: ledger)
            }
        } catch { return .failed(Self.failure(error, operationID: nil)) }
    }

    /// The revision a read names: a session's pin, or one of the skill's kept revisions,
    /// or a revision some session pins (a purged skill still serves its pinned sessions).
    private func resolve(_ manifest: SkillsManifest, skill: String, revision: String?, session: String?) throws -> (String, SkillRevision) {
        let record = manifest.record(skill)
        let id: String
        if let session {
            guard let pin = try store.readSnapshot(session)?.pins.first(where: { $0.skill == skill }) else { throw Lookup.missing }
            id = pin.revision
        } else if let revision {
            let kept = record?.kept.contains(revision) == true
            guard try kept || store.snapshots().contains(where: { $0.pins.contains { $0.skill == skill && $0.revision == revision } }) else { throw Lookup.missing }
            id = revision
        } else {
            guard let record else { throw Lookup.missing }
            id = record.revision
        }
        return (id, try store.readRevision(id))
    }
    enum Lookup: Error { case missing }

    private func snapshot(_ session: String, _ manifest: SkillsManifest) throws -> JSValue {
        if let existing = try store.readSnapshot(session) { return Self.with(existing.value, ("created", .bool(false))) }
        try store.prepare()
        let stored = try store.snapshots()
        // A bound must never change an existing or resumable session's revisions.
        // Snapshot release is explicit; capacity rejects only the new session.
        guard stored.count < SkillsLimits.maxSnapshots else {
            throw SkillsPlan.Refusal.conflict("The skill snapshot limit was reached. Existing sessions remain pinned; explicitly release unneeded saved sessions before starting another.")
        }
        var pins: [SkillPin] = [], skipped: [JSValue] = []
        for record in manifest.skills where record.active && record.enabled {
            if (try? store.readRevision(record.revision)) != nil {
                pins.append(SkillPin(skill: record.id, name: record.name, revision: record.revision, providers: record.providers))
            } else { skipped.append(.string(JSText(record.id))) }
        }
        let created = SkillSnapshot(session: session, createdAt: now(), pins: pins)
        try store.writeSnapshot(created)
        return Self.with(created.value, ("created", .bool(true)), ("skipped", .array(skipped)))
    }

    private func mutate(_ request: ServiceRequest, _ operation: SkillsRequest, ledger: OperationLedger) async -> PreferencesOwner.Answer {
        externalChange = false
        var outcome = await ledger.perform(request, domain: Self.domain) { context in
            try await self.effect(context, operation)
        }
        if case .operation(let op) = outcome, op.phase == .uncertain {
            await reconcile()
            if case .operation(let settled) = await ledger.status(op.id) { outcome = .operation(settled) }
        }
        if externalChange, case .failed(let problem) = await ensure() { return .failed(problem) }
        switch outcome.result {
        case .succeeded(let result):
            guard case .operation(let op) = outcome, case .object(let fields) = result else { return .succeeded(PreferencesOwner.value(result)) }
            if case .purge = operation { await collect() }
            var payload: [(JSText, JSValue)] = [(JSText("revision"), PreferencesOwner.value(op.reserved))]
            for name in ["digest", "changed", "skill", "skillRevision", "skipped"] { if let value = fields[name] { payload.append((JSText(name), PreferencesOwner.value(value))) } }
            return .succeeded(.object(payload))
        case .failed(let failure): return .failed(failure)
        }
    }

    private func effect(_ context: LedgerEffectContext, _ operation: SkillsRequest) async throws -> LedgerCommit {
        func notApplied(_ error: Error) -> LedgerEffectError { .notApplied(Self.failure(error, operationID: context.operationID)) }
        let current: Data?
        do { current = try manifestBytes() } catch { throw notApplied(SkillsPackageError.damaged("manifest")) }
        let found = PreferencesDisk.digest(current)
        guard context.checkpoint["digest"]?.string == found else {
            externalChange = true
            throw LedgerEffectError.notApplied(Self.fail(.conflict, "The skills registry changed outside Trezi. Nothing was changed; try again.", operationID: context.operationID))
        }
        var manifest: SkillsManifest
        do { manifest = try SkillsManifest.decode(current) } catch { throw notApplied(error) }
        var result: [String: ServiceJSON]
        do {
            try store.prepare()
            result = try SkillsPlan(store: store, now: now()).apply(operation, to: &manifest)
        } catch { throw notApplied(error) }
        guard result["changed"] == .bool(true) else {
            result["digest"] = .string(found)
            return LedgerCommit(result: .object(result), checkpoint: Self.checkpoint(found))
        }
        let bytes = manifest.encoded(), target = PreferencesDisk.digest(bytes), disk = store.manifest
        do { try disk.prepare(bytes) } catch { throw notApplied(SkillsPackageError.io("\(error)")) }
        result["digest"] = .string(target)
        do { try await context.beginEffect(pending: result) }
        catch { unlink(disk.temporaryPath); throw error }
        do { try disk.replace() } catch { throw notApplied(SkillsPackageError.io("\(error)")) }
        try? disk.syncDirectory()
        return LedgerCommit(result: .object(result), checkpoint: Self.checkpoint(target))
    }

    /// The manifest as committed, without adopting anything (for reply snapshots).
    func committed() async -> State? {
        guard let ledger, let snapshot = await ledger.snapshot(domain: Self.domain), let data = try? manifestBytes(),
              snapshot.value["digest"]?.string == PreferencesDisk.digest(data), let manifest = try? SkillsManifest.decode(data) else { return nil }
        return State(revision: snapshot.revision, digest: PreferencesDisk.digest(data), manifest: manifest)
    }

    // MARK: Encoding

    static let stopping = fail(.unavailable, "The service is stopping; skills were not changed.", retryable: true)
    static let damaged = fail(.recoveryRequired, "The skills registry (skills/manifest.json in Trezi’s data) is damaged. It was left untouched; fix or remove it, then try again.")
    static func checkpoint(_ digest: String) -> [String: ServiceJSON] { ["digest": .string(digest), "format": .string(SkillsManifest.format)] }
    static func fail(_ code: ServiceContractFailure, _ message: String, retryable: Bool = false, operationID: String? = nil) -> ServiceFailure {
        PreferencesOwner.fail(code, message, retryable: retryable, operationID: operationID)
    }
    static func failure(_ error: Error, operationID: String?) -> ServiceFailure {
        switch error {
        case SkillsPackageError.invalid(let message): return fail(.invalidRequest, message, operationID: operationID)
        case SkillsPackageError.refused(let message): return fail(.unauthorized, message, operationID: operationID)
        case SkillsPackageError.damaged(let what): return fail(.recoveryRequired, "Stored skill data (\(what)) is damaged. It was left untouched.", operationID: operationID)
        case SkillsPlan.Refusal.conflict(let message): return fail(.conflict, message, operationID: operationID)
        case SkillsPlan.Refusal.notFound, Lookup.missing: return fail(.notFound, "No such skill or revision.", operationID: operationID)
        default: return fail(.ioFailure, "The skills registry could not be written (\(error)). Nothing was changed.", retryable: true, operationID: operationID)
        }
    }
    static func stoppingReply(id: JSValue) -> Data { reply(id: id, frame: nil, result: .failed(stopping), snapshot: nil) }

    static func internalRequest(method: String, revision: ServiceRevision, body: [String: ServiceJSON]) -> ServiceRequest {
        ServiceRequest(connection: UUID().uuidString.lowercased(), requestID: UUID().uuidString.lowercased(),
            operationID: UUID().uuidString.lowercased(), scope: PreferencesOwner.global, mode: .mutation, expectedRevision: revision,
            timeoutMilliseconds: nil, service: service, method: method, body: body)
    }

    static func with(_ value: JSValue, _ extra: (String, JSValue)...) -> JSValue {
        guard case .object(let fields) = value else { return value }
        return .object(fields + extra.map { (JSText($0.0), $0.1) })
    }
    static func entryValue(_ entry: SkillEntry) -> JSValue {
        .object([(JSText("path"), .string(JSText(entry.path))), (JSText("size"), .number(Double(entry.size))), (JSText("digest"), .string(JSText(entry.digest)))])
    }

    /// Metadata only: no package text leaves the service in a listing.
    static func listValue(_ state: State) -> JSValue {
        .object([(JSText("revision"), PreferencesOwner.value(state.revision)), (JSText("digest"), .string(JSText(state.digest))),
            (JSText("skills"), .array(state.manifest.skills.map { skill in
                .object([
                    (JSText("id"), .string(JSText(skill.id))), (JSText("name"), .string(JSText(skill.name))),
                    (JSText("description"), .string(JSText(skill.description))), (JSText("revision"), .string(JSText(skill.revision))),
                    (JSText("installedRevision"), .string(JSText(skill.installed))), (JSText("modified"), .bool(skill.modified)),
                    (JSText("enabled"), .bool(skill.enabled)), (JSText("removed"), .bool(!skill.active)),
                    (JSText("removedAt"), skill.removedAt.map(JSValue.number) ?? .null), (JSText("providers"), skill.providers.value),
                    (JSText("source"), skill.source.value), (JSText("files"), .number(Double(skill.files))), (JSText("bytes"), .number(Double(skill.bytes))),
                    (JSText("history"), .array(skill.history.map { .object([(JSText("revision"), .string(JSText($0.revision))),
                        (JSText("createdAt"), .number($0.createdAt)), (JSText("kind"), .string(JSText($0.kind)))]) })),
                    (JSText("createdAt"), .number(skill.createdAt)), (JSText("updatedAt"), .number(skill.updatedAt))
                ])
            }))])
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
