import Foundation
import Darwin

/// The single owner of managed project runtimes when the Swift service owns the
/// profile (S06, LKM-94): runtime detection, dependency installs, dev-server process
/// groups, readiness, the static site and its watcher, and shutdown/crash recovery.
/// Bun asks over the private pipe (`{"service":"runtime",…}`) and still decides
/// *what* to run: the detected command or the user's custom command. Git-serialized
/// installs stay inside Bun's repository write queue until S07; Bun holds that lease
/// while this owner runs the install. HTML stamping stays a JS helper (parse5):
/// the static site asks Bun over the same pipe and serves unstamped HTML if it
/// cannot answer. Nothing here adopts a process it did not launch.
final class RuntimeOwner: @unchecked Sendable {
    static let service = "runtime"
    static let helperPrefix = Data("{\"service\":\"runtime-helper\"".utf8)
    static let maxStampBytes = 4 * 1024 * 1024
    static let cancelled = "Preview start was cancelled."

    struct Options {
        /// The launch environment Bun was given: the user's PATH selects the
        /// project's Bun/Node/pnpm/Yarn, exactly as it did for Bun's own spawns.
        var environment: [String: String]
        var watchdog: String?
        var journal: RuntimeJournal?
        var allocatePort: @Sendable (Set<Int>) -> Int? = { RuntimeNet.freePort(from: RuntimeNet.portBase, reserved: $0) }
        var probe: @Sendable (String) -> Int? = { RuntimeNet.probe($0) }
        var readyTimeout: TimeInterval = 90
        /// A ready server is probed this often; `healthFailures` unanswered probes in a
        /// row (a cold page compile can take a while, so the timeout is generous) stop
        /// it as unresponsive, and Bun restarts it (LKM-146).
        var healthProbe: @Sendable (String) -> Int? = { RuntimeNet.probe($0, timeout: 10) }
        var healthInterval: TimeInterval = 10
        var healthFailures = 3
        var installTimeout: TimeInterval = 300
        var stopGrace: TimeInterval = 1
        var stampTimeout: TimeInterval = 5
    }

    let options: Options
    private let send: @Sendable (Data) -> Void
    private let queue = DispatchQueue(label: "dev.trezi.runtime.owner")
    private let work = DispatchQueue(label: "dev.trezi.runtime.work", attributes: .concurrent)
    // Owned by `queue`.
    private var generations: [String: Int] = [:]
    private var servers: [String: RuntimeServer] = [:]
    /// Taken out of `servers` by a stop or restart and still ending; a drain waits for them.
    private var retiring: [ObjectIdentifier: RuntimeServer] = [:]
    /// Ready groups the health check stopped: their exit reports that, not the exit code.
    private var unresponsive = Set<ObjectIdentifier>()
    private var installs: [String: ManagedProcess] = [:]
    private var cancelledInstalls = Set<ObjectIdentifier>()
    private var timedOutInstalls = Set<ObjectIdentifier>()
    private var reserved = Set<Int>()
    private var closed = false
    // Stamping requests to Bun, owned by `helperLock`.
    private let helperLock = NSLock()
    private var helperSequence = 0
    private var helpers: [Int: (DispatchSemaphore, String?)] = [:]
    private var helpersOpen = true

    init(options: Options, send: @escaping @Sendable (Data) -> Void) { self.options = options; self.send = send }

    // MARK: Requests (from the backend reader thread, in pipe order)

    func submit(_ line: Data) {
        if line.starts(with: Self.helperPrefix) { helperReply(line); return }
        let frame: PipeFrame
        do { frame = try PipeFrame(line, service: Self.service, maxDepth: 8) } catch {
            let code = error as? ServiceContractFailure ?? .invalidRequest
            send(Self.reply(id: (try? JSValue.parse(line, maxDepth: 8))?["id"] ?? .null, frame: nil,
                            result: .failed(Self.fail(code, "Invalid project runtime request."))))
            return
        }
        queue.async { self.dispatch(frame) }
    }

    private func dispatch(_ frame: PipeFrame) {
        guard !closed else { return answer(frame, .failed(Self.stopping)) }
        do {
            guard frame.expectedRevision == nil else { throw ServiceContractFailure.invalidRequest }
            switch (frame.method, frame.mode) {
            case ("detect", "read"):
                let root = try Self.root(Self.fields(frame, ["root"]))
                work.async {
                    do { self.answer(frame, .succeeded(try RuntimeDetect.detect(root: root))) }
                    catch { self.answer(frame, .failed(Self.fail(.unavailable, (error as? RuntimeDetect.Failure)?.message ?? "\(error)"))) }
                }
            case ("info", "read"): answer(frame, .succeeded(info(try Self.root(Self.fields(frame, ["root"])))))
            case ("start", "mutation"):
                let body = try Self.fields(frame, ["root", "command"], optional: ["framework", "cleanCache"])
                guard let command = body["command"]?.text, command.count <= 65_536, !command.contains(0),
                      body["framework"].map({ ($0.text?.count ?? 65) <= 64 }) ?? true else { throw ServiceContractFailure.invalidRequest }
                start(frame, root: try Self.root(body), command: command.string, framework: body["framework"]?.text?.string,
                      cleanCache: body["cleanCache"] == .bool(true))
            case ("stop", "mutation"): stop(frame, root: try Self.root(Self.fields(frame, ["root"])))
            case ("install", "mutation"): install(frame, root: try Self.root(Self.fields(frame, ["root"])))
            case ("stopAll", "mutation"):
                _ = try Self.fields(frame, [])
                stopEverything { self.answer(frame, .succeeded(.object([]))) }
            default: throw ServiceContractFailure.invalidRequest
            }
        } catch {
            answer(frame, .failed(Self.fail(error as? ServiceContractFailure ?? .invalidRequest, "Invalid project runtime request.")))
        }
    }

    private func info(_ root: String) -> JSValue {
        guard let server = servers[Self.key(root)] else { return .object([(JSText("running"), .bool(false))]) }
        var fields: [(JSText, JSValue)] = [(JSText("running"), .bool(true))]
        if let info = server.info { fields.append((JSText("server"), info)) }
        return .object(fields)
    }

    /// A newer start or stop for the project supersedes this one.
    private func bump(_ key: String) -> Int {
        let next = (generations[key] ?? 0) + 1
        generations[key] = next
        return next
    }

    // MARK: Start

    private func start(_ frame: PipeFrame, root: String, command: String, framework: String?, cleanCache: Bool = false) {
        let key = Self.key(root), generation = bump(key)
        let previous = servers.removeValue(forKey: key)
        previous?.readiness?.settle(.failed(.cancelled, Self.cancelled))
        if let previous { retiring[ObjectIdentifier(previous)] = previous }
        work.async {
            // A restart never overlaps its predecessor: the old group is gone first.
            if let previous { self.retire(previous) }
            if cleanCache { self.clearDependencyCaches(root, framework: framework) }
            self.queue.async { self.launch(frame, root: root, key: key, command: command, framework: framework, generation: generation) }
        }
    }

    /// LKM-197: caches built from `node_modules` that a start after a dependency change
    /// must not reuse. Vite (and SvelteKit, Astro, …) pre-bundles dependencies into
    /// `node_modules/.vite` and only re-checks at startup against the lockfile; Next keeps
    /// its dev build cache in `.next/cache`. Only caches: nothing the project wrote itself.
    static func dependencyCaches(framework: String?) -> [String] {
        framework == "next" ? ["node_modules/.vite", ".next/cache"] : ["node_modules/.vite"]
    }

    private func clearDependencyCaches(_ root: String, framework: String?) {
        for relative in Self.dependencyCaches(framework: framework) {
            let path = root + "/" + relative
            guard (try? FileManager.default.attributesOfItem(atPath: path)) != nil else { continue }
            do {
                try FileManager.default.removeItem(atPath: path)
                log(root, "Cleared the dependency cache \(relative).")
            } catch { log(root, "Could not clear the dependency cache \(relative): \(error.localizedDescription)") }
        }
    }

    private func launch(_ frame: PipeFrame, root: String, key: String, command: String, framework: String?, generation: Int) {
        guard !closed else { return answer(frame, .failed(Self.stopping)) }
        guard generations[key] == generation else { return answer(frame, .failed(Self.fail(.cancelled, Self.cancelled))) }
        guard let port = options.allocatePort(reserved) else {
            return answer(frame, .failed(Self.fail(.unavailable, "No free port found from \(RuntimeNet.portBase).", retryable: true)))
        }
        reserved.insert(port)
        log(root, "Assigned free port \(port) (binding \(RuntimeNet.previewHost)).")
        if framework == "static" && command.isEmpty { return startSite(frame, root: root, key: key, port: port) }

        let forced = "http://\(RuntimeNet.previewHost):\(port)"
        var environment = options.environment
        for (name, value) in [("FORCE_COLOR", "0"), ("BROWSER", "none"), ("PORT", String(port)), ("HOST", RuntimeNet.previewHost),
                              ("HOSTNAME", RuntimeNet.previewHost)] { environment[name] = value }
        let lines = OutputLines()
        // The owner lives as long as the service; these closures end with their group.
        let readiness = Readiness { readiness, outcome in
            self.queue.async { self.settled(frame, key: key, readiness: readiness, outcome) }
        }
        let process: ManagedProcess
        do {
            // The command is the detected literal or the user's own; never project file content.
            process = try ManagedProcess.launch(ProcessLaunch(executable: "/bin/sh", arguments: ["-c", RuntimeDetect.withPort(command, framework: framework, port: port)],
                                                              directory: root, environment: environment, watchdog: options.watchdog),
                onOutput: { chunk in self.output(chunk, lines, root: root, readiness: readiness, forced: forced) },
                onExit: { process, status in
                    self.options.journal?.remove(process.pid)
                    let code = ProcessGroup.exitCode(status)
                    let failure = RuntimeDetect.interpretFailure(code: code, tail: lines.tail)
                    readiness.settle(.failed(failure.conflict ? .conflict : .unavailable, failure.message))
                    let reason = "The dev server exited (code \(code.map(String.init) ?? "null")).\n\(RuntimeDetect.last(lines.tail, 600).string)"
                    self.queue.async { self.ended(process, key: key, port: port, reason: reason) }
                })
        } catch {
            reserved.remove(port)
            return answer(frame, .failed(Self.fail(.unavailable, "Failed to start dev server: \(error)")))
        }
        if let identity = process.identity { options.journal?.add(identity) }
        servers[key] = RuntimeServer(root: root, key: key, port: port, kind: .process(process), readiness: readiness)
        let probe = options.probe
        work.async {
            if RuntimeNet.waitForReachable([forced], settled: { readiness.settled }, probe: probe) != nil {
                readiness.settle(.ready(url: forced, note: "Serving at \(forced)."))
            }
        }
        queue.asyncAfter(deadline: .now() + options.readyTimeout) {
            let tail = RuntimeDetect.last(lines.tail, 600).string
            // Stops THIS group: a restart may already have replaced the project's server.
            readiness.settle(.failedAfterStop(.deadlineExceeded, "Timed out waiting for a localhost URL.\n\(tail)", process))
        }
    }

    private func output(_ chunk: Data, _ lines: OutputLines, root: String, readiness: Readiness, forced: String) {
        let (complete, partial) = lines.append(chunk)
        for line in complete { if let text = OutputLines.loggable(line) { log(root, text) } }
        // Fallback: a framework that ignored our port printed its own URL.
        guard !readiness.settled, let raw = (complete + [partial]).lazy.compactMap(RuntimeNet.firstURL).first, lines.claimURL() else { return }
        let probe = options.probe
        work.async {
            if let url = RuntimeNet.waitForReachable(RuntimeNet.hostVariants(RuntimeNet.normalizeURL(raw)), settled: { readiness.settled }, probe: probe) {
                readiness.settle(.ready(url: url, note: url != forced ? "Serving at \(url)." : nil))
            }
        }
    }

    private func settled(_ frame: PipeFrame, key: String, readiness: Readiness, _ outcome: Readiness.Outcome) {
        switch outcome {
        case let .ready(url, note):
            guard let server = servers[key], server.readiness === readiness, case .process(let process) = server.kind else {
                return answer(frame, .failed(Self.fail(.cancelled, Self.cancelled)))
            }
            let running = RuntimeServer.running(url: url, pid: process.pid)
            server.info = running
            if let note { log(server.root, note) }
            answer(frame, .succeeded(running))
            watch(process, key: key, url: url, misses: 0)
        case let .failed(code, message):
            answer(frame, .failed(Self.fail(code, message, retryable: code == .conflict || code == .deadlineExceeded)))
        case let .failedAfterStop(code, message, process):
            if let server = servers[key], case .process(let current) = server.kind, current === process { servers.removeValue(forKey: key) }
            work.async {
                process.stop(grace: self.options.stopGrace)
                self.answer(frame, .failed(Self.fail(code, message, retryable: true)))
            }
        }
    }

    /// Probes the ready server while it is still the project's; enough misses in a row
    /// stop its group, and its exit carries the reason.
    private func watch(_ process: ManagedProcess, key: String, url: String, misses: Int) {
        queue.asyncAfter(deadline: .now() + options.healthInterval) {
            guard !self.closed, let server = self.servers[key], case .process(let current) = server.kind, current === process else { return }
            let probe = self.options.healthProbe
            self.work.async {
                let answered = probe(url) != nil
                self.queue.async {
                    guard let server = self.servers[key], case .process(let current) = server.kind, current === process else { return }
                    let missed = answered ? 0 : misses + 1
                    guard missed >= self.options.healthFailures else { return self.watch(process, key: key, url: url, misses: missed) }
                    self.unresponsive.insert(ObjectIdentifier(process))
                    self.log(server.root, "The dev server stopped responding at \(url); stopping it.")
                    self.work.async { process.stop(grace: self.options.stopGrace) }
                }
            }
        }
    }

    /// A group ended (by itself or stopped): release its port; if it was the ready
    /// server, tell Bun why, so the preview evidence forgets its URL and the preview
    /// restarts it.
    private func ended(_ process: ManagedProcess, key: String, port: Int, reason: String) {
        reserved.remove(port)
        let hung = unresponsive.remove(ObjectIdentifier(process)) != nil
        guard let server = servers[key], case .process(let current) = server.kind, current === process else { return }
        servers.removeValue(forKey: key)
        guard let url = server.url else { return }
        event("exit", [("root", .string(JSText(server.root))), ("url", .string(JSText(url))),
                       ("reason", .string(JSText(hung ? "The dev server stopped responding." : reason)))])
    }

    private func startSite(_ frame: PipeFrame, root: String, key: String, port: Int) {
        let site = StaticSite(root: root, stamp: { html, path in self.stamp(html, path) }, log: { line in self.log(root, line) })
        let server: StaticServer
        do { server = try StaticServer.listen(site: site, host: RuntimeNet.previewHost, port: port) } catch {
            reserved.remove(port)
            return answer(frame, .failed(Self.fail(.unavailable, "Failed to start static server: \(error)", retryable: true)))
        }
        let url = "http://\(RuntimeNet.previewHost):\(port)"
        let entry = RuntimeServer(root: root, key: key, port: port, kind: .site(server), readiness: nil)
        entry.info = RuntimeServer.running(url: url, pid: getpid())
        servers[key] = entry
        log(root, "Static server serving \(root) at \(url).")
        answer(frame, .succeeded(entry.info!))
    }

    // MARK: Stop

    /// Off the owner queue: stops the group (or site) and returns its port.
    private func retire(_ server: RuntimeServer) {
        server.shutdown(grace: options.stopGrace)
        queue.async {
            self.retiring.removeValue(forKey: ObjectIdentifier(server))
            if case .site = server.kind { self.reserved.remove(server.port) }
        }
    }

    private func stop(_ frame: PipeFrame, root: String) {
        let key = Self.key(root)
        _ = bump(key)
        let server = servers.removeValue(forKey: key)
        server?.readiness?.settle(.failed(.cancelled, Self.cancelled))
        if let server { retiring[ObjectIdentifier(server)] = server }
        // An install is not interrupted by a stop (a half-written node_modules helps no
        // one); Bun discards a start whose install outlived it. Quit stops installs.
        work.async {
            if let server { self.retire(server) }
            self.answer(frame, .succeeded(.object([(JSText("stopped"), .bool(server != nil))])))
        }
    }

    /// Every server and install, in parallel; `done` runs once all are gone.
    private func stopEverything(_ done: @escaping @Sendable () -> Void) {
        for key in Set(servers.keys).union(installs.keys) { _ = bump(key) }
        // Servers already retiring are stopped again: a repeated stop joins the first.
        let all = Array(servers.values) + Array(retiring.values), running = Array(installs.values)
        servers.removeAll()
        for install in running { cancelledInstalls.insert(ObjectIdentifier(install)) }
        for server in all { server.readiness?.settle(.failed(.cancelled, Self.cancelled)) }
        work.async {
            DispatchQueue.concurrentPerform(iterations: all.count + running.count) { index in
                if index < all.count { self.retire(all[index]) } else { running[index - all.count].stop(grace: self.options.stopGrace) }
            }
            done()
        }
    }

    /// Service shutdown: refuse new requests, stop every owned group and site, and
    /// wait (bounded) before the profile lock is released, so a legacy relaunch can
    /// never overlap a server this owner started.
    @discardableResult
    func close(timeout: TimeInterval) -> Bool {
        let finished = DispatchSemaphore(value: 0)
        queue.async {
            self.closed = true
            self.stopEverything { finished.signal() }
        }
        let drained = finished.wait(timeout: .now() + timeout) == .success
        helperLock.lock()
        helpersOpen = false
        for (_, entry) in helpers { entry.0.signal() }
        helperLock.unlock()
        return drained
    }

    // MARK: Install

    private func install(_ frame: PipeFrame, root: String) {
        let key = Self.key(root)
        guard installs[key] == nil else {
            return answer(frame, .failed(Self.fail(.busy, "Project dependencies are already being installed.", retryable: true)))
        }
        guard RuntimeDetect.exists(root + "/package.json") else { return answer(frame, .succeeded(.object([(JSText("installed"), .bool(false))]))) }
        let manager = RuntimeDetect.packageManager(root: root)
        log(root, "Installing project dependencies with \(manager)…")
        let lines = OutputLines()
        let failure = "Could not install project dependencies with \(manager)"
        let process: ManagedProcess
        do {
            process = try ManagedProcess.launch(ProcessLaunch(executable: manager, arguments: ["install"], directory: root,
                                                              environment: options.environment, watchdog: options.watchdog),
                onOutput: { chunk in
                    for line in lines.append(chunk).lines { if let text = OutputLines.loggable(line) { self.log(root, text) } }
                },
                onExit: { process, status in
                    self.options.journal?.remove(process.pid)
                    self.queue.async {
                        if self.installs[key] === process { self.installs.removeValue(forKey: key) }
                        let tail = RuntimeDetect.last(lines.tail, 600).string, identity = ObjectIdentifier(process)
                        let cancelled = self.cancelledInstalls.remove(identity) != nil, timedOut = self.timedOutInstalls.remove(identity) != nil
                        let code = ProcessGroup.exitCode(status)
                        if cancelled {
                            self.answer(frame, .failed(Self.fail(.cancelled, "Installing project dependencies was cancelled.")))
                        } else if timedOut {
                            self.answer(frame, .failed(Self.fail(.deadlineExceeded, "\(failure): it did not finish within \(Int(self.options.installTimeout)) seconds and was stopped.\n\(tail)", retryable: true)))
                        } else if code == 0 {
                            self.answer(frame, .succeeded(.object([(JSText("installed"), .bool(true))])))
                        } else {
                            let how = code.map { "exited with code \($0)" } ?? "was stopped by a signal"
                            self.answer(frame, .failed(Self.fail(.unavailable, "\(failure): `\(manager) install` \(how).\n\(tail)")))
                        }
                    }
                })
        } catch {
            return answer(frame, .failed(Self.fail(.unavailable, "\(failure): \(error).")))
        }
        if let identity = process.identity { options.journal?.add(identity) }
        installs[key] = process
        queue.asyncAfter(deadline: .now() + options.installTimeout) {
            guard self.installs[key] === process else { return }
            self.timedOutInstalls.insert(ObjectIdentifier(process))
            self.work.async { process.stop(grace: self.options.stopGrace) }
        }
    }

    // MARK: Stamping helper (JS, in Bun)

    /// Stamped HTML from Bun, or the input unchanged (too large, no answer in time,
    /// the service stopping). Called on a connection thread.
    func stamp(_ html: String, _ path: String) -> String {
        guard html.utf8.count <= Self.maxStampBytes else { return html }
        helperLock.lock()
        guard helpersOpen else { helperLock.unlock(); return html }
        helperSequence += 1
        let id = helperSequence, signal = DispatchSemaphore(value: 0)
        helpers[id] = (signal, nil)
        helperLock.unlock()
        event("stamp", [("id", .number(Double(id))), ("path", .string(JSText(path))), ("html", .string(JSText(html)))])
        _ = signal.wait(timeout: .now() + options.stampTimeout)
        helperLock.lock()
        let result = helpers.removeValue(forKey: id)?.1
        helperLock.unlock()
        return result ?? html
    }

    /// `{"service":"runtime-helper","id":n,"html":string|null}`; null means "serve it unstamped".
    private func helperReply(_ line: Data) {
        guard let value = try? JSValue.parse(line, maxDepth: 4), case .object(let fields) = value, fields.count == 3,
              case .number(let number)? = value["id"], let id = Int(exactly: number) else { return }
        helperLock.lock()
        if let entry = helpers[id] {
            helpers[id] = (entry.0, value["html"]?.text?.string)
            entry.0.signal()
        }
        helperLock.unlock()
    }

    // MARK: Frames

    private func log(_ root: String, _ line: String) { event("log", [("root", .string(JSText(root))), ("line", .string(JSText(line)))]) }

    private func event(_ kind: String, _ fields: [(String, JSValue)]) {
        let head: [(JSText, JSValue)] = [(JSText("event"), .string(JSText("service-event"))), (JSText("service"), .string(JSText(Self.service))),
                                        (JSText("kind"), .string(JSText(kind)))]
        send(JSValue.object(head + fields.map { (JSText($0.0), $0.1) }).utf8())
    }

    private func answer(_ frame: PipeFrame, _ result: PreferencesOwner.Answer) { send(Self.reply(id: frame.id, frame: frame, result: result)) }

    static let stopping = fail(.unavailable, "The service is stopping; the project server was not started.", retryable: true)

    static func key(_ root: String) -> String { WorkspaceDocument.projectKey(JSText(root)).string }

    /// Exactly these body fields (plus `optional`), each a string.
    /// The only fields that are booleans rather than text.
    static let flags: Set<String> = ["cleanCache"]
    static func fields(_ frame: PipeFrame, _ required: Set<String>, optional: Set<String> = []) throws -> [String: JSValue] {
        var fields: [String: JSValue] = [:]
        for (name, value) in frame.body {
            let key = name.string
            guard required.union(optional).contains(key), fields[key] == nil,
                  value.text != nil || Self.flags.contains(key) && (value == .bool(true) || value == .bool(false)) else { throw ServiceContractFailure.invalidRequest }
            fields[key] = value
        }
        guard required.isSubset(of: Set(fields.keys)) else { throw ServiceContractFailure.invalidRequest }
        return fields
    }

    /// An absolute root of at most 4,096 UTF-16 units, without NUL or lone surrogates.
    static func root(_ fields: [String: JSValue]) throws -> String {
        guard let text = fields["root"]?.text, text.hasPrefix("/"), text.count <= 4096, !text.contains(0),
              JSText(text.string) == text else { throw ServiceContractFailure.invalidRequest }
        return text.string
    }

    static func fail(_ code: ServiceContractFailure, _ message: String, retryable: Bool = false) -> ServiceFailure {
        PreferencesOwner.fail(code, message, retryable: retryable)
    }

    static func reply(id: JSValue, frame: PipeFrame?, result: PreferencesOwner.Answer) -> Data {
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
        return JSValue.object([(JSText("event"), .string(JSText("service-reply"))), (JSText("service"), .string(JSText(service))),
                               (JSText("id"), id), (JSText("reply"), .object(reply))]).utf8()
    }
}
