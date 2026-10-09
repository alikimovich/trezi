import Foundation
import Darwin

// Line-driven process around the real WorkflowOwner (S13) on a profile directory, with
// the RepositoryOwner whose lanes it runs in. `{"service":"workflow"|"repository"…`
// lines are Bun frames (answers go to stdout); `{"cmd"…}` lines are fixture commands.
// WORKFLOW_FAULT=<point> SIGKILLs the process at that named point (publish.pr,
// publish.merge, connect.repo, update.pull: after the effect, before its receipt), so
// the next process sees what a crashed service leaves. `{"cmd":"drop","count":n}`
// discards the next n workflow replies (a reply lost on the way to Bun), announcing each
// as `{"event":"workflow-dropped"}` so the test expires the client's deadline then.

signal(SIGPIPE, SIG_IGN)
setvbuf(stdout, nil, _IOLBF, 0)
let env = ProcessInfo.processInfo.environment
let profile = CommandLine.arguments[1]
let output = NSLock()
nonisolated(unsafe) var dropping = 0
func emit(_ data: Data) { output.lock(); FileHandle.standardOutput.write(data + Data([10])); output.unlock() }
func emit(_ fields: [(String, JSValue)]) { emit(JSValue.object(fields.map { (JSText($0.0), $0.1) }).utf8()) }
func reply(_ data: Data) {
    output.lock()
    if dropping > 0, data.starts(with: Data("{\"event\":\"service-reply\",\"service\":\"workflow\"".utf8)) {
        dropping -= 1; output.unlock()
        return emit([("event", .string(JSText("workflow-dropped")))])
    }
    output.unlock()
    emit(data)
}

let crash = env["WORKFLOW_FAULT"]
let fault: @Sendable (String) -> Void = { point in
    guard point == crash else { return }
    kill(getpid(), SIGKILL); while true { pause() }
}
let repository = RepositoryOwner(options: RepositoryOwner.Options(profile: profile, environment: env), send: { emit($0) })
let workflow = WorkflowOwner(options: WorkflowOwner.Options(profile: profile, environment: env, bun: env["WORKFLOW_BUN"], fault: fault),
                             repository: repository, send: { reply($0) })
emit([("ready", .bool(true))])

let commands = DispatchQueue(label: "fixture.commands")
let finished = DispatchSemaphore(value: 0)
while let line = readLine(strippingNewline: true) {
    let data = Data(line.utf8)
    if line.hasPrefix("{\"service\":\"workflow\"") { workflow.submit(data); continue }
    if line.hasPrefix("{\"service\":\"repository\"") { repository.submit(data); continue }
    commands.async {
        guard let command = try? JSValue.parse(data), let name = command["cmd"]?.text?.string else { return emit([("error", .string(JSText("bad command")))]) }
        switch name {
        case "drop":
            output.lock(); if case .number(let n)? = command["count"] { dropping = Int(n) }; output.unlock()
            emit([("dropping", .bool(true))])
        case "close":
            var timeout: TimeInterval = 5
            if case .number(let value)? = command["timeout"] { timeout = value }
            emit([("closed", .bool(workflow.close(timeout: timeout)))])
        default: emit([("error", .string(JSText("unknown command \(name)")))])
        }
    }
}
commands.async { finished.signal() }
finished.wait()
_ = workflow.close(timeout: 10)
_ = repository.close(timeout: 10)
