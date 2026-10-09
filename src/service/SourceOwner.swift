import Foundation

/// The source transaction service (S08/S09, LKM-96): under the Swift launch the only
/// writer of a user's source files for Trezi's own edits — prop, text, style, move,
/// island, content and control edits, the code editor's saves, the file tree's
/// create/rename/delete, and Undo, redo and revert over all of them. Bun's parsers
/// (React, Svelte, HTML, Tailwind, tokens) only *propose*: each proposal names the
/// file, the SHA-256 of the bytes it was computed from, and the new content. A
/// proposal computed from anything but the file's current bytes — an external edit,
/// a cancelled or out-of-order parse — is refused as a conflict with nothing written.
///
/// Every effect runs in the repository coordinator's lane for the file's repository
/// (or inside a lease Bun holds on it), so the Repository stays the serialization
/// authority. Multi-file writes are journaled transactions (`SourceJournal`).
final class SourceOwner: @unchecked Sendable {
    static let service = "source"
    static let maxEdits = 256

    struct Options {
        var profile: String
        /// Test hook: named points inside transactions (a fixture crashes there).
        var fault: (@Sendable (String) -> Void)?
    }

    let store: SourceStore
    let drafts: SourceDrafts
    private let repository: RepositoryOwner
    private let send: @Sendable (Data) -> Void
    /// Pipe order in: validation, history records and draft writes happen here, in order.
    private let intake = DispatchQueue(label: "dev.trezi.source.intake")
    private let reads = DispatchQueue(label: "dev.trezi.source.reads", attributes: .concurrent)
    private let lock = NSLock()
    private var closed = false
    private var journalFailure: String?
    private let inflight = DispatchGroup()

    init(options: Options, repository: RepositoryOwner, send: @escaping @Sendable (Data) -> Void) {
        self.repository = repository; self.send = send
        let journal = SourceJournal(profile: options.profile)
        do { try journal.open() } catch { journalFailure = "\(error)" }
        store = SourceStore(journal: journal, fault: options.fault)
        drafts = SourceDrafts(profile: options.profile)
    }

    // MARK: Requests (from the backend reader thread, in pipe order)

    func submit(_ line: Data) {
        let frame: PipeFrame
        do { frame = try PipeFrame(line, service: Self.service, maxDepth: 8) } catch {
            let code = error as? ServiceContractFailure ?? .invalidRequest
            send(Self.reply(id: (try? JSValue.parse(line, maxDepth: 8))?["id"] ?? .null, frame: nil,
                            result: .failed(RepositoryOwner.fail(code, "Invalid source request."))))
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
                var fields: [(String, JSValue)] = [("interrupted", .array(store.journal.reports().map { PreferencesOwner.value($0) }))]
                if let journalFailure { fields.append(("journal", .string(JSText(journalFailure)))) }
                answer(frame, .succeeded(RepositoryOwner.object(fields)))
            case ("acknowledge", "mutation"):
                let body = try Body(frame, required: ["operationID", "intent"], optional: [])
                guard try body.string("intent") == "acknowledge" else { throw ServiceContractFailure.invalidRequest }
                answer(frame, store.journal.acknowledge(try body.string("operationID"))
                    ? .succeeded(.object([])) : .failed(RepositoryOwner.fail(.notFound, "No such interrupted source transaction.")))
            case ("read", "read"):
                let body = try Body(frame, required: ["root", "path"], optional: [])
                let (given, root) = try roots(body)
                let target = try SourcePaths.target(given: given, root: root, path: try body.string("path"))
                reads.async { self.respond(frame) { try self.read(target) } }
            case ("history", "read"):
                let body = try Body(frame, required: ["root"], optional: [])
                let (undo, redo) = store.history.available(root: try roots(body).1)
                answer(frame, .succeeded(RepositoryOwner.object([("undo", .bool(undo)), ("redo", .bool(redo))])))
            case ("canRevert", "read"):
                let body = try Body(frame, required: ["root", "group"], optional: [])
                let root = try roots(body).1, group = try body.string("group")
                reads.async { self.respond(frame) { RepositoryOwner.object([("revertable", .bool(self.store.revertable(root: root, group: group)))]) } }
            case ("drafts", "read"):
                let body = try Body(frame, required: ["root"], optional: [])
                let (given, root) = try roots(body)
                reads.async { self.respond(frame) { try self.listDrafts(given: given, root: root) } }
            case ("record", "mutation"):
                let body = try Body(frame, required: ["root", "edits"], optional: ["key", "group"])
                let (given, root) = try roots(body)
                let key = body.has("key") ? try body.string("key") : nil, group = body.has("group") ? try body.string("group") : nil
                let entries = try Self.objects(body.value("edits"), ["path", "before", "after"]).map { edit in
                    let path = try Body.text(edit["path"])
                    let target = try SourcePaths.target(given: given, root: root, path: path)
                    return SourceHistory.Entry(display: path, file: target.real, before: Data(try Self.content(edit["before"]).utf8),
                                               after: Data(try Self.content(edit["after"]).utf8), key: key, group: group, at: Date(), gesture: false)
                }
                for entry in entries { store.history.record(root: root, entry) }
                answer(frame, .succeeded(RepositoryOwner.object([("recorded", .number(Double(entries.count)))])))
            case ("clearHistory", "mutation"):
                store.history.clear(root: try roots(try Body(frame, required: ["root"], optional: [])).1)
                answer(frame, .succeeded(.object([])))
            case ("saveDraft", "mutation"):
                let body = try Body(frame, required: ["root", "path", "base", "text"], optional: [])
                let root = try roots(body).1
                guard let path = SourcePaths.relative(try body.string("path")) else { throw ServiceContractFailure.invalidRequest }
                try drafts.save(root: root, SourceDrafts.Draft(path: path, base: try Self.hash(body.value("base")),
                    text: try Self.content(body.value("text")), updated: ISO8601DateFormatter().string(from: Date())))
                answer(frame, .succeeded(.object([])))
            case ("clearDraft", "mutation"):
                let body = try Body(frame, required: ["root", "path"], optional: [])
                guard let path = SourcePaths.relative(try body.string("path")) else { throw ServiceContractFailure.invalidRequest }
                try drafts.clear(root: try roots(body).1, path: path)
                answer(frame, .succeeded(.object([])))
            case (let method, "mutation") where Self.laneMethods[method] != nil:
                let rule = Self.laneMethods[method]!
                let body = try Body(frame, required: rule.required, optional: rule.optional.union(["leases"]))
                if let intent = rule.intent, try body.string("intent") != intent { throw ServiceContractFailure.invalidRequest }
                let (given, root) = try roots(body)
                let effect = try prepare(frame, method: method, body: body, given: given, root: root)
                if !["createFile", "renameFile", "deleteFile", "removeWorkbench"].contains(method), let failure = journalFailure {
                    throw RepositoryRefusal(.recoveryRequired, failure)
                }
                // A request the client stopped waiting for (its deadline) never starts late.
                let deadline = frame.timeoutMilliseconds.map { DispatchTime.now() + .milliseconds(Int($0)) }
                let scheduled = repository.serialize(root: root, leases: try body.strings("leases")) {
                    self.lock.lock(); let refused = self.closed; self.lock.unlock()
                    if refused { return self.answer(frame, .failed(Self.stopping)) }
                    if let deadline, DispatchTime.now() > deadline { return self.answer(frame, .failed(Self.expired)) }
                    self.respond(frame, effect)
                }
                if !scheduled { answer(frame, .failed(Self.stopping)) }
            default: throw ServiceContractFailure.invalidRequest
            }
        } catch {
            answer(frame, .failed(Self.failure(error)))
        }
    }

    /// method → (required, optional, required intent)
    static let laneMethods: [String: (required: Set<String>, optional: Set<String>, intent: String?)] = [
        "commit": (["root", "edits"], ["key", "group", "gesture"], nil),
        "undo": (["root"], [], nil),
        "redo": (["root"], [], nil),
        "revert": (["root", "group", "intent"], [], "revert"),
        "createFile": (["root", "path"], [], nil),
        "renameFile": (["root", "path", "to"], [], nil),
        "deleteFile": (["root", "path", "intent"], [], "trash"),
        "removeWorkbench": (["root", "path", "seams", "intent"], [], "trash"),
    ]

    /// Everything is validated before the request enters a lane; the effect only runs there.
    private func prepare(_ frame: PipeFrame, method: String, body: Body, given: String, root: String) throws -> @Sendable () throws -> JSValue {
        let id = frame.operationID
        switch method {
        case "commit":
            let key = body.has("key") ? try body.string("key") : nil, group = body.has("group") ? try body.string("group") : nil
            let gesture = body.has("gesture") ? try body.bool("gesture") : false
            let edits = try Self.objects(body.value("edits"), ["path", "expectedHash", "content"])
            guard !edits.isEmpty, edits.count <= Self.maxEdits else { throw ServiceContractFailure.invalidRequest }
            var total = 0
            let writes = try edits.map { edit -> SourceStore.Write in
                let path = try Body.text(edit["path"])
                let content = Data(try Self.content(edit["content"]).utf8)
                total += content.count
                return SourceStore.Write(target: try SourcePaths.target(given: given, root: root, path: path), display: path,
                                         expected: try Self.hash(edit["expectedHash"]), content: content)
            }
            guard total <= SourcePaths.maxFileBytes, Set(writes.map(\.target.real)).count == writes.count else {
                throw ServiceContractFailure.invalidRequest
            }
            return {
                switch try self.store.transact(kind: "commit", operationID: id, root: root, writes) {
                case .conflict(let file):
                    return RepositoryOwner.object([("ok", .bool(false)), ("conflict", .bool(true)), ("file", .string(JSText(file)))])
                case .applied(let targets, let previous):
                    // Only now does the edit enter the history, with the bytes it actually replaced.
                    for write in writes {
                        guard let before = previous[write.target.real] else { continue }
                        self.store.history.record(root: root, SourceHistory.Entry(display: write.display, file: write.target.real,
                            before: before, after: write.content, key: key, group: group, at: Date(), gesture: gesture))
                    }
                    return RepositoryOwner.object([("ok", .bool(true)), ("files", RepositoryOwner.strings(targets.map(\.rel))),
                                                   ("hashes", RepositoryOwner.strings(writes.map { SourcePaths.hash($0.content) }))])
                }
            }
        case "undo", "redo":
            return { Self.undoValue(try self.store.step(root: root, undo: method == "undo", operationID: id)) }
        case "revert":
            let group = try body.string("group")
            return { Self.undoValue(try self.store.revert(root: root, group: group, operationID: id)) }
        case "createFile", "renameFile", "deleteFile":
            // A refused path is an ordinary answer for the file tree, not a protocol failure.
            guard let from = try? SourcePaths.target(given: given, root: root, path: try body.string("path")) else {
                return { Self.fileValue(SourceStore.badPath) }
            }
            if method == "createFile" { return { Self.fileValue(self.store.create(from)) } }
            if method == "deleteFile" { return { Self.fileValue(self.store.delete(from)) } }
            guard let to = try? SourcePaths.target(given: given, root: root, path: try body.string("to")) else {
                return { Self.fileValue(SourceStore.badPath) }
            }
            return { Self.fileValue(self.store.rename(from, to)) }
        case "removeWorkbench":
            let seams = try body.strings("seams")
            guard seams.count <= Self.maxEdits,
                  let folder = try? SourcePaths.target(given: given, root: root, path: try body.string("path")),
                  let targets = try? seams.map({ try SourcePaths.target(given: given, root: root, path: $0) }),
                  targets.allSatisfy({ !$0.lexical.hasPrefix(folder.lexical + "/") }) else {
                return { Self.fileValue(SourceStore.badPath) }
            }
            return { Self.fileValue(self.store.removeWorkbench(folder, seams: targets)) }
        default: throw ServiceContractFailure.invalidRequest
        }
    }

    private func read(_ target: SourcePaths.Target) throws -> JSValue {
        guard SourcePaths.isRegularFile(target.real) else { throw RepositoryRefusal(.notFound, "The source file does not exist.") }
        var info = stat()
        stat(target.real, &info)
        var fields: [(String, JSValue)] = [("path", .string(JSText(target.rel))), ("size", .number(Double(info.st_size)))]
        guard info.st_size <= SourcePaths.maxFileBytes, let data = try SourcePaths.read(target.real) else {
            return RepositoryOwner.object(fields + [("binary", .bool(true))])
        }
        fields.append(("hash", .string(JSText(SourcePaths.hash(data)))))
        // Text only when it round-trips exactly; otherwise the editor shows a placeholder.
        guard let text = String(data: data, encoding: .utf8), !text.contains("\0") else {
            return RepositoryOwner.object(fields + [("binary", .bool(true))])
        }
        return RepositoryOwner.object(fields + [("binary", .bool(false)), ("content", .string(JSText(text)))])
    }

    private func listDrafts(given: String, root: String) throws -> JSValue {
        .array(try drafts.list(root: root).map { draft in
            let current = (try? SourcePaths.target(given: given, root: root, path: draft.path))
                .flatMap { try? SourcePaths.read($0.real) }.map(SourcePaths.hash)
            return RepositoryOwner.object([("path", .string(JSText(draft.path))), ("base", .string(JSText(draft.base))),
                ("text", .string(JSText(draft.text))), ("current", current.map { .string(JSText($0)) } ?? .null)])
        })
    }

    // MARK: Drain

    /// Refuses new requests; effects already running finish.
    func refuse() { lock.lock(); closed = true; lock.unlock() }

    /// Refuses new requests and waits (bounded) for accepted ones to settle.
    @discardableResult
    func close(timeout: TimeInterval) -> Bool {
        refuse()
        return inflight.wait(timeout: .now() + timeout) == .success
    }

    // MARK: Values

    private func roots(_ body: Body) throws -> (String, String) {
        let given = try body.path("root")
        return (given, try SourcePaths.root(given))
    }

    /// Source text: well-formed (no lone surrogate), no NUL, bounded.
    static func content(_ value: JSValue?) throws -> String {
        guard let text = value?.text, text.count <= SourcePaths.maxFileBytes, !text.contains(0), JSText(text.string) == text else {
            throw ServiceContractFailure.invalidRequest
        }
        return text.string
    }

    static func hash(_ value: JSValue?) throws -> String {
        let text = try Body.text(value)
        guard text.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil else { throw ServiceContractFailure.invalidRequest }
        return text
    }

    /// An array of objects with exactly `fields`.
    static func objects(_ value: JSValue?, _ fields: Set<String>) throws -> [JSValue] {
        guard case .array(let items)? = value, items.count <= 10_000 else { throw ServiceContractFailure.invalidRequest }
        for item in items {
            guard case .object(let parts) = item, parts.count == fields.count, Set(parts.map { $0.0.string }) == fields else {
                throw ServiceContractFailure.invalidRequest
            }
        }
        return items
    }

    static func undoValue(_ r: SourceStore.UndoResult) -> JSValue {
        var fields: [(String, JSValue)] = [("ok", .bool(r.ok))]
        if r.empty { fields.append(("empty", .bool(true))) }
        if r.conflict { fields.append(("conflict", .bool(true))) }
        if let file = r.file { fields.append(("file", .string(JSText(file)))) }
        return RepositoryOwner.object(fields)
    }

    static func fileValue(_ r: SourceStore.FileResult) -> JSValue {
        var fields: [(String, JSValue)] = [("ok", .bool(r.ok))]
        if let path = r.path { fields.append(("path", .string(JSText(path)))) }
        if let error = r.error { fields.append(("error", .string(JSText(error)))) }
        return RepositoryOwner.object(fields)
    }

    static func failure(_ error: Error) -> ServiceFailure {
        if let refusal = error as? RepositoryRefusal { return RepositoryOwner.fail(refusal.code, refusal.message) }
        if let code = error as? ServiceContractFailure { return RepositoryOwner.fail(code, "Invalid source request.") }
        return RepositoryOwner.fail(.ioFailure, "\(error)")
    }

    static let stopping = RepositoryOwner.fail(.unavailable, "The service is stopping; no source file was changed.", retryable: true)
    static let expired = RepositoryOwner.fail(.deadlineExceeded, "The edit waited too long for the repository and was not applied; no source file was changed.", retryable: true)

    // MARK: Frames

    private func respond(_ frame: PipeFrame, _ effect: () throws -> JSValue) {
        do { answer(frame, .succeeded(try effect())) } catch { answer(frame, .failed(Self.failure(error))) }
    }

    private func answer(_ frame: PipeFrame, _ result: PreferencesOwner.Answer, counted: Bool = true) {
        send(Self.reply(id: frame.id, frame: frame, result: result))
        if counted { inflight.leave() }
    }

    /// Also the conversation coordinator's reply (same frame shape, its own service name).
    static func reply(service: String = SourceOwner.service, id: JSValue, frame: PipeFrame?, result: PreferencesOwner.Answer) -> Data {
        let body: JSValue
        switch result {
        case .succeeded(let payload): body = RepositoryOwner.object([("kind", .string(JSText("succeeded"))), ("payload", payload)])
        case .failed(let failure): body = RepositoryOwner.object([("kind", .string(JSText("failed"))), ("payload", PreferencesOwner.value(failure))])
        }
        var reply: [(String, JSValue)] = []
        if let frame {
            reply = [("connection", .string(JSText(frame.connection))), ("requestID", .string(JSText(frame.requestID))),
                     ("operationID", .string(JSText(frame.operationID))), ("scope", .object([]))]
        }
        reply.append(("result", body))
        return RepositoryOwner.object([("event", .string(JSText("service-reply"))), ("service", .string(JSText(service))), ("id", id),
                                       ("reply", RepositoryOwner.object(reply))]).utf8()
    }
}
