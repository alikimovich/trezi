import Foundation
import Darwin

// Line-driven process around the real SkillsOwner + OperationLedger on a profile
// directory. A line starting with {"service" is a Bun frame and is answered with the
// owner's reply frame; {"cmd":…} lines are fixture commands (the service-internal
// `install` and `pin` seams, concurrent frames, close).
// SKILLS_NOW=<ms> fixes the clock.
// SKILLS_FAIL=<create|write|flush|rename|directory> fails that manifest write step once.
// SKILLS_CRASH=<intent|effect|after-rename|receipt> SIGKILLs at that boundary.
// GitHub import (LKM-285): SKILLS_GITHUB_PORT points the importer at a loopback test
// server; SKILLS_GITHUB_DEADLINE (seconds) and SKILLS_ARCHIVE_<COMPRESSED|EXPANDED|ENTRIES>
// lower its bounds. Deferred replies (a `github` frame) are emitted when they arrive.
// {"cmd":"parse"} and {"cmd":"archive"} run the address parser and the archive reader
// with the skills-only scope and license checks on their own, without HTTP.

setvbuf(stdout, nil, _IOLBF, 0)
let env = ProcessInfo.processInfo.environment
let profile = URL(fileURLWithPath: CommandLine.arguments[1])
let crash = env["SKILLS_CRASH"]
/// SIGKILL may land on another thread after kill() returns: never run past it.
func die(at point: String) { if crash == point { kill(getpid(), SIGKILL); while true { pause() } } }
let output = NSLock()
func emit(_ data: Data) { output.lock(); FileHandle.standardOutput.write(data + Data([10])); output.unlock() }
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

var limits = SkillsArchiveLimits()
if let value = env["SKILLS_ARCHIVE_COMPRESSED"].flatMap(Int.init) { limits.compressed = value }
if let value = env["SKILLS_ARCHIVE_EXPANDED"].flatMap(Int.init) { limits.expanded = value }
if let value = env["SKILLS_ARCHIVE_ENTRIES"].flatMap(Int.init) { limits.entries = value }
let endpoints = env["SKILLS_GITHUB_PORT"].flatMap(Int.init).map(SkillsGitHubEndpoints.loopback) ?? .github
let deadline = env["SKILLS_GITHUB_DEADLINE"].flatMap(Double.init) ?? SkillsGitHubFetcher.deadline

let ledger = try? OperationLedger(directory: profile.appendingPathComponent("service/ledger"), options: options)
let owner = SkillsOwner(store: store, ledger: ledger, now: clock, github: endpoints, archiveLimits: limits, importDeadline: deadline)
await owner.open()
await owner.onChange { emit($0) }
emit([("ready", .bool(true)), ("ledger", .bool(ledger != nil))])

func strings(_ items: [String]) -> JSValue { .array(items.map { .string(JSText($0)) }) }
func text(_ value: String?) -> JSValue { value.map { .string(JSText($0)) } ?? .null }
func refusal(_ error: Error) -> JSValue {
    let (kind, message): (String, String)
    switch error {
    case SkillsArchive.Failure.refused(let text): (kind, message) = ("refused", text)
    case SkillsArchive.Failure.invalid(let text): (kind, message) = ("invalid", text)
    case SkillsArchive.Failure.tooLarge(let text): (kind, message) = ("tooLarge", text)
    case SkillsPackageError.refused(let text): (kind, message) = ("refused", text)
    case SkillsPackageError.invalid(let text): (kind, message) = ("invalid", text)
    default: (kind, message) = ("other", "\(error)")
    }
    return .object([(JSText("kind"), .string(JSText(kind))), (JSText("message"), .string(JSText(message)))])
}

while let line = readLine(strippingNewline: true) {
    let data = Data(line.utf8)
    if line.hasPrefix("{\"service\"") {
        let reply = await owner.handle(data)
        if !reply.isEmpty { emit(reply) }
        continue
    }
    guard let command = try? JSValue.parse(data), let name = command["cmd"]?.text?.string else { emit([("error", .string(JSText("bad command")))]); continue }
    switch name {
    case "parse":
        do {
            let address = try SkillsGitHubAddress.parse(url: command["url"]?.text?.string ?? "", ref: command["ref"]?.text?.string, subpath: command["subpath"]?.text?.string)
            emit([("result", .object([(JSText("repository"), .string(JSText(address.repository))), (JSText("subpath"), .string(JSText(address.subpath))),
                (JSText("candidates"), .array(address.candidates.map { .object([(JSText("ref"), .string(JSText($0.ref))), (JSText("subpath"), .string(JSText($0.subpath)))]) }))]))])
        } catch { emit([("error", refusal(error))]) }
    case "archive":
        // A local .tar.gz read exactly as an import reads a downloaded one.
        do {
            let bytes = try Data(contentsOf: URL(fileURLWithPath: command["path"]?.text?.string ?? ""))
            let subpath = command["subpath"]?.text?.string ?? ""
            let contents = try SkillsArchive.read(bytes, subpath: subpath, limits: limits, cancelled: { false })
            try SkillsScope.check(contents.files)
            let evidence = SkillsLicense.evidence(files: contents.files, subpath: subpath, rootLicenses: contents.rootLicenses)
            emit([("result", .object([(JSText("commit"), text(contents.commit)), (JSText("found"), .bool(contents.found)),
                (JSText("files"), strings(contents.files.map(\.path).sorted())), (JSText("skipped"), strings(contents.skipped)),
                (JSText("license"), text(evidence.license)), (JSText("licenseFile"), text(evidence.file)),
                (JSText("attribution"), text(evidence.attribution?.path))]))])
        } catch { emit([("error", refusal(error))]) }
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
