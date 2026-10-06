import Foundation
import Darwin

/// Starting provider helpers, and what LKM-119 added around a seat's login:
/// - the first-event deadline: a helper turn that produces nothing (no delta, status,
///   usage, record, approval or tool call) within `firstEventTimeout` is ended with a
///   visible error and its helper stopped, so a wedged SDK or a CLI waiting on a login
///   never leaves the chat on "Thinking…";
/// - the Claude subscription token (`claude setup-token`) saved in Settings: encrypted
///   with the Keychain helper like a connection key, and put into a Claude helper's
///   environment as `CLAUDE_CODE_OAUTH_TOKEN` (never another helper's, never a reply,
///   never an error text);
/// - "Check provider login": a helper started exactly like a chat's (same allowlisted
///   environment, token, cwd) that reports the provider CLI's auth status and exits;
///   the owner adds which provider variables were passed and dropped (LKM-124).
///
/// LKM-135 split that deadline by cold-start phase, from the helper's `phase` frames: a
/// turn sent before the provider CLI started gets `firstEventTimeout`; once it is up, the
/// session init and the first model output get `replyTimeout`, renewed by every phase or
/// progress report, with "Still thinking…" shown after `stillThinking`. Each phase's
/// timing is logged at debug level, and the error names the phase it stopped in.
/// Providers that report no phases (Codex, Gemini) keep the LKM-119 deadline.
enum Liveness: Int, Comparable {
    case cli, initialization, model

    static func < (lhs: Liveness, rhs: Liveness) -> Bool { lhs.rawValue < rhs.rawValue }

    func label(_ provider: String) -> String {
        switch self {
        case .cli: return provider == "claude" ? "starting the Claude CLI" : "starting the turn"
        case .initialization: return "waiting for the session to start"
        case .model: return "waiting for the model's first reply"
        }
    }
}

extension ProviderOwner {
    static let seatTokenVariable = "CLAUDE_CODE_OAUTH_TOKEN"

    func launchHelper(_ session: Session, _ command: ProviderHelperCommand, open: Data, token: String?) {
        guard let frame = session.opening, sessions[session.id] === session else { return }
        let helper: ProviderHelperProcess
        do {
            helper = try ProviderHelperProcess.launch(command, directory: session.root,
                environment: helperEnvironment(session.provider, token: token), watchdog: options.watchdog,
                maxLine: options.maxLine,
                onFrame: { [weak self] data in
                    guard let owner = self else { return }
                    owner.queue.async { owner.helperFrame(session, data) }
                },
                onOversize: { [weak self] in
                    guard let owner = self else { return }
                    owner.queue.async { owner.violation(session, "a frame larger than the limit") }
                },
                onExit: { [weak self] status, tail in
                    guard let owner = self else { return }
                    owner.queue.async { owner.exited(session, status: status, tail: tail) }
                })
        } catch {
            ProductLog.error("provider", "Provider helper \(session.provider) could not start: \(error)", chat: session.chat)
            session.opening = nil
            sessions[session.id] = nil
            answer(frame, .failed(PreferencesOwner.fail(.unavailable, "The provider helper could not start: \(error).")))
            persist()
            return
        }
        if let identity = helper.identity { options.journal?.add(identity) }
        ProductLog.info("provider", "Provider helper started provider=\(session.provider) pid=\(helper.identity?.pgid ?? 0) session=\(session.id.prefix(8))\(session.background ? " background" : "")", chat: session.chat)
        session.helper = helper
        session.launchedAt = Self.clock()
        helper.write(open)
        queue.asyncAfter(deadline: .now() + options.readyTimeout) {
            guard let opening = session.opening, self.sessions[session.id] === session else { return }
            session.opening = nil
            self.sessions[session.id] = nil
            self.answer(opening, .failed(PreferencesOwner.fail(.deadlineExceeded, "The provider helper did not start in time.")))
            self.end(session, reason: "did not start")
            self.persist()
        }
    }

    func helperEnvironment(_ provider: String, token: String?) -> [String: String] {
        var environment = ProviderHelperProcess.environment(base: options.environment, provider: provider)
        if let token, !token.isEmpty, provider == "claude" { environment[Self.seatTokenVariable] = token }
        return environment
    }

    /// The saved token, decrypted off the owner queue (a Keychain call can wait on an
    /// unlock prompt), then `next` on the queue. nil: none saved, or it cannot be read.
    func withSeatToken(_ provider: String, _ next: @escaping (String?) -> Void) {
        guard data.hasSeatToken(provider) else { return next(nil) }
        work.async {
            let token = self.data.seatToken(provider)
            self.queue.async { next(token) }
        }
    }

    // MARK: First event (LKM-119) and cold-start phases (LKM-135)

    static func noResponse(_ provider: String) -> String {
        switch provider {
        case "claude": return "Claude did not respond — check login (claude auth status) and retry"
        case "codex": return "Codex did not respond — check login (codex login status) and retry"
        default: return "The provider did not respond — check its login and retry"
        }
    }

    /// Milliseconds on a monotonic clock (`options.now` may be pinned in fixtures).
    static func clock() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 }

    func debug(_ session: Session, _ text: String) {
        options.log("debug provider \(session.provider) \(session.id.prefix(8)): \(text)")
    }

    func since(_ start: Double) -> Int { Int((Self.clock() - start).rounded()) }

    /// A sent turn waits first for the CLI to start (the short LKM-119 deadline: a hang
    /// at the process level), then, once the CLI is up, for its session and the model's
    /// first output with a much longer deadline that every phase or progress report renews.
    func armFirstEvent(_ session: Session) {
        session.heard = false
        session.still = false
        session.sentAt = Self.clock()
        session.waiting = !session.alive ? .cli : session.initialized ? .model : .initialization
        session.silence += 1
        let token = session.silence
        rearm(session)
        queue.asyncAfter(deadline: .now() + options.stillThinking) { self.thinking(session, token) }
    }

    func rearm(_ session: Session) {
        let token = session.silence, waiting = session.waiting
        let timeout = waiting == .cli ? options.firstEventTimeout : options.replyTimeout
        session.renewals += 1
        let renewal = session.renewals
        queue.asyncAfter(deadline: .now() + timeout) { self.silent(session, token, renewal, waited: timeout) }
    }

    func waitingTurn(_ session: Session, _ token: Int) -> Bool {
        session.silence == token && !session.heard && session.turnOpen && session.phase == .running && sessions[session.id] === session
    }

    func silent(_ session: Session, _ token: Int, _ renewal: Int, waited: TimeInterval) {
        guard waitingTurn(session, token), session.renewals == renewal else { return }
        let phase = session.waiting.label(session.provider)
        debug(session, "no-response while \(phase), \(since(session.sentAt)) ms after send")
        let seconds = waited >= 10 || waited == waited.rounded() ? "\(Int(waited.rounded()))" : String(format: "%.1f", waited)
        finishTurn(session, "\(Self.noResponse(session.provider)). Stopped while \(phase) (no answer in \(seconds) s).", code: "no-response")
        session.phase = .stopped
        wake(session, escalate: true)
        stop(session)
        persist()
    }

    /// A helper that exits during a turn with no output yet: the phase it died in.
    func exitPhase(_ session: Session, _ code: String) -> String {
        guard session.turnOpen, !session.heard else { return "" }
        let phase = session.waiting.label(session.provider)
        debug(session, "helper exited (\(code)) while \(phase), \(since(session.sentAt)) ms after send")
        return " It exited while \(phase)."
    }

    /// "Still thinking…" instead of silence (or an error) while a started CLI works. A
    /// `progress` step (LKM-147): the chat's one status line says it, the transcript does not.
    func thinking(_ session: Session, _ token: Int) {
        guard waitingTurn(session, token), session.alive, !session.still,
              Self.clock() - session.sentAt >= options.stillThinking * 1000 - 1 else { return }
        session.still = true
        let text = session.waiting == .model ? "Still thinking…" : "Still starting \(session.provider == "claude" ? "Claude" : "the provider")…"
        relay(session, "event", [("value", Self.object([("type", .string(JSText("progress"))), ("step", .string(JSText(text)))]))])
    }

    /// The turn produced its first output: the deadline is over (logged once per turn).
    func heard(_ session: Session) {
        guard !session.heard else { return }
        session.heard = true
        if session.turnOpen && session.sentAt > 0 { debug(session, "first model event \(since(session.sentAt)) ms after send") }
    }

    /// `{"type":"phase","phase":…}` from a helper: progress before any output (LKM-135).
    func helperPhase(_ session: Session, _ frame: JSValue) {
        guard case .object(let fields) = frame, fields.count <= 6, let name = frame["phase"]?.text?.string,
              Set(fields.map { $0.0.string }).isSubset(of: ["type", "phase", "ms", "cached", "cli", "loggedIn"]) else {
            return violation(session, "a malformed phase report")
        }
        var ms = ""
        if let value = frame["ms"] {
            guard case .number(let n) = value, n.isFinite, n >= 0, n <= 1e9 else { return violation(session, "a malformed phase report") }
            ms = " \(Int(n)) ms"
        }
        let waiting = session.turnOpen && !session.heard
        switch name {
        case "auth":
            let cached = frame["cached"] == .bool(true)
            debug(session, "auth probe\(ms) (\(cached ? "cached choice" : "probed"))")
            if !cached, session.provider == "claude", frame["loggedIn"] == .bool(true), let cli = frame["cli"] {
                claudeCli = Self.claudeChoice(cli)
            }
        case "cli":
            session.alive = true
            debug(session, "CLI started\(ms) after spawn, \(since(session.launchedAt)) ms after the helper launched")
            if waiting && session.waiting == .cli { advance(session, to: .initialization) }
        case "init":
            session.alive = true
            session.initialized = true
            if waiting { debug(session, "session init \(since(session.sentAt)) ms after send") }
            if waiting { advance(session, to: .model) }
        case "progress":
            session.alive = true
            if waiting { advance(session, to: max(session.waiting, .initialization)) }
        default:
            violation(session, "an unknown phase")
        }
    }

    func advance(_ session: Session, to waiting: Liveness) {
        session.waiting = waiting
        rearm(session)
        thinking(session, session.silence)
    }

    /// A probed choice the owner may hand to later helpers: the bundled CLI, or an
    /// installed `claude` executable by absolute path.
    static func claudeChoice(_ value: JSValue) -> JSValue? {
        guard case .object(let fields) = value, fields.count <= 2, let source = value["source"]?.text?.string else { return nil }
        if source == "bundled" { return fields.count == 1 ? object([("source", .string(JSText("bundled")))]) : nil }
        guard source == "installed", let path = bounded(value["executable"], 4096), path.hasPrefix("/"), path.hasSuffix("/claude") else { return nil }
        return object([("source", .string(JSText("installed"))), ("executable", .string(JSText(path)))])
    }

    /// The cached choice, while an installed executable is still there.
    func cachedClaudeCli() -> JSValue? {
        guard let cli = claudeCli else { return nil }
        if let path = cli["executable"]?.text?.string, access(path, X_OK) != 0 { claudeCli = nil; return nil }
        return cli
    }

    // MARK: Login requests

    func handleLogin(_ frame: PipeFrame, _ body: ProviderBody) throws -> JSValue? {
        switch frame.method {
        case "seatTokenSave":
            let provider = try body.string("provider", max: 32), token = try body.string("token", max: 8192, empty: true)
            guard ProviderData.seatProviders.contains(provider) else { throw ServiceContractFailure.invalidRequest }
            // Another token can change which CLI is signed in: the next helper probes again.
            if provider == "claude" { claudeCli = nil }
            dataWrites.async {
                self.settle(frame) { Self.object([("hasToken", .bool(try self.data.saveSeatToken(provider, token)))]) }
            }
            return nil
        case "seatTokenStatus":
            return Self.object(ProviderData.seatProviders.sorted().map { ($0, Self.object([("hasToken", .bool(data.hasSeatToken($0)))])) })
        default:
            let provider = try body.string("provider", max: 32), root = try body.path("root")
            guard let command = options.helper else { throw ProviderRefusal(.unavailable, "Provider helpers are not available in this service.") }
            guard command.providers.contains(provider) else { throw ProviderRefusal(.unauthorized, "This service does not host the \(provider) provider.") }
            if provider == "claude" { claudeCli = nil }
            withSeatToken(provider) { token in self.diagnose(frame, command, provider: provider, root: root, token: token) }
            return nil
        }
    }

    private final class Diagnosis: @unchecked Sendable {
        var answered = false
        var helper: ProviderHelperProcess?
    }

    /// One helper, one `diagnose` frame, one `diagnosis` answer (or an error), then stopped.
    func diagnose(_ frame: PipeFrame, _ command: ProviderHelperCommand, provider: String, root: String, token: String?) {
        let state = Diagnosis()
        let finish: (PreferencesOwner.Answer) -> Void = { result in
            guard !state.answered else { return }
            state.answered = true
            self.answer(frame, result)
            if let helper = state.helper {
                helper.closeInput()
                self.work.async { helper.stop(grace: 0.5) }
            }
        }
        let helper: ProviderHelperProcess
        do {
            helper = try ProviderHelperProcess.launch(command, directory: root, environment: helperEnvironment(provider, token: token),
                watchdog: options.watchdog, maxLine: options.maxLine,
                onFrame: { [weak self] data in
                    guard let owner = self else { return }
                    owner.queue.async {
                        guard let value = try? JSValue.parse(data, maxDepth: 16), value["type"]?.text?.string == "diagnosis" else { return }
                        guard let report = Self.loginReport(value["report"], provider: provider, token: token) else {
                            return finish(.failed(PreferencesOwner.fail(.providerFailure, "The provider helper sent a malformed login report.")))
                        }
                        finish(.succeeded(Self.object([("report", owner.variableReport(report, provider: provider))])))
                    }
                },
                onOversize: { [weak self] in
                    self?.queue.async { finish(.failed(PreferencesOwner.fail(.providerFailure, "The provider helper sent a malformed login report."))) }
                },
                onExit: { [weak self] status, _ in
                    guard let owner = self else { return }
                    owner.queue.async {
                        if let identity = state.helper?.identity { owner.options.journal?.remove(identity.pgid) }
                        let code = ProcessGroup.exitCode(status).map { "status \($0)" } ?? "signal \(status & 0x7f)"
                        finish(.failed(PreferencesOwner.fail(.unavailable, "The provider helper exited before it reported its login (\(code)).")))
                    }
                })
        } catch {
            return finish(.failed(PreferencesOwner.fail(.unavailable, "The provider helper could not start: \(error).")))
        }
        state.helper = helper
        if let identity = helper.identity { options.journal?.add(identity) }
        helper.write(Self.object([("type", .string(JSText("diagnose"))), ("provider", .string(JSText(provider))),
                                  ("root", .string(JSText(root)))]).utf8())
        queue.asyncAfter(deadline: .now() + options.readyTimeout + 15) {
            finish(.failed(PreferencesOwner.fail(.deadlineExceeded, "The provider helper did not report its login in time.")))
        }
    }

    /// A helper's login report: known fields only, bounded, and never the token itself.
    static func loginReport(_ value: JSValue?, provider: String, token: String?) -> JSValue? {
        guard case .object(let fields)? = value, fields.count <= 20, value?["detail"]?.text != nil else { return nil }
        var out: [(String, JSValue)] = [("provider", .string(JSText(provider)))]
        for (name, field) in fields {
            let key = name.string
            switch key {
            case "provider": continue
            case "loggedIn", "keychainItem":
                guard field == .null || field == .bool(true) || field == .bool(false) else { return nil }
            case "token", "credentialsExists", "credentialsReadable":
                guard field == .bool(true) || field == .bool(false) else { return nil }
            case "keychainItemExit", "credentialsSize":
                // A `security` exit status or a byte count: null when it did not run or the file is absent.
                if field != .null {
                    guard case .number(let number) = field, number >= 0, number <= 1e12, number == number.rounded() else { return nil }
                }
            case "source":
                guard let source = field.text?.string, source == "bundled" || source == "installed" else { return nil }
            case "keychain":
                // LKM-125: `security list-keychains` / `default-keychain` exit codes only.
                guard case .object(let codes) = field, codes.count <= 2 else { return nil }
                for (probe, code) in codes {
                    guard ["listKeychains", "defaultKeychain"].contains(probe.string) else { return nil }
                    if code == .null { continue }
                    guard case .number(let n) = code, n == n.rounded(), abs(n) <= 255 else { return nil }
                }
            case "executable", "authMethod", "detail", "keychainList", "keychainDefault", "credentialsPath":
                guard let text = field.text, text.count <= 4096, !text.contains(0) else { return nil }
                if let token, !token.isEmpty, text.string.contains(token) { return nil }
            default: return nil
            }
            out.append((key, field))
        }
        return object(out)
    }

    /// The report plus which of the provider's variables Trezi's environment had: those
    /// the helper got and those it dropped, by name only, never a value (LKM-124).
    func variableReport(_ report: JSValue, provider: String) -> JSValue {
        guard case .object(var fields) = report, ProviderHelperProcess.providerFamilies[provider] != nil else { return report }
        let names = ProviderHelperProcess.variableNames(base: options.environment, provider: provider)
        let list = { (names: [String]) in names.isEmpty ? "none" : names.prefix(40).joined(separator: ", ") }
        var lines = ["Passed to the helper from Trezi’s environment: \(list(names.inherited))",
                     "Dropped (a parent session’s or not a user setting): \(list(names.dropped))"]
        let bare = names.dropped.contains("CLAUDE_CODE_SIMPLE")
        if bare {
            lines.append("CLAUDE_CODE_SIMPLE was set where Trezi started. It makes the Claude CLI skip its login (bare mode), so Trezi drops it.")
        }
        let strings = { (names: [String]) in JSValue.array(names.prefix(40).map { .string(JSText($0)) }) }
        for index in fields.indices where fields[index].0.string == "detail" {
            fields[index].1 = .string(JSText((fields[index].1.text?.string ?? "") + "\n" + lines.joined(separator: "\n")))
        }
        fields.append((JSText("inherited"), strings(names.inherited)))
        fields.append((JSText("dropped"), strings(names.dropped)))
        if bare { fields.append((JSText("bare"), .bool(true))) }
        return .object(fields)
    }
}

/// The built-in seats' subscription tokens, `<profile>/trezi/seat-tokens.json`
/// (`{"version":1,"tokens":{"claude":"<base64 ciphertext>"}}`, mode 0600).
extension ProviderData {
    static let seatProviders: Set<String> = ["claude"]
    static let badSeatToken = "That does not look like a token from claude setup-token: paste the single line it printed."

    var seatTokensFile: String { directory + "/seat-tokens.json" }

    func seatTokens() -> [(JSText, JSValue)] {
        guard let data = FileManager.default.contents(atPath: seatTokensFile), data.count <= 64 * 1024,
              let parsed = try? JSValue.parse(data), case .object(let tokens)? = parsed["tokens"] else { return [] }
        return tokens.filter { Self.seatProviders.contains($0.0.string) && Self.truthy($0.1) && $0.1.text != nil }
    }

    func hasSeatToken(_ provider: String) -> Bool { seatTokens().contains { $0.0.string == provider } }

    /// Saves (or, for an empty token, removes) a seat's token; answers whether one is saved.
    func saveSeatToken(_ provider: String, _ raw: String) throws -> Bool {
        let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        var tokens = seatTokens().filter { $0.0.string != provider }
        if !token.isEmpty {
            guard token.utf8.count <= 4096, token.utf8.allSatisfy({ (0x21...0x7E).contains($0) }) else {
                throw ProviderRefusal(.invalidRequest, Self.badSeatToken)
            }
            guard let crypto = tools.crypto, !crypto.isEmpty else { throw ProviderRefusal(.unavailable, Self.noKeyring) }
            guard let sealed = self.crypto("encrypt", Data(token.utf8)) else { throw ProviderRefusal(.unavailable, Self.keychain) }
            tokens.append((JSText(provider), .string(JSText(sealed.base64EncodedString()))))
        }
        try prepareDirectory()
        let body = JSValue.object([(JSText("version"), .number(1)), (JSText("tokens"), .object(tokens))])
        try Self.replace(seatTokensFile, Data(JSValue.pretty(body).utf8), mode: 0o600)
        return !token.isEmpty
    }

    /// The plaintext token, or nil (none, or it cannot be decrypted here).
    func seatToken(_ provider: String) -> String? {
        guard let blob = seatTokens().first(where: { $0.0.string == provider })?.1.text,
              let plain = crypto("decrypt", Self.base64(blob.string)) else { return nil }
        let token = String(decoding: plain, as: UTF8.self)
        return token.isEmpty ? nil : token
    }
}
