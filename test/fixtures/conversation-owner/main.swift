import Foundation
import Darwin

// Line-driven process around the real ConversationOwner (S11) on a profile directory,
// with the RepositoryOwner and SourceOwner a chat's landing and Undo go through (as in
// the service). `{"service":"conversation"|"repository"|"source"…` lines are Bun frames
// (answers go to stdout); `{"cmd"…}` lines are fixture commands.
// CONVERSATION_FAULT=<point> SIGKILLs the process at that named point inside a write (checkpoint.write, session.write; the nth time with
// CONVERSATION_FAULT_COUNT=n), so the next process sees what a crashed service leaves.

signal(SIGPIPE, SIG_IGN)
setvbuf(stdout, nil, _IOLBF, 0)
let env = ProcessInfo.processInfo.environment
let profile = CommandLine.arguments[1]
let output = NSLock()
func emit(_ data: Data) { output.lock(); FileHandle.standardOutput.write(data + Data([10])); output.unlock() }
func emit(_ fields: [(String, JSValue)]) { emit(JSValue.object(fields.map { (JSText($0.0), $0.1) }).utf8()) }

let crash = env["CONVERSATION_FAULT"]
/// CONVERSATION_FAULT_COUNT=n crashes at the nth time the point is reached (default 1).
let crashAt = Int(env["CONVERSATION_FAULT_COUNT"] ?? "1") ?? 1
final class Hits: @unchecked Sendable { let lock = NSLock(); var count = 0 }
let hits = Hits()
/// SIGKILL may land on another thread after kill() returns: never run past it.
let fault: @Sendable (String) -> Void = { point in
    guard point == crash else { return }
    hits.lock.lock(); hits.count += 1; let reached = hits.count >= crashAt; hits.lock.unlock()
    if reached { kill(getpid(), SIGKILL); while true { pause() } }
}
let owner = ConversationOwner(options: ConversationOwner.Options(profile: profile, fault: fault), send: { emit($0) })
// REPOSITORY_WORKTREES_ROOT widens where worktrees may live (the chat and Git suites use the temp dir).
let repository = RepositoryOwner(options: RepositoryOwner.Options(profile: profile, environment: env,
                                                                 worktreesRoot: env["REPOSITORY_WORKTREES_ROOT"]), send: { emit($0) })
let source = SourceOwner(options: SourceOwner.Options(profile: profile), repository: repository, send: { emit($0) })
emit([("ready", .bool(true))])

let commands = DispatchQueue(label: "fixture.commands")
let finished = DispatchSemaphore(value: 0)
while let line = readLine(strippingNewline: true) {
    let data = Data(line.utf8)
    if line.hasPrefix("{\"service\":\"conversation\"") { owner.submit(data); continue }
    if line.hasPrefix("{\"service\":\"repository\"") { repository.submit(data); continue }
    if line.hasPrefix("{\"service\":\"source\"") { source.submit(data); continue }
    commands.async {
        guard let command = try? JSValue.parse(data), let name = command["cmd"]?.text?.string else { return emit([("error", .string(JSText("bad command")))]) }
        switch name {
        case "close": emit([("closed", .bool(owner.close(timeout: 5)))])
        default: emit([("error", .string(JSText("unknown command \(name)")))])
        }
    }
}
commands.async { finished.signal() }
finished.wait()
_ = owner.close(timeout: 10)
source.refuse()
_ = repository.close(timeout: 10)
_ = source.close(timeout: 10)
