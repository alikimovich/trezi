import Foundation
import Darwin

// Line-driven process around the real PreferencesOwner + OperationLedger on a
// profile directory. A line starting with {"service" is a Bun frame and is
// answered with the owner's reply frame; {"cmd":…} lines are fixture commands.
// PREFS_FAIL=<create|write|flush|rename|directory> fails that write step once.
// PREFS_CRASH=<intent|effect|after-rename|receipt> SIGKILLs at that boundary.

setvbuf(stdout, nil, _IOLBF, 0)
let env = ProcessInfo.processInfo.environment
let profile = URL(fileURLWithPath: CommandLine.arguments[1])
let crash = env["PREFS_CRASH"]
/// SIGKILL may land on another thread after kill() returns: never run past it.
func die(at point: String) { if crash == point { kill(getpid(), SIGKILL); while true { pause() } } }
func emit(_ data: Data) { FileHandle.standardOutput.write(data + Data([10])) }
func emit(_ fields: [(String, JSValue)]) { emit(JSValue.object(fields.map { (JSText($0.0), $0.1) }).utf8()) }

final class Once: @unchecked Sendable {
    private let lock = NSLock(); private var step: String?
    init(_ step: String?) { self.step = step }
    func take(_ candidate: String) -> Bool { lock.lock(); defer { lock.unlock() }; if step == candidate { step = nil; return true }; return false }
}
let failure = Once(env["PREFS_FAIL"])
var disk = PreferencesDisk(path: profile.appendingPathComponent("preferences.json").path)
disk.fault = { step in if failure.take(step.rawValue) { throw PreferencesError.io(step, EIO) } }
disk.afterRename = { die(at: "after-rename") }
var options = LedgerOptions()
options.boundary = { die(at: $0.rawValue) }

func decode(_ path: String) -> [(String, JSValue)] {
    guard let data = FileManager.default.contents(atPath: path) else { return [("ok", .bool(false)), ("error", .string(JSText("unreadable")))] }
    guard let values = try? PreferenceValues.decode(data) else { return [("ok", .bool(false))] }
    return [("ok", .bool(true)),
            ("entries", .array(values.entries.map { .array([.string($0.key), $0.value.map(JSValue.string) ?? .null]) })),
            ("encoded", .string(JSText(values.encoded().base64EncodedString())))]
}

let ledger = try? OperationLedger(directory: profile.appendingPathComponent("service/ledger"), options: options)
let owner = PreferencesOwner(disk: disk, ledger: ledger)
await owner.open()
await owner.onChange { emit($0) }
emit([("ready", .bool(true)), ("ledger", .bool(ledger != nil))])

while let line = readLine(strippingNewline: true) {
    let data = Data(line.utf8)
    if line.hasPrefix("{\"service\"") { emit(await owner.handle(data)); continue }
    guard let command = try? JSValue.parse(data), let name = command["cmd"]?.text?.string else { emit([("error", .string(JSText("bad command")))]); continue }
    switch name {
    case "decode": emit(decode(command["path"]?.text?.string ?? ""))
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
