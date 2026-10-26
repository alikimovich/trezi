import Foundation
import Darwin

/// LKM-347: why the service went away, in the product log, whenever the host loses
/// it without a `serviceStopped` announcement. The host is not the service's parent,
/// so there is no exit status to read; instead it records what it can observe:
/// whether the process is gone, its last sampled memory, recent system memory
/// pressure, the service's own last log lines (already redacted), and any crash or
/// jetsam report macOS writes. Never prompts, file contents or secrets.
final class ServiceExitReport {
    private let lock = NSLock()
    private var pid: pid_t = 0
    private var memory: MemorySampler?
    private var pressure: (level: String, at: Date)?
    private var pressureSource: DispatchSourceMemoryPressure?

    init() {
        memory = MemorySampler { [weak self] in self?.watched }
        let source = DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical], queue: .main)
        source.setEventHandler { [weak self, weak source] in
            guard let self, let event = source?.data else { return }
            let level = event.contains(.critical) ? "critical" : "warning"
            self.pressure = (level, Date())
            ProductLog.warn("memory", "System memory pressure \(level); service \(self.memory?.summary() ?? "")")
        }
        source.resume(); pressureSource = source
    }
    private var watched: pid_t? {
        lock.lock(); defer { lock.unlock() }
        return pid > 0 ? pid : nil
    }
    /// The service instance the host is now connected to.
    func watch(_ servicePID: pid_t) {
        lock.lock(); let changed = pid != servicePID; pid = servicePID; lock.unlock()
        if changed { memory?.reset(); DispatchQueue.global(qos: .utility).async { [weak self] in self?.memory?.sample() } }
    }
    /// Logs the loss now and any crash or jetsam report macOS writes for it shortly after.
    func lost(attempt: Int, pending: Int) {
        let now = Date(), servicePID = watched ?? 0
        let gone = servicePID > 0 && Self.exited(servicePID)
        var line = "Service lost without a stop announcement pid=\(servicePID) exited=\(gone ? "yes" : servicePID > 0 ? "no" : "unknown")"
        line += " \(memory?.summary(before: now) ?? "") pending=\(pending) attempt=\(attempt)"
        if let pressure { line += " memoryPressure=\(pressure.level) \(Int(now.timeIntervalSince(pressure.at)))s ago" }
        let recent = Self.recentServiceLines()
        line += recent.isEmpty ? " lastServiceLines=none" : " lastServiceLines: " + recent.joined(separator: " | ")
        ProductLog.error("xpc", line)
        // Crash and jetsam reports appear a few seconds after the process ends.
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 10) {
            let reports = Self.exitReports(since: now.addingTimeInterval(-30))
            ProductLog.warn("xpc", reports.isEmpty
                ? "Service exit: no crash or jetsam report (a SIGKILL from launchd or another process, or an XPC idle exit)"
                : "Service exit reports: \(reports.joined(separator: ", "))")
        }
    }

    /// The service's last three lines from the tail of today's product log.
    static func recentServiceLines(directory: String = ProductLog.configuredDirectory, now: Date = Date()) -> [String] {
        ProductLog.flush()
        let path = directory + "/trezi-\(ProductLog.timestamp(now).prefix(10)).log"
        guard let file = FileHandle(forReadingAtPath: path) else { return [] }
        defer { try? file.close() }
        let size = (try? file.seekToEnd()) ?? 0
        try? file.seek(toOffset: size > 65_536 ? size - 65_536 : 0)
        guard let data = try? file.readToEnd(), let text = String(data: data, encoding: .utf8) else { return [] }
        let lines = text.split(separator: "\n").filter { $0.split(separator: " ", maxSplits: 3).dropFirst(2).first == "service" }
        return lines.suffix(3).map { String($0.prefix(240)) }
    }
    /// Dead or a zombie launchd has not reaped yet (`kill(pid, 0)` still succeeds on one).
    static func exited(_ pid: pid_t) -> Bool {
        if kill(pid, 0) != 0 { return errno == ESRCH }
        var info = proc_bsdshortinfo()
        return proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdshortinfo>.size)) == 0 && errno == ESRCH
    }
    /// Names of crash reports for the service and jetsam reports newer than `since`.
    static func exitReports(since: Date) -> [String] {
        let folders = [ProductLog.accountHome + "/Library/Logs/DiagnosticReports", "/Library/Logs/DiagnosticReports"]
        return folders.flatMap { folder -> [String] in
            let names = (try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? []
            return names.filter { name in
                guard name.hasPrefix("TreziService") || name.hasPrefix("JetsamEvent"),
                      let modified = (try? FileManager.default.attributesOfItem(atPath: folder + "/" + name))?[.modificationDate] as? Date
                else { return false }
                return modified >= since
            }
        }.sorted()
    }
}
