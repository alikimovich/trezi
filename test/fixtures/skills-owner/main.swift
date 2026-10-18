import Foundation
import Darwin

// Line-driven process around the real SkillsOwner + OperationLedger on a profile
// directory. A line starting with {"service" is a Bun frame and is answered with the
// owner's reply frame; {"cmd":…} lines are fixture commands (the service-internal
// `install` and `pin` seams, concurrent frames, close).
// SKILLS_NOW=<ms> fixes the clock.
// SKILLS_FAIL=<create|write|flush|rename|directory> fails that manifest write step once.
// SKILLS_CRASH=<intent|effect|after-rename|receipt> SIGKILLs at that boundary.

setvbuf(stdout, nil, _IOLBF, 0)
let env = ProcessInfo.processInfo.environment
let profile = URL(fileURLWithPath: CommandLine.arguments[1])
let crash = env["SKILLS_CRASH"]
/// SIGKILL may land on another thread after kill() returns: never run past it.
func die(at point: String) { if crash == point { kill(getpid(), SIGKILL); while true { pause() } } }
func emit(_ data: Data) { FileHandle.standardOutput.write(data + Data([10])) }
func emit(_ fields: [(String, JSValue)]) { emit(JSValue.object(fields.map { (JSText($0.0), $0.1) }).utf8()) }

final class Once: @unchecked Sendable {
    private let lock = NSLock(); private var step: String?
    init(_ step: String?) { self.step = step }
    func take(_ candidate: String) -> Bool { lock.lock(); defer { lock.unlock() }; if step == candidate { step = nil; return true }; return false }
}
let failure = Once(env["SKILLS_FAIL"])
var store = SkillsStore(profile: profile)
store.fault = { step in if failure.take(step.rawValue) { throw PreferencesError.io(step, EIO) } }
store.afterRename = { die(at: "after-rename") }
var options = LedgerOptions()
options.boundary = { die(at: $0.rawValue) }
let fixed = env["SKILLS_NOW"].flatMap(Double.init)
let clock: @Sendable () -> Double = { fixed ?? (Date().timeIntervalSince1970 * 1000).rounded(.down) }

func answer(_ result: PreferencesOwner.Answer) -> JSValue {
    switch result {
    case .succeeded(let payload): return .object([(JSText("kind"), .string(JSText("succeeded"))), (JSText("payload"), payload)])
    case .failed(let failure): return .object([(JSText("kind"), .string(JSText("failed"))), (JSText("payload"), PreferencesOwner.value(failure))])
    }
}

let ledger = try? OperationLedger(directory: profile.appendingPathComponent("service/ledger"), options: options)
let owner = SkillsOwner(store: store, ledger: ledger, now: clock)
await owner.open()
emit([("ready", .bool(true)), ("ledger", .bool(ledger != nil))])

while let line = readLine(strippingNewline: true) {
    let data = Data(line.utf8)
    if line.hasPrefix("{\"service\"") { emit(await owner.handle(data)); continue }
    guard let command = try? JSValue.parse(data), let name = command["cmd"]?.text?.string else { emit([("error", .string(JSText("bad command")))]); continue }
    switch name {
    case "install":
        // The GitHub import's seam: files as {path,text}, a source value, optional replacing.
        guard case .array(let items)? = command["files"], let source = SkillSource(command["source"]) else {
            emit([("result", answer(.failed(SkillsOwner.fail(.invalidRequest, "Invalid source."))))]); continue
        }
        let files = items.map { SkillFile(path: $0["path"]?.text?.string ?? "", data: Data(($0["text"]?.text?.string ?? "").utf8)) }
        emit([("result", answer(await owner.install(files: files, source: source, replacing: command["replacing"]?.text?.string)))])
    case "pin":
        emit([("result", answer(await owner.pin(session: command["session"]?.text?.string ?? "")))])
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
