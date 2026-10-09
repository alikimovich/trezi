import Foundation

/// The editing coordinator (S12, LKM-99). Under the Swift launch the service decides
/// the editing workflows between the preview, the inspectors and the chat:
/// - chat islands: their history files, pending activation bound to the originating
///   turn, command admission, revision chains and per-island Undo (`EditingIslands`);
/// - the project sidecars (`.trezi/control-panels.json`, `annotations.json`,
///   `tokens.json`), committed hash-bound in the repository's lane (`EditingSidecar`);
/// - deferred preview navigation, released when the requesting turn lands.
/// Bun keeps the JS helpers (manifest validation, Jev composition, literal
/// resolution and splicing), the isolated WebKit instrumentation, and the inspector
/// views; source writes stay proposals to `SourceOwner`, turns are the
/// `ConversationOwner`'s.
final class EditingOwner: @unchecked Sendable {
    static let service = "editing"

    struct Options {
        var profile: String
        /// The conversation coordinator's view of a chat: known, and the turn in flight.
        var turn: @Sendable (String) -> (known: Bool, turn: String?) = { _ in (false, nil) }
        /// Test hook: named points inside writes (a fixture crashes there).
        var fault: (@Sendable (String) -> Void)?
    }

    private let send: @Sendable (Data) -> Void
    private let repository: RepositoryOwner
    private let turnOf: @Sendable (String) -> (known: Bool, turn: String?)
    private let intake = DispatchQueue(label: "dev.trezi.editing.intake")
    private let lock = NSLock()
    private var closed = false
    private let inflight = DispatchGroup()
    private var islands: EditingIslands
    private var navigation = EditingNavigation()

    init(options: Options, repository: RepositoryOwner, send: @escaping @Sendable (Data) -> Void) {
        self.send = send; self.repository = repository; turnOf = options.turn
        islands = EditingIslands(profile: options.profile)
        islands.fault = options.fault
    }

    // MARK: Requests (from the backend reader thread, in pipe order)

    func submit(_ line: Data) {
        let frame: PipeFrame
        do { frame = try PipeFrame(line, service: Self.service, maxDepth: 64) } catch {
            let code = error as? ServiceContractFailure ?? .invalidRequest
            send(SourceOwner.reply(service: Self.service, id: (try? JSValue.parse(line, maxDepth: 64))?["id"] ?? .null, frame: nil,
                                   result: .failed(RepositoryOwner.fail(code, "Invalid editing request."))))
            return
        }
        lock.lock()
        let refused = closed
        if !refused { inflight.enter() }
        lock.unlock()
        if refused { return answer(frame, .failed(Self.stopping), counted: false) }
        intake.async {
            do {
                if let effect = try self.handle(frame) { return self.lane(frame, effect) }
            } catch { self.answer(frame, .failed(Self.failure(error))) }
        }
    }

    static let reads: Set<String> = ["islands", "navigationState"]
    static let methods: [String: (required: Set<String>, optional: Set<String>)] = [
        "islandsOpen": (["chat", "root", "record"], []), "islandsClose": (["chat"], []), "islands": (["chat"], []),
        "islandDefine": (["chat", "turn"], ["origin", "id", "revision"]),
        "islandCommit": (["chat", "token", "definition", "engine", "initial"], ["fallback", "name", "planned"]),
        "islandActivate": (["chat", "id", "revision", "initial"], []),
        "islandAbort": (["chat", "token"], []), "islandSettle": (["chat", "successful"], ["turn"]),
        "islandMark": (["chat", "id"], ["user"]), "islandShow": (["chat", "id", "turn"], ["origin"]),
        "islandHealth": (["chat", "id", "revision", "health"], ["reason", "reasons"]),
        "islandCommand": (["chat", "id", "revision", "action", "sourceRevision"], []),
        "islandFinish": (["chat", "ticket", "ok", "last"], ["group", "revision"]),
        "navigate": (["chat", "root", "path"], ["turn", "now"]), "navigation": (["chat", "kind"], ["turn"]),
        "navigationTake": (["chat"], []), "navigationState": ([], []),
        "sidecar": (["root", "name", "expectedHash", "content"], ["leases"]),
        // Project files (EditingProject): `root` is the live project, whose lane they run in.
        "migrateSidecar": (["root"], ["leases"]),
        "legacyNames": (["root"], ["leases"]), "migrateNames": (["root", "confirmed"], ["leases"]),
        "syncSetupHelpers": (["root", "worktree"], ["leases"]),
        "dependencyState": (["root", "checkout"], ["leases"]),
        "markDependencies": (["root", "checkout"], ["leases"]),
    ]
    static let actions: Set<String> = ["commit", "reset", "undo", "reload"]

    /// An effect that runs in the project's repository lane (or the lease Bun's chain holds).
    struct Effect { let root: String; let leases: [String]; let run: @Sendable () throws -> JSValue }

    /// Decides a request on the intake queue; a sidecar or project-file effect is answered from the lane.
    private func handle(_ frame: PipeFrame) throws -> Effect? {
        guard frame.expectedRevision == nil, let rule = Self.methods[frame.method],
              frame.mode == (Self.reads.contains(frame.method) ? "read" : "mutation") else { throw ServiceContractFailure.invalidRequest }
        let body = try Body(frame, required: rule.required, optional: rule.optional)
        let ok = JSValue.object([])
        func result(_ value: JSValue) -> Effect? { answer(frame, .succeeded(value)); return nil }
        switch frame.method {
        // Islands
        case "islandsOpen":
            // The history file is named from the root as Bun gives it (unchanged from the Bun store it replaced).
            let records = islands.open(chat: try Self.key(body, "chat"), root: try body.path("root"), record: try Self.key(body, "record"))
            return result(Self.object([("records", .array(records))]))
        case "islandsClose":
            return result(Self.object([("composing", .bool(islands.close(chat: try Self.key(body, "chat"))))]))
        case "islands":
            return result(Self.object([("records", .array(islands.sessions[try Self.key(body, "chat")]?.records ?? []))]))
        case "islandDefine":
            let chat = try Self.key(body, "chat")
            let origin = try origin(chat: chat, claimed: body.has("origin") ? try Self.key(body, "origin") : nil)
            let composition = try islands.define(chat: chat, origin: origin, turn: try Self.count(body.value("turn")),
                id: body.has("id") ? try Self.key(body, "id") : nil,
                revision: body.has("revision") ? try Self.count(body.value("revision")) : nil, token: frame.operationID)
            return result(Self.object([("token", .string(JSText(composition.token))), ("id", .string(JSText(composition.id))),
                                       ("revision", .number(Double(composition.revision))), ("turn", .number(Double(composition.turn))),
                                       ("replacing", .bool(composition.replacing))]))
        case "islandCommit":
            guard case .object(let definition)? = body.value("definition"),
                  Set(definition.map { $0.0.string }) == ["manifest", "blocks"], definition.count == 2,
                  case .object? = body.value("initial") else { throw ServiceContractFailure.invalidRequest }
            let engine = try body.string("engine")
            guard engine == "agent" || engine == "jev" else { throw ServiceContractFailure.invalidRequest }
            let fallback = body.value("fallback")
            if let fallback, fallback.text == nil { throw ServiceContractFailure.invalidRequest }
            let records = try islands.commit(chat: try Self.key(body, "chat"), token: try Self.key(body, "token"), definition: definition,
                                             engine: engine, fallback: fallback, initial: body.value("initial")!,
                                             name: body.has("name") ? try Self.islandName(body) : nil,
                                             planned: body.has("planned") ? try body.bool("planned") : false)
            return result(Self.object([("records", .array(records))]))
        case "islandActivate":
            guard case .object? = body.value("initial") else { throw ServiceContractFailure.invalidRequest }
            let records = try islands.activate(chat: try Self.key(body, "chat"), id: try Self.key(body, "id"),
                revision: try Self.count(body.value("revision")), initial: body.value("initial")!)
            return result(Self.object([("records", .array(records))]))
        case "islandMark":
            let user = body.has("user") ? try body.string("user") : nil
            if let user, !EditingIslands.userStates.contains(user) { throw ServiceContractFailure.invalidRequest }
            let records = try islands.mark(chat: try Self.key(body, "chat"), id: try Self.key(body, "id"), user: user)
            return result(Self.object([("records", .array(records))]))
        case "islandHealth":
            let health = try body.string("health")
            guard EditingIslands.healths.contains(health) else { throw ServiceContractFailure.invalidRequest }
            let records = try islands.health(chat: try Self.key(body, "chat"), id: try Self.key(body, "id"),
                revision: try Self.count(body.value("revision")), health: health,
                reason: body.has("reason") ? try Self.line(body.value("reason")) : nil,
                reasons: body.has("reasons") ? try Self.lines(body.value("reasons")) : nil)
            return result(Self.object([("records", .array(records))]))
        case "islandShow":
            let chat = try Self.key(body, "chat")
            _ = try origin(chat: chat, claimed: body.has("origin") ? try Self.key(body, "origin") : nil)
            let records = try islands.show(chat: chat, id: try Self.key(body, "id"), turn: try Self.count(body.value("turn")))
            return result(Self.object([("records", .array(records))]))
        case "islandAbort":
            islands.abort(chat: try Self.key(body, "chat"), token: try Self.key(body, "token"))
            return result(ok)
        case "islandSettle":
            let settled = try islands.settle(chat: try Self.key(body, "chat"), turn: body.has("turn") ? try Self.key(body, "turn") : nil,
                                             successful: try body.bool("successful"))
            guard let settled else { return result(Self.object([("records", .null), ("cancelled", .bool(false))])) }
            return result(Self.object([("records", .array(settled.records)), ("cancelled", .bool(settled.cancelled))]))
        case "islandCommand":
            let action = try body.string("action")
            guard Self.actions.contains(action) else { throw ServiceContractFailure.invalidRequest }
            let admitted = try islands.command(chat: try Self.key(body, "chat"), id: try Self.key(body, "id"),
                revision: try Self.count(body.value("revision")), action: action, source: try Self.key(body, "sourceRevision"), ticket: frame.operationID)
            var fields: [(String, JSValue)] = [("ticket", .string(JSText(frame.operationID))), ("expected", .string(JSText(admitted.expected)))]
            if let group = admitted.group { fields.append(("group", .string(JSText(group)))) }
            if let initial = admitted.initial { fields.append(("initial", initial)) }
            return result(Self.object(fields))
        case "islandFinish":
            try islands.finish(chat: try Self.key(body, "chat"), ticket: try Self.key(body, "ticket"), ok: try body.bool("ok"),
                               group: body.has("group") ? try Self.key(body, "group") : nil,
                               revision: body.has("revision") ? try Self.key(body, "revision") : nil, last: try body.bool("last"))
            return result(ok)

        // Deferred navigation
        case "navigate":
            let chat = try Self.key(body, "chat"), path = try body.string("path")
            guard EditingNavigation.valid(path) else { throw RepositoryRefusal(.invalidRequest, "Invalid preview path.") }
            // `now`: Bun found nothing unlanded in the chat, so the live page already is the chat's (LKM-196).
            let now = body.has("now") ? try body.bool("now") : false
            let turn = now ? nil : try origin(chat: chat, claimed: body.has("turn") ? try Self.key(body, "turn") : nil, strict: false)
            let ready = navigation.request(chat: chat, root: try body.path("root"), path: path, turn: turn)
            return result(Self.object([("ready", .bool(ready))]))
        case "navigation":
            let kind = try body.string("kind")
            guard ["landed", "failed", "begin", "close"].contains(kind) else { throw ServiceContractFailure.invalidRequest }
            let ready = navigation.event(chat: try Self.key(body, "chat"), kind: kind, turn: body.has("turn") ? try Self.key(body, "turn") : nil)
            return result(Self.object([("ready", .bool(ready))]))
        case "navigationTake":
            guard let taken = navigation.take(chat: try Self.key(body, "chat")) else { return result(Self.object([("path", .null)])) }
            return result(Self.object([("root", .string(JSText(taken.root))), ("path", .string(JSText(taken.path)))]))
        case "navigationState":
            let pending = navigation.pending.keys.sorted().map { chat -> JSValue in
                let request = navigation.pending[chat]!
                return Self.object([("chat", .string(JSText(chat))), ("root", .string(JSText(request.root))), ("path", .string(JSText(request.path))),
                                    ("turn", request.turn.map { .string(JSText($0)) } ?? .null), ("awaiting", .bool(request.awaiting))])
            }
            return result(.array(pending))

        // Controls sidecars
        case "sidecar":
            let name = try body.string("name")
            guard EditingSidecar.names.contains(name) else { throw ServiceContractFailure.invalidRequest }
            let expected: String? = body.value("expectedHash") == .null ? nil : try SourceOwner.hash(body.value("expectedHash"))
            let content = Data(try SourceOwner.content(body.value("content")).utf8)
            guard content.count <= EditingSidecar.maxBytes else { throw RepositoryRefusal(.invalidRequest, "The \(name) store would exceed 1 MB.") }
            let root = try SourcePaths.root(try body.path("root"))
            return Effect(root: root, leases: try body.strings("leases")) {
                switch try EditingSidecar.commit(root: root, name: name, expected: expected, content: content) {
                case .conflict: return Self.object([("ok", .bool(false)), ("conflict", .bool(true))])
                case .written(let hash): return Self.object([("ok", .bool(true)), ("hash", .string(JSText(hash)))])
                }
            }

        // Project files (`.trezi/` beside the sidecars)
        case "migrateSidecar":
            let root = try SourcePaths.root(try body.path("root"))
            return Effect(root: root, leases: try body.strings("leases")) {
                Self.object([("collisions", .array(try EditingProject.migrate(root: root).map { .string(JSText($0)) }))])
            }
        case "legacyNames", "migrateNames":
            // Answered from the lane, so the clean check sees no turn landing halfway.
            let root = try SourcePaths.root(try body.path("root")), git = repository.effects.git
            let confirmed = frame.method == "migrateNames" ? try body.bool("confirmed") : nil
            return Effect(root: root, leases: try body.strings("leases")) {
                guard let confirmed else { return try EditingLegacyNames.plan(root: root, git: git).value }
                return try EditingLegacyNames.migrate(root: root, git: git, confirmed: confirmed)
            }
        case "syncSetupHelpers":
            let root = try SourcePaths.root(try body.path("root")), worktree = try SourcePaths.root(try body.path("worktree"))
            return Effect(root: root, leases: try body.strings("leases")) {
                try EditingProject.syncHelpers(liveRoot: root, worktree: worktree)
                return .object([])
            }
        case "dependencyState":
            let root = try SourcePaths.root(try body.path("root")), checkout = try SourcePaths.root(try body.path("checkout"))
            let git = repository.effects.git
            return Effect(root: root, leases: try body.strings("leases")) {
                // Like the link it replaces: a node_modules Git does not ignore (exit 1) is never
                // copied in. Outside a repository (exit 128) nothing could capture it.
                let unignored = (try? git.run(root, ["check-ignore", "-q", "--", "node_modules"]).status) == 1
                let state = try EditingProject.dependencyState(liveRoot: root, checkout: checkout, ignored: !unignored)
                return Self.object([("install", .bool(state.install)), ("cloned", .bool(state.cloned))])
            }
        case "markDependencies":
            let root = try SourcePaths.root(try body.path("root")), checkout = try SourcePaths.root(try body.path("checkout"))
            return Effect(root: root, leases: try body.strings("leases")) {
                try EditingProject.mark(checkout: checkout)
                return .object([])
            }
        default: throw ServiceContractFailure.invalidRequest
        }
    }

    /// The turn a definition or navigation belongs to. The conversation coordinator is
    /// the authority: when it knows the chat, its turn in flight wins, and a definition
    /// Bun attributes to any other turn (a finished one, a stale attribution) is refused.
    private func origin(chat: String, claimed: String?, strict: Bool = true) throws -> String? {
        let known = turnOf(chat)
        guard known.known else { return claimed }
        if strict, let claimed, claimed != known.turn {
            throw RepositoryRefusal(.conflict, "This turn has finished; the island was not attached.")
        }
        return known.turn
    }

    /// An effect runs in the repository's lane (or the lease Bun's chain holds).
    private func lane(_ frame: PipeFrame, _ effect: Effect) {
        let deadline = frame.timeoutMilliseconds.map { DispatchTime.now() + .milliseconds(Int($0)) }
        let scheduled = repository.serialize(root: effect.root, leases: effect.leases) {
            self.lock.lock(); let refused = self.closed; self.lock.unlock()
            if refused { return self.answer(frame, .failed(Self.stopping)) }
            if let deadline, DispatchTime.now() > deadline { return self.answer(frame, .failed(SourceOwner.expired)) }
            do { self.answer(frame, .succeeded(try effect.run())) } catch { self.answer(frame, .failed(Self.failure(error))) }
        }
        if !scheduled { answer(frame, .failed(Self.stopping)) }
    }

    // MARK: Drain

    func refuse() { lock.lock(); closed = true; lock.unlock() }

    @discardableResult
    func close(timeout: TimeInterval) -> Bool {
        refuse()
        return inflight.wait(timeout: .now() + timeout) == .success
    }

    // MARK: Values

    static func object(_ fields: [(String, JSValue)]) -> JSValue { RepositoryOwner.object(fields) }

    static func key(_ body: Body, _ name: String) throws -> String { try ConversationOwner.key(body, name) }

    static func count(_ value: JSValue?) throws -> Int {
        guard let number = EditingIslands.integer(value), number >= 0 else { throw ServiceContractFailure.invalidRequest }
        return number
    }

    /// An island's short name, `island-<word>-<n>` (LKM-181).
    static func islandName(_ body: Body) throws -> String {
        let name = try body.string("name")
        guard name.utf8.count <= 64, name.hasPrefix("island-"),
              name.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-").contains($0) })
        else { throw ServiceContractFailure.invalidRequest }
        return name
    }

    /// One reason line for an island (LKM-181): text, single line, bounded.
    static func line(_ value: JSValue?) throws -> String {
        guard let text = value?.text?.string, !text.isEmpty, text.utf16.count <= 400, !text.contains("\n") else {
            throw ServiceContractFailure.invalidRequest
        }
        return text
    }

    /// param id → reason line, at most one per param of a definition.
    static func lines(_ value: JSValue?) throws -> JSValue {
        guard case .object(let fields)? = value, fields.count <= 64 else { throw ServiceContractFailure.invalidRequest }
        for (_, reason) in fields { _ = try line(reason) }
        return .object(fields)
    }

    static func failure(_ error: Error) -> ServiceFailure {
        if let code = error as? ServiceContractFailure { return RepositoryOwner.fail(code, "Invalid editing request.") }
        return SourceOwner.failure(error)
    }

    static let stopping = RepositoryOwner.fail(.unavailable, "The service is stopping; nothing was changed.", retryable: true)

    private func answer(_ frame: PipeFrame, _ result: PreferencesOwner.Answer, counted: Bool = true) {
        send(SourceOwner.reply(service: Self.service, id: frame.id, frame: frame, result: result))
        if counted { inflight.leave() }
    }
}
