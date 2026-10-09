import Foundation
import Darwin

// Line-driven process around the real RuntimeOwner (S06) on a profile directory.
// `{"service"…` lines are Bun frames (answers and events go to stdout); `{"cmd"…}`
// lines are fixture commands. The binary is also its own watchdog (`--watch-group`).
// RUNTIME_PORT=<n> fixes the allocated port (no bind probe: the sandbox may forbid it).
// RUNTIME_PORT_BASE=<n> keeps the real bind probe but starts it at <n> instead of 7777.
// RUNTIME_READY_TIMEOUT / RUNTIME_INSTALL_TIMEOUT / RUNTIME_STAMP_TIMEOUT /
// RUNTIME_HEALTH_INTERVAL (seconds), RUNTIME_HEALTH_FAILURES.
// RUNTIME_NO_WATCHDOG=1 leaves crash recovery to the journal alone.

signal(SIGPIPE, SIG_IGN)
if CommandLine.arguments.count > 1, CommandLine.arguments[1] == "--watch-group" {
    runGroupWatchdog(arguments: Array(CommandLine.arguments.dropFirst(2)))
}
setvbuf(stdout, nil, _IOLBF, 0)
let env = ProcessInfo.processInfo.environment
let profile = CommandLine.arguments[1]
let output = NSLock()
func emit(_ data: Data) { output.lock(); FileHandle.standardOutput.write(data + Data([10])); output.unlock() }
func emit(_ fields: [(String, JSValue)]) { emit(JSValue.object(fields.map { (JSText($0.0), $0.1) }).utf8()) }
func string(_ value: String) -> JSValue { .string(JSText(value)) }
func seconds(_ name: String, _ fallback: TimeInterval) -> TimeInterval { env[name].flatMap(Double.init) ?? fallback }

let journal = RuntimeJournal(profile: profile)
let swept = journal.sweep()
var options = RuntimeOwner.Options(environment: env, watchdog: env["RUNTIME_NO_WATCHDOG"] == "1" ? nil : CommandLine.arguments[0], journal: journal)
if let fixed = env["RUNTIME_PORT"].flatMap(Int.init) {
    options.allocatePort = { reserved in var port = fixed; while reserved.contains(port) { port += 1 }; return port }
} else if let base = env["RUNTIME_PORT_BASE"].flatMap(Int.init) {
    options.allocatePort = { RuntimeNet.freePort(from: base, reserved: $0) }
}
// RUNTIME_PROBE_FILE: every probe answers 200 while that file exists (no socket needed).
if let file = env["RUNTIME_PROBE_FILE"] {
    options.probe = { _ in access(file, F_OK) == 0 ? 200 : nil }
    options.healthProbe = options.probe
}
options.healthInterval = seconds("RUNTIME_HEALTH_INTERVAL", 10)
options.healthFailures = Int(seconds("RUNTIME_HEALTH_FAILURES", 3))
options.readyTimeout = seconds("RUNTIME_READY_TIMEOUT", 90)
options.installTimeout = seconds("RUNTIME_INSTALL_TIMEOUT", 300)
options.stampTimeout = seconds("RUNTIME_STAMP_TIMEOUT", 5)
let owner = RuntimeOwner(options: options, send: { emit($0) })
emit([("ready", .bool(true)), ("swept", .array(swept.map { .number(Double($0)) }))])

/// A socketpair connection served by the real HTTP layer; returns the raw response.
func exchange(_ site: StaticSite, _ request: String, hold: TimeInterval = 0) -> (Data, Int32) {
    var pair: [Int32] = [0, 0]
    socketpair(AF_UNIX, SOCK_STREAM, 0, &pair)
    let server = pair[0], client = pair[1]
    DispatchQueue.global().async { StaticServer.serve(server, site: site) }
    _ = StaticServer.writeAll(client, Data(request.utf8))
    var timeout = timeval(tv_sec: 5, tv_usec: 0)
    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var data = Data(), buffer = [UInt8](repeating: 0, count: 65536)
    let deadline = Date().addingTimeInterval(hold > 0 ? hold : 5)
    while Date() < deadline {
        let count = read(client, &buffer, buffer.count)
        if count <= 0 { break }
        data.append(contentsOf: buffer[..<count])
        if hold > 0 && data.range(of: Data("retry: 1000\n\n".utf8)) != nil { break }
    }
    return (data, client)
}

func readMore(_ fd: Int32, until marker: String, timeout: TimeInterval) -> Data {
    var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
    var interval = timeval(tv_sec: 0, tv_usec: 200_000)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &interval, socklen_t(MemoryLayout<timeval>.size))
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        let count = read(fd, &buffer, buffer.count)
        if count == 0 { break }
        if count > 0 { data.append(contentsOf: buffer[..<count]); if String(decoding: data, as: UTF8.self).contains(marker) { break } }
    }
    return data
}

var sites: [String: StaticSite] = [:]
var streams: [String: Int32] = [:]
func site(_ command: JSValue) -> StaticSite {
    let root = command["root"]?.text?.string ?? "/"
    if let existing = sites[root] { return existing }
    let created = StaticSite(root: root, stamp: { html, path in
        env["RUNTIME_STAMP"] == "owner" ? owner.stamp(html, path) : html.replacingOccurrences(of: "<h1", with: "<h1 data-stamped=\"\(path)\"")
    }, log: { line in emit([("log", string(line))]) })
    sites[root] = created
    return created
}

// Bun frames go straight to the owner (as the service's reader thread does), so a
// command blocked on the owner (a stamp awaiting the helper) never holds them back.
let commands = DispatchQueue(label: "fixture.commands")
let finished = DispatchSemaphore(value: 0)
while let line = readLine(strippingNewline: true) {
    let data = Data(line.utf8)
    if line.hasPrefix("{\"service\"") { owner.submit(data); continue }
    commands.async { handle(data) }
}
commands.async { finished.signal() }
finished.wait()
_ = owner.close(timeout: 10)

func handle(_ data: Data) {
    guard let command = try? JSValue.parse(data), let name = command["cmd"]?.text?.string else { emit([("error", string("bad command"))]); return }
    func texts(_ key: String) -> [String] { if case .array(let items)? = command[key] { return items.compactMap { $0.text?.string } }; return [] }
    switch name {
    case "detect":
        emit([("results", .array(texts("roots").map { root in
            do { return try RuntimeDetect.detect(root: root) } catch { return .object([(JSText("error"), string((error as? RuntimeDetect.Failure)?.message ?? "\(error)"))]) }
        }))])
    case "net":
        emit([("urls", .array(texts("texts").map { RuntimeNet.firstURL($0).map(string) ?? .null })),
              ("stripped", .array(texts("texts").map { string(RuntimeNet.stripAnsi($0)) })),
              ("normalized", .array(texts("raw").map { string(RuntimeNet.normalizeURL($0)) })),
              ("variants", .array(texts("raw").map { .array(RuntimeNet.hostVariants($0).map(string)) })),
              ("trimmed", .array(texts("texts").map { string(RuntimeDetect.jsTrim($0)) }))])
    case "commands":
        guard case .array(let cases)? = command["cases"] else { return }
        emit([("commands", .array(cases.map { item in
            string(RuntimeDetect.withPort(item["command"]?.text?.string ?? "", framework: item["framework"]?.text?.string, port: 7777))
        })), ("failures", .array(cases.map { item in
            var code: Int32?
            if case .number(let value)? = item["code"] { code = Int32(value) }
            let result = RuntimeDetect.interpretFailure(code: code, tail: item["tail"]?.text ?? [])
            return .object([(JSText("conflict"), .bool(result.conflict)), (JSText("message"), string(result.message))])
        }))])
    case "http":
        let (response, fd) = exchange(site(command), command["request"]?.text?.string ?? "")
        close(fd)
        emit([("response", string(response.base64EncodedString()))])
    case "open-stream":
        let key = command["name"]?.text?.string ?? "stream"
        let (response, fd) = exchange(site(command), command["request"]?.text?.string ?? "", hold: 3)
        streams[key] = fd
        emit([("response", string(response.base64EncodedString())), ("clients", .number(Double(site(command).clientCount)))])
    case "read-stream":
        let fd = streams[command["name"]?.text?.string ?? "stream"] ?? -1
        let received = readMore(fd, until: command["until"]?.text?.string ?? "\n\n", timeout: seconds("RUNTIME_READ", 3))
        emit([("received", string(String(decoding: received, as: UTF8.self)))])
    case "changed": site(command).changed(); emit([("version", .number(Double(site(command).currentVersion)))])
    case "watch": site(command).watch(); emit([("watching", .bool(site(command).watching))])
    case "state":
        let current = site(command)
        emit([("version", .number(Double(current.currentVersion))), ("clients", .number(Double(current.clientCount))), ("watching", .bool(current.watching))])
    case "close-site": site(command).close(); emit([("closed", .bool(true)), ("watching", .bool(site(command).watching))])
    case "identity":
        var pid: pid_t = 0
        if case .number(let value)? = command["pid"] { pid = pid_t(value) }
        emit([("started", GroupIdentity.of(pid).map { string(String($0.started)) } ?? .null)])
    case "journal": emit([("groups", .array(RuntimeJournal.read(journal.path).map { .number(Double($0.pgid)) }))])
    case "close":
        let drained = owner.close(timeout: 10)
        emit([("closed", .bool(drained)), ("groups", .array(RuntimeJournal.read(journal.path).map { .number(Double($0.pgid)) }))])
    case "bind": emit([("bind", string("\(RuntimeNet.tryBind(port: 0, address: RuntimeNet.previewHost))"))])
    case "free":
        var port = 0
        if case .number(let value)? = command["port"] { port = Int(value) }
        emit([("free", .bool(RuntimeNet.isPortFree(port)))])
    default: emit([("error", string("unknown command \(name)"))])
    }
}
