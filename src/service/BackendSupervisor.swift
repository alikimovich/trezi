import Foundation
import Darwin

/// The service's exclusive profile lock (`service.lock`), plus the `native.lock` PID
/// reservation older Trezi builds honour. The file is never unlinked: replacing its
/// inode could admit a second profile owner.
final class ProfileExclusion {
    private let mutex = NSLock()
    private var descriptor: Int32 = -1
    private var legacyPath: String?

    init(profile: String) throws {
        try FileManager.default.createDirectory(atPath: profile, withIntermediateDirectories: true)
        let path = URL(fileURLWithPath: profile).appendingPathComponent("service.lock").path
        let fd = open(path, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw SupervisorError.system("open profile lock", errno) }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            let code = errno
            close(fd)
            throw SupervisorError.system("profile already owned", code)
        }
        // Pre-migration launches do not know service.lock. Respect their PID lock
        // and fail closed for malformed contents rather than deleting user files.
        let legacy = URL(fileURLWithPath: profile).appendingPathComponent("native.lock")
        if FileManager.default.fileExists(atPath: legacy.path) {
            let contents = try? String(contentsOf: legacy, encoding: .utf8)
            guard let text = contents?.trimmingCharacters(in: .whitespacesAndNewlines),
                  let pid = Int32(text), pid > 0,
                  kill(pid, 0) != 0, errno == ESRCH else {
                flock(fd, LOCK_UN)
                close(fd)
                throw SupervisorError.system("legacy profile already owned or lock invalid", EBUSY)
            }
            // Only an ESRCH owner may be removed. Atomic exclusive creation below
            // arbitrates against old launchers which do not honor service.lock.
            guard unlink(legacy.path) == 0 || errno == ENOENT else {
                let code = errno
                flock(fd, LOCK_UN)
                close(fd)
                throw SupervisorError.system("remove stale legacy lock", code)
            }
        }
        let legacyFD = open(legacy.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard legacyFD >= 0 else {
            let code = errno
            flock(fd, LOCK_UN)
            close(fd)
            throw SupervisorError.system("reserve legacy profile lock", code)
        }
        let owner = Array(String(getpid()).utf8)
        let written = owner.withUnsafeBytes { write(legacyFD, $0.baseAddress!, $0.count) }
        close(legacyFD)
        guard written == owner.count else {
            unlink(legacy.path)
            flock(fd, LOCK_UN)
            close(fd)
            throw SupervisorError.system("write legacy profile lock", EIO)
        }
        legacyPath = legacy.path
        descriptor = fd
    }

    var guardDescriptor: Int32 {
        mutex.lock()
        defer { mutex.unlock() }
        return descriptor
    }

    func release() {
        mutex.lock()
        defer { mutex.unlock() }
        guard descriptor >= 0 else { return }
        if let path = legacyPath,
           let owner = try? String(contentsOfFile: path, encoding: .utf8), owner == String(getpid()) {
            unlink(path)
        }
        legacyPath = nil
        // Guardian fd4 shares this open description. Explicit LOCK_UN would
        // release its lease too; close alone keeps exclusion until the last
        // guardian has drained its backend, including service crash recovery.
        close(descriptor)
        descriptor = -1
    }

    deinit { release() }
}

enum SupervisorError: Error, CustomStringConvertible {
    case system(String, Int32)
    var description: String {
        switch self {
        case let .system(operation, code): return "\(operation): \(String(cString: strerror(code)))"
        }
    }
}

extension FileHandle {
    /// Whatever the pipe holds now; empty at EOF. `read(upToCount:)` waits for the
    /// full count (or EOF) on a pipe, which would hold short bridge lines forever.
    func readAvailable(upTo limit: Int) throws -> Data {
        var buffer = [UInt8](repeating: 0, count: limit)
        while true {
            let count = Darwin.read(fileDescriptor, &buffer, limit)
            if count >= 0 { return Data(buffer[..<count]) }
            if errno != EINTR { throw SupervisorError.system("read pipe", errno) }
        }
    }
}

struct BackendChild {
    let pid: pid_t
    /// Parent writes to the child's stdin.
    let input: FileHandle
    /// Parent reads the child's stdout. Stderr inherits the launcher's stderr.
    let output: FileHandle
}

/// Owns one process group, including descendants which survive the direct child.
/// Call shutdown before releasing ProfileExclusion. Each instance may launch once.
final class BackendSupervisor {
    private let condition = NSCondition()
    private var child: BackendChild?
    private var reaped = false
    private var stopping = false
    private var stopped = false
    private var started = false
    private var lifetimeWriter: FileHandle?
    private var guarded = false

    func start(executable: String, arguments: [String], environment: [String: String],
               profileDescriptor: Int32? = nil, guardianExecutable: String? = nil,
               diagnostics: Int32? = nil, onExit: @escaping (Int32) -> Void) throws -> BackendChild {
        condition.lock()
        defer { condition.unlock() }
        guard !started && !stopping else { throw SupervisorError.system("supervisor already started or stopped", EALREADY) }
        let inheritedProfile: Int32
        if let profileDescriptor {
            // Duplicate above reserved stdio/lifetime slots before spawn actions
            // overwrite fd3/fd4. Only the guardian retains the resulting lease.
            inheritedProfile = fcntl(profileDescriptor, F_DUPFD_CLOEXEC, 20)
            guard inheritedProfile >= 0 else { throw SupervisorError.system("duplicate profile lease", errno) }
        } else { inheritedProfile = -1 }
        defer { if inheritedProfile >= 0 { close(inheritedProfile) } }
        // Same reason: a low caller descriptor could be overwritten before its dup2.
        let inheritedDiagnostics = diagnostics.map { fcntl($0, F_DUPFD_CLOEXEC, 20) } ?? -1
        if diagnostics != nil && inheritedDiagnostics < 0 { throw SupervisorError.system("duplicate diagnostics", errno) }
        defer { if inheritedDiagnostics >= 0 { close(inheritedDiagnostics) } }
        let input = Pipe()
        let output = Pipe()
        let lifetime = Pipe()
        let descriptors = [input.fileHandleForReading.fileDescriptor, input.fileHandleForWriting.fileDescriptor,
                           output.fileHandleForReading.fileDescriptor, output.fileHandleForWriting.fileDescriptor,
                           lifetime.fileHandleForReading.fileDescriptor, lifetime.fileHandleForWriting.fileDescriptor]
        for fd in descriptors { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }
        var actions: posix_spawn_file_actions_t?
        var attributes: posix_spawnattr_t?
        var result = posix_spawn_file_actions_init(&actions)
        guard result == 0 else { throw SupervisorError.system("spawn actions", result) }
        defer { posix_spawn_file_actions_destroy(&actions) }
        result = posix_spawnattr_init(&attributes)
        guard result == 0 else { throw SupervisorError.system("spawn attributes", result) }
        defer { posix_spawnattr_destroy(&attributes) }
        let setup = [
            posix_spawn_file_actions_adddup2(&actions, input.fileHandleForReading.fileDescriptor, STDIN_FILENO),
            posix_spawn_file_actions_adddup2(&actions, output.fileHandleForWriting.fileDescriptor, STDOUT_FILENO),
            posix_spawn_file_actions_adddup2(&actions, lifetime.fileHandleForReading.fileDescriptor, 3),
            posix_spawnattr_setpgroup(&attributes, 0),
            posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF))
        ]
        if let failure = setup.first(where: { $0 != 0 }) { throw SupervisorError.system("configure spawn", failure) }
        if inheritedDiagnostics >= 0 {
            let diagnosticsResult = posix_spawn_file_actions_adddup2(&actions, inheritedDiagnostics, STDERR_FILENO)
            guard diagnosticsResult == 0 else { throw SupervisorError.system("inherit diagnostics", diagnosticsResult) }
        }
        if inheritedProfile >= 0 {
            let leaseResult = posix_spawn_file_actions_adddup2(&actions, inheritedProfile, 4)
            guard leaseResult == 0 else { throw SupervisorError.system("inherit profile lease", leaseResult) }
        }
        // Parent dispatch signal sources may ignore SIGTERM; children need their
        // own normal termination semantics and an empty inherited signal mask.
        var mask = sigset_t(0)
        var defaults = sigset_t(0)
        sigemptyset(&mask)
        sigemptyset(&defaults)
        sigaddset(&defaults, SIGTERM)
        sigaddset(&defaults, SIGINT)
        sigaddset(&defaults, SIGHUP)
        sigaddset(&defaults, SIGPIPE)
        let maskResult = posix_spawnattr_setsigmask(&attributes, &mask)
        let defaultResult = posix_spawnattr_setsigdefault(&attributes, &defaults)
        guard maskResult == 0 && defaultResult == 0 else {
            throw SupervisorError.system("spawn signal settings", maskResult != 0 ? maskResult : defaultResult)
        }
        let launchedExecutable = guardianExecutable ?? executable
        let launchedArguments = guardianExecutable == nil ? arguments : ["--guard-backend", executable] + arguments
        let argv = ([launchedExecutable] + launchedArguments).map { strdup($0) } + [nil]
        let envp = environment.sorted { $0.key < $1.key }.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer {
            for pointer in argv { free(pointer) }
            for pointer in envp { free(pointer) }
        }
        var pid: pid_t = 0
        result = argv.withUnsafeBufferPointer { argvBuffer in
            envp.withUnsafeBufferPointer { envBuffer in
                posix_spawn(&pid, launchedExecutable, &actions, &attributes,
                            UnsafeMutablePointer(mutating: argvBuffer.baseAddress!),
                            UnsafeMutablePointer(mutating: envBuffer.baseAddress!))
            }
        }
        guard result == 0 else { throw SupervisorError.system("launch child", result) }
        lifetime.fileHandleForReading.closeFile()
        lifetimeWriter = lifetime.fileHandleForWriting
        input.fileHandleForReading.closeFile()
        output.fileHandleForWriting.closeFile()
        let launched = BackendChild(pid: pid, input: input.fileHandleForWriting, output: output.fileHandleForReading)
        child = launched
        started = true
        guarded = guardianExecutable != nil
        DispatchQueue.global(qos: .utility).async { [self] in
            var status: Int32 = 0
            var waited: pid_t
            repeat { waited = waitpid(launched.pid, &status, 0) } while waited < 0 && errno == EINTR
            condition.lock()
            try? lifetimeWriter?.close()
            lifetimeWriter = nil
            reaped = true
            condition.broadcast()
            condition.unlock()
            onExit(waited < 0 ? -1 : status)
        }
        return launched
    }

    /// Bounded TERM grace followed by unconditional group KILL, even when the
    /// direct child exited first. Repeated/concurrent callers join one cleanup.
    func shutdown(gracePeriod: TimeInterval = 2) {
        condition.lock()
        if stopping {
            while !stopped { condition.wait() }
            condition.unlock()
            return
        }
        stopping = true
        guard let child else {
            stopped = true
            condition.broadcast()
            condition.unlock()
            return
        }
        try? lifetimeWriter?.close()
        lifetimeWriter = nil
        condition.unlock()
        try? child.input.close()
        kill(-child.pid, SIGTERM)
        let deadline = Date().addingTimeInterval(max(guarded ? 1.5 : 0, min(gracePeriod, 10)))
        // Do not finish the grace period merely because the group leader exited:
        // another group member can still be draining its own children.
        while Date() < deadline && kill(-child.pid, 0) == 0 { usleep(10_000) }
        kill(-child.pid, SIGKILL)
        condition.lock()
        let reapDeadline = Date().addingTimeInterval(2)
        while !reaped && Date() < reapDeadline { _ = condition.wait(until: reapDeadline) }
        try? child.output.close()
        stopped = true
        condition.broadcast()
        condition.unlock()
    }
}
