import Foundation
import Darwin

// Line-driven process around the real PlatformOwner (S14) on a profile directory.
// `{"service":"platform"…` lines are Bun frames (answers and events go to stdout);
// `{"cmd"…}` lines are fixture commands. As the service does under the profile lock,
// it first sweeps the runtime journal (groups a crashed owner left) and reports them.
// Tool paths and bounds come from PLATFORM_* variables, so the scripted xcrun, idb and
// pkill in this folder stand in for the real ones; nothing here reaches a simulator.

signal(SIGPIPE, SIG_IGN)
setvbuf(stdout, nil, _IOLBF, 0)
let env = ProcessInfo.processInfo.environment
let profile = CommandLine.arguments[1]
let output = NSLock()
func emit(_ data: Data) { output.lock(); FileHandle.standardOutput.write(data + Data([10])); output.unlock() }
func emit(_ fields: [(String, JSValue)]) { emit(JSValue.object(fields.map { (JSText($0.0), $0.1) }).utf8()) }
func number(_ key: String, _ fallback: Double) -> Double { env[key].flatMap(Double.init) ?? fallback }

let journal = RuntimeJournal(profile: profile)
let swept = journal.sweep()
emit([("swept", .array(swept.map { .number(Double($0)) }))])

var simulator = SimulatorCoordinator.Options(environment: env, scratch: profile + "/service/simulator")
simulator.journal = journal
simulator.open = nil
simulator.xcrun = env["PLATFORM_XCRUN"] ?? "/nonexistent/xcrun"
simulator.pkill = env["PLATFORM_PKILL"] ?? "/nonexistent/pkill"
simulator.idbCandidates = (env["PLATFORM_IDB"] ?? "").split(separator: ":").map(String.init)
simulator.idbState = env["PLATFORM_IDB_STATE"] ?? profile + "/idb-state"
simulator.fps = number("PLATFORM_FPS", 20)
simulator.firstFrameTimeout = number("PLATFORM_FIRST_FRAME", 5)
simulator.markerTimeout = number("PLATFORM_MARKER", 20)
simulator.stopGrace = 0.3
simulator.bridgePortBase = Int(number("PLATFORM_BRIDGE_BASE", 7800))

// Opening: PLATFORM_OPEN stands in for /usr/bin/open; the editor CLIs are the real list,
// looked up on this process's PATH (the test puts scripted ones there).
let opening = PlatformOpen.Tools(open: env["PLATFORM_OPEN"] ?? "/nonexistent/open", environment: env, timeout: number("PLATFORM_EDITOR_TIMEOUT", 5))
let options = PlatformOwner.Options(profile: profile, environment: env, watchdog: nil, journal: journal,
    mediaTTL: number("PLATFORM_MEDIA_TTL", 900), maxMediaTokens: Int(number("PLATFORM_MEDIA_TOKENS", 500)),
    maxMediaBytes: Int64(number("PLATFORM_MEDIA_MAX", 256 * 1024 * 1024)),
    maxAttachmentBytes: Int(number("PLATFORM_ATTACH_MAX", 25 * 1024 * 1024)), attachmentIdle: number("PLATFORM_ATTACH_IDLE", 60),
    open: opening, simulator: simulator)
let owner = PlatformOwner(options: options, send: { emit($0) })
emit([("ready", .bool(true))])

let commands = DispatchQueue(label: "fixture.commands")
let finished = DispatchSemaphore(value: 0)
while let line = readLine(strippingNewline: true) {
    let data = Data(line.utf8)
    if line.hasPrefix("{\"service\":\"platform\"") { owner.submit(data); continue }
    commands.async {
        guard let command = try? JSValue.parse(data), let name = command["cmd"]?.text?.string else { return emit([("error", .string(JSText("bad command")))]) }
        switch name {
        case "close":
            emit([("closed", .bool(owner.close(timeout: 5)))])
        case "journal":
            emit([("journal", .array(RuntimeJournal.read(journal.path).map { .number(Double($0.pgid)) }))])
        case "pure":
            // The pure helpers, for direct parity checks against the TS originals.
            var results: [(String, JSValue)] = []
            if let log = command["log"]?.text?.string { results.append(("extract", .string(JSText(SimulatorTools.extractBuildError(log))))) }
            if let sdk = command["sdk"]?.text?.string, case .array(let runtimes)? = command["runtimes"] {
                results.append(("destination", SimulatorTools.buildDestination(sdk: sdk, runtimes: runtimes.compactMap { $0.text?.string })
                    .map { .string(JSText($0)) } ?? .null))
            }
            if let id = command["testID"]?.text?.string { results.append(("source", SimulatorTools.source(testID: id).map { .string(JSText($0)) } ?? .null)) }
            if let node = command["node"] { results.append(("stamp", SimulatorTools.stamp(node).map { .string(JSText($0)) } ?? .null)) }
            if let body = command["control"] {
                let args = SimulatorTools.command(body).map { SimulatorTools.idbArguments(udid: "U", $0, size: (402, 874)) }
                results.append(("args", args.map { .array($0.map { .string(JSText($0)) }) } ?? .null))
            }
            if let name = command["attachment"]?.text?.string, let type = command["mediaType"]?.text?.string {
                results.append(("fileName", .string(JSText(AttachmentUploads.fileName(mediaType: type, name: name, stamp: "1")))))
            }
            if let message = command["xcodeMessage"]?.text?.string {
                results.append(("reason", .string(JSText(SimulatorTools.xcodeFailureReason(message: message, stderr: command["stderr"]?.text?.string ?? "",
                                                                                            missing: command["missing"] == .bool(true))))))
            }
            emit([("pure", .object(results.map { (JSText($0.0), $0.1) }))])
        default: emit([("error", .string(JSText("unknown command \(name)")))])
        }
    }
}
commands.async { finished.signal() }
finished.wait()
_ = owner.close(timeout: 5)
