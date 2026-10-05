import Foundation

/// The provider owner's values and frame checks (S10): replies, the helper event and
/// record-delta validation, images and tool results. Split from `ProviderOwner.swift`; the
/// handlers run on the owner's queue like everything else there.
extension ProviderOwner {
    /// One frame from a helper. Anything not in the protocol, or outside the grant, is a violation.
    func helperFrame(_ session: Session, _ data: Data) {
        guard sessions[session.id] === session, !session.violated else { return }
        guard let frame = try? JSValue.parse(data, maxDepth: 64), case .object(let fields) = frame,
              let type = frame["type"]?.text?.string else { return violation(session, "a frame that is not a JSON object") }
        let keys = Set(fields.map { $0.0.string })
        // Anything the turn produced (not the slash menu a session posts on its own, nor the
        // resume id its session init records, LKM-135) stops the first-event timer. A
        // `progress` heartbeat only says the helper is alive (LKM-147): a CLI that never
        // answers must still reach the deadline. Nor does the init's resolved `model` (LKM-164).
        let resumeOnly = type == "record" && frame["entries"] == .array([]) && frame["filesTouched"] == nil
        if ["record", "permission", "question", "tool"].contains(type) && !resumeOnly
            || (type == "event" && !["commands", "progress", "model"].contains(frame["event"]?["type"]?.text?.string ?? "")) {
            heard(session)
        }
        func only(_ allowed: Set<String>) -> Bool { keys.isSubset(of: allowed.union(["type"])) }
        switch type {
        case "ready":
            guard let opening = session.opening, only([]) else { return violation(session, "an unexpected ready") }
            debug(session, "helper ready \(since(session.launchedAt)) ms after launch")
            session.opening = nil
            answer(opening, .succeeded(Self.object([("tools", Self.strings(ProviderPolicy.granted(background: session.background)))])))
        case "failed":
            guard let opening = session.opening, only(["message"]), let message = frame["message"]?.text else {
                return violation(session, "an unexpected failure report")
            }
            session.opening = nil
            sessions[session.id] = nil
            answer(opening, .failed(PreferencesOwner.fail(.providerFailure, String(message.string.prefix(4096)))))
            end(session, reason: "failed to start")
            persist()
        case "event":
            guard only(["event"]), let event = frame["event"] else { return violation(session, "a malformed event frame") }
            switch Self.event(event, session: session) {
            case .failure(let refusal): return violation(session, refusal.reason)
            case .success(let relayed):
                let kind = relayed["type"]?.text?.string
                if kind == "done" {
                    session.turnOpen = false
                    if session.phase == .running { session.phase = .idle; persist() }
                } else if kind == "permission-resolved" || kind == "question-resolved", let id = relayed["id"]?.text?.string {
                    session.approvals[id] = nil
                } else if kind == "error", relayed["code"]?.text?.string == "auth", session.provider == "claude" {
                    // A sign-in failure: the next Claude helper probes the CLIs again (LKM-135).
                    claudeCli = nil
                }
                relay(session, "event", [("value", relayed)])
            }
        case "record":
            guard only(["entries", "filesTouched", "sdkSessionId", "sdkCwd"]), let delta = Self.record(frame) else {
                return violation(session, "a malformed or forbidden record delta")
            }
            relay(session, "record", [("record", delta)])
        case "permission":
            guard only(["id", "tool", "title", "detail"]), let id = Self.bounded(frame["id"], 512), let tool = Self.bounded(frame["tool"], 512),
                  let title = Self.bounded(frame["title"], 4096), frame["detail"] == nil || Self.bounded(frame["detail"], 4096) != nil,
                  session.approvals[id] == nil, session.approvals.count < ProviderPolicy.Limits.pendingApprovals else {
                return violation(session, "a malformed permission request")
            }
            let detail = frame["detail"]?.text?.string
            func result(_ behavior: String, _ message: String?) {
                var out: [(String, JSValue)] = [("type", .string(JSText("permission-result"))), ("id", .string(JSText(id))), ("behavior", .string(JSText(behavior)))]
                if let message { out.append(("message", .string(JSText(message)))) }
                session.helper?.write(Self.object(out).utf8())
            }
            switch ProviderPolicy.decide(tool: tool, target: detail, scope: scope(session)) {
            case .allow: result("allow", nil)
            case .deny(let message): result("deny", message)
            case .question: result("deny", "Questions are asked with a question frame.")
            case .ask:
                session.approvals[id] = "permission"
                var request: [(String, JSValue)] = [("id", .string(JSText(id))), ("toolName", .string(JSText(tool))), ("title", .string(JSText(title)))]
                if let detail { request.append(("detail", .string(JSText(detail)))) }
                request.append(("sessionKey", .string(JSText(session.chat))))
                relay(session, "event", [("value", Self.object([("type", .string(JSText("permission-request"))), ("request", Self.object(request))]))])
            }
        case "question":
            guard only(["id", "questions"]), let id = Self.bounded(frame["id"], 512), case .array(let questions)? = frame["questions"],
                  (1...16).contains(questions.count), (frame["questions"]?.utf8().count ?? .max) <= 64 * 1024,
                  session.approvals[id] == nil, session.approvals.count < ProviderPolicy.Limits.pendingApprovals else {
                return violation(session, "a malformed question")
            }
            guard scope(session).live else {
                session.helper?.write(Self.object([("type", .string(JSText("question-result"))), ("id", .string(JSText(id))), ("answers", .null)]).utf8())
                return
            }
            session.approvals[id] = "question"
            let request = Self.object([("id", .string(JSText(id))), ("questions", .array(questions)), ("sessionKey", .string(JSText(session.chat)))])
            relay(session, "event", [("value", Self.object([("type", .string(JSText("question-request"))), ("request", request)]))])
        case "tool":
            guard only(["id", "name", "args"]), case .number(let number)? = frame["id"], number >= 0, number < 9e15, number.rounded() == number,
                  let name = Self.bounded(frame["name"], 256), let args = frame["args"],
                  session.tools < ProviderPolicy.Limits.pendingTools else { return violation(session, "a malformed tool call") }
            let helperID: JSValue = .number(number)
            // Outside the grant: refused, like any tool failure (not a violation: the model asked).
            if let refusal = ProviderPolicy.authorize(tool: name, bytes: args.utf8().count, live: scope(session).live, background: session.background) {
                session.helper?.write(Self.object([("type", .string(JSText("tool-error"))), ("id", helperID), ("message", .string(JSText(refusal.message)))]).utf8())
                return
            }
            toolSequence += 1
            let call = toolSequence
            toolCalls[call] = (session.id, helperID)
            session.tools += 1
            relay(session, "tool", [("id", .number(Double(call))), ("tool", .string(JSText(name))), ("args", args)])
            queue.asyncAfter(deadline: .now() + options.toolTimeout) {
                guard let pending = self.toolCalls.removeValue(forKey: call) else { return }
                session.tools -= 1
                self.sessions[pending.session]?.helper?.write(Self.object([("type", .string(JSText("tool-error"))), ("id", pending.id),
                    ("message", .string(JSText("The tool did not answer in time.")))]).utf8())
            }
        case "settled":
            guard only([]) else { return violation(session, "a malformed settled report") }
            if session.phase == .cancelling { session.phase = .idle; persist() }
            wake(session, escalate: false)
        case "phase":
            helperPhase(session, frame)
        default:
            violation(session, "an unknown frame type")
        }
    }

    /// Bun's answer to a tool call: `{"service":"provider-helper","id":n,"result"|"error"}`.
    func toolReply(_ line: Data) {
        guard let value = try? JSValue.parse(line, maxDepth: 64), case .object(let fields) = value, fields.count == 3,
              case .number(let number)? = value["id"], let call = Int(exactly: number),
              let pending = toolCalls.removeValue(forKey: call) else { return }
        let session = sessions[pending.session]
        session?.tools -= 1
        let out: JSValue
        if let message = value["error"]?.text {
            out = Self.object([("type", .string(JSText("tool-error"))), ("id", pending.id), ("message", .string(message))])
        } else if let result = value["result"], Self.toolResult(result, limit: options.maxLine - 1024) {
            out = Self.object([("type", .string(JSText("tool-result"))), ("id", pending.id), ("result", result)])
        } else {
            out = Self.object([("type", .string(JSText("tool-error"))), ("id", pending.id),
                               ("message", .string(JSText("The tool result was refused (malformed image, or too large).")))])
        }
        session?.helper?.write(out.utf8())
    }

    static func object(_ fields: [(String, JSValue)]) -> JSValue { .object(fields.map { (JSText($0.0), $0.1) }) }
    static func strings(_ values: [String]) -> JSValue { .array(values.map { .string(JSText($0)) }) }

    static func verdict(_ verdict: ProviderPolicy.Verdict) -> JSValue {
        switch verdict {
        case .allow: return object([("decision", .string(JSText("allow")))])
        case .ask: return object([("decision", .string(JSText("ask")))])
        case .question: return object([("decision", .string(JSText("question")))])
        case .deny(let message): return object([("decision", .string(JSText("deny"))), ("message", .string(JSText(message)))])
        }
    }

    static func bounded(_ value: JSValue?, _ max: Int) -> String? {
        guard let text = value?.text, !text.isEmpty, text.count <= max, !text.contains(0), JSText(text.string) == text else { return nil }
        return text.string
    }

    /// Pasted or dropped images: each exactly `{mediaType, data}`, an allowed type, bounded base64.
    static func images(_ value: JSValue?) throws -> JSValue {
        guard case .array(let items)? = value, items.count <= ProviderPolicy.Limits.images,
              items.reduce(0, { $0 + ($1["data"]?.text?.count ?? 0) }) <= ProviderPolicy.Limits.imagesTotal else { throw ServiceContractFailure.invalidRequest }
        for item in items {
            guard case .object(let fields) = item, Set(fields.map { $0.0.string }) == ["mediaType", "data"], fields.count == 2,
                  ProviderPolicy.validImage(mediaType: item["mediaType"]?.text?.string, data: item["data"]?.text) else {
                throw ServiceContractFailure.invalidRequest
            }
        }
        return .array(items)
    }

    /// A question's answers: question text → the chosen label(s), bounded.
    static func answers(_ value: JSValue) -> Bool {
        guard case .object(let fields) = value, fields.count <= 16 else { return false }
        return fields.allSatisfy { $0.0.count <= 4096 && ($0.1.text?.count ?? .max) <= 16_384 }
    }

    /// A tool result the helper may receive: bounded, and every image block well-formed.
    static func toolResult(_ value: JSValue, limit: Int) -> Bool {
        guard value.utf8().count <= limit else { return false }
        guard case .array(let content)? = value["content"] else { return true }
        return content.allSatisfy { item in
            guard item["type"]?.text?.string == "image" else { return true }
            return ProviderPolicy.validImage(mediaType: item["mimeType"]?.text?.string, data: item["data"]?.text)
        }
    }

    static let eventFields: [String: Set<String>] = [
        "delta": ["text"], "status": ["text"], "error": ["message"], "done": [], "usage": ["input", "output", "cached"],
        "commands": ["commands"], "permission-resolved": ["id"], "question-resolved": ["id"], "progress": [],
        "model": ["model"],
    ]
    /// Fields an event may leave out: an error's card code (LKM-119), a progress step (LKM-147).
    static let optionalEventFields: [String: Set<String>] = ["error": ["code"], "progress": ["step"]]
    static let errorCodes: Set<String> = ["auth", "no-response"]

    /// A helper's event: a type the protocol relays, its own fields only, bounded, for its own chat.
    static func event(_ value: JSValue, session: Session) -> Result<JSValue, EventRefusal> {
        guard case .object(let fields) = value, let type = value["type"]?.text?.string else { return .failure(EventRefusal("a malformed event")) }
        guard let allowed = eventFields[type] else {
            // Approvals go through their own frames, so the owner applies the policy first.
            return .failure(EventRefusal("a \(type) event it may not send"))
        }
        if let key = value["projectKey"], key.text?.string != session.chat { return .failure(EventRefusal("an event for another chat")) }
        if let spawn = value["sessionId"], spawn.text?.string != session.spawn { return .failure(EventRefusal("an event for another session")) }
        var out: [(String, JSValue)] = [("type", .string(JSText(type)))]
        for (name, field) in fields {
            let key = name.string
            if key == "type" || key == "projectKey" || key == "sessionId" { continue }
            guard allowed.contains(key) || optionalEventFields[type]?.contains(key) == true else {
                return .failure(EventRefusal("an event field it may not send"))
            }
            switch key {
            case "code":
                guard let code = field.text?.string, errorCodes.contains(code) else { return .failure(EventRefusal("an unknown error code")) }
            case "text", "message", "id":
                guard let text = field.text, text.count <= ProviderPolicy.Limits.eventText else { return .failure(EventRefusal("an oversized event")) }
            case "step":
                guard bounded(field, 512) != nil else { return .failure(EventRefusal("a malformed progress event")) }
            case "model":
                guard bounded(field, 256) != nil else { return .failure(EventRefusal("a malformed model event")) }
            case "input", "output", "cached":
                guard case .number(let n) = field, n.isFinite, n >= 0 else { return .failure(EventRefusal("a malformed usage event")) }
            case "commands":
                guard case .array(let items) = field, items.count <= 1000, field.utf8().count <= 256 * 1024 else { return .failure(EventRefusal("oversized commands")) }
            default: break
            }
            out.append((key, field))
        }
        guard allowed.isSubset(of: Set(out.map { $0.0 })) else { return .failure(EventRefusal("an incomplete event")) }
        return .success(object(out))
    }

    /// A record delta: only assistant and status entries (a helper cannot write what the user said).
    static func record(_ frame: JSValue) -> JSValue? {
        guard case .array(let entries)? = frame["entries"], entries.count <= 10_000 else { return nil }
        for entry in entries {
            guard case .object(let fields) = entry, fields.count == 3, let role = entry["role"]?.text?.string, role == "assistant" || role == "status",
                  let text = entry["text"]?.text, text.count <= ProviderPolicy.Limits.eventText, case .number(let at)? = entry["at"], at.isFinite else { return nil }
        }
        var delta: [(String, JSValue)] = [("entries", .array(entries))]
        if let files = frame["filesTouched"] {
            guard case .array(let list) = files, list.count <= 10_000, list.allSatisfy({ ($0.text?.count ?? .max) <= 4096 }) else { return nil }
            delta.append(("filesTouched", files))
        }
        if let resume = frame["sdkSessionId"] {
            guard bounded(resume, 4096) != nil else { return nil }
            delta.append(("sdkSessionId", resume))
        }
        if let cwd = frame["sdkCwd"] {
            guard bounded(cwd, 4096) != nil else { return nil }
            delta.append(("sdkCwd", cwd))
        }
        return object(delta)
    }

    static func failure(_ error: Error) -> ServiceFailure {
        if let refusal = error as? ProviderRefusal { return refusal.failure }
        if let code = error as? ServiceContractFailure { return PreferencesOwner.fail(code, "Invalid provider request.") }
        return PreferencesOwner.fail(.ioFailure, "\(error)")
    }

    static let stopping = PreferencesOwner.fail(.unavailable, "The service is stopping; the provider session was not changed.", retryable: true)

    static func reply(id: JSValue, frame: PipeFrame?, result: PreferencesOwner.Answer) -> Data {
        let body: JSValue
        switch result {
        case .succeeded(let payload): body = object([("kind", .string(JSText("succeeded"))), ("payload", payload)])
        case .failed(let failure): body = object([("kind", .string(JSText("failed"))), ("payload", PreferencesOwner.value(failure))])
        }
        var reply: [(String, JSValue)] = []
        if let frame {
            reply = [("connection", .string(JSText(frame.connection))), ("requestID", .string(JSText(frame.requestID))),
                     ("operationID", .string(JSText(frame.operationID))), ("scope", .object([]))]
        }
        reply.append(("result", body))
        return object([("event", .string(JSText("service-reply"))), ("service", .string(JSText(service))), ("id", id), ("reply", object(reply))]).utf8()
    }
}

struct EventRefusal: Error { let reason: String; init(_ reason: String) { self.reason = reason } }

struct ProviderRefusal: Error {
    let failure: ServiceFailure
    init(_ failure: ServiceFailure) { self.failure = failure }
    init(_ code: ServiceContractFailure, _ message: String) { failure = PreferencesOwner.fail(code, message) }
}

/// A provider request body: exactly the allowed fields, each well-formed.
struct ProviderBody {
    private let fields: [String: JSValue]

    init(_ frame: PipeFrame, required: Set<String>, optional: Set<String>) throws {
        var fields: [String: JSValue] = [:]
        for (name, value) in frame.body {
            let key = name.string
            guard required.union(optional).contains(key), fields[key] == nil else { throw ServiceContractFailure.invalidRequest }
            fields[key] = value
        }
        guard required.isSubset(of: Set(fields.keys)) else { throw ServiceContractFailure.invalidRequest }
        self.fields = fields
    }

    func has(_ key: String) -> Bool { fields[key] != nil }
    func value(_ key: String) -> JSValue? { fields[key] }

    /// Well-formed text (no lone surrogate, no NUL), at most `max` UTF-16 units.
    func string(_ key: String, max: Int, empty: Bool = false) throws -> String {
        guard let text = fields[key]?.text, empty || !text.isEmpty, text.count <= max, !text.contains(0), JSText(text.string) == text else {
            throw ServiceContractFailure.invalidRequest
        }
        return text.string
    }

    /// A session or record id (it names files).
    func key(_ key: String) throws -> String {
        let value = try string(key, max: 128)
        guard ProviderPolicy.validSessionID(value) else { throw ServiceContractFailure.invalidRequest }
        return value
    }

    func path(_ key: String) throws -> String {
        let value = try string(key, max: 4096)
        guard value.hasPrefix("/") else { throw ServiceContractFailure.invalidRequest }
        return value
    }

    func bool(_ key: String) throws -> Bool {
        guard case .bool(let value)? = fields[key] else { throw ServiceContractFailure.invalidRequest }
        return value
    }

    func count(_ key: String) throws -> Int {
        guard case .number(let value)? = fields[key], value >= 0, value.rounded() == value, value < 1e12 else { throw ServiceContractFailure.invalidRequest }
        return Int(value)
    }
}
