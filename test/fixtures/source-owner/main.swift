import Foundation
import Darwin

// Line-driven process around the real SourceOwner (S08/S09) and the RepositoryOwner
// whose lanes serialize it, on a profile directory. `{"service":"source"…` and
// `{"service":"repository"…` lines are Bun frames (answers go to stdout); `{"cmd"…}`
// lines are fixture commands. SOURCE_FAULT=<point> SIGKILLs the process at that named
// point inside a transaction (commit.write.1, undo.written, …), so the next process
// sees what a crashed service leaves behind.

signal(SIGPIPE, SIG_IGN)
setvbuf(stdout, nil, _IOLBF, 0)
let env = ProcessInfo.processInfo.environment
let profile = CommandLine.arguments[1]
let output = NSLock()
func emit(_ data: Data) { output.lock(); FileHandle.standardOutput.write(data + Data([10])); output.unlock() }
func emit(_ fields: [(String, JSValue)]) { emit(JSValue.object(fields.map { (JSText($0.0), $0.1) }).utf8()) }

let crash = env["SOURCE_FAULT"]
/// SIGKILL may land on another thread after kill() returns: never run past it.
let fault: @Sendable (String) -> Void = { point in if point == crash { kill(getpid(), SIGKILL); while true { pause() } } }
let repository = RepositoryOwner(options: RepositoryOwner.Options(profile: profile, environment: env), send: { emit($0) })
let source = SourceOwner(options: SourceOwner.Options(profile: profile, fault: fault), repository: repository, send: { emit($0) })
emit([("ready", .bool(true))])

let commands = DispatchQueue(label: "fixture.commands")
let finished = DispatchSemaphore(value: 0)
while let line = readLine(strippingNewline: true) {
    let data = Data(line.utf8)
    if line.hasPrefix("{\"service\":\"source\"") { source.submit(data); continue }
    if line.hasPrefix("{\"service\":\"repository\"") { repository.submit(data); continue }
    commands.async {
        guard let command = try? JSValue.parse(data), let name = command["cmd"]?.text?.string else { return emit([("error", .string(JSText("bad command")))]) }
        switch name {
        case "close":
            // The service's order: refuse source requests, drain the lanes, settle.
            source.refuse()
            let repositoryClosed = repository.close(timeout: 5)
            emit([("closed", .bool(source.close(timeout: 5) && repositoryClosed))])
        default: emit([("error", .string(JSText("unknown command \(name)")))])
        }
    }
}
commands.async { finished.signal() }
finished.wait()
source.refuse()
_ = repository.close(timeout: 10)
_ = source.close(timeout: 10)
