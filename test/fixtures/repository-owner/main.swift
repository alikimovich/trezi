import Foundation
import Darwin

// Line-driven process around the real RepositoryOwner (S07) on a profile directory.
// `{"service"…` lines are Bun frames (answers go to stdout); `{"cmd"…}` lines are
// fixture commands. REPOSITORY_FAULT=<point> SIGKILLs the process at that named
// point inside an effect (land.write, resolve.reset, remove.preserved, …), so the
// next process sees what a crashed service leaves behind.

signal(SIGPIPE, SIG_IGN)
setvbuf(stdout, nil, _IOLBF, 0)
let env = ProcessInfo.processInfo.environment
let profile = CommandLine.arguments[1]
let output = NSLock()
func emit(_ data: Data) { output.lock(); FileHandle.standardOutput.write(data + Data([10])); output.unlock() }
func emit(_ fields: [(String, JSValue)]) { emit(JSValue.object(fields.map { (JSText($0.0), $0.1) }).utf8()) }

let crash = env["REPOSITORY_FAULT"]
/// SIGKILL may land on another thread after kill() returns: never run past it.
let fault: @Sendable (String) -> Void = { point in if point == crash { kill(getpid(), SIGKILL); while true { pause() } } }
// REPOSITORY_WORKTREES_ROOT widens where worktrees may live (the chat and Git suites use the temp dir).
let owner = RepositoryOwner(options: RepositoryOwner.Options(profile: profile, environment: env, fault: fault,
                                                             worktreesRoot: env["REPOSITORY_WORKTREES_ROOT"]), send: { emit($0) })
emit([("ready", .bool(true))])

let commands = DispatchQueue(label: "fixture.commands")
let finished = DispatchSemaphore(value: 0)
while let line = readLine(strippingNewline: true) {
    let data = Data(line.utf8)
    if line.hasPrefix("{\"service\"") { owner.submit(data); continue }
    commands.async {
        guard let command = try? JSValue.parse(data), let name = command["cmd"]?.text?.string else { return emit([("error", .string(JSText("bad command")))]) }
        switch name {
        case "close":
            var timeout: TimeInterval = 5
            if case .number(let value)? = command["timeout"] { timeout = value }
            emit([("closed", .bool(owner.close(timeout: timeout)))])
        case "apply":
            // A raw patch through the landing's apply: no request can carry one, so a
            // patch Git cannot read is only reachable here.
            guard let root = command["root"]?.text?.string, let patch = command["patch"]?.text?.string else {
                return emit([("error", .string(JSText("apply needs root and patch")))])
            }
            let effects = owner.effects
            let context = RepositoryContext(operationID: UUID().uuidString, kind: "applyBranch", lane: effects.lane(root), root: root, effects: effects)
            do {
                let applied = try effects.applyToWorkingTree(context, root, patch: Data(patch.utf8))
                let problems = applied.problems.map { problem in
                    JSValue.object([(JSText("reason"), .string(JSText(problem.reason.rawValue))),
                                    (JSText("file"), problem.file.map { .string(JSText($0)) } ?? .null),
                                    (JSText("line"), problem.line.map { .number(Double($0)) } ?? .null)])
                }
                emit([("ok", .bool(applied.ok)), ("conflict", .bool(applied.conflict)), ("message", applied.error.map { .string(JSText($0)) } ?? .null),
                      ("problems", .array(problems))])
            } catch { emit([("error", .string(JSText("\(error)")))]) }
        default: emit([("error", .string(JSText("unknown command \(name)")))])
        }
    }
}
commands.async { finished.signal() }
finished.wait()
_ = owner.close(timeout: 10)
