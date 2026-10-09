import Foundation
import Darwin

// Line-driven process around the real ProviderOwner (S10) on a profile directory, as
// the service wires it: `{"service":"provider"…` and `{"service":"provider-helper"…`
// lines are Bun frames (answers and pushed events go to stdout); `{"cmd"…}` lines are
// fixture commands. The helper command is the fake provider helper
// (PROVIDER_HELPER_EXEC + PROVIDER_HELPER_ARGS, `\u{1f}`-separated; the live parity run
// names the real helper entry and PROVIDER_HELPER_PROVIDERS=claude,codex). Like the service,
// it sweeps the runtime journal before anything starts. The base environment helpers
// are filtered from is this process's own.
// PROVIDER_FAULT=<point> SIGKILLs the process at that named point inside a write.

signal(SIGPIPE, SIG_IGN)
setvbuf(stdout, nil, _IOLBF, 0)
let env = ProcessInfo.processInfo.environment
let profile = CommandLine.arguments[1]
let output = NSLock()
func emit(_ data: Data) { output.lock(); FileHandle.standardOutput.write(data + Data([10])); output.unlock() }
func emit(_ fields: [(String, JSValue)]) { emit(JSValue.object(fields.map { (JSText($0.0), $0.1) }).utf8()) }

let crash = env["PROVIDER_FAULT"]
let fault: @Sendable (String) -> Void = { point in
    guard point == crash else { return }
    kill(getpid(), SIGKILL); while true { pause() }
}
// A descriptor the service holds open without close-on-exec: a helper must not inherit it.
let canary = open(profile + "/canary", O_CREAT | O_RDWR, 0o600)
precondition(canary >= 0)
let journal = RuntimeJournal(profile: profile)
let swept = journal.sweep()
var options = ProviderOwner.Options(profile: profile, environment: env, journal: journal, fault: fault)
if let executable = env["PROVIDER_HELPER_EXEC"] {
    options.helper = ProviderHelperCommand(executable: executable,
        arguments: (env["PROVIDER_HELPER_ARGS"] ?? "").split(separator: "\u{1f}").map(String.init),
        providers: Set((env["PROVIDER_HELPER_PROVIDERS"] ?? "fake").split(separator: ",").map(String.init)))
}
if let value = env["PROVIDER_GRACE"].flatMap(Double.init) { options.grace = value }
if let value = env["PROVIDER_READY"].flatMap(Double.init) { options.readyTimeout = value }
if let value = env["PROVIDER_TOOL_TIMEOUT"].flatMap(Double.init) { options.toolTimeout = value }
if let value = env["PROVIDER_FIRST_EVENT"].flatMap(Double.init) { options.firstEventTimeout = value }
if let value = env["PROVIDER_REPLY"].flatMap(Double.init) { options.replyTimeout = value }
if let value = env["PROVIDER_STILL"].flatMap(Double.init) { options.stillThinking = value }
if let value = env["PROVIDER_MAX_LINE"].flatMap(Int.init) { options.maxLine = value }
// Provider data: PROVIDER_CRYPTO stands in for `TreziSecrets --crypto` (`\u{1f}`-separated
// argv prefix), PROVIDER_NOW pins the catalog clock, the environment names TREZI_CODEX_BIN.
options.data = ProviderData.Tools(crypto: env["PROVIDER_CRYPTO"].map { $0.split(separator: "\u{1f}").map(String.init) },
    checkout: env["PROVIDER_CHECKOUT"], environment: env)
if let value = env["PROVIDER_NOW"].flatMap(Double.init) { options.now = { value } }
let owner = ProviderOwner(options: options, send: { emit($0) })
emit([("ready", .bool(true)), ("swept", .array(swept.map { .number(Double($0)) }))])

let commands = DispatchQueue(label: "fixture.commands")
let finished = DispatchSemaphore(value: 0)
while let line = readLine(strippingNewline: true) {
    let data = Data(line.utf8)
    if line.hasPrefix("{\"service\":\"provider") { owner.submit(data); continue }
    commands.async {
        guard let command = try? JSValue.parse(data), let name = command["cmd"]?.text?.string else { return emit([("error", .string(JSText("bad command")))]) }
        switch name {
        case "close": emit([("closed", .bool(owner.close(timeout: 5)))])
        case "journal": emit([("groups", .array(RuntimeJournal.read(journal.path).map { .number(Double($0.pgid)) }))])
        case "builtIn":
            // The service's launch-time helper decision (ServiceRuntime's hello).
            let helper = ProviderHelperCommand.builtIn(backend: command["backend"]?.text?.string ?? "",
                bun: command["bun"]?.text?.string ?? "")
            emit([("helper", helper.map { .object([(JSText("executable"), .string(JSText($0.executable))),
                (JSText("arguments"), .array($0.arguments.map { .string(JSText($0)) })),
                (JSText("providers"), .array($0.providers.sorted().map { .string(JSText($0)) }))]) } ?? .null)])
        case "environment":
            // The names a provider's helper would get from this process's environment (LKM-124).
            let provider = command["provider"]?.text?.string ?? ""
            emit([("names", .array(ProviderHelperProcess.environment(base: env, provider: provider).keys.sorted().map { .string(JSText($0)) }))])
        default: emit([("error", .string(JSText("unknown command \(name)")))])
        }
    }
}
commands.async { finished.signal() }
finished.wait()
_ = owner.close(timeout: 10)
