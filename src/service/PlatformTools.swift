import Foundation
import Darwin

/// A refusal the platform owner answers with (code + the user-facing message).
struct PlatformRefusal: Error, CustomStringConvertible {
    let code: ServiceContractFailure
    let message: String
    init(_ code: ServiceContractFailure, _ message: String) { self.code = code; self.message = message }
    var description: String { message }
}

/// The processes one piece of work started (a simulator start, a bridge's captures).
/// `cancel()` signals every running group and refuses new runs, so a Stop reaches a
/// boot or build that is still waiting on `xcrun`. A group is signalled only while
/// its leader is unreaped (the runner unregisters it under this lock before reaping),
/// so a reused pid is never signalled.
final class ToolScope: @unchecked Sendable {
    private let lock = NSLock()
    private var running = Set<pid_t>()
    private var stopped = false

    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return stopped }

    func cancel() {
        lock.lock()
        stopped = true
        for pid in running { kill(-pid, SIGTERM) }
        lock.unlock()
    }

    /// False when the scope was already cancelled (the caller stops the group itself).
    fileprivate func register(_ pid: pid_t) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !stopped else { return false }
        running.insert(pid)
        return true
    }

    fileprivate func unregister(_ pid: pid_t) { lock.lock(); running.remove(pid); lock.unlock() }
}

struct ToolResult {
    let status: Int32?
    let stdout: Data
    let stderr: Data
    let timedOut: Bool
    let cancelled: Bool
    var ok: Bool { status == 0 && !timedOut && !cancelled }
    var output: String { String(decoding: stdout, as: UTF8.self) }
    var errors: String { String(decoding: stderr, as: UTF8.self) }
}

/// A short-lived platform tool (`xcrun`, `idb`, `lsof`, `ps`, `pkill`): its own process
/// group, stdin from /dev/null, stdout and stderr captured separately (bounded), a
/// deadline after which the whole group is stopped (TERM, then KILL a second later),
/// and cancellation through a `ToolScope`. When the leader exits, anything it left in
/// its group is stopped before it is reaped. Nothing is run through a shell.
enum PlatformTool {
    static let maxOutput = 32 * 1024 * 1024

    /// `input`, when given, is the tool's whole stdin (written from another thread, then
    /// closed); otherwise stdin is /dev/null. Secrets travel this way, never in argv.
    static func run(_ executable: String, _ arguments: [String], environment: [String: String], directory: String? = nil,
                    timeout: TimeInterval, scope: ToolScope? = nil, input: Data? = nil) throws -> ToolResult {
        guard let path = ManagedProcess.resolve(executable, path: environment["PATH"]) else {
            throw PlatformRefusal(.unavailable, "spawn \(executable) ENOENT")
        }
        if scope?.isCancelled == true { return ToolResult(status: nil, stdout: Data(), stderr: Data(), timedOut: false, cancelled: true) }
        var out: [Int32] = [0, 0], err: [Int32] = [0, 0], inPipe: [Int32] = [-1, -1]
        guard pipe(&out) == 0 else { throw PlatformRefusal(.ioFailure, "output pipe: \(String(cString: strerror(errno)))") }
        guard pipe(&err) == 0 else {
            close(out[0]); close(out[1])
            throw PlatformRefusal(.ioFailure, "error pipe: \(String(cString: strerror(errno)))")
        }
        if input != nil {
            guard pipe(&inPipe) == 0 else {
                for fd in out + err { close(fd) }
                throw PlatformRefusal(.ioFailure, "input pipe: \(String(cString: strerror(errno)))")
            }
            _ = fcntl(inPipe[1], F_SETFD, FD_CLOEXEC)
        }
        let outWrite = fcntl(out[1], F_DUPFD_CLOEXEC, 20), errWrite = fcntl(err[1], F_DUPFD_CLOEXEC, 20)
        let inRead = input == nil ? -1 : fcntl(inPipe[0], F_DUPFD_CLOEXEC, 20)
        close(out[1]); close(err[1])
        if input != nil { close(inPipe[0]) }
        for fd in [out[0], err[0]] { _ = fcntl(fd, F_SETFD, FD_CLOEXEC); _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK) }
        let pid: pid_t
        do {
            pid = try ManagedProcess.spawn(path, [executable] + arguments, environment: environment, directory: directory,
                                           actions: [input == nil ? .null(0) : .dup(inRead, 0), .dup(outWrite, 1), .dup(errWrite, 2)], newGroup: true)
        } catch {
            close(outWrite); close(errWrite); close(out[0]); close(err[0])
            if input != nil { close(inRead); close(inPipe[1]) }
            throw PlatformRefusal(.unavailable, "spawn \(executable): \(error)")
        }
        close(outWrite); close(errWrite)
        if let input {
            close(inRead)
            let fd = inPipe[1]
            // A tool that exits without reading gets EPIPE here (SIGPIPE is ignored by the service).
            Thread.detachNewThread {
                input.withUnsafeBytes { raw in
                    var offset = 0
                    while offset < raw.count {
                        let wrote = write(fd, raw.baseAddress! + offset, raw.count - offset)
                        if wrote < 0 { if errno == EINTR { continue }; break }
                        offset += wrote
                    }
                }
                close(fd)
            }
        }
        let registered = scope?.register(pid) ?? true
        if !registered { kill(-pid, SIGTERM) }

        let exited = DispatchSemaphore(value: 0)
        let box = StatusBox()
        Thread.detachNewThread {
            var info = siginfo_t()
            // Observe the exit without reaping: the zombie keeps the pgid reserved.
            while waitid(P_PID, id_t(pid), &info, WEXITED | WNOWAIT) != 0 && errno == EINTR {}
            scope?.unregister(pid)
            ProcessGroup.terminate(pid, grace: 0.2)
            var raw: Int32 = 0
            while waitpid(pid, &raw, 0) < 0 && errno == EINTR {}
            box.set(raw)
            exited.signal()
        }

        var captured = [Data(), Data()]
        var open = [true, true]
        let fds = [out[0], err[0]]
        let deadline = Date().addingTimeInterval(timeout)
        var timedOut = false, cancelled = !registered
        var terminatedAt: Date? = registered ? nil : Date()
        var exitedAt: Date?
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while open.contains(true) {
            if exitedAt == nil, box.value != nil { exitedAt = Date() }
            // A descendant that escaped the group may hold a pipe open: stop reading 1 s after exit.
            if let exitedAt, Date().timeIntervalSince(exitedAt) > 1 { break }
            if terminatedAt == nil, box.value == nil {
                if Date() >= deadline { timedOut = true; terminatedAt = Date(); kill(-pid, SIGTERM) }
                else if scope?.isCancelled == true { cancelled = true; terminatedAt = Date() }
            }
            if let terminatedAt, box.value == nil, Date().timeIntervalSince(terminatedAt) > 1 { kill(-pid, SIGKILL) }
            var polls = (0..<2).filter { open[$0] }.map { pollfd(fd: fds[$0], events: Int16(POLLIN), revents: 0) }
            let ready = poll(&polls, nfds_t(polls.count), 100)
            if ready < 0 && errno != EINTR { break }
            guard ready > 0 else { continue }
            for entry in polls where entry.revents != 0 {
                let index = entry.fd == fds[0] ? 0 : 1
                let count = read(entry.fd, &buffer, buffer.count)
                if count < 0 && (errno == EINTR || errno == EAGAIN) { continue }
                if count <= 0 { open[index] = false; continue }
                if captured[index].count < maxOutput { captured[index].append(contentsOf: buffer[..<min(count, maxOutput - captured[index].count)]) }
            }
        }
        close(out[0]); close(err[0])
        // The leader ends (a signal was sent on deadline or cancellation); reaping follows.
        while exited.wait(timeout: .now() + 1) == .timedOut { kill(-pid, SIGKILL) }
        let raw = box.value ?? 0
        return ToolResult(status: ProcessGroup.exitCode(raw), stdout: captured[0], stderr: captured[1],
                          timedOut: timedOut, cancelled: cancelled || (scope?.isCancelled == true && ProcessGroup.exitCode(raw) != 0))
    }

    /// Node's `execFile` rejection message: "Command failed: <cmd>\n<stderr>".
    static func failure(_ command: [String], _ result: ToolResult) -> String {
        if result.cancelled { return "Command was cancelled: \(command.joined(separator: " "))" }
        if result.timedOut { return "Command timed out: \(command.joined(separator: " "))" }
        return "Command failed: \(command.joined(separator: " "))\n\(result.errors)"
    }

    private final class StatusBox: @unchecked Sendable {
        private let lock = NSLock()
        private var raw: Int32?
        var value: Int32? { lock.lock(); defer { lock.unlock() }; return raw }
        func set(_ value: Int32) { lock.lock(); raw = value; lock.unlock() }
    }
}

/// The "Running servers" recovery sheet's inspection and stop: TCP listeners of this user whose working
/// directory is the project folder. A server is identified by pid, kernel start time,
/// command, folder and addresses, re-checked immediately before it is signalled; only
/// SIGTERM is sent (the user is told to stop it themselves if it does not exit), and
/// the service, its parent and supervised Bun are never listed.
enum PreviewServers {
    struct Tools {
        var lsof = "/usr/sbin/lsof"
        var ps = "/bin/ps"
        var environment: [String: String] = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
    }

    static func parseListeners(_ raw: String) -> [(pid_t, [String])] {
        var order: [pid_t] = [], addresses: [pid_t: [String]] = [:]
        var pid: pid_t = 0
        for line in raw.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("p") {
                pid = pid_t(line.dropFirst()) ?? 0
                if pid > 1, addresses[pid] == nil { order.append(pid); addresses[pid] = [] }
            }
            if line.hasPrefix("n"), addresses[pid] != nil { addresses[pid]!.append(String(line.dropFirst())) }
        }
        return order.map { ($0, addresses[$0]!) }
    }

    private static func output(_ tools: Tools, _ executable: String, _ arguments: [String]) throws -> String {
        let result = try PlatformTool.run(executable, arguments, environment: tools.environment, timeout: 8)
        // lsof and ps exit 1 when nothing matches.
        if result.status == 1 && result.errors.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "" }
        guard result.ok else {
            let reason = result.errors.isEmpty ? PlatformTool.failure([executable] + arguments, result) : result.errors
            throw PlatformRefusal(.unavailable, "Could not inspect running servers: \(reason)")
        }
        return result.output
    }

    /// The kernel start time (microseconds) and the working directory of a process.
    static func facts(_ pid: pid_t) -> (started: UInt64, cwd: String)? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size, info.pbi_uid == getuid() else { return nil }
        var paths = proc_vnodepathinfo()
        let pathSize = Int32(MemoryLayout<proc_vnodepathinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &paths, pathSize) == pathSize else { return nil }
        let cwd = withUnsafeBytes(of: paths.pvi_cdir.vip_path) { raw in String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self) }
        return (UInt64(info.pbi_start_tvsec) * 1_000_000 + UInt64(info.pbi_start_tvusec), cwd)
    }

    static func startedText(_ micros: UInt64) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "EEE MMM d HH:mm:ss yyyy"
        return formatter.string(from: Date(timeIntervalSince1970: TimeInterval(micros / 1_000_000)))
    }

    static func inspect(_ root: String, _ pid: pid_t, tools: Tools, protected: Set<pid_t>) throws -> JSValue? {
        guard pid > 1, !protected.contains(pid) else { return nil }
        let uid = String(getuid())
        guard let addresses = parseListeners(try output(tools, tools.lsof, ["-nP", "-a", "-u", uid, "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fpn"]))
            .first(where: { $0.0 == pid })?.1, !addresses.isEmpty else { return nil }
        guard let facts = facts(pid), StaticSite.realPath(facts.cwd) == root else { return nil }
        let command = try output(tools, tools.ps, ["-p", String(pid), "-o", "command="]).trimmingCharacters(in: .whitespacesAndNewlines)
        // Identity is re-read after the command: a pid reused in between is refused.
        guard !command.isEmpty, let again = Self.facts(pid), again.started == facts.started else { return nil }
        let sorted = Array(Set(addresses)).sorted()
        return .object([(JSText("pid"), .number(Double(pid))), (JSText("root"), .string(JSText(root))),
                        (JSText("command"), .string(JSText(command))), (JSText("started"), .string(JSText(startedText(facts.started)))),
                        (JSText("addresses"), .array(sorted.map { .string(JSText($0)) })),
                        (JSText("identity"), .string(JSText("\(pid):\(facts.started)")))])
    }

    static func find(_ root: String, tools: Tools, protected: Set<pid_t>) throws -> [JSValue] {
        guard let canonical = StaticSite.realPath(root) else { throw PlatformRefusal(.notFound, "The project folder is not available.") }
        let listeners = parseListeners(try output(tools, tools.lsof, ["-nP", "-a", "-u", String(getuid()), "-iTCP", "-sTCP:LISTEN", "-Fpn"]))
        return try listeners.compactMap { try inspect(canonical, $0.0, tools: tools, protected: protected) }
    }

    static let changed = "This server changed or exited. Refresh the server list before trying again."

    /// SIGTERM only, after re-checking every identity field; waits up to 6 s.
    static func stop(_ server: JSValue, tools: Tools, protected: Set<pid_t>, sleep: (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) }) throws {
        guard case .number(let number)? = server["pid"], let pid = pid_t(exactly: number), let root = server["root"]?.text?.string else {
            throw PlatformRefusal(.invalidRequest, "Invalid server.")
        }
        guard let current = try inspect(root, pid, tools: tools, protected: protected),
              ["pid", "root", "command", "started", "addresses", "identity"].allSatisfy({ current[$0] == server[$0] }) else {
            throw PlatformRefusal(.conflict, changed)
        }
        guard kill(pid, SIGTERM) == 0 else { throw PlatformRefusal(.conflict, changed) }
        for _ in 0..<30 {
            sleep(0.2)
            if try inspect(root, pid, tools: tools, protected: protected) == nil { return }
        }
        throw PlatformRefusal(.unavailable, "The server did not stop. Review Activity or stop it in its terminal, then retry. Trezi did not force-kill it.")
    }
}
