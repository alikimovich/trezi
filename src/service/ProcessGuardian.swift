import Foundation
import Darwin

/// Lifecycle-only wrapper for Bun-owned detached children. FD 3 is the read end
/// of a lifetime pipe whose sole writer is the Swift service. The wrapper never
/// reads profile state or chooses a server/provider command.
func runProcessGuardian(arguments: [String], backend: Bool = false) -> Never {
    guard let executable = arguments.first, fcntl(3, F_GETFD) >= 0 else {
        fputs("Trezi process guardian requires a command and lifetime descriptor\n", stderr)
        exit(64)
    }
    // Bun needs the read end to pass to its detached guardians. Other project
    // processes must not receive it. The profile lease stays only in this guard.
    _ = fcntl(3, F_SETFD, backend ? 0 : FD_CLOEXEC)
    if backend {
        guard fcntl(4, F_GETFD) >= 0 else {
            fputs("Trezi backend guardian requires a profile lease\n", stderr)
            exit(64)
        }
        _ = fcntl(4, F_SETFD, FD_CLOEXEC)
    }
    let state = GuardianState(gracePeriod: backend ? 1 : 0.5)
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    signal(SIGHUP, SIG_IGN)
    let signals = [SIGTERM, SIGINT, SIGHUP].map { number -> DispatchSourceSignal in
        let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
        source.setEventHandler { state.stop() }
        source.resume()
        return source
    }
    var attributes: posix_spawnattr_t?
    var result = posix_spawnattr_init(&attributes)
    guard result == 0 else { exit(70) }
    let groupResult = posix_spawnattr_setpgroup(&attributes, 0)
    let flagsResult = posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK))
    var mask = sigset_t(0)
    var defaults = sigset_t(0)
    sigemptyset(&mask)
    sigemptyset(&defaults)
    for number in [SIGTERM, SIGINT, SIGHUP, SIGPIPE] { sigaddset(&defaults, number) }
    let maskResult = posix_spawnattr_setsigmask(&attributes, &mask)
    let defaultsResult = posix_spawnattr_setsigdefault(&attributes, &defaults)
    guard [groupResult, flagsResult, maskResult, defaultsResult].allSatisfy({ $0 == 0 }) else {
        posix_spawnattr_destroy(&attributes)
        fputs("Trezi process guardian could not configure child isolation\n", stderr)
        exit(70)
    }
    let argv = arguments.map { strdup($0) } + [nil]
    let envp = ProcessInfo.processInfo.environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
    var pid: pid_t = 0
    result = argv.withUnsafeBufferPointer { argvBuffer in
        envp.withUnsafeBufferPointer { envBuffer in
            posix_spawnp(&pid, executable, nil, &attributes,
                         UnsafeMutablePointer(mutating: argvBuffer.baseAddress!),
                         UnsafeMutablePointer(mutating: envBuffer.baseAddress!))
        }
    }
    posix_spawnattr_destroy(&attributes)
    for value in argv { free(value) }
    for value in envp { free(value) }
    guard result == 0 else {
        fputs("Trezi process guardian could not launch child: \(String(cString: strerror(result)))\n", stderr)
        exit(127)
    }
    state.install(pid: pid)
    DispatchQueue.global(qos: .utility).async {
        var byte: UInt8 = 0
        while true {
            let count = read(3, &byte, 1)
            if count < 0 && errno == EINTR { continue }
            if count <= 0 { state.stop(); return }
        }
    }
    var status: Int32 = 0
    var waited: pid_t
    repeat { waited = waitpid(pid, &status, 0) } while waited < 0 && errno == EINTR
    state.stop()
    withExtendedLifetime(signals) {}
    if waited < 0 { exit(70) }
    let signalCode = status & 0x7f
    exit(signalCode == 0 ? ((status >> 8) & 0xff) : (128 + signalCode))
}

private final class GuardianState {
    private let condition = NSCondition()
    private var pid: pid_t?
    private var stopping = false
    private var stopped = false
    private var earlyStop = false
    private let gracePeriod: TimeInterval

    init(gracePeriod: TimeInterval) { self.gracePeriod = gracePeriod }

    func install(pid: pid_t) {
        condition.lock()
        self.pid = pid
        let stopNow = earlyStop
        condition.unlock()
        if stopNow { stop() }
    }

    func stop() {
        condition.lock()
        guard let pid else { earlyStop = true; condition.unlock(); return }
        if stopping {
            while !stopped { condition.wait() }
            condition.unlock()
            return
        }
        stopping = true
        condition.unlock()
        kill(-pid, SIGTERM)
        // Detached guards finish before Bun's one-second force-stop grace.
        // The backend itself receives the full existing drain interval.
        let deadline = Date().addingTimeInterval(gracePeriod)
        while Date() < deadline && kill(-pid, 0) == 0 { usleep(10_000) }
        kill(-pid, SIGKILL)
        condition.lock()
        stopped = true
        condition.broadcast()
        condition.unlock()
    }
}

/// `--watch-group <pgid>` (S06): the crash backstop for a project process group the
/// Swift service launched itself. FD 3 is the read end of a lifetime pipe whose only
/// writer is the service. EOF (the service died) or SIGTERM stops the group: TERM,
/// a bounded grace, then KILL. It exits by itself once the group is gone. It never
/// launches anything and never signals any other group.
func runGroupWatchdog(arguments: [String]) -> Never {
    guard let text = arguments.first, let pgid = pid_t(text), pgid > 1, fcntl(3, F_GETFD) >= 0 else {
        fputs("Trezi group watchdog requires a process group and lifetime descriptor\n", stderr)
        exit(64)
    }
    _ = fcntl(3, F_SETFD, FD_CLOEXEC)
    signal(SIGINT, SIG_IGN)
    signal(SIGHUP, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    let watchdog = GroupWatchdog(pgid: pgid)
    let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    term.setEventHandler { watchdog.stopGroup() }
    term.resume()
    DispatchQueue.global(qos: .utility).async {
        var byte: UInt8 = 0
        while true {
            let count = read(3, &byte, 1)
            if count < 0 && errno == EINTR { continue }
            if count <= 0 { watchdog.stopGroup() }
        }
    }
    // An empty group (only an unreaped leader left answers EPERM) needs no watch.
    while kill(-pgid, 0) == 0 { usleep(100_000) }
    withExtendedLifetime(term) {}
    exit(0)
}

private final class GroupWatchdog: @unchecked Sendable {
    private let pgid: pid_t
    private let lock = NSLock()
    private var stopping = false
    init(pgid: pid_t) { self.pgid = pgid }

    /// TERM, 0.5 s grace, KILL, exit. A second caller parks until the first exits.
    func stopGroup() -> Never {
        lock.lock()
        let first = !stopping
        stopping = true
        lock.unlock()
        guard first else { while true { pause() } }
        kill(-pgid, SIGTERM)
        let deadline = Date().addingTimeInterval(0.5)
        while Date() < deadline && kill(-pgid, 0) == 0 { usleep(10_000) }
        kill(-pgid, SIGKILL)
        exit(0)
    }
}
