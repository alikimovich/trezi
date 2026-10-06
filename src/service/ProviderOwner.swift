import Foundation
import Darwin

/// The provider owner (S10, LKM-98). Every provider session is opened here first and
/// gets its grant from facts fixed at open: the Trezi tools it may run (a background
/// edit is not granted the editor or islands), the roots its edits may touch, and its
/// chat. The owner answers each permission request and tool authorization, holds the
/// Stop deadline (a graceful cancel that does not answer in time is escalated), and
/// persists the provider thread id a restored chat resumes (`ProviderStore`).
///
/// It also hosts provider HELPERS: separate processes (`ProviderHelper.swift`) with a
/// scrubbed environment and only their stdio, whose every frame is checked against the
/// grant. A frame for another chat, a raw approval event, a user transcript entry, an
/// unknown type or an oversized line is a violation: the frame is refused and the
/// helper stopped. Tool calls outside the grant are refused; granted ones are run by
/// Bun and their results (screenshots included) are validated before the helper gets
/// them. A helper that crashes or hangs past Stop's deadline ends its turn exactly once.
///
/// The built-in SDK adapters (Claude, Codex, Gemini) always run in helpers (LKM-111,
/// after the live parity run); only a v10 connection runs in Bun, so its key stays
/// there, and asks this owner the same way.
///
/// It also writes the provider data (`ProviderData.swift`): the connections store with
/// its Keychain-encrypted keys, the model catalog cache, and the Codex model probe.
final class ProviderOwner: @unchecked Sendable {
    static let service = "provider"
    static let helperPrefix = Data("{\"service\":\"provider-helper\"".utf8)
    static let modes: Set<String> = ["auto", "default", "acceptEdits", "bypassPermissions"]
    static let forceStopped = "That turn stopped responding, so Trezi force-stopped it. The chat has been restarted — earlier messages are still shown, but the assistant no longer has them in context."

    struct Options {
        var profile: String
        /// The launch environment helpers' environments are filtered from.
        var environment: [String: String] = [:]
        /// How helpers are started; nil: this service hosts none.
        var helper: ProviderHelperCommand?
        /// The service executable (`--watch-group`); nil only in fixtures.
        var watchdog: String?
        var journal: RuntimeJournal?
        var grace: TimeInterval = ProviderPolicy.grace
        var readyTimeout: TimeInterval = 15
        /// A helper turn with no event by then is ended with a visible error (LKM-119). Since
        /// LKM-135 only while the provider CLI has not started (a hang at the process level).
        var firstEventTimeout: TimeInterval = 90
        /// Once the CLI is up: the wait for the first model output, renewed by every phase
        /// or progress report from the helper (LKM-135).
        var replyTimeout: TimeInterval = 600
        /// A started CLI's turn still without output by then shows "Still thinking…".
        var stillThinking: TimeInterval = 20
        /// The service log (the host's diagnostics under XPC, stderr in a fixture): the
        /// debug-level cold-start timings (LKM-135).
        var log: @Sendable (String) -> Void = { fputs($0 + "\n", stderr) }
        var toolTimeout: TimeInterval = 120
        var maxLine: Int = ProviderPolicy.Limits.helperLine
        var now: @Sendable () -> Double = { (Date().timeIntervalSince1970 * 1000).rounded(.down) }
        /// Test hook: named points inside writes (a fixture crashes there).
        var fault: (@Sendable (String) -> Void)?
        /// The Keychain helper, the checkout and the launch environment for `ProviderData`.
        var data = ProviderData.Tools()
    }

    enum Phase: String { case idle, running, cancelling, stopped }

    /// Confined to the owner's queue.
    final class Session: @unchecked Sendable {
        let id: String, chat: String, provider: String, root: String, liveRoot: String
        let background: Bool, host: String
        /// A helper-hosted background session's spawn id (its events carry it).
        let spawn: String?
        var phase = Phase.idle
        var turnOpen = false
        var record: String?, resume: String?
        var helper: ProviderHelperProcess?
        var opening: PipeFrame?
        var waiters: [PipeFrame] = []
        var deadline = 0
        /// The first-event timer's token, and whether the turn has produced anything.
        var silence = 0, heard = true, renewals = 0
        /// LKM-135: the helper's CLI answered (`alive`) and began a session (`initialized`);
        /// what this turn waits for, since when, and whether "Still thinking…" was shown.
        var alive = false, initialized = false, still = false
        var waiting = Liveness.cli, sentAt = 0.0, launchedAt = 0.0
        var approvals: [String: String] = [:]
        var tools = 0
        var violated = false
        init(id: String, chat: String, provider: String, root: String, liveRoot: String, background: Bool, host: String, spawn: String?) {
            self.id = id; self.chat = chat; self.provider = provider; self.root = root; self.liveRoot = liveRoot
            self.background = background; self.host = host; self.spawn = spawn
        }
    }

    let options: Options
    var store: ProviderStore
    let send: @Sendable (Data) -> Void
    /// All state below is touched only here, in the order requests and helper frames arrive.
    let queue = DispatchQueue(label: "dev.trezi.provider.owner")
    let work = DispatchQueue(label: "dev.trezi.provider.stop", attributes: .concurrent)
    var sessions: [String: Session] = [:]
    var toolCalls: [Int: (session: String, id: JSValue)] = [:]
    var toolSequence = 0
    var violations: [(String, String)] = []
    /// The Claude CLI a helper chose by probing, cached for this app session and passed to
    /// later helpers; dropped after a sign-in failure or a login check (LKM-135).
    var claudeCli: JSValue?
    let recovered: [ProviderStore.Recovery]
    let lock = NSLock()
    var closed = false
    let inflight = DispatchGroup()
    /// Provider data writes, one at a time and off the session queue (a Keychain call or
    /// the Codex probe must not hold up a permission answer).
    let data: ProviderData
    let dataWrites = DispatchQueue(label: "dev.trezi.provider.data")

    init(options: Options, send: @escaping @Sendable (Data) -> Void) {
        var store = ProviderStore(profile: URL(fileURLWithPath: options.profile))
        store.fault = options.fault
        self.options = options; self.store = store; self.send = send
        data = ProviderData(profile: options.profile, tools: options.data, now: options.now)
        // Before any request: sessions a crash cut off are reported, and the list starts empty.
        recovered = store.recover()
    }

    // MARK: Requests (from the backend reader thread, in pipe order)

    func submit(_ line: Data) {
        if line.starts(with: Self.helperPrefix) { queue.async { self.toolReply(line) }; return }
        let frame: PipeFrame
        do { frame = try PipeFrame(line, service: Self.service, maxDepth: 64) } catch {
            let code = error as? ServiceContractFailure ?? .invalidRequest
            send(Self.reply(id: (try? JSValue.parse(line, maxDepth: 64))?["id"] ?? .null, frame: nil,
                            result: .failed(PreferencesOwner.fail(code, "Invalid provider request."))))
            return
        }
        lock.lock()
        let refused = closed
        if !refused { inflight.enter() }
        lock.unlock()
        if refused { return send(Self.reply(id: frame.id, frame: frame, result: .failed(Self.stopping))) }
        queue.async {
            do { if let result = try self.handle(frame) { self.answer(frame, .succeeded(result)) } }
            catch { self.answer(frame, .failed(Self.failure(error))) }
        }
    }

    static let reads: Set<String> = ["recover", "snapshot", "status", "connectionSecret", "codexModels", "seatTokenStatus", "diagnose"]
    static let dataMethods: Set<String> = ["connectionSave", "connectionRemove", "connectionSecret", "catalogSave", "codexModels"]
    static let loginMethods: Set<String> = ["seatTokenSave", "seatTokenStatus", "diagnose"]
    static let methods: [String: (required: Set<String>, optional: Set<String>)] = [
        "open": (["session", "chat", "provider", "root", "liveRoot", "background"], []),
        "openHelper": (["session", "chat", "provider", "root", "liveRoot", "background", "options", "context"], []),
        "permission": (["session", "tool"], ["target"]), "authorize": (["session", "tool", "bytes"], []),
        "turn": (["session"], []), "send": (["session", "text"], ["images"]), "cancel": (["session"], []),
        "settled": (["session"], []), "terminal": (["session", "kind"], []), "resume": (["session", "id", "record"], []),
        "recover": (["record"], []), "answer": (["session", "id", "kind", "value"], []),
        "configure": (["session"], ["model", "mode"]), "close": (["session"], []),
        "snapshot": ([], []), "status": ([], []),
        "connectionSave": (["input"], []), "connectionRemove": (["id"], []), "connectionSecret": (["id"], []),
        "catalogSave": (["backend", "models"], ["harness"]), "codexModels": ([], []),
        "seatTokenSave": (["provider", "token"], []), "seatTokenStatus": ([], []), "diagnose": (["provider", "root"], []),
    ]

    /// Provider data requests, answered off the session queue.
    func handleData(_ frame: PipeFrame, _ body: ProviderBody) throws {
        let ok = JSValue.object([])
        switch frame.method {
        case "connectionSave":
            guard let input = body.value("input") else { throw ServiceContractFailure.invalidRequest }
            dataWrites.async { self.settle(frame) { Self.object([("connection", try self.data.saveConnection(input))]) } }
        case "connectionRemove":
            let id = try body.string("id", max: 256, empty: true)
            dataWrites.async { self.settle(frame) { try self.data.removeConnection(id); return ok } }
        case "connectionSecret":
            let id = try body.string("id", max: 256, empty: true)
            work.async { self.settle(frame) { Self.object([("secret", self.data.secret(id).map { .string(JSText($0)) } ?? .null)]) } }
        case "catalogSave":
            let backend = try body.string("backend", max: 16)
            guard ["claude", "codex"].contains(backend), case .array(let raw)? = body.value("models"), raw.count <= 10_000 else {
                throw ServiceContractFailure.invalidRequest
            }
            let models: [(id: JSText, label: JSText)] = try raw.map {
                guard let id = $0["id"]?.text, let label = $0["label"]?.text else { throw ServiceContractFailure.invalidRequest }
                return (id, label)
            }
            // Bun ignores an entry another SDK/CLI version wrote (LKM-164).
            let harness = body.has("harness") ? try body.string("harness", max: 512) : nil
            dataWrites.async { self.settle(frame) { Self.object([("saved", .bool(self.data.saveCatalog(backend: backend, models: models, harness: harness)))]) } }
        default:
            work.async { self.settle(frame) { Self.object([("stdout", self.data.codexModels().map { .string(JSText($0)) } ?? .null)]) } }
        }
    }

    func settle(_ frame: PipeFrame, _ run: () throws -> JSValue) {
        do { answer(frame, .succeeded(try run())) } catch { answer(frame, .failed(Self.failure(error))) }
    }

    /// nil: answered later (a cancel waits for its deadline, a helper for its readiness).
    func handle(_ frame: PipeFrame) throws -> JSValue? {
        guard frame.expectedRevision == nil, let rule = Self.methods[frame.method],
              frame.mode == (Self.reads.contains(frame.method) ? "read" : "mutation") else { throw ServiceContractFailure.invalidRequest }
        let body = try ProviderBody(frame, required: rule.required, optional: rule.optional)
        if Self.dataMethods.contains(frame.method) {
            try handleData(frame, body)
            return nil
        }
        if Self.loginMethods.contains(frame.method) { return try handleLogin(frame, body) }
        let ok = JSValue.object([])
        switch frame.method {
        case "open":
            let session = try opened(body, host: "bun", spawn: nil)
            sessions[session.id] = session
            persist()
            return Self.object([("tools", Self.strings(ProviderPolicy.granted(background: session.background)))])
        case "openHelper":
            return try openHelper(frame, body)
        case "permission":
            let session = sessions[try body.key("session")]
            // Bun sends only what the policy reads (`permissionTarget`): an edit's path, a command.
            let tool = try body.string("tool", max: 512)
            let target = body.has("target") ? try body.string("target", max: ProviderPolicy.Limits.permissionTarget, empty: true) : nil
            return Self.verdict(ProviderPolicy.decide(tool: tool, target: target, scope: scope(session)))
        case "authorize":
            let session = sessions[try body.key("session")]
            let tool = try body.string("tool", max: 512), bytes = try body.count("bytes")
            if let refusal = ProviderPolicy.authorize(tool: tool, bytes: bytes, live: scope(session).live, background: session?.background ?? false) {
                throw ProviderRefusal(refusal)
            }
            return ok
        case "turn":
            if let session = sessions[try body.key("session")], session.phase != .stopped {
                session.phase = .running; session.turnOpen = true
                persist()
            }
            return ok
        case "send":
            let session = try helperSession(body)
            guard session.phase != .stopped, session.helper != nil, session.opening == nil else {
                throw ProviderRefusal(.unavailable, "The provider helper is not running.")
            }
            let text = try body.string("text", max: ProviderPolicy.Limits.sendText, empty: true)
            var fields: [(String, JSValue)] = [("type", .string(JSText("send"))), ("text", .string(JSText(text)))]
            if body.has("images") { fields.append(("images", try Self.images(body.value("images")))) }
            session.phase = .running; session.turnOpen = true
            session.helper?.write(Self.object(fields).utf8())
            armFirstEvent(session)
            persist()
            return ok
        case "cancel":
            guard let session = sessions[try body.key("session")], session.phase != .stopped else {
                return Self.object([("escalate", .bool(false))])
            }
            if session.phase != .cancelling {
                session.phase = .cancelling
                session.helper?.write(Self.object([("type", .string(JSText("interrupt")))]).utf8())
                session.deadline += 1
                let token = session.deadline
                queue.asyncAfter(deadline: .now() + options.grace) { self.deadlinePassed(session, token) }
            }
            session.waiters.append(frame)
            return nil
        case "settled":
            guard let session = sessions[try body.key("session")] else { return ok }
            // A graceful answer that raced the deadline keeps an in-process adapter's session
            // (Bun did not kill it); a helper the owner killed stays stopped.
            if session.phase == .cancelling || (session.phase == .stopped && session.host == "bun") { session.phase = .idle }
            wake(session, escalate: false)
            persist()
            return ok
        case "terminal":
            let kind = try body.string("kind", max: 8)
            guard kind == "done" || kind == "error" else { throw ServiceContractFailure.invalidRequest }
            if let session = sessions[try body.key("session")] {
                session.turnOpen = false
                if session.phase == .running { session.phase = .idle }
                persist()
            }
            return ok
        case "resume":
            guard let session = sessions[try body.key("session")] else { throw ProviderRefusal(.notFound, "No such provider session.") }
            let id = try body.string("id", max: 4096), record = try body.key("record")
            session.resume = id; session.record = record
            do {
                try store.setResume(record: record, provider: session.provider, resume: id, at: options.now())
            } catch { throw ProviderRefusal(.ioFailure, "The provider thread could not be recorded (\(error)).") }
            persist()
            return ok
        case "recover":
            let record = try body.key("record")
            guard let found = store.resume(record: record) else { return Self.object([("recovered", .null)]) }
            return Self.object([("recovered", Self.object([("provider", .string(JSText(found.provider))), ("resume", .string(JSText(found.resume)))]))])
        case "answer":
            let session = try helperSession(body)
            let id = try body.string("id", max: 512), kind = try body.string("kind", max: 16)
            guard session.approvals[id] == kind else { throw ProviderRefusal(.notFound, "That approval is no longer pending.") }
            let value = body.value("value") ?? .null
            let result: JSValue
            if kind == "permission" {
                guard let behavior = value.text?.string, behavior == "allow" || behavior == "deny" else { throw ServiceContractFailure.invalidRequest }
                result = Self.object([("type", .string(JSText("permission-result"))), ("id", .string(JSText(id))), ("behavior", .string(JSText(behavior)))])
            } else {
                guard value == .null || Self.answers(value) else { throw ServiceContractFailure.invalidRequest }
                result = Self.object([("type", .string(JSText("question-result"))), ("id", .string(JSText(id))), ("answers", value)])
            }
            session.approvals[id] = nil
            session.helper?.write(result.utf8())
            return ok
        case "configure":
            let session = try helperSession(body)
            var fields: [(String, JSValue)] = [("type", .string(JSText("configure")))]
            if body.has("model") { fields.append(("model", .string(JSText(try body.string("model", max: 256))))) }
            if body.has("mode") {
                let mode = try body.string("mode", max: 32)
                guard Self.modes.contains(mode) else { throw ServiceContractFailure.invalidRequest }
                fields.append(("mode", .string(JSText(mode))))
            }
            session.helper?.write(Self.object(fields).utf8())
            return ok
        case "close":
            if let session = sessions.removeValue(forKey: try body.key("session")) { end(session, reason: "closed") }
            persist()
            return ok
        case "snapshot":
            let list: [JSValue] = sessions.values.sorted { $0.id < $1.id }.map { s in
                Self.object([("session", .string(JSText(s.id))), ("chat", .string(JSText(s.chat))), ("provider", .string(JSText(s.provider))),
                             ("host", .string(JSText(s.host))), ("phase", .string(JSText(s.phase.rawValue))), ("background", .bool(s.background)),
                             ("tools", Self.strings(ProviderPolicy.granted(background: s.background))),
                             ("resume", s.resume.map { .string(JSText($0)) } ?? .null)])
            }
            return Self.object([("sessions", .array(list))])
        case "status":
            let list: [JSValue] = recovered.map { r in
                Self.object([("session", .string(JSText(r.session))), ("chat", .string(JSText(r.chat))), ("provider", .string(JSText(r.provider))),
                             ("record", r.record.map { .string(JSText($0)) } ?? .null), ("resume", r.resume.map { .string(JSText($0)) } ?? .null),
                             ("interrupted", .bool(r.interrupted))])
            }
            let broken: [JSValue] = violations.map { Self.object([("session", .string(JSText($0.0))), ("reason", .string(JSText($0.1)))]) }
            return Self.object([("recovered", .array(list)), ("violations", .array(broken))])
        default: throw ServiceContractFailure.invalidRequest
        }
    }

    func opened(_ body: ProviderBody, host: String, spawn: String?) throws -> Session {
        let id = try body.key("session"), provider = try body.string("provider", max: 32)
        guard ProviderPolicy.validSessionID(id), ProviderPolicy.validProviderID(provider) else { throw ServiceContractFailure.invalidRequest }
        guard sessions[id] == nil else { throw ProviderRefusal(.conflict, "That provider session is already open.") }
        return Session(id: id, chat: try body.string("chat", max: 4096), provider: provider, root: try body.path("root"),
                       liveRoot: try body.path("liveRoot"), background: try body.bool("background"), host: host, spawn: spawn)
    }

    func helperSession(_ body: ProviderBody) throws -> Session {
        guard let session = sessions[try body.key("session")], session.host == "helper" else {
            throw ProviderRefusal(.notFound, "No helper-hosted provider session.")
        }
        return session
    }

    func scope(_ session: Session?) -> ProviderPolicy.Scope {
        ProviderPolicy.Scope(live: session.map { $0.phase != .stopped } ?? false, background: session?.background ?? false,
                             root: session?.root ?? "/", liveRoot: session?.liveRoot ?? "/", profile: options.profile)
    }

    // MARK: Helpers

    func openHelper(_ frame: PipeFrame, _ body: ProviderBody) throws -> JSValue? {
        guard let command = options.helper else { throw ProviderRefusal(.unavailable, "Provider helpers are not available in this service.") }
        let provider = try body.string("provider", max: 32)
        guard command.providers.contains(provider) else { throw ProviderRefusal(.unauthorized, "This service does not host the \(provider) provider.") }
        guard case .object(let context)? = body.value("context"), case .object? = body.value("options"),
              (body.value("options")?.utf8().count ?? 0) <= 64 * 1024 else { throw ServiceContractFailure.invalidRequest }
        let background = try body.bool("background"), chat = try body.string("chat", max: 4096)
        let allowed: Set<String> = ["emitKey", "sessionId", "resumeSessionId", "resumeSummary", "resumeCwd", "liveRoot", "projectMemory"]
        guard context.allSatisfy({ allowed.contains($0.0.string) }), context.allSatisfy({ $0.1.text != nil }),
              (body.value("context")?.utf8().count ?? 0) <= 128 * 1024 else { throw ServiceContractFailure.invalidRequest }
        let value = body.value("context")!, liveRoot = try body.path("liveRoot")
        // The helper's own context may not name another chat or root than its grant.
        guard value["emitKey"]?.text?.string == chat,
              value["liveRoot"] == nil || value["liveRoot"]?.text?.string == liveRoot,
              (value["sessionId"] != nil) == background else { throw ProviderRefusal(.unauthorized, "The helper context is outside its grant.") }
        let session = try opened(body, host: "helper", spawn: value["sessionId"]?.text?.string)
        var fields: [(String, JSValue)] = [("type", .string(JSText("open"))), ("session", .string(JSText(session.id))),
                                           ("provider", .string(JSText(provider))), ("root", .string(JSText(session.root))),
                                           ("options", body.value("options")!), ("context", value)]
        // The CLI an earlier Claude helper chose: this one skips the login probes (LKM-135).
        if provider == "claude", let cli = cachedClaudeCli() { fields.append(("cli", cli)) }
        let open = Self.object(fields).utf8()
        session.opening = frame
        sessions[session.id] = session
        persist()
        // A Claude helper gets the subscription token saved in Settings (`ProviderLaunch.swift`).
        withSeatToken(provider) { token in self.launchHelper(session, command, open: open, token: token) }
        return nil
    }

    func deadlinePassed(_ session: Session, _ token: Int) {
        guard session.deadline == token, session.phase == .cancelling, sessions[session.id] === session else { return }
        session.phase = .stopped
        if session.host == "helper" {
            // The owner kills the helper itself, and ends the turn it cut off exactly once.
            finishTurn(session, Self.forceStopped)
            stop(session)
        }
        wake(session, escalate: true)
        persist()
    }

    func violation(_ session: Session, _ reason: String) {
        guard sessions[session.id] === session, !session.violated else { return }
        session.violated = true
        violations.append((session.id, reason))
        if violations.count > 100 { violations.removeFirst(violations.count - 100) }
        if let opening = session.opening {
            session.opening = nil
            sessions[session.id] = nil
            answer(opening, .failed(PreferencesOwner.fail(.unauthorized, "The provider helper broke its grant (\(reason)).")))
        }
        finishTurn(session, "The provider helper broke its grant (\(reason)) and was stopped.")
        session.phase = .stopped
        wake(session, escalate: true)
        stop(session)
        persist()
    }

    func exited(_ session: Session, status: Int32, tail: String) {
        if let identity = session.helper?.identity { options.journal?.remove(identity.pgid) }
        for (call, pending) in toolCalls where pending.session == session.id { toolCalls[call] = nil }
        session.tools = 0
        session.approvals = [:]
        let code = ProcessGroup.exitCode(status).map { "status \($0)" } ?? "signal \(status & 0x7f)"
        let detail = tail.split(separator: "\n").last.map { ": \($0.prefix(300))" } ?? ""
        // LKM-168: a helper that ends while its session is current and not stopping crashed.
        let current = sessions[session.id] === session
        if current && session.phase != .stopped {
            ProductLog.error("provider", "Provider helper crashed provider=\(session.provider) \(code)\(detail.prefix(200))", chat: session.chat)
        } else {
            ProductLog.info("provider", "Provider helper exited provider=\(session.provider) \(code)", chat: session.chat)
        }
        guard current else { return }
        if let opening = session.opening {
            session.opening = nil
            sessions[session.id] = nil
            answer(opening, .failed(PreferencesOwner.fail(.unavailable, "The provider helper exited before it was ready (\(code))\(detail).")))
        }
        finishTurn(session, "The provider helper stopped unexpectedly (\(code)). Send your message again to continue.\(exitPhase(session, code))")
        session.phase = .stopped
        wake(session, escalate: true)
        relay(session, "exit", [("reason", .string(JSText(session.violated ? "violation" : code)))])
        persist()
    }

    /// A turn the helper can no longer finish ends here: one `error`, one `done`.
    func finishTurn(_ session: Session, _ message: String, code: String? = nil) {
        guard session.turnOpen else { return }
        session.turnOpen = false
        var error: [(String, JSValue)] = [("type", .string(JSText("error"))), ("message", .string(JSText(message)))]
        if let code { error.append(("code", .string(JSText(code)))) }
        relay(session, "event", [("value", Self.object(error))])
        relay(session, "event", [("value", Self.object([("type", .string(JSText("done")))]))])
    }

    func wake(_ session: Session, escalate: Bool) {
        let waiters = session.waiters
        session.waiters = []
        session.deadline += 1
        for frame in waiters { answer(frame, .succeeded(Self.object([("escalate", .bool(escalate))]))) }
    }

    /// A session leaves the owner: waiters answered, a helper asked to shut down and stopped.
    func end(_ session: Session, reason: String) {
        if let opening = session.opening {
            session.opening = nil
            answer(opening, .failed(PreferencesOwner.fail(.unavailable, "The provider session was \(reason) before its helper was ready.")))
        }
        wake(session, escalate: false)
        session.phase = .stopped
        if let helper = session.helper {
            helper.write(Self.object([("type", .string(JSText("shutdown")))]).utf8())
            helper.closeInput()
            work.async { helper.stop(grace: 1) }
        }
    }

    func stop(_ session: Session) {
        guard let helper = session.helper else { return }
        work.async { helper.stop(grace: 0.2) }
    }

    func relay(_ session: Session, _ kind: String, _ fields: [(String, JSValue)]) {
        let head: [(String, JSValue)] = [("event", .string(JSText("service-event"))), ("service", .string(JSText(Self.service))),
                                         ("kind", .string(JSText(kind))), ("session", .string(JSText(session.id)))]
        send(Self.object(head + fields).utf8())
    }

    func persist() {
        let entries = sessions.values.sorted { $0.id < $1.id }.map { s in
            ProviderStore.Entry(session: s.id, chat: s.chat, provider: s.provider, host: s.host, phase: s.phase.rawValue, record: s.record, resume: s.resume)
        }
        try? store.writeSessions(entries)
    }

    // MARK: Drain

    /// Refuses new requests; one being decided finishes.
    func refuse() { lock.lock(); closed = true; lock.unlock() }

    /// Refuses new requests, stops every helper (bounded) and answers what was waiting.
    @discardableResult
    func close(timeout: TimeInterval) -> Bool {
        refuse()
        let stopped = DispatchGroup()
        queue.sync {
            for session in sessions.values {
                if let opening = session.opening {
                    session.opening = nil
                    answer(opening, .failed(Self.stopping))
                }
                wake(session, escalate: false)
                if let helper = session.helper {
                    helper.closeInput()
                    work.async(group: stopped) { helper.stop(grace: 0.5) }
                }
            }
            for (call, pending) in toolCalls {
                toolCalls[call] = nil
                sessions[pending.session]?.helper?.write(Self.object([("type", .string(JSText("tool-error"))), ("id", pending.id),
                    ("message", .string(JSText("The service is stopping.")))]).utf8())
            }
        }
        let helpers = stopped.wait(timeout: .now() + timeout) == .success
        return inflight.wait(timeout: .now() + timeout) == .success && helpers
    }

    func answer(_ frame: PipeFrame, _ result: PreferencesOwner.Answer) {
        send(Self.reply(id: frame.id, frame: frame, result: result))
        inflight.leave()
    }

}
