import Foundation

/// The conversation coordinator (S11, LKM-97). Under the Swift launch the service owns
/// what a chat *is* between provider events: its persisted record (transcripts, titles,
/// History), a checkpoint of every live chat, the turn state machine and its completion
/// policy, model handoff, pending approvals, and background-spawn admission. Bun keeps
/// the provider SDK sessions as adapters: it reports typed events (a turn's start, a
/// terminal `done`/`error` attributed to its turn and run, an approval request) and
/// performs the effects the owner's answers call for (land the turn through the
/// repository coordinator, generate a title, settle an SDK callback). Repository and
/// source effects never run here; they stay with `RepositoryOwner`/`SourceOwner`.
///
/// A terminal event is claimed at most once per run of a turn; one for another turn or
/// run — a late event — is refused as `stale` and changes nothing, so it can never
/// complete the wrong turn. Each transition rewrites the chat's checkpoint before it is
/// answered, so a crash mid-turn keeps the transcript (see `ConversationStore`).
final class ConversationOwner: @unchecked Sendable {
    static let service = "conversation"

    struct Options {
        var profile: String
        /// Milliseconds since the epoch (`Date.now()`), stamped on checkpoints.
        var now: @Sendable () -> Double = { (Date().timeIntervalSince1970 * 1000).rounded(.down) }
        /// Test hook: named points inside writes (a fixture crashes there).
        var fault: (@Sendable (String) -> Void)?
    }

    private let store: ConversationStore
    private let now: @Sendable () -> Double
    private let send: @Sendable (Data) -> Void
    /// Pipe order in: every request is decided here, one at a time, in the order Bun wrote it.
    private let intake = DispatchQueue(label: "dev.trezi.conversation.intake")
    private let lock = NSLock()
    private var closed = false
    private let inflight = DispatchGroup()
    private var state = ConversationState()
    private let recovered: [ConversationStore.Recovery]

    init(options: Options, send: @escaping @Sendable (Data) -> Void) {
        var store = ConversationStore(profile: URL(fileURLWithPath: options.profile))
        store.fault = options.fault
        self.store = store; now = options.now; self.send = send
        // Before any request: chats a crash cut off are saved (never over newer work).
        recovered = store.recover()
    }

    // MARK: Requests (from the backend reader thread, in pipe order)

    func submit(_ line: Data) {
        let frame: PipeFrame
        do { frame = try PipeFrame(line, service: Self.service, maxDepth: 64) } catch {
            let code = error as? ServiceContractFailure ?? .invalidRequest
            send(SourceOwner.reply(service: Self.service, id: (try? JSValue.parse(line, maxDepth: 64))?["id"] ?? .null, frame: nil,
                                   result: .failed(RepositoryOwner.fail(code, "Invalid conversation request."))))
            return
        }
        lock.lock()
        let refused = closed
        if !refused { inflight.enter() }
        lock.unlock()
        if refused { return answer(frame, .failed(Self.stopping), counted: false) }
        intake.async {
            do { self.answer(frame, .succeeded(try self.handle(frame))) }
            catch { self.answer(frame, .failed(Self.failure(error))) }
        }
    }

    static let reads: Set<String> = ["snapshot", "status"]
    /// `PermissionMode` in `src/shared/api.ts`.
    static let modes: Set<String> = ["auto", "default", "acceptEdits", "bypassPermissions"]
    static let methods: [String: (required: Set<String>, optional: Set<String>)] = [
        "save": (["record"], ["current"]), "remove": (["id"], []), "rename": (["id", "title"], []),
        "open": (["chat", "project", "root", "record", "options", "active", "sequence"], []),
        "activate": (["chat"], []), "checkpoint": (["chat", "record", "sequence"], []),
        "close": (["chat", "persist", "record", "sequence"], []), "configure": (["chat", "options"], []),
        "handoff": (["chat", "options", "record", "sequence", "reason"], []),
        "begin": (["chat", "turn"], []), "send": (["chat", "turn", "entry"], []), "abort": (["chat", "turn"], []),
        "cancel": (["chat"], []), "terminal": (["chat", "turn", "run", "kind", "record", "sequence"], []),
        "continue": (["chat", "turn", "run"], []), "landed": (["chat", "turn", "at"], []),
        "title": (["chat", "title", "source"], []),
        "register": (["chat", "id", "kind", "tool"], []), "resolve": (["id", "kind"], []),
        "mode": (["chat", "mode"], []), "release": (["chat"], []),
        "spawn": (["id", "project"], []), "spawnDone": (["id"], []), "spawnCancel": (["id"], []),
        "snapshot": ([], []), "status": ([], []),
    ]

    private func handle(_ frame: PipeFrame) throws -> JSValue {
        guard frame.expectedRevision == nil, let rule = Self.methods[frame.method],
              frame.mode == (Self.reads.contains(frame.method) ? "read" : "mutation") else { throw ServiceContractFailure.invalidRequest }
        let body = try Body(frame, required: rule.required, optional: rule.optional)
        let ok = JSValue.object([])
        switch frame.method {
        // Session records
        case "save":
            try store.save(try Self.record(body.value("record")), current: body.has("current") ? try body.bool("current") : false)
            return ok
        case "remove": store.remove(try body.string("id")); return ok
        case "rename":
            let id = try body.string("id"), name = ConversationStore.cleanTitle(JSText(try body.string("title")))
            guard !name.isEmpty else { return Self.object([("ok", .bool(false)), ("error", .string(JSText("empty name")))]) }
            guard var record = store.read(id) else { return Self.object([("ok", .bool(false)), ("error", .string(JSText("unknown session")))]) }
            ConversationState.set(&record, "title", .string(name))
            try store.save(record, current: false)
            // A live chat carrying this record keeps the user's name too.
            for chat in state.live where chat.record["id"]?.text?.string == id {
                try state.update(chat.chat) { ConversationState.set(&$0.record, "title", .string(name)); $0.titleSource = "user" }
            }
            return Self.object([("ok", .bool(true)), ("title", .string(name))])

        // Live chats
        case "open":
            let key = try Self.key(body, "chat")
            var chat = ConversationChat(chat: key, project: try Self.key(body, "project"), root: try body.path("root"),
                                        record: try Self.record(body.value("record")), options: try Self.object(body.value("options")))
            chat.sequence = try Self.sequence(body)
            state.open(chat, active: try body.bool("active"))
            try checkpoint(key)
            return ok
        case "activate":
            let key = try Self.key(body, "chat")
            try state.activate(key)
            for chat in state.live where chat.project == state.chats[key]?.project { try checkpoint(chat.chat) }
            return ok
        case "checkpoint":
            let key = try Self.key(body, "chat")
            let accepted = try adopt(key, record: try Self.record(body.value("record")), sequence: try Self.sequence(body))
            if accepted { try checkpoint(key) }
            return Self.object([("accepted", .bool(accepted))])
        case "close":
            let key = try Self.key(body, "chat"), persist = try body.string("persist")
            guard ["current", "history", "none"].contains(persist) else { throw ServiceContractFailure.invalidRequest }
            let record = try Self.record(body.value("record")), sequence = try Self.sequence(body)
            if state.chats[key] != nil { _ = try adopt(key, record: record, sequence: sequence) }
            let (chat, released) = state.close(key)
            var saved = false
            // Only engaged chats (≥1 prompt) are kept.
            if let chat, persist != "none", Self.engaged(chat.record) {
                var final = chat.record
                if persist == "history" { ConversationState.set(&final, "slot", nil) }
                try store.save(final, current: persist == "current")
                saved = true
            }
            if chat != nil { store.dropCheckpoint(key) }
            return Self.object([("saved", .bool(saved)), ("release", Self.released(released))])
        case "configure":
            let key = try Self.key(body, "chat"), options = try Self.object(body.value("options"))
            try state.update(key) { $0.options = options }
            try checkpoint(key)
            return ok
        case "handoff":
            // A model change waits for the turn; a restart after a force-stop replaces a dead session.
            let key = try Self.key(body, "chat"), reason = try body.string("reason")
            guard reason == "model" || reason == "restart" else { throw ServiceContractFailure.invalidRequest }
            let options = try Self.object(body.value("options")), record = try Self.record(body.value("record")), sequence = try Self.sequence(body)
            try state.update(key) { chat in
                if reason == "model", chat.phase != .idle { throw ConversationRefusal.busy("Wait for the current response to finish before switching models.") }
                chat.options = options; chat.handoff = true
                // The force-stopped session is gone: its turn is abandoned, not landed.
                if reason == "restart" { chat.phase = .idle; chat.turn = nil; chat.claimed = false; chat.cancelled = false }
            }
            _ = try adopt(key, record: record, sequence: sequence)
            try checkpoint(key)
            return ok

        // Turns
        case "begin":
            let key = try Self.key(body, "chat")
            try state.begin(key, turn: try Self.key(body, "turn"))
            try checkpoint(key)
            return ok
        case "send":
            let key = try Self.key(body, "chat"), turn = try Self.key(body, "turn"), entry = try Self.entry(body.value("entry"))
            let handoff = try state.send(key, turn: turn)
            try state.update(key) { chat in
                guard case .object(var fields) = chat.record, let index = fields.lastIndex(where: { $0.0 == JSText("transcript") }),
                      case .array(var entries) = fields[index].1 else { return }
                entries.append(entry); fields[index].1 = .array(entries); chat.record = .object(fields)
            }
            try checkpoint(key)
            return Self.object([("handoff", .bool(handoff))])
        case "abort":
            let key = try Self.key(body, "chat")
            let aborted = state.abort(key, turn: try Self.key(body, "turn"))
            if aborted { try checkpoint(key) }
            return Self.object([("aborted", .bool(aborted))])
        case "cancel":
            let (phase, turn) = state.cancel(try Self.key(body, "chat"))
            return Self.object([("phase", .string(JSText(phase.rawValue))), ("turn", turn.map { .string(JSText($0)) } ?? .null)])
        case "terminal":
            let key = try Self.key(body, "chat"), turn = try Self.key(body, "turn"), kind = try body.string("kind")
            guard kind == "done" || kind == "error" else { throw ServiceContractFailure.invalidRequest }
            let record = try Self.record(body.value("record")), sequence = try Self.sequence(body)
            let claim = state.terminal(key, turn: turn, run: try Self.run(body), done: kind == "done", record: record, sequence: sequence)
            switch claim {
            case .stale: return Self.object([("claimed", .bool(false)), ("reason", .string(JSText("stale")))])
            case .duplicate: return Self.object([("claimed", .bool(false)), ("reason", .string(JSText("duplicate")))])
            case .claimed(let success, let title, let memory):
                try checkpoint(key)
                return Self.object([("claimed", .bool(true)), ("outcome", .string(JSText(success ? "success" : "failed"))),
                                    ("title", .bool(title)), ("memory", .bool(memory))])
            }
        case "continue":
            let key = try Self.key(body, "chat")
            let continued = state.continue(key, turn: try Self.key(body, "turn"), run: try Self.run(body))
            if continued { try checkpoint(key) }
            return Self.object([("continued", .bool(continued))])
        case "landed":
            let key = try Self.key(body, "chat"), turn = try Self.key(body, "turn")
            guard case .number(let at)? = body.value("at"), at.isFinite else { throw ServiceContractFailure.invalidRequest }
            let wasLanding = state.chats[key]?.phase == .landing && state.chats[key]?.turn == turn
            let stamped = state.landed(key, turn: turn, at: at)
            if wasLanding { try checkpoint(key) }
            var fields: [(String, JSValue)] = [("landed", .bool(wasLanding))]
            if let stamped { fields.append(("completedAt", .number(stamped))) }
            return Self.object(fields)
        case "title":
            let key = try Self.key(body, "chat"), source = try body.string("source")
            guard source == "user" || source == "generated" else { throw ServiceContractFailure.invalidRequest }
            let raw = JSText(try body.string("title"))
            var answer: JSValue = Self.object([("ok", .bool(false))])
            try state.update(key) { chat in
                if source == "generated" {
                    chat.titling = false
                    // A generated name never replaces any name (the user's, or an earlier one).
                    guard !raw.isEmpty, ConversationState.title(chat.record) == nil else { return }
                    ConversationState.set(&chat.record, "title", .string(raw))
                    answer = Self.object([("ok", .bool(true)), ("title", .string(raw))])
                } else {
                    let name = ConversationStore.cleanTitle(raw)
                    guard !name.isEmpty else { answer = Self.object([("ok", .bool(false)), ("error", .string(JSText("empty name")))]); return }
                    ConversationState.set(&chat.record, "title", .string(name)); chat.titleSource = "user"
                    answer = Self.object([("ok", .bool(true)), ("title", .string(name))])
                }
            }
            if answer["ok"] == .bool(true) {
                try checkpoint(key)
                // A chat whose record is already in History (resumed, parked) keeps the name there too.
                if source == "user", let chat = state.chats[key], let id = chat.record["id"]?.text?.string, var saved = store.read(id) {
                    ConversationState.set(&saved, "title", chat.record["title"])
                    try store.save(saved, current: false)
                }
            }
            return answer

        // Approvals
        case "register":
            let kind = try body.string("kind")
            guard kind == "permission" || kind == "question" else { throw ServiceContractFailure.invalidRequest }
            try state.register(chat: try Self.key(body, "chat"), id: try Self.key(body, "id"), kind: kind, tool: try body.string("tool"))
            return ok
        case "resolve":
            let chat = state.resolve(id: try Self.key(body, "id"), kind: try body.string("kind"))
            return Self.object([("chat", chat.map { .string(JSText($0)) } ?? .null)])
        case "mode":
            let key = try Self.key(body, "chat"), mode = try body.string("mode")
            guard Self.modes.contains(mode) else { throw ServiceContractFailure.invalidRequest }
            _ = try state.get(key)
            try state.update(key) { chat in
                var options = chat.options
                ConversationState.set(&options, "permissionMode", .string(JSText(mode)))
                chat.options = options
            }
            try checkpoint(key)
            return Self.object([("allow", RepositoryOwner.strings(state.mode(key, mode: mode)))])
        case "release":
            return Self.object([("release", Self.released(state.release(try Self.key(body, "chat"))))])

        // Background spawns
        case "spawn":
            return Self.object([("start", .bool(state.spawn(id: try Self.key(body, "id"), project: try Self.key(body, "project"))))])
        case "spawnDone":
            return Self.object([("start", RepositoryOwner.strings(state.spawnDone(id: try Self.key(body, "id"))))])
        case "spawnCancel":
            return Self.object([("queued", .bool(state.spawnCancel(id: try Self.key(body, "id"))))])

        // Reads
        case "snapshot":
            let chats: [JSValue] = state.live.map { chat in
                Self.object([("chat", .string(JSText(chat.chat))), ("project", .string(JSText(chat.project))),
                             ("root", .string(JSText(chat.root))), ("active", .bool(state.isActive(chat))),
                             ("phase", .string(JSText(chat.phase.rawValue))), ("turn", chat.turn.map { .string(JSText($0)) } ?? .null),
                             ("run", .number(Double(chat.run))), ("record", chat.record), ("options", chat.options)])
            }
            let running = state.running.keys.sorted()
            return Self.object([("chats", .array(chats)),
                                ("spawns", Self.object([("running", RepositoryOwner.strings(running)),
                                                         ("queued", RepositoryOwner.strings(state.queue.map(\.id)))]))])
        case "status":
            return Self.object([("recovered", .array(recovered.map(\.value)))])
        default: throw ServiceContractFailure.invalidRequest
        }
    }

    private func adopt(_ key: String, record: JSValue, sequence: Double) throws -> Bool {
        var accepted = false
        try state.update(key) { accepted = $0.adopt(record, sequence: sequence) }
        return accepted
    }

    private func checkpoint(_ key: String) throws {
        guard let chat = state.chats[key] else { return }
        do { try store.checkpoint(chat, active: state.isActive(chat), savedAt: now()) }
        catch { throw RepositoryRefusal(.ioFailure, "The chat could not be checkpointed (\(error)).") }
    }

    /// The editing coordinator's question (S12): is this a live chat, and which turn is in
    /// flight (nil when idle)? Answered in order with the chat's own transitions.
    func turn(of chat: String) -> (known: Bool, turn: String?) {
        intake.sync {
            guard let current = state.chats[chat] else { return (false, nil) }
            return (true, current.phase == .idle ? nil : current.turn)
        }
    }

    // MARK: Drain

    /// Refuses new requests; one being decided finishes.
    func refuse() { lock.lock(); closed = true; lock.unlock() }

    @discardableResult
    func close(timeout: TimeInterval) -> Bool {
        refuse()
        return inflight.wait(timeout: .now() + timeout) == .success
    }

    // MARK: Values

    static func object(_ fields: [(String, JSValue)]) -> JSValue { RepositoryOwner.object(fields) }

    static func released(_ items: [(String, String)]) -> JSValue {
        .array(items.map { object([("id", .string(JSText($0.0))), ("kind", .string(JSText($0.1)))]) })
    }

    /// A chat, project, turn or approval id: well-formed, bounded, non-empty.
    static func key(_ body: Body, _ name: String) throws -> String {
        let value = try body.string(name)
        guard !value.isEmpty, value.utf16.count <= 4096 else { throw ServiceContractFailure.invalidRequest }
        return value
    }

    static func sequence(_ body: Body) throws -> Double {
        guard case .number(let value)? = body.value("sequence"), value >= 0, value.rounded() == value, value < 9e15 else {
            throw ServiceContractFailure.invalidRequest
        }
        return value
    }

    static func run(_ body: Body) throws -> Int {
        guard case .number(let value)? = body.value("run"), value >= 0, value.rounded() == value, value < 1_000_000 else {
            throw ServiceContractFailure.invalidRequest
        }
        return Int(value)
    }

    static func object(_ value: JSValue?) throws -> JSValue {
        guard let value, case .object = value else { throw ServiceContractFailure.invalidRequest }
        return value
    }

    /// A session record: the id becomes a file name; the transcript is well-formed.
    static func record(_ value: JSValue?) throws -> JSValue {
        let record = try object(value)
        guard let id = record["id"]?.text?.string, ConversationStore.validID(id), record["projectKey"]?.text != nil,
              case .array(let transcript)? = record["transcript"], transcript.allSatisfy(validEntry) else {
            throw ServiceContractFailure.invalidRequest
        }
        return record
    }

    static func validEntry(_ entry: JSValue) -> Bool {
        guard case .object = entry, let role = entry["role"]?.text?.string, ["user", "assistant", "status"].contains(role),
              entry["text"]?.text != nil, case .number? = entry["at"] else { return false }
        return true
    }

    static func entry(_ value: JSValue?) throws -> JSValue {
        let entry = try object(value)
        guard validEntry(entry), entry["role"]?.text?.string == "user" else { throw ServiceContractFailure.invalidRequest }
        return entry
    }

    static func engaged(_ record: JSValue) -> Bool {
        guard case .array(let transcript)? = record["transcript"] else { return false }
        return transcript.contains { $0["role"]?.text?.string == "user" }
    }

    static func failure(_ error: Error) -> ServiceFailure {
        switch error {
        case ConversationRefusal.notFound(let message): return RepositoryOwner.fail(.notFound, message)
        case ConversationRefusal.busy(let message): return RepositoryOwner.fail(.busy, message, retryable: true)
        case ConversationRefusal.cancelled: return RepositoryOwner.fail(.cancelled, "Message cancelled before sending.")
        case ConversationStoreError.unsafeID: return RepositoryOwner.fail(.invalidRequest, "Unsafe session id.")
        case MemoryError.sessionStoreNotReady: return RepositoryOwner.fail(.unavailable, "Trezi's session store is not ready yet.", retryable: true)
        default: return SourceOwner.failure(error)
        }
    }

    static let stopping = RepositoryOwner.fail(.unavailable, "The service is stopping; the chat was not changed.", retryable: true)

    private func answer(_ frame: PipeFrame, _ result: PreferencesOwner.Answer, counted: Bool = true) {
        send(SourceOwner.reply(service: Self.service, id: frame.id, frame: frame, result: result))
        if counted { inflight.leave() }
    }
}
