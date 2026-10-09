import Foundation
import CryptoKit

/// The single writer of `<profile>/preferences.json` when the Swift service owns
/// the profile (S03 domain `preferences`). The file keeps the legacy v1 format; this
/// is its only writer since LKM-111.
///
/// Commit protocol for one batch, inside the ledger's FIFO lane for the domain:
/// re-read the file (a digest other than the checkpoint's is an external edit:
/// the batch conflicts and the file is adopted as a new revision), write a 0600
/// temp file and `F_FULLFSYNC` it, `beginEffect` (records the target digest),
/// rename, sync the directory, install the new values, then the receipt.
actor PreferencesOwner {
    static let domain = "preferences"
    static let format = "trezi-preferences-v1"
    static let maxEntries = 256

    let disk: PreferencesDisk
    let ledger: OperationLedger?
    private var values = PreferenceValues()
    private var digest = PreferencesDisk.absent
    private var revision = ServiceRevision(epoch: "", counter: "0")
    /// Set until `open` succeeds; every request is answered with it.
    private var failure: ServiceFailure? = PreferencesOwner.fail(.unavailable, "Preferences are not open yet.", retryable: true)
    private var closed = false
    private var externalChange = false
    private var changed: (@Sendable (Data) -> Void)?

    init(disk: PreferencesDisk, ledger: OperationLedger?) { self.disk = disk; self.ledger = ledger }

    func onChange(_ handler: @escaping @Sendable (Data) -> Void) { changed = handler }
    func close() { closed = true }

    // MARK: Opening: import, reconcile, adopt

    /// Imports the newest file as the domain's checkpoint. A file that is not valid
    /// v1 is never replaced: the domain stays unavailable and the file untouched.
    func open() async {
        guard let ledger else {
            failure = Self.fail(.recoveryRequired, "The operation ledger could not be opened, so preferences cannot be saved. Quit and relaunch Trezi.")
            return
        }
        let data: Data?, parsed: PreferenceValues
        do { data = try disk.read() }
        catch { failure = Self.fail(.ioFailure, "preferences.json could not be read (\(error)).", retryable: true); return }
        do { parsed = try data.map(PreferenceValues.decode) ?? PreferenceValues() }
        catch { failure = Self.fail(.recoveryRequired, "preferences.json is not a valid version 1 preferences file. It was left untouched."); return }
        let found = PreferencesDisk.digest(data)
        guard await ledger.register(domain: Self.domain, checkpoint: Self.checkpoint(found)) != nil else {
            failure = Self.fail(.ioFailure, "The preferences domain could not be recorded.", retryable: true); return
        }
        await reconcile(found: found)
        guard let current = await ledger.snapshot(domain: Self.domain), current.value["digest"]?.string != nil else { return }
        guard !(await ledger.recoveries().contains { $0.domain == Self.domain }) else {
            failure = Self.fail(.recoveryRequired, "An earlier preferences write could not be reconciled.")
            return
        }
        values = parsed
        digest = current.value["digest"]?.string ?? PreferencesDisk.absent
        revision = current.revision
        failure = nil
        // The file changed since the last checkpoint (e.g. an edit made while the service
        // was down): it is adopted, never overwritten.
        if let problem = await adopt() { failure = problem }
    }

    /// Resolves writes whose outcome is uncertain by what the file now holds:
    /// the target digest means applied, the prior checkpoint means not applied,
    /// anything else was superseded by an external edit. Never replayed.
    private func reconcile(found: String) async {
        guard let ledger, let prior = await ledger.snapshot(domain: Self.domain)?.value["digest"]?.string else { return }
        for op in await ledger.recoveries() where op.domain == Self.domain {
            let target = op.pending?["digest"]?.string
            let resolution: LedgerResolution
            if let target, target == found {
                resolution = .applied(result: .object(["digest": .string(target)]), checkpoint: Self.checkpoint(target))
            } else if found == prior {
                resolution = .notApplied(Self.fail(.ioFailure, "The change did not reach preferences.json.", retryable: true, operationID: op.id))
            } else {
                resolution = .notApplied(Self.fail(.conflict, "preferences.json changed outside Trezi before this change was confirmed.", operationID: op.id))
            }
            _ = await ledger.reconcile(op.id, resolution)
        }
    }

    /// Takes the file as it is now as a new revision, when it differs from ours.
    private func adopt() async -> ServiceFailure? {
        guard let ledger else { return Self.fail(.recoveryRequired, "The operation ledger is unavailable.") }
        for _ in 0..<3 {
            let data: Data?
            do { data = try disk.read() } catch { return Self.fail(.ioFailure, "preferences.json could not be read.", retryable: true) }
            let found = PreferencesDisk.digest(data)
            if found == digest { return nil }
            guard let parsed = try? data.map(PreferenceValues.decode) ?? PreferenceValues() else {
                return Self.fail(.recoveryRequired, "preferences.json was changed outside Trezi and is not a valid version 1 file. It was left untouched; fix or remove it, then try again.")
            }
            let request = ServiceRequest(connection: UUID().uuidString.lowercased(), requestID: UUID().uuidString.lowercased(),
                operationID: UUID().uuidString.lowercased(), scope: Self.global, mode: .mutation, expectedRevision: revision,
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
        return Self.fail(.busy, "preferences.json keeps changing outside Trezi.", retryable: true)
    }

    private func adoptEffect(_ context: LedgerEffectContext, parsed: PreferenceValues, found: String) throws -> LedgerCommit {
        guard context.revision == revision else { throw LedgerEffectError.notApplied(Self.fail(.conflict, "Preferences changed.")) }
        guard (try? PreferencesDisk.digest(disk.read())) == found else {
            throw LedgerEffectError.notApplied(Self.fail(.conflict, "preferences.json changed again while it was read."))
        }
        install(parsed, digest: found, revision: context.reserved)
        return LedgerCommit(result: .object(["digest": .string(found), "adopted": .bool(true)]), checkpoint: Self.checkpoint(found))
    }

    // MARK: Requests

    /// One request frame from Bun's private pipe; the answer frame (no newline).
    func handle(_ line: Data) async -> Data {
        let frame: PreferencesFrame
        do { frame = try PreferencesFrame(line) }
        catch {
            let code = error as? ServiceContractFailure ?? .invalidRequest
            return Self.reply(id: (try? JSValue.parse(line, maxDepth: 8))?["id"] ?? .null, request: nil,
                result: .failed(Self.fail(code, code == .unauthorized ? "Preferences are global; a scoped request is refused." : "Invalid preferences request.")), snapshot: nil)
        }
        if closed { return Self.reply(id: frame.id, request: frame.request, result: .failed(Self.stopping), snapshot: nil) }
        if let failure { return Self.reply(id: frame.id, request: frame.request, result: .failed(failure), snapshot: nil) }
        guard let entries = frame.entries else {
            return Self.reply(id: frame.id, request: frame.request, result: .succeeded(snapshotValue()), snapshot: nil)
        }
        let result = await set(frame.request, entries: entries)
        return Self.reply(id: frame.id, request: frame.request, result: result, snapshot: failure == nil ? snapshotValue() : nil)
    }

    enum Answer { case succeeded(JSValue), failed(ServiceFailure) }

    func set(_ request: ServiceRequest, entries: [(JSText, JSText?)]) async -> Answer {
        guard let ledger else { return .failed(Self.fail(.recoveryRequired, "The operation ledger is unavailable.")) }
        externalChange = false
        var outcome = await ledger.perform(request, domain: Self.domain) { context in
            try await self.setEffect(context, entries: entries)
        }
        // Only a failed journal write leaves a live operation uncertain; settle it
        // from the file now instead of blocking the domain until a restart.
        if case .operation(let op) = outcome, op.phase == .uncertain {
            if let found = try? PreferencesDisk.digest(disk.read()) { await reconcile(found: found) }
            if case .operation(let settled) = await ledger.status(op.id) { outcome = .operation(settled) }
        }
        if externalChange, let problem = await adopt() { return .failed(problem) }
        switch outcome.result {
        case .succeeded(let result):
            guard case .operation(let op) = outcome else { return .succeeded(Self.value(result)) }
            return .succeeded(.object([(JSText("revision"), Self.value(op.reserved)), (JSText("digest"), Self.value(result["digest"] ?? .null))]))
        case .failed(let failure): return .failed(failure)
        }
    }

    private func setEffect(_ context: LedgerEffectContext, entries: [(JSText, JSText?)]) async throws -> LedgerCommit {
        guard context.revision == revision, context.checkpoint["digest"]?.string == digest else {
            throw LedgerEffectError.notApplied(Self.fail(.recoveryRequired, "Preferences are out of step with the ledger; relaunch Trezi."))
        }
        let current: Data?
        do { current = try disk.read() }
        catch { throw LedgerEffectError.notApplied(Self.fail(.ioFailure, "preferences.json could not be read.", retryable: true)) }
        guard PreferencesDisk.digest(current) == digest else {
            externalChange = true
            throw LedgerEffectError.notApplied(Self.fail(.conflict, "preferences.json changed outside Trezi. Your change was not saved; try again.", operationID: context.operationID))
        }
        var next = values
        for (key, value) in entries { next.set(PreferenceValues.canonical(key), value) }
        let bytes = next.encoded()
        let target = PreferencesDisk.digest(bytes)
        func notSaved(_ error: Error) -> LedgerEffectError {
            .notApplied(Self.fail(.ioFailure, "Preferences could not be saved (\(error)). Nothing was changed.", retryable: true, operationID: context.operationID))
        }
        do { try disk.prepare(bytes) } catch { throw notSaved(error) }
        do { try await context.beginEffect(pending: ["digest": .string(target)]) }
        catch { unlink(disk.temporaryPath); throw error }
        do { try disk.replace() } catch { throw notSaved(error) }
        // Readers already see the new file. A failed directory sync cannot undo that;
        // a later open adopts whatever the file holds if the rename did not persist.
        try? disk.syncDirectory()
        install(next, digest: target, revision: context.reserved)
        return LedgerCommit(result: .object(["digest": .string(target)]), checkpoint: Self.checkpoint(target))
    }

    private func install(_ next: PreferenceValues, digest: String, revision: ServiceRevision) {
        values = next; self.digest = digest; self.revision = revision
    }

    /// Only for changes Bun did not ask for (adopted external edits); its own
    /// writes are answered with the snapshot in the reply.
    private func announce() {
        changed?(JSValue.object([(JSText("event"), .string(JSText("service-event"))), (JSText("service"), .string(JSText(Self.domain))),
            (JSText("name"), .string(JSText("preferences.changed"))), (JSText("snapshot"), snapshotValue())]).utf8())
    }

    // MARK: Encoding

    static let global = ServiceScope(project: nil, chat: nil, turn: nil, checkout: nil, document: nil)
    static let stopping = fail(.unavailable, "The service is stopping; preferences were not saved.", retryable: true)
    static func checkpoint(_ digest: String) -> [String: ServiceJSON] { ["digest": .string(digest), "format": .string(format)] }

    func snapshotValue() -> JSValue {
        .object([(JSText("revision"), Self.value(revision)), (JSText("digest"), .string(JSText(digest))),
            (JSText("entries"), .array(values.entries.map { .object([(JSText("key"), .string($0.key)), (JSText("value"), $0.value.map(JSValue.string) ?? .null)]) }))])
    }

    static func fail(_ code: ServiceContractFailure, _ message: String, retryable: Bool = false, operationID: String? = nil) -> ServiceFailure {
        ServiceFailure(code: code, message: message, retryable: retryable, operationID: operationID, currentRevision: nil, recoveryID: nil)
    }

    static func value(_ json: ServiceJSON) -> JSValue {
        switch json {
        case .null: return .null
        case .bool(let value): return .bool(value)
        case .number(let value): return .number(value)
        case .string(let value): return .string(JSText(value))
        case .array(let values): return .array(values.map(value))
        case .object(let fields): return .object(fields.sorted { $0.key < $1.key }.map { (JSText($0.key), value($0.value)) })
        }
    }
    static func value<T: Encodable>(_ encodable: T) -> JSValue {
        guard let data = try? JSONEncoder().encode(encodable), let json = try? JSONDecoder().decode(ServiceJSON.self, from: data) else { return .null }
        return value(json)
    }

    static func reply(id: JSValue, request: ServiceRequest?, result: Answer, snapshot: JSValue?) -> Data {
        let body: JSValue
        switch result {
        case .succeeded(let payload): body = .object([(JSText("kind"), .string(JSText("succeeded"))), (JSText("payload"), payload)])
        case .failed(let failure): body = .object([(JSText("kind"), .string(JSText("failed"))), (JSText("payload"), value(failure))])
        }
        var reply: [(JSText, JSValue)] = []
        if let request {
            reply = [(JSText("connection"), .string(JSText(request.connection))), (JSText("requestID"), .string(JSText(request.requestID))),
                     (JSText("operationID"), .string(JSText(request.operationID))), (JSText("scope"), .object([]))]
        }
        reply.append((JSText("result"), body))
        var frame: [(JSText, JSValue)] = [(JSText("event"), .string(JSText("service-reply"))), (JSText("service"), .string(JSText(domain))),
                                         (JSText("id"), id), (JSText("reply"), .object(reply))]
        if let snapshot { frame.append((JSText("snapshot"), snapshot)) }
        return JSValue.object(frame).utf8()
    }
}

/// `{"service":"preferences","id":n,"request":{…S01 request…}}` from Bun. Strict:
/// unknown fields, a non-global scope, a wrong mode/method pairing and any invalid
/// key or value are refused before anything is recorded or written.
struct PreferencesFrame {
    let id: JSValue
    let request: ServiceRequest
    /// nil for `snapshot`; the ordered batch for `set`.
    let entries: [(JSText, JSText?)]?

    init(_ line: Data) throws {
        let invalid = ServiceContractFailure.invalidRequest
        let root = try JSValue.parse(line, maxDepth: 8)
        guard case .object(let top) = root, top.count == 3, Set(top.map { $0.0.string }) == ["service", "id", "request"],
              root["service"]?.text?.string == PreferencesOwner.domain, case .number(let number)? = root["id"],
              number.rounded() == number, case .object(let requestFields)? = root["request"] else { throw invalid }
        id = .number(number)
        let allowed: Set<String> = ["connection", "requestID", "operationID", "scope", "mode", "expectedRevision",
                                    "timeoutMilliseconds", "service", "method", "body"]
        let names = Set(requestFields.map { $0.0.string })
        guard names.isSubset(of: allowed), names.count == requestFields.count,
              names.isSuperset(of: ["connection", "requestID", "operationID", "scope", "mode", "service", "method", "body"]) else { throw invalid }
        let fields = root["request"]!
        func uuid(_ key: String) throws -> String {
            guard let text = fields[key]?.text?.string, UUID(uuidString: text) != nil else { throw invalid }
            return text
        }
        guard case .object(let scope)? = fields["scope"], scope.isEmpty else { throw ServiceContractFailure.unauthorized }
        guard fields["service"]?.text?.string == PreferencesOwner.domain, let mode = fields["mode"]?.text?.string,
              let method = fields["method"]?.text?.string, case .object(let body)? = fields["body"] else { throw invalid }
        var expected: ServiceRevision?
        if let revision = fields["expectedRevision"] {
            guard case .object(let parts) = revision, parts.count == 2, let epoch = revision["epoch"]?.text?.string,
                  let counter = revision["counter"]?.text?.string, UInt64(counter) != nil else { throw invalid }
            expected = ServiceRevision(epoch: epoch, counter: counter)
        }
        var timeout: UInt32?
        if let value = fields["timeoutMilliseconds"] {
            guard case .number(let ms) = value, ms >= 0, ms <= Double(UInt32.max), ms.rounded() == ms else { throw invalid }
            timeout = UInt32(ms)
        }
        var ledgerBody: [String: ServiceJSON] = [:]
        switch (method, mode) {
        case ("snapshot", "read"):
            guard body.isEmpty, expected == nil else { throw invalid }
            entries = nil
        case ("set", "mutation"):
            guard body.count == 1, case .array(let items)? = fields["body"]?["entries"], expected != nil,
                  (1...PreferencesOwner.maxEntries).contains(items.count) else { throw invalid }
            var batch: [(JSText, JSText?)] = []
            for item in items {
                guard case .object(let parts) = item, parts.count == 2, let key = item["key"]?.text, PreferenceValues.validKey(key) else { throw invalid }
                switch item["value"] {
                case .null?: batch.append((key, nil))
                case .string(let text)? where PreferenceValues.validValue(text): batch.append((key, text))
                default: throw invalid
                }
            }
            entries = batch
            // Identity is the exact batch (UTF-16, order, null versus text): its digest.
            let exact = JSValue.array(batch.map { .array([.string($0.0), $0.1.map(JSValue.string) ?? .null]) }).utf8()
            ledgerBody["entries"] = .string(SHA256.hash(data: exact).map { String(format: "%02x", $0) }.joined())
        default: throw invalid
        }
        request = ServiceRequest(connection: try uuid("connection"), requestID: try uuid("requestID"), operationID: try uuid("operationID"),
            scope: PreferencesOwner.global, mode: mode == "read" ? .read : .mutation, expectedRevision: expected,
            timeoutMilliseconds: timeout, service: PreferencesOwner.domain, method: method, body: ledgerBody)
    }
}
