import Foundation
import Darwin

// Line-driven process around the real EditingOwner (S12) on a profile directory, with
// the ConversationOwner its turn binding asks (as in the service), and the
// RepositoryOwner and SourceOwner an island's source writes and the sidecar lanes go
// through. `{"service":"editing"|"conversation"|"repository"|"source"…` lines are Bun
// frames (answers go to stdout); `{"cmd"…}` lines are fixture commands.
// EDITING_FAULT=<point> SIGKILLs the process at that named point (island.write,
// island.written), so the next process sees what a crashed service leaves.

signal(SIGPIPE, SIG_IGN)
setvbuf(stdout, nil, _IOLBF, 0)
let env = ProcessInfo.processInfo.environment
let profile = CommandLine.arguments[1]
let output = NSLock()
func emit(_ data: Data) { output.lock(); FileHandle.standardOutput.write(data + Data([10])); output.unlock() }
func emit(_ fields: [(String, JSValue)]) { emit(JSValue.object(fields.map { (JSText($0.0), $0.1) }).utf8()) }

let crash = env["EDITING_FAULT"]
let fault: @Sendable (String) -> Void = { point in
    guard point == crash else { return }
    kill(getpid(), SIGKILL); while true { pause() }
}
let conversation = ConversationOwner(options: ConversationOwner.Options(profile: profile), send: { emit($0) })
// REPOSITORY_WORKTREES_ROOT widens where worktrees may live (the chat and Git suites use the temp dir).
let repository = RepositoryOwner(options: RepositoryOwner.Options(profile: profile, environment: env,
                                                             worktreesRoot: env["REPOSITORY_WORKTREES_ROOT"]), send: { emit($0) })
let source = SourceOwner(options: SourceOwner.Options(profile: profile), repository: repository, send: { emit($0) })
let editing = EditingOwner(options: EditingOwner.Options(profile: profile, turn: { conversation.turn(of: $0) }, fault: fault),
                           repository: repository, send: { emit($0) })
emit([("ready", .bool(true))])

let commands = DispatchQueue(label: "fixture.commands")
let finished = DispatchSemaphore(value: 0)
while let line = readLine(strippingNewline: true) {
    let data = Data(line.utf8)
    if line.hasPrefix("{\"service\":\"editing\"") { editing.submit(data); continue }
    if line.hasPrefix("{\"service\":\"conversation\"") { conversation.submit(data); continue }
    if line.hasPrefix("{\"service\":\"repository\"") { repository.submit(data); continue }
    if line.hasPrefix("{\"service\":\"source\"") { source.submit(data); continue }
    commands.async {
        guard let command = try? JSValue.parse(data), let name = command["cmd"]?.text?.string else { return emit([("error", .string(JSText("bad command")))]) }
        switch name {
        case "close": emit([("closed", .bool(editing.close(timeout: 5)))])
        default: emit([("error", .string(JSText("unknown command \(name)")))])
        }
    }
}
commands.async { finished.signal() }
finished.wait()
_ = editing.close(timeout: 10)
_ = conversation.close(timeout: 10)
source.refuse()
_ = repository.close(timeout: 10)
_ = source.close(timeout: 10)
