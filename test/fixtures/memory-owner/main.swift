import Foundation
import Darwin

// Line-driven process around the real MemoryOwner + OperationLedger on a profile
// directory. A line starting with {"service" is a Bun frame and is answered with the
// owner's reply frame; {"cmd":…} lines are fixture commands.
// MEMORY_NOW=<ms> fixes the clock (parity with the Bun writer's injected clock).
// MEMORY_FAIL=<create|write|flush|rename|directory> fails that write step once.
// MEMORY_CRASH=<intent|effect|after-rename|receipt> SIGKILLs at that boundary.

setvbuf(stdout, nil, _IOLBF, 0)
let env = ProcessInfo.processInfo.environment
let profile = URL(fileURLWithPath: CommandLine.arguments[1])
let crash = env["MEMORY_CRASH"]
/// SIGKILL may land on another thread after kill() returns: never run past it.
func die(at point: String) { if crash == point { kill(getpid(), SIGKILL); while true { pause() } } }
func emit(_ data: Data) { FileHandle.standardOutput.write(data + Data([10])) }
func emit(_ fields: [(String, JSValue)]) { emit(JSValue.object(fields.map { (JSText($0.0), $0.1) }).utf8()) }

final class Once: @unchecked Sendable {
    private let lock = NSLock(); private var step: String?
    init(_ step: String?) { self.step = step }
    func take(_ candidate: String) -> Bool { lock.lock(); defer { lock.unlock() }; if step == candidate { step = nil; return true }; return false }
}
let failure = Once(env["MEMORY_FAIL"])
var store = MemoryStore(profile: profile)
store.fault = { step in if failure.take(step.rawValue) { throw PreferencesError.io(step, EIO) } }
store.afterRename = { die(at: "after-rename") }
var options = LedgerOptions()
options.boundary = { die(at: $0.rawValue) }
let fixed = env["MEMORY_NOW"].flatMap(Double.init)
let clock: @Sendable () -> Double = { fixed ?? (Date().timeIntervalSince1970 * 1000).rounded(.down) }

/// Offline parity: file IDs, the stored bytes for a save, and the reader's verdicts.
func parity(_ command: JSValue) -> [(String, JSValue)] {
    var ids: [JSValue] = [], encoded: [JSValue] = [], decoded: [JSValue] = []
    if case .array(let roots)? = command["roots"] { ids = roots.map { .string(JSText(MemoryRecord.fileID(root: $0.text ?? []))) } }
    if case .array(let contents)? = command["contents"] {
        encoded = contents.map { .string(JSText(MemoryRecord(content: MemoryRecord.normalize($0.text ?? []), updatedAt: clock()).encoded().base64EncodedString())) }
    }
    if case .array(let files)? = command["files"] {
        decoded = files.map { file in
            guard let data = Data(base64Encoded: (file.text ?? []).string), let record = try? MemoryRecord.decode(data) else { return .null }
            return .object([(JSText("content"), .string(record.content)), (JSText("updatedAt"), .number(record.updatedAt))])
        }
    }
    return [("ids", .array(ids)), ("encoded", .array(encoded)), ("decoded", .array(decoded))]
}

let ledger = try? OperationLedger(directory: profile.appendingPathComponent("service/ledger"), options: options)
let owner = MemoryOwner(store: store, ledger: ledger, now: clock)
await owner.open()
emit([("ready", .bool(true)), ("ledger", .bool(ledger != nil))])

while let line = readLine(strippingNewline: true) {
    let data = Data(line.utf8)
    if line.hasPrefix("{\"service\"") { emit(await owner.handle(data)); continue }
    guard let command = try? JSValue.parse(data), let name = command["cmd"]?.text?.string else { emit([("error", .string(JSText("bad command")))]); continue }
    switch name {
    case "parity": emit(parity(command))
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
