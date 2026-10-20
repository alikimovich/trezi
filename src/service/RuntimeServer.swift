import Foundation
import Darwin

/// A start request's outcome, settled exactly once: ready, failed, or cancelled.
final class Readiness: @unchecked Sendable {
    enum Outcome {
        case ready(url: String, note: String?), failed(ServiceContractFailure, String)
        /// Answered only once this group is gone (failed readiness).
        case failedAfterStop(ServiceContractFailure, String, ManagedProcess)
    }
    private let lock = NSLock()
    private var completion: ((Readiness, Outcome) -> Void)?

    init(_ completion: @escaping (Readiness, Outcome) -> Void) { self.completion = completion }

    var settled: Bool { lock.lock(); defer { lock.unlock() }; return completion == nil }

    /// True for the first caller only.
    @discardableResult
    func settle(_ outcome: Outcome) -> Bool {
        lock.lock()
        let done = completion
        completion = nil
        lock.unlock()
        done?(self, outcome)
        return done != nil
    }
}

/// A project's process output as log lines, with a bounded tail for failure
/// messages. Lines are split on bytes, so a character split across reads survives.
final class OutputLines: @unchecked Sendable {
    static let maxLine = 8_000
    private let lock = NSLock()
    private var pending = Data()
    private var tailText: JSText = []
    private var urlClaimed = false

    /// True once: the first printed URL is the only one probed (as before).
    func claimURL() -> Bool { lock.lock(); defer { lock.unlock() }; if urlClaimed { return false }; urlClaimed = true; return true }

    /// Complete lines (ANSI stripped) and the undelimited remainder, for URL matching.
    func append(_ chunk: Data) -> (lines: [String], partial: String) {
        lock.lock(); defer { lock.unlock() }
        pending.append(chunk)
        var lines: [String] = []
        while let end = pending.firstIndex(of: 10) {
            lines.append(RuntimeNet.stripAnsi(String(decoding: pending[pending.startIndex..<end], as: UTF8.self)))
            pending.removeSubrange(pending.startIndex...end)
        }
        if pending.count > 64 * 1024 {
            lines.append(RuntimeNet.stripAnsi(String(decoding: pending, as: UTF8.self)))
            pending.removeAll()
        }
        for line in lines { remember(line + "\n") }
        return (lines, RuntimeNet.stripAnsi(String(decoding: pending, as: UTF8.self)))
    }

    /// The last 4,000 UTF-16 units of output, the remainder included.
    var tail: JSText {
        lock.lock(); defer { lock.unlock() }
        return RuntimeDetect.last(tailText + JSText(RuntimeNet.stripAnsi(String(decoding: pending, as: UTF8.self))), 4000)
    }

    private func remember(_ text: String) { tailText = RuntimeDetect.last(tailText + JSText(text), 4000) }

    /// JS `line.trim() ? line.trimEnd() : skip`, bounded.
    static func loggable(_ line: String) -> String? {
        guard !RuntimeDetect.jsTrim(line).isEmpty else { return nil }
        var units = Array(line.utf16)
        let space = Set(Array(" \t\n\u{0B}\u{0C}\r\u{A0}\u{1680}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}".utf16) + Array(0x2000...0x200A))
        while let last = units.last, space.contains(last) { units.removeLast() }
        return String(decoding: units.prefix(maxLine), as: UTF16.self)
    }
}

/// One project's managed server: a process group or a static site on a reserved
/// port. `info` is set once it is ready (`RunningDevServer`). A private agent runtime
/// (LOCAL-WEBKIT-1) carries its agent id and the generation it was started under.
final class RuntimeServer: @unchecked Sendable {
    enum Kind { case process(ManagedProcess), site(StaticServer) }
    let root: String
    let key: String
    let port: Int
    let kind: Kind
    let readiness: Readiness?
    let agent: String?
    let generation: Int
    private let lock = NSLock()
    private var ready: JSValue?

    init(root: String, key: String, port: Int, kind: Kind, readiness: Readiness?, agent: String? = nil, generation: Int = 0) {
        self.root = root; self.key = key; self.port = port; self.kind = kind; self.readiness = readiness
        self.agent = agent; self.generation = generation
    }

    /// The ready answer: `RunningDevServer`, plus `agent` and `generation` for a private runtime.
    func running(url: String, pid: Int32) -> JSValue {
        guard let agent, case .object(let fields) = Self.running(url: url, pid: pid) else { return Self.running(url: url, pid: pid) }
        return .object(fields + [(JSText("agent"), .string(JSText(agent))), (JSText("generation"), .number(Double(generation)))])
    }

    var info: JSValue? { get { lock.lock(); defer { lock.unlock() }; return ready } set { lock.lock(); ready = newValue; lock.unlock() } }

    var url: String? { info?["url"]?.text?.string }

    /// Stops the group (TERM, grace, KILL; waits for it) or closes the site.
    func shutdown(grace: TimeInterval) {
        switch kind {
        case .process(let process): process.stop(grace: grace)
        case .site(let server): server.close()
        }
    }

    static func running(url: String, pid: Int32) -> JSValue {
        .object([(JSText("url"), .string(JSText(url))), (JSText("pid"), .number(Double(pid))), (JSText("attached"), .bool(false))])
    }
}

/// Private agent runtimes (LOCAL-WEBKIT-1): a request with an `agent` id runs the
/// server for that agent's worktree under its own key (`agent:<id>:<root>`), apart
/// from the project's visible server. Its start, stop, exit and logs never touch the
/// visible one, and its events carry the `agent` field. At most `maxAgentRuntimes`
/// exist at once; `stopAgents` stops them (one agent's or all) and leaves every
/// visible server alone.
extension RuntimeOwner {
    static let agentPrefix = "agent:"
    static let maxAgentRuntimes = 3

    /// A private runtime's key; a visible key is an absolute path, so the two never meet.
    static func key(_ root: String, agent: String?) -> String { (agent.map { agentPrefix + $0 + ":" } ?? "") + key(root) }

    /// The optional `agent` id: 1–64 ASCII letters, digits, `-` or `_`.
    static func agent(_ fields: [String: JSValue]) throws -> String? {
        guard let value = fields["agent"] else { return nil }
        guard let text = value.text?.string, (1...64).contains(text.count),
              text.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { throw ServiceContractFailure.invalidRequest }
        return text
    }

    /// A private runtime's events name its agent and generation; a visible server's carry neither.
    static func scope(_ server: RuntimeServer) -> [(String, JSValue)] {
        guard let agent = server.agent else { return [] }
        return [("agent", .string(JSText(agent))), ("generation", .number(Double(server.generation)))]
    }
}
