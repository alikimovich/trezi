import Foundation
import Darwin

/// The simulator coordinator (S14; formerly `src/main/simulator.ts` in Bun): preflight
/// (Xcode, runtimes, devices, SDK/runtime match, idb), device choice, boot, the app's
/// own launch command (Metro/Expo) as a supervised process group, the loopback bridge
/// with its frame capture, idb input and element picks, and teardown. One simulator
/// preview at a time: a newer start or a stop supersedes a start still under way, which
/// stops every tool it is waiting on (`xcrun`, `idb`) and answers `cancelled`; a restart
/// never overlaps its predecessor. The Metro group is journaled with the runtime owner's
/// groups (watchdog + `processes.json`), so a crash never leaves it running. The booted
/// simulator is left booted, as before (cheap to reopen; the user can quit it).
final class SimulatorCoordinator: @unchecked Sendable {
    struct Options {
        var environment: [String: String]
        var scratch: String
        var watchdog: String?
        var journal: RuntimeJournal?
        var xcrun = "/usr/bin/xcrun"
        /// `open -a Simulator` after boot; nil skips it (fixtures, headless checks).
        var open: String? = "/usr/bin/open"
        var pkill = "/usr/bin/pkill"
        /// Explicit idb binaries to try; nil resolves `idb` on the usual install paths.
        var idbCandidates: [String]?
        var idbState = "/tmp/idb"
        var fps: Double = 6
        var firstFrameTimeout: TimeInterval = 30
        var markerTimeout: TimeInterval = 180
        var stopGrace: TimeInterval = 1
        var bridgePortBase = 7800
    }

    static let cancelled = PlatformRefusal(.cancelled, "Simulator start was cancelled.")
    static let preferredDevice = "iPhone 16 Pro"

    let options: Options
    private let log: @Sendable (String) -> Void
    private let picked: @Sendable (String?, String) -> Void
    private let lock = NSLock()
    private var generation = 0
    private var closed = false
    private var starting: Attempt?
    private var running: Running?
    private var selecting = false
    private var idbBinary: String?
    private let recovery = NSLock()

    init(options: Options, log: @escaping @Sendable (String) -> Void, picked: @escaping @Sendable (String?, String) -> Void) {
        self.options = options; self.log = log; self.picked = picked
    }

    /// Resources a start has made so far; `abort` (a stop, a newer start, shutdown)
    /// stops them, and a resource registered after the abort is refused.
    final class Attempt: @unchecked Sendable {
        let scope = ToolScope()
        private let lock = NSLock()
        private var aborted = false
        private var metro: ManagedProcess?
        private var bridge: SimulatorBridge?
        let grace: TimeInterval
        init(grace: TimeInterval) { self.grace = grace }

        func hold(metro process: ManagedProcess) -> Bool { lock.lock(); defer { lock.unlock() }; if !aborted { metro = process }; return !aborted }
        func hold(bridge value: SimulatorBridge) -> Bool { lock.lock(); defer { lock.unlock() }; if !aborted { bridge = value }; return !aborted }
        func release() -> (ManagedProcess?, SimulatorBridge?) { lock.lock(); defer { lock.unlock() }; let held = (metro, bridge); metro = nil; bridge = nil; return held }

        func abort() {
            scope.cancel()
            lock.lock(); aborted = true; lock.unlock()
            let (metro, bridge) = release()
            bridge?.close()
            metro?.stop(grace: grace)
        }
    }

    struct Running {
        let metro: ManagedProcess?
        let bridge: SimulatorBridge
        let scope: ToolScope
        let grace: TimeInterval
        func shutdown() { scope.cancel(); bridge.close(); metro?.stop(grace: grace) }
    }

    var state: JSValue {
        lock.lock(); defer { lock.unlock() }
        return .object([(JSText("running"), .bool(running != nil)), (JSText("starting"), .bool(starting != nil)),
                        (JSText("selectMode"), .bool(selecting)), (JSText("streams"), .number(Double(running?.bridge.streams ?? 0)))])
    }

    func setSelectMode(_ active: Bool) { lock.lock(); selecting = active; lock.unlock() }
    private var selectMode: Bool { lock.lock(); defer { lock.unlock() }; return selecting }

    // MARK: Tools

    private func xcrun(_ arguments: [String], timeout: TimeInterval = 8, scope: ToolScope?) throws -> String {
        let result = try PlatformTool.run(options.xcrun, arguments, environment: options.environment, timeout: timeout, scope: scope)
        if result.cancelled || scope?.isCancelled == true { throw Self.cancelled }
        guard result.ok else { throw PlatformRefusal(.unavailable, PlatformTool.failure(["xcrun"] + arguments, result)) }
        return result.output
    }

    private func json(_ text: String) throws -> JSValue {
        do { return try JSValue.parse(Data(text.utf8), maxDepth: 32) } catch { throw PlatformRefusal(.unavailable, "Unexpected output from simctl.") }
    }

    private var idbPaths: [String] {
        let home = options.environment["HOME"] ?? ""
        return ["/opt/homebrew/bin", "/opt/homebrew/Caskroom/miniforge/base/bin", "/usr/local/bin"] + (home.isEmpty ? [] : [home + "/.local/bin"])
    }

    private var idbEnvironment: [String: String] {
        var environment = options.environment
        environment["PATH"] = (idbPaths + [options.environment["PATH"] ?? ""]).filter { !$0.isEmpty }.joined(separator: ":")
        return environment
    }

    /// A working `idb`, or nil. A found binary is remembered; a missing one is looked for again next time.
    func resolveIdb(scope: ToolScope?) -> String? {
        lock.lock(); let cached = idbBinary; lock.unlock()
        if let cached { return cached }
        for binary in options.idbCandidates ?? (["idb"] + idbPaths.map { $0 + "/idb" }) {
            guard let result = try? PlatformTool.run(binary, ["--help"], environment: idbEnvironment, timeout: 4, scope: scope), result.ok else { continue }
            lock.lock(); idbBinary = binary; lock.unlock()
            return binary
        }
        return nil
    }

    struct IdbFailure: Error, CustomStringConvertible { let description: String; let stale: Bool }

    /// Failures that look like a stale companion are thrown as `stale`, even on exit 0.
    private func idbRaw(_ arguments: [String], timeout: TimeInterval, scope: ToolScope?) throws -> String {
        guard let binary = resolveIdb(scope: scope) else { throw IdbFailure(description: "idb not found", stale: false) }
        let result = try PlatformTool.run(binary, arguments, environment: idbEnvironment, timeout: timeout, scope: scope)
        if result.cancelled { throw Self.cancelled }
        if SimulatorTools.matches(SimulatorTools.staleIdb, result.errors) {
            let last = result.errors.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.last
            throw IdbFailure(description: last ?? "idb companion unavailable", stale: true)
        }
        guard result.ok else {
            let message = PlatformTool.failure([binary] + arguments, result)
            throw IdbFailure(description: message, stale: SimulatorTools.matches(SimulatorTools.staleIdb, message + result.output))
        }
        return result.output
    }

    private func idb(_ arguments: [String], timeout: TimeInterval = 10, scope: ToolScope?) throws -> String {
        do { return try idbRaw(arguments, timeout: timeout, scope: scope) } catch let failure as IdbFailure where failure.stale {
            recoverIdb(scope: scope)
            return try idbRaw(arguments, timeout: timeout, scope: scope)
        }
    }

    /// Stops stale idb_companion daemons and clears idb's state folder, so the next
    /// command starts a fresh companion for the current boot. Concurrent callers share one run.
    private func recoverIdb(scope: ToolScope?) {
        guard recovery.try() else { recovery.lock(); recovery.unlock(); return }
        defer { recovery.unlock() }
        log("idb companion looks stale — restarting it…")
        _ = try? PlatformTool.run(options.pkill, ["-f", "idb_companion"], environment: options.environment, timeout: 4, scope: scope)
        // A link at the state path is removed itself, never followed.
        try? FileManager.default.removeItem(atPath: options.idbState)
    }

    private func idbHealthy(_ udid: String, scope: ToolScope?) -> Bool {
        guard let output = try? idbRaw(["describe", "--udid", udid, "--json"], timeout: 8, scope: scope),
              let value = try? JSValue.parse(Data(output.utf8), maxDepth: 32) else { return false }
        return value["state"]?.text?.string == "Booted"
    }

    private func screen(_ udid: String, scope: ToolScope?) throws -> (width: Double, height: Double) {
        let output = try idb(["describe", "--udid", udid, "--json"], timeout: 8, scope: scope)
        guard let value = try? JSValue.parse(Data(output.utf8), maxDepth: 32) else { throw IdbFailure(description: "Unexpected output from idb.", stale: false) }
        return SimulatorTools.screenPoints(value)
    }

    // MARK: Preflight

    struct Device { let udid: String, name: String, runtime: String }

    struct Preflight {
        var ok = false, hasXcode = false, hasIdb = false
        var runtimes: [String] = [], devices: [Device] = []
        var reason: String?

        var value: JSValue {
            var fields: [(JSText, JSValue)] = [(JSText("ok"), .bool(ok)), (JSText("isMac"), .bool(true)), (JSText("hasXcode"), .bool(hasXcode)),
                (JSText("hasIdb"), .bool(hasIdb)), (JSText("runtimes"), .array(runtimes.map { .string(JSText($0)) })),
                (JSText("devices"), .array(devices.map { .object([(JSText("udid"), .string(JSText($0.udid))), (JSText("name"), .string(JSText($0.name))),
                                                                  (JSText("runtime"), .string(JSText($0.runtime)))]) }))]
            if let reason { fields.append((JSText("reason"), .string(JSText(reason)))) }
            return .object(fields)
        }
    }

    func preflight(scope: ToolScope? = nil) throws -> Preflight {
        var result = Preflight()
        do {
            let help = try PlatformTool.run(options.xcrun, ["simctl", "help"], environment: options.environment, timeout: 8, scope: scope)
            if help.cancelled { throw Self.cancelled }
            guard help.ok else {
                result.reason = SimulatorTools.xcodeFailureReason(message: PlatformTool.failure(["xcrun", "simctl", "help"], help), stderr: help.errors, missing: false)
                return result
            }
        } catch let refusal as PlatformRefusal where refusal.code == .unavailable {
            result.reason = SimulatorTools.xcodeFailureReason(message: refusal.message, stderr: "", missing: true)
            return result
        }
        result.hasXcode = true
        result.hasIdb = resolveIdb(scope: scope) != nil
        var runtimeVersions: [String] = []
        do {
            guard case .array(let runtimes) = try json(xcrun(["simctl", "list", "runtimes", "-j"], scope: scope))["runtimes"] ?? .array([]) else {
                throw PlatformRefusal(.unavailable, "Unexpected output from simctl.")
            }
            for runtime in runtimes {
                guard let name = runtime["name"]?.text?.string, runtime["isAvailable"] != .bool(false), name.range(of: "iOS", options: .caseInsensitive) != nil else { continue }
                result.runtimes.append(name)
                if let version = runtime["version"]?.text?.string, !version.isEmpty { runtimeVersions.append(version) }
            }
            guard case .object(let byRuntime) = try json(xcrun(["simctl", "list", "devices", "available", "-j"], scope: scope))["devices"] ?? .object([]) else {
                throw PlatformRefusal(.unavailable, "Unexpected output from simctl.")
            }
            for (runtime, list) in byRuntime where runtime.string.range(of: "iOS", options: .caseInsensitive) != nil {
                guard case .array(let devices) = list else { continue }
                for device in devices {
                    guard let udid = device["udid"]?.text?.string, let name = device["name"]?.text?.string, device["isAvailable"] != .bool(false),
                          name.range(of: "iPhone|iPad", options: [.regularExpression, .caseInsensitive]) != nil else { continue }
                    result.devices.append(Device(udid: udid, name: name, runtime: runtime.string))
                }
            }
        } catch let refusal as PlatformRefusal where refusal.code != .cancelled {
            result.reason = "Couldn't list simulators: \(refusal.message)"
            return result
        }
        if result.runtimes.isEmpty { result.reason = "No iOS runtimes installed. Add one in Xcode → Settings → Platforms."; return result }
        if result.devices.isEmpty { result.reason = "No iPhone/iPad simulators found. Create one in Xcode → Settings → Platforms."; return result }
        // Best effort: an unreadable SDK version never blocks.
        let sdk = try? xcrun(["--sdk", "iphonesimulator", "--show-sdk-version"], scope: scope).trimmingCharacters(in: .whitespacesAndNewlines)
        if scope?.isCancelled == true { throw Self.cancelled }
        if let reason = SimulatorTools.buildDestination(sdk: sdk, runtimes: runtimeVersions) { result.reason = reason; return result }
        result.ok = true
        return result
    }

    private func booted(scope: ToolScope?) -> Set<String> {
        guard let output = try? xcrun(["simctl", "list", "devices", "booted", "-j"], scope: scope),
              case .object(let byRuntime)? = (try? json(output))?["devices"] else { return [] }
        var set = Set<String>()
        for (_, list) in byRuntime { if case .array(let devices) = list { for device in devices { if let udid = device["udid"]?.text?.string { set.insert(udid) } } } }
        return set
    }

    private static func runtimeOrder(_ a: Device, _ b: Device) -> Bool {
        a.runtime.compare(b.runtime, locale: Locale(identifier: "en_US_POSIX")) == .orderedAscending
    }

    private func pick(_ preflight: Preflight, preferred: String?, scope: ToolScope) -> Device {
        if let preferred, let exact = preflight.devices.first(where: { $0.udid == preferred }) { return exact }
        if let named = preflight.devices.filter({ $0.name == Self.preferredDevice }).sorted(by: Self.runtimeOrder).last { return named }
        let running = booted(scope: scope)
        if let device = preflight.devices.first(where: { running.contains($0.udid) }) { return device }
        let phones = preflight.devices.filter { $0.name.range(of: "iPhone", options: .caseInsensitive) != nil }
        return (phones.isEmpty ? preflight.devices : phones).sorted(by: Self.runtimeOrder).last!
    }

    // MARK: Start

    /// Blocking; runs on a worker thread. Answers the running simulator, or throws.
    func start(root: String, command requested: String?, udid preferred: String?, frame: SimulatorTools.Frame) throws -> JSValue {
        let attempt = Attempt(grace: options.stopGrace)
        lock.lock()
        guard !closed else { lock.unlock(); throw PlatformOwner.stopping }
        generation += 1
        let mine = generation, previousAttempt = starting, previous = running
        starting = attempt; running = nil
        lock.unlock()
        // A restart never overlaps its predecessor.
        previousAttempt?.abort()
        previous?.shutdown()
        do {
            let result = try launch(attempt, generation: mine, root: root, command: requested, udid: preferred, frame: frame)
            return result
        } catch {
            // Decided before cleaning up (which cancels the scope itself).
            let superseded = attempt.scope.isCancelled || isSuperseded(mine)
            attempt.abort()
            lock.lock(); if starting === attempt { starting = nil }; lock.unlock()
            throw superseded ? Self.cancelled : error
        }
    }

    private func isSuperseded(_ generation: Int) -> Bool { lock.lock(); defer { lock.unlock() }; return closed || self.generation != generation }

    private func check(_ attempt: Attempt, _ generation: Int) throws {
        if attempt.scope.isCancelled || isSuperseded(generation) { throw Self.cancelled }
    }

    private func launch(_ attempt: Attempt, generation: Int, root: String, command requested: String?, udid preferred: String?,
                        frame: SimulatorTools.Frame) throws -> JSValue {
        let scope = attempt.scope
        let checked = try preflight(scope: scope)
        try check(attempt, generation)
        guard checked.ok else { throw PlatformRefusal(.unavailable, checked.reason ?? "No simulator available.") }
        let device = pick(checked, preferred: preferred, scope: scope)
        log("Using \(device.name) · \(device.runtime)")
        try boot(device.udid, scope: scope)
        try check(attempt, generation)

        let command = (requested?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 } ?? "npx expo run:ios"
        log("Launching app: \(command)")
        let gate = MetroGate(log: log)
        var environment = options.environment
        for (name, value) in [("FORCE_COLOR", "0"), ("CI", "1"), ("EXPO_NO_TELEMETRY", "1")] { environment[name] = value }
        let journal = options.journal
        let metro: ManagedProcess
        do {
            // The command is the default literal or the user's own; never page or project content.
            metro = try ManagedProcess.launch(ProcessLaunch(executable: "/bin/sh", arguments: ["-c", command], directory: root,
                                                            environment: environment, watchdog: options.watchdog),
                onOutput: { chunk in gate.output(chunk) },
                onExit: { process, status in journal?.remove(process.pid); gate.exited(ProcessGroup.exitCode(status)) })
        } catch {
            throw PlatformRefusal(.unavailable, "Failed to start Metro: \(error)")
        }
        if let identity = metro.identity { journal?.add(identity) }
        guard attempt.hold(metro: metro) else { metro.stop(grace: options.stopGrace); throw Self.cancelled }
        if let failure = gate.wait(timeout: options.markerTimeout, cancelled: { scope.isCancelled }) { throw PlatformRefusal(.unavailable, failure) }
        try check(attempt, generation)
        let bundleID = Self.bundleID(root)

        // Expo opens the app on whichever simulator is booted: mirror the one it names.
        var capture = device
        if let name = gate.launchedName, name != device.name {
            let running = booted(scope: scope)
            if let hit = checked.devices.first(where: { $0.name == name && running.contains($0.udid) }) {
                capture = hit
                log("App launched on \(hit.name) — mirroring it instead of \(device.name).")
            }
        }
        let udid = capture.udid
        let bridgeScope = ToolScope()
        var interaction: SimulatorBridge.Interaction?
        if resolveIdb(scope: scope) != nil {
            var healthy = idbHealthy(udid, scope: scope)
            if !healthy { recoverIdb(scope: scope); healthy = idbHealthy(udid, scope: scope) }
            if healthy {
                interaction = self.interaction(udid: udid, scope: bridgeScope)
                log("idb detected — tap / scroll / type + element-select enabled.")
            } else {
                log("idb is installed but cannot attach to this simulator — preview is view-only. Quit Simulator.app and reopen the project to retry.")
            }
        } else {
            log("idb not found — preview is view-only (install idb to interact).")
        }
        try check(attempt, generation)
        guard let port = RuntimeNet.freePort(from: options.bridgePortBase, reserved: []) else {
            throw PlatformRefusal(.unavailable, "No free port found from \(options.bridgePortBase).")
        }
        let bridge = try SimulatorBridge.listen(port: port, frame: frame, interaction: interaction)
        guard attempt.hold(bridge: bridge) else { bridge.close(); bridgeScope.cancel(); throw Self.cancelled }
        let file = options.scratch + "/trezi-sim-\(udid).jpg"
        try? FileManager.default.createDirectory(atPath: options.scratch, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let xcrun = options.xcrun, toolEnvironment = options.environment
        bridge.start(FrameCapture(interval: 1 / max(0.1, options.fps), capture: {
            let arguments = ["simctl", "io", udid, "screenshot", "--type=jpeg", file]
            let result = try PlatformTool.run(xcrun, arguments, environment: toolEnvironment, timeout: 10, scope: bridgeScope)
            guard result.ok else { throw PlatformRefusal(.unavailable, PlatformTool.failure(["xcrun"] + arguments, result)) }
            return FileManager.default.contents(atPath: file)
        }, onStop: { unlink(file) }))
        if let failure = bridge.waitForFirstFrame(timeout: options.firstFrameTimeout, cancelled: { scope.isCancelled }) {
            bridgeScope.cancel()
            if failure == "cancelled" { throw Self.cancelled }
            throw PlatformRefusal(.unavailable, failure)
        }
        lock.lock()
        guard !closed, self.generation == generation, starting === attempt else { lock.unlock(); bridgeScope.cancel(); throw Self.cancelled }
        let (heldMetro, heldBridge) = attempt.release()
        running = Running(metro: heldMetro, bridge: heldBridge ?? bridge, scope: bridgeScope, grace: options.stopGrace)
        starting = nil
        lock.unlock()
        log("Simulator preview ready at \(bridge.url)")
        return .object([(JSText("url"), .string(JSText(bridge.url))), (JSText("pid"), .number(Double(metro.pid))),
                        (JSText("udid"), .string(JSText(udid))), (JSText("bundleId"), .string(JSText(bundleID))),
                        (JSText("previewKind"), .string(JSText("simulator")))])
    }

    private func boot(_ udid: String, scope: ToolScope) throws {
        log("Booting simulator \(udid)…")
        do { _ = try xcrun(["simctl", "boot", udid], timeout: 60, scope: scope) } catch let refusal as PlatformRefusal {
            // "Unable to boot device in current state: Booted" just means it is already up.
            guard refusal.code != .cancelled, refusal.message.range(of: "current state: Booted", options: .caseInsensitive) != nil else { throw refusal }
        }
        _ = try xcrun(["simctl", "bootstatus", udid, "-b"], timeout: 120, scope: scope)
        // Show the Simulator window too (capture works headless); failures are not fatal.
        if let open = options.open { _ = try? PlatformTool.run(open, ["-a", "Simulator"], environment: options.environment, timeout: 8, scope: scope) }
    }

    /// `expo.ios.bundleIdentifier` from app.json / app.config.json (a regular file of the project, ≤ 1 MiB).
    static func bundleID(_ root: String) -> String {
        let canonical = StaticSite.realPath(root) ?? root
        for name in ["app.json", "app.config.json"] {
            guard let real = StaticSite.realPath(root + "/" + name), real.hasPrefix(canonical + "/"), SourcePaths.isRegularFile(real),
                  let handle = FileHandle(forReadingAtPath: real) else { continue }
            let data = (try? handle.read(upToCount: 1 << 20)) ?? nil
            try? handle.close()
            guard let data, let value = try? JSValue.parse(data, maxDepth: 64) else { continue }
            if let id = value["expo"]?["ios"]?["bundleIdentifier"]?.text?.string ?? value["ios"]?["bundleIdentifier"]?.text?.string { return id }
        }
        return ""
    }

    private func interaction(udid: String, scope: ToolScope) -> SimulatorBridge.Interaction {
        let size = SizeBox()
        return SimulatorBridge.Interaction(
            send: { [weak self] command in
                guard let self else { throw SimulatorCoordinator.cancelled }
                var dims: (width: Double, height: Double)
                if let known = size.value { dims = known } else { dims = try self.screen(udid, scope: scope); size.value = dims }
                _ = try self.idb(SimulatorTools.idbArguments(udid: udid, command, size: dims), scope: scope)
            },
            selecting: { [weak self] in self?.selectMode ?? false },
            select: { [weak self] fx, fy in
                DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                    guard let self else { return }
                    do {
                        let dims = try self.screen(udid, scope: scope)
                        let point = SimulatorTools.points(fx, fy, dims)
                        let output = try self.idb(["ui", "describe-point", "--udid", udid, "--json", String(point.0), String(point.1)], timeout: 8, scope: scope)
                        guard let node = try? JSValue.parse(Data(output.utf8), maxDepth: 64) else { throw IdbFailure(description: "Unexpected output from idb.", stale: false) }
                        // No stamp is still a pick: the inspector then offers the setup instead of the tap doing nothing.
                        self.picked(SimulatorTools.stamp(node).flatMap(SimulatorTools.source(testID:)), node["type"]?.text?.string ?? "element")
                    } catch {
                        if !scope.isCancelled { self.log("Element select failed: \(error)") }
                    }
                }
            })
    }

    // MARK: Stop

    /// Stops the preview and any start under way; true when there was something to stop.
    @discardableResult
    func stop() -> Bool {
        lock.lock()
        generation += 1
        let attempt = starting, current = running
        starting = nil; running = nil
        lock.unlock()
        attempt?.abort()
        current?.shutdown()
        return attempt != nil || current != nil
    }

    /// Service shutdown: refuse new starts and stop everything (bounded).
    @discardableResult
    func close(timeout: TimeInterval) -> Bool {
        lock.lock(); closed = true; lock.unlock()
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.global().async { self.stop(); done.signal() }
        return done.wait(timeout: .now() + timeout) == .success
    }

    private final class SizeBox: @unchecked Sendable {
        private let lock = NSLock()
        private var stored: (width: Double, height: Double)?
        var value: (width: Double, height: Double)? {
            get { lock.lock(); defer { lock.unlock() }; return stored }
            set { lock.lock(); stored = newValue; lock.unlock() }
        }
    }
}

/// Metro's launch output: log lines, the device Expo names, and the readiness verdict
/// (a marker, a build failure, or the process exiting first).
final class MetroGate: @unchecked Sendable {
    private let condition = NSCondition()
    private let log: @Sendable (String) -> Void
    private var outcome: String??
    private var tail = ""
    private var sniffed: String?

    init(log: @escaping @Sendable (String) -> Void) { self.log = log }

    var launchedName: String? { condition.lock(); defer { condition.unlock() }; return sniffed }

    func output(_ chunk: Data) {
        let text = RuntimeNet.stripAnsi(String(decoding: chunk, as: UTF8.self))
        condition.lock()
        tail = SimulatorTools.tail(tail + text, 8000)
        var lines: [String] = []
        for line in text.components(separatedBy: "\n") where !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            lines.append(SimulatorTools.trimEnd(line))
            if sniffed == nil { sniffed = SimulatorTools.launchedDevice(line) }
        }
        if outcome == nil {
            if SimulatorTools.matches(SimulatorTools.ready, text) { outcome = .some(nil); condition.broadcast() }
            else if SimulatorTools.matches(SimulatorTools.buildFailed, text) {
                outcome = .some("The app failed to build/launch.\n\(SimulatorTools.extractBuildError(tail))"); condition.broadcast()
            }
        }
        condition.unlock()
        for line in lines { log(line) }
    }

    func exited(_ code: Int32?) {
        condition.lock()
        if outcome == nil {
            outcome = .some("Dev process exited (code \(code.map(String.init) ?? "null")) before launching.\n\(SimulatorTools.extractBuildError(tail))")
            condition.broadcast()
        }
        condition.unlock()
    }

    /// Nil when Metro is ready (or no marker came in time: capture proceeds), else the failure.
    func wait(timeout: TimeInterval, cancelled: () -> Bool) -> String? {
        let deadline = Date().addingTimeInterval(timeout)
        condition.lock()
        while outcome == nil && !cancelled() && Date() < deadline {
            _ = condition.wait(until: min(deadline, Date().addingTimeInterval(0.1)))
        }
        let result = outcome
        condition.unlock()
        if let result { return result }
        if !cancelled() { log("No Metro readiness marker yet — proceeding to capture the screen.") }
        return nil
    }
}
