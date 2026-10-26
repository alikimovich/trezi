import Foundation
import Darwin

/// LKM-347: how much memory a process held shortly before it died, for the product
/// log's exit reports. The physical footprint is what macOS weighs when it kills a
/// process for memory (jetsam). Same-user processes only; no entitlement needed.
final class MemorySampler {
    private let lock = NSLock()
    private let target: () -> pid_t?
    private var timer: DispatchSourceTimer?
    private var footprint: UInt64 = 0
    private var peak: UInt64 = 0
    private var sampledAt: Date?

    init(interval: TimeInterval = 30, target: @escaping () -> pid_t?) {
        self.target = target
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now(), repeating: interval, leeway: .seconds(5))
        timer.setEventHandler { [weak self] in self?.sample() }
        timer.resume()
        self.timer = timer
    }
    deinit { timer?.cancel() }

    func sample() {
        guard let pid = target(), pid > 0, let usage = Self.usage(pid) else { return }
        lock.lock(); defer { lock.unlock() }
        footprint = usage.footprint; peak = max(peak, usage.peak); sampledAt = Date()
    }
    func reset() {
        lock.lock(); defer { lock.unlock() }
        footprint = 0; peak = 0; sampledAt = nil
    }
    /// `footprint=812MB peak=1204MB sampled=14s` before the given moment.
    func summary(before now: Date = Date()) -> String {
        lock.lock(); defer { lock.unlock() }
        guard let sampledAt else { return "footprint=unknown" }
        return "footprint=\(Self.megabytes(footprint)) peak=\(Self.megabytes(peak)) sampled=\(Int(now.timeIntervalSince(sampledAt)))s"
    }

    static func usage(_ pid: pid_t) -> (footprint: UInt64, peak: UInt64)? {
        var info = rusage_info_v4()
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
        }
        return result == 0 ? (info.ri_phys_footprint, info.ri_lifetime_max_phys_footprint) : nil
    }
    static func firstChild(of pid: pid_t) -> pid_t? {
        var children = [pid_t](repeating: 0, count: 8)
        let count = proc_listchildpids(pid, &children, Int32(children.count * MemoryLayout<pid_t>.size))
        return count > 0 ? children[0] : nil
    }
    static func megabytes(_ bytes: UInt64) -> String { "\(bytes / 1_048_576)MB" }

    /// How a waitpid status ended: `code=17` or `signal=9 (SIGKILL)`. A guardian
    /// reports its child's signal as exit code 128 + signal.
    static func describe(status: Int32, guarded: Bool = false) -> String {
        let signal = status & 0x7f, code = (status >> 8) & 0xff
        if signal == 0 && !(guarded && code > 128 && code < 160) { return "code=\(code)" }
        let number = signal == 0 ? code - 128 : signal
        let name = [SIGKILL: "SIGKILL", SIGTERM: "SIGTERM", SIGSEGV: "SIGSEGV", SIGBUS: "SIGBUS", SIGABRT: "SIGABRT",
                    SIGILL: "SIGILL", SIGTRAP: "SIGTRAP", SIGHUP: "SIGHUP", SIGINT: "SIGINT"][number] ?? "signal \(number)"
        // SIGKILL leaves no crash report: macOS's memory limit (jetsam), launchd or another process.
        return "signal=\(number) (\(name))" + (number == SIGKILL ? " killed without a crash report" : "")
    }
}
