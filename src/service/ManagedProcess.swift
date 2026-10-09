import Foundation
import Darwin

/// A launched group's leader and its kernel start time (microseconds). A pid is
/// only ever treated as ours while both match, so a reused pid is never signalled.
struct GroupIdentity: Equatable, Sendable {
    let pgid: pid_t
    let started: UInt64

    static func of(_ pid: pid_t) -> GroupIdentity? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard pid > 1, proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        return GroupIdentity(pgid: pid, started: UInt64(info.pbi_start_tvsec) * 1_000_000 + UInt64(info.pbi_start_tvusec))
    }
}

enum ProcessGroup {
    /// Whether a live member remains. A group holding only its unreaped leader
    /// answers EPERM on macOS, which counts as empty.
    static func alive(_ pgid: pid_t) -> Bool { pgid > 1 && kill(-pgid, 0) == 0 }

    /// TERM, a bounded grace while any member remains, then KILL. Repeated and
    /// concurrent callers are harmless: each returns once the group is empty or killed.
    static func terminate(_ pgid: pid_t, grace: TimeInterval) {
        guard pgid > 1 else { return }
        kill(-pgid, SIGTERM)
        let deadline = Date().addingTimeInterval(grace)
        while Date() < deadline && alive(pgid) { usleep(10_000) }
        kill(-pgid, SIGKILL)
        // Give the kernel time to release listeners after a forced stop (bounded).
        let settle = Date().addingTimeInterval(0.5)
        while Date() < settle && alive(pgid) { usleep(10_000) }
    }

    /// The exit code, or nil when a signal ended it (Node's `code: null`).
    static func exitCode(_ status: Int32) -> Int32? { status & 0x7f == 0 ? (status >> 8) & 0xff : nil }
}

struct ProcessLaunch {
    /// A bare name is looked up on `environment["PATH"]`, as Node's spawn does.
    var executable: String
    var arguments: [String]
    var directory: String
    var environment: [String: String]
    /// The service executable, run as `--watch-group <pgid>`. Nil only in fixtures
    /// that exercise crash recovery through the journal alone.
    var watchdog: String?
}

enum ManagedProcessError: Error, CustomStringConvertible {
    case notFound(String), spawn(String, Int32)
    var description: String {
        switch self {
        case .notFound(let name): return "\(name) was not found on PATH"
        case let .spawn(what, code): return "\(what): \(String(cString: strerror(code)))"
        }
    }
}

/// One project process group owned by the Swift service (S06): `executable` is the
/// group leader in a new process group, stdin is /dev/null, stdout and stderr share
/// one pipe, and no other descriptor is inherited. A watchdog holding the read end of
/// a lifetime pipe stops the group if the service dies. When the leader exits, the
/// rest of its group is stopped before the leader is reaped, so descendants never
/// outlive it and the pgid cannot be reused while anything could still signal it.
final class ManagedProcess: @unchecked Sendable {
    let pid: pid_t
    let identity: GroupIdentity?
    private let condition = NSCondition()
    private var status: Int32?
    private var stopRequested = false

    private init(pid: pid_t) { self.pid = pid; identity = GroupIdentity.of(pid) }

    /// `onOutput` receives stdout/stderr bytes as they arrive; `onExit` the wait
    /// status once the group is empty and the leader reaped. `grace` bounds the TERM
    /// period for descendants left behind by a leader that exited on its own.
    static func launch(_ spec: ProcessLaunch, grace: TimeInterval = 0.5,
                       onOutput: @escaping @Sendable (Data) -> Void,
                       onExit: @escaping @Sendable (ManagedProcess, Int32) -> Void) throws -> ManagedProcess {
        guard let executable = resolve(spec.executable, path: spec.environment["PATH"]) else {
            throw ManagedProcessError.notFound(spec.executable)
        }
        var output: [Int32] = [0, 0]
        guard pipe(&output) == 0 else { throw ManagedProcessError.spawn("output pipe", errno) }
        let writeEnd = fcntl(output[1], F_DUPFD_CLOEXEC, 20)
        close(output[1])
        _ = fcntl(output[0], F_SETFD, FD_CLOEXEC)
        let pid: pid_t
        do {
            pid = try spawn(executable, [spec.executable] + spec.arguments, environment: spec.environment,
                            directory: spec.directory, actions: [.null(0), .dup(writeEnd, 1), .dup(writeEnd, 2)], newGroup: true)
        } catch { close(writeEnd); close(output[0]); throw error }
        close(writeEnd)
        let process = ManagedProcess(pid: pid)
        var watchdog: pid_t = 0, lifetimeWriter: Int32 = -1
        if let service = spec.watchdog {
            var lifetime: [Int32] = [0, 0]
            do {
                guard pipe(&lifetime) == 0 else { throw ManagedProcessError.spawn("lifetime pipe", errno) }
                lifetimeWriter = lifetime[1]
                _ = fcntl(lifetimeWriter, F_SETFD, FD_CLOEXEC)
                let readEnd = fcntl(lifetime[0], F_DUPFD_CLOEXEC, 20)
                close(lifetime[0])
                defer { close(readEnd) }
                watchdog = try spawn(service, [service, "--watch-group", String(pid)], environment: [:], directory: nil,
                                     actions: [.null(0), .null(1), .inherit(2), .dup(readEnd, 3)], newGroup: true)
            } catch {
                // Never leave a group running that nothing would stop on a crash.
                if lifetimeWriter >= 0 { close(lifetimeWriter) }
                ProcessGroup.terminate(pid, grace: 0)
                var raw: Int32 = 0
                while waitpid(pid, &raw, 0) < 0 && errno == EINTR {}
                close(output[0])
                throw error
            }
        }
        let reader = output[0], watchdogPID = watchdog, watchdogLifetime = lifetimeWriter
        let drained = DispatchSemaphore(value: 0)
        Thread.detachNewThread {
            var buffer = [UInt8](repeating: 0, count: 64 * 1024)
            while true {
                let count = read(reader, &buffer, buffer.count)
                if count < 0 && errno == EINTR { continue }
                if count <= 0 { break }
                onOutput(Data(buffer[..<count]))
            }
            close(reader)
            drained.signal()
        }
        Thread.detachNewThread { [process] in
            var info = siginfo_t()
            // Observe the exit without reaping: the zombie keeps the pgid reserved.
            while waitid(P_PID, id_t(pid), &info, WEXITED | WNOWAIT) != 0 && errno == EINTR {}
            ProcessGroup.terminate(pid, grace: grace)
            if watchdogPID > 0 {
                kill(watchdogPID, SIGKILL)
                var ignored: Int32 = 0
                while waitpid(watchdogPID, &ignored, 0) < 0 && errno == EINTR {}
            }
            if watchdogLifetime >= 0 { close(watchdogLifetime) }
            var raw: Int32 = 0
            while waitpid(pid, &raw, 0) < 0 && errno == EINTR {}
            // The group is gone, so its last output (an error message) arrives at once;
            // `onExit` reads the tail. Bounded for a writer that left the group.
            _ = drained.wait(timeout: .now() + 0.5)
            // Before waiters wake: whoever stopped it sees the owner's bookkeeping done.
            onExit(process, raw)
            process.condition.lock()
            process.status = raw
            process.condition.broadcast()
            process.condition.unlock()
        }
        return process
    }

    /// Stops the whole group (TERM, `grace`, KILL) and waits until the leader is
    /// reaped. Repeated and concurrent calls join the first; after exit it is a no-op.
    func stop(grace: TimeInterval) {
        condition.lock()
        let first = !stopRequested && status == nil
        stopRequested = true
        condition.unlock()
        if first { ProcessGroup.terminate(pid, grace: grace) }
        _ = wait(timeout: grace + 3)
    }

    /// The wait status once reaped, or nil if still running after `timeout`.
    func wait(timeout: TimeInterval) -> Int32? {
        condition.lock()
        defer { condition.unlock() }
        let deadline = Date().addingTimeInterval(timeout)
        while status == nil && condition.wait(until: deadline) {}
        return status
    }

    var exited: Bool { condition.lock(); defer { condition.unlock() }; return status != nil }

    // MARK: Spawning

    enum Action { case null(Int32), dup(Int32, Int32), inherit(Int32) }

    static func resolve(_ name: String, path: String?) -> String? {
        if name.contains("/") { return access(name, X_OK) == 0 ? name : nil }
        for directory in (path ?? "/usr/bin:/bin").split(separator: ":", omittingEmptySubsequences: false) {
            let candidate = (directory.isEmpty ? "." : String(directory)) + "/" + name
            var info = stat()
            if stat(candidate, &info) == 0, info.st_mode & S_IFMT == S_IFREG, access(candidate, X_OK) == 0 { return candidate }
        }
        return nil
    }

    /// posix_spawn with an empty signal mask, default dispositions and
    /// POSIX_SPAWN_CLOEXEC_DEFAULT: only the descriptors named in `actions` survive.
    static func spawn(_ path: String, _ argv: [String], environment: [String: String], directory: String?,
                      actions list: [Action], newGroup: Bool) throws -> pid_t {
        var actions: posix_spawn_file_actions_t?
        var attributes: posix_spawnattr_t?
        guard posix_spawn_file_actions_init(&actions) == 0 else { throw ManagedProcessError.spawn("spawn actions", errno) }
        defer { posix_spawn_file_actions_destroy(&actions) }
        guard posix_spawnattr_init(&attributes) == 0 else { throw ManagedProcessError.spawn("spawn attributes", errno) }
        defer { posix_spawnattr_destroy(&attributes) }
        var results: [Int32] = []
        for action in list {
            switch action {
            case .null(let fd): results.append(posix_spawn_file_actions_addopen(&actions, fd, "/dev/null", fd == 0 ? O_RDONLY : O_WRONLY, 0))
            case let .dup(from, to): results.append(posix_spawn_file_actions_adddup2(&actions, from, to))
            case .inherit(let fd): results.append(posix_spawn_file_actions_addinherit_np(&actions, fd))
            }
        }
        if let directory { results.append(posix_spawn_file_actions_addchdir_np(&actions, directory)) }
        var mask = sigset_t(0), defaults = sigset_t(0)
        sigemptyset(&mask)
        sigemptyset(&defaults)
        for number in [SIGTERM, SIGINT, SIGHUP, SIGPIPE, SIGCHLD] { sigaddset(&defaults, number) }
        var flags = POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_CLOEXEC_DEFAULT
        if newGroup { flags |= POSIX_SPAWN_SETPGROUP; results.append(posix_spawnattr_setpgroup(&attributes, 0)) }
        results += [posix_spawnattr_setflags(&attributes, Int16(flags)), posix_spawnattr_setsigmask(&attributes, &mask),
                    posix_spawnattr_setsigdefault(&attributes, &defaults)]
        if let failure = results.first(where: { $0 != 0 }) { throw ManagedProcessError.spawn("configure spawn", failure) }
        let arguments = argv.map { strdup($0) } + [nil]
        let variables = environment.sorted { $0.key < $1.key }.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer { for value in arguments { free(value) }; for value in variables { free(value) } }
        var pid: pid_t = 0
        let result = arguments.withUnsafeBufferPointer { argvBuffer in
            variables.withUnsafeBufferPointer { envBuffer in
                posix_spawn(&pid, path, &actions, &attributes, UnsafeMutablePointer(mutating: argvBuffer.baseAddress!),
                            UnsafeMutablePointer(mutating: envBuffer.baseAddress!))
            }
        }
        guard result == 0 else { throw ManagedProcessError.spawn("launch \(argv.first ?? path)", result) }
        return pid
    }
}

/// `<profile>/service/runtime/processes.json`: the groups this service launched and
/// has not yet seen end. The watchdog is the first crash backstop; the journal is
/// the second (a killed watchdog, a crash between launch and watch). At the next
/// Swift (or legacy) launch every recorded group whose leader still has the recorded
/// start time, or whose leader is gone while members remain, is stopped. A recorded
/// pid now held by another process is left alone: nothing is adopted or signalled
/// on a guess.
final class RuntimeJournal: @unchecked Sendable {
    let path: String
    private let lock = NSLock()
    private var groups: [GroupIdentity] = []

    init(profile: String) { path = URL(fileURLWithPath: profile).appendingPathComponent("service/runtime/processes.json").path }

    func add(_ identity: GroupIdentity) { lock.lock(); groups.append(identity); persist(); lock.unlock() }
    func remove(_ pgid: pid_t) { lock.lock(); groups.removeAll { $0.pgid == pgid }; persist(); lock.unlock() }

    /// Stops groups a previous owner left behind, then empties the journal. With no
    /// journal it creates nothing.
    @discardableResult
    func sweep() -> [pid_t] {
        lock.lock(); defer { lock.unlock() }
        guard FileManager.default.fileExists(atPath: path) else { return [] }
        var stopped: [pid_t] = []
        for entry in Self.read(path) {
            if let current = GroupIdentity.of(entry.pgid) {
                guard current == entry else { continue } // pid reused by an unrelated process
            } else if !ProcessGroup.alive(entry.pgid) { continue }
            ProcessGroup.terminate(entry.pgid, grace: 0.5)
            stopped.append(entry.pgid)
        }
        groups = []
        persist()
        return stopped
    }

    static func read(_ path: String) -> [GroupIdentity] {
        guard let data = FileManager.default.contents(atPath: path),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = object["groups"] as? [[String: Any]] else { return [] }
        return list.compactMap { item in
            guard let pgid = (item["pgid"] as? NSNumber)?.int32Value, pgid > 1,
                  let started = (item["started"] as? String).flatMap(UInt64.init) else { return nil }
            return GroupIdentity(pgid: pgid, started: started)
        }
    }

    /// Best effort: a journal that cannot be written leaves the watchdog as the backstop.
    private func persist() {
        let body: [String: Any] = ["version": 1, "groups": groups.map { ["pgid": Int($0.pgid), "started": String($0.started)] }]
        guard let data = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]) else { return }
        let directory = (path as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        // Temp file beside it, then rename: readers see the old or the new journal.
        let temporary = path + ".tmp"
        let fd = open(temporary, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { return }
        let complete = data.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) == $0.count }
        close(fd)
        if !complete || rename(temporary, path) != 0 { unlink(temporary) }
    }
}
