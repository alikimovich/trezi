import Foundation
import Darwin

// Line-driven process around the real WorkspaceOwner + OperationLedger on a profile
// directory. A line starting with {"service" is a Bun frame and is answered with the
// owner's reply frame; {"cmd":…} lines are fixture commands.
// WORKSPACE_NOW=<ms> fixes the clock (parity with the Bun writer's injected clock).
// WORKSPACE_FAIL=<create|write|flush|rename|directory> fails that write step once.
// WORKSPACE_CRASH=<intent|effect|after-rename|receipt> SIGKILLs at that boundary.

setvbuf(stdout, nil, _IOLBF, 0)
let env = ProcessInfo.processInfo.environment
let profile = URL(fileURLWithPath: CommandLine.arguments[1])
let crash = env["WORKSPACE_CRASH"]
/// SIGKILL may land on another thread after kill() returns: never run past it.
func die(at point: String) { if crash == point { kill(getpid(), SIGKILL); while true { pause() } } }
func emit(_ data: Data) { FileHandle.standardOutput.write(data + Data([10])) }
func emit(_ fields: [(String, JSValue)]) { emit(JSValue.object(fields.map { (JSText($0.0), $0.1) }).utf8()) }

final class Once: @unchecked Sendable {
    private let lock = NSLock(); private var step: String?
    init(_ step: String?) { self.step = step }
    func take(_ candidate: String) -> Bool { lock.lock(); defer { lock.unlock() }; if step == candidate { step = nil; return true }; return false }
}
let failure = Once(env["WORKSPACE_FAIL"])
var disk = PreferencesDisk(path: profile.appendingPathComponent("workspace.json").path)
disk.fault = { step in if failure.take(step.rawValue) { throw PreferencesError.io(step, EIO) } }
disk.afterRename = { die(at: "after-rename") }
var options = LedgerOptions()
options.boundary = { die(at: $0.rawValue) }
let fixed = env["WORKSPACE_NOW"].flatMap(Double.init)
let clock: @Sendable () -> Double = { fixed ?? (Date().timeIntervalSince1970 * 1000).rounded(.down) }

func view(_ document: WorkspaceDocument) -> JSValue {
    .object([(JSText("projects"), .array(document.entries().map(\.entry))),
             (JSText("activeKey"), document.activeKey.map(JSValue.string) ?? .null),
             (JSText("recents"), .array(document.recents))])
}

/// Offline: decode a file and apply operations without the ledger (parity checks).
func apply(_ command: JSValue) -> [(String, JSValue)] {
    guard let path = command["path"]?.text?.string, let data = FileManager.default.contents(atPath: path) else { return [("ok", .bool(false))] }
    guard var document = try? WorkspaceDocument.decode(data) else { return [("ok", .bool(false))] }
    var results: [JSValue] = []
    if case .array(let ops)? = command["ops"] {
        for op in ops {
            guard case .object(let fields) = op, let method = op["method"]?.text?.string else { results.append(.string(JSText("invalidRequest"))); continue }
            do {
                let operation = try WorkspaceOperation(method: method, body: fields.filter { $0.0.string != "method" })
                let applied = try document.apply(operation, now: clock(), resolve: { resolveWorkspaceRoot($0) })
                var out: [(JSText, JSValue)] = [(JSText("changed"), .bool(applied.changed))]
                if let key = applied.key { out.append((JSText("key"), .string(key))) }
                if let created = applied.created { out.append((JSText("created"), .bool(created))) }
                results.append(.object(out))
            } catch WorkspaceError.notFound { results.append(.string(JSText("notFound")))
            } catch WorkspaceError.tooMany { results.append(.string(JSText("busy")))
            } catch { results.append(.string(JSText("invalidRequest"))) }
        }
    }
    return [("ok", .bool(true)), ("view", view(document)), ("results", .array(results)),
            ("encoded", .string(JSText(document.encoded().base64EncodedString())))]
}

let ledger = try? OperationLedger(directory: profile.appendingPathComponent("service/ledger"), options: options)
let owner = WorkspaceOwner(disk: disk, ledger: ledger, now: clock)
await owner.open()
await owner.onChange { emit($0) }
emit([("ready", .bool(true)), ("ledger", .bool(ledger != nil))])

while let line = readLine(strippingNewline: true) {
    let data = Data(line.utf8)
    if line.hasPrefix("{\"service\"") { emit(await owner.handle(data)); continue }
    guard let command = try? JSValue.parse(data), let name = command["cmd"]?.text?.string else { emit([("error", .string(JSText("bad command")))]); continue }
    switch name {
    case "apply": emit(apply(command))
    case "number":
        guard case .array(let values)? = command["values"] else { continue }
        emit([("out", .array(values.map { value in
            guard case .number(let number) = value else { return .null }
            return .string(JSText(JSValue.number(number)))
        }))])
    case "concurrent":
        guard case .array(let frames)? = command["frames"] else { continue }
        let replies = await withTaskGroup(of: (Int, Data).self) { group in
            for (index, frame) in frames.enumerated() {
                let bytes = Data((frame.text ?? []).string.utf8)
                group.addTask { (index, await owner.handle(bytes)) }
            }
            var out: [(Int, Data)] = []
            for await reply in group { out.append(reply) }
            return out.sorted { $0.0 < $1.0 }.map { (try? JSValue.parse($0.1)) ?? .null }
        }
        emit([("replies", .array(replies))])
    case "close":
        await owner.close()
        emit([("closed", .bool(true))])
    default: emit([("error", .string(JSText("unknown command")))])
    }
}
