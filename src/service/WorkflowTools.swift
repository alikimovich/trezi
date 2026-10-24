import Foundation
import Darwin

/// Outward-facing tools that used to run in Bun (S15), now recorded workflows:
/// - `skills`: `npx skills add` for a curated pack. Bun's catalog picks the pack; the
///   service accepts only a GitHub `owner/name` and plain skill names, builds the argv
///   itself (never a shell string), and runs it in the project (for `-g`, a temporary) folder.
/// - `ciRerun`: one rerun of a commit's failed GitHub Actions jobs.
/// The in-app feedback issue (`gh issue create`) was removed in LKM-336: feedback now goes
/// privately to the Trezi feedback endpoint from Bun (`main/feedback-endpoint.ts`).
struct WorkflowTools {
    let context: WorkflowContext
    var root: String { context.root }

    private static func text(_ value: String) -> JSValue { .string(JSText(value)) }

    // MARK: Params (validated at intake)

    static func skillsParams(_ body: Body) throws -> JSValue {
        let pack = try body.string("packId"), scope = try body.string("scope"), repo = try body.string("repo"), title = try body.string("title")
        let names = try body.strings("skills")
        let plain = #"^[A-Za-z0-9_.-]{1,100}$"#
        guard pack.range(of: #"^[a-z0-9-]{1,64}$"#, options: .regularExpression) != nil, scope == "project" || scope == "user",
              repo.range(of: #"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$"#, options: .regularExpression) != nil,
              !repo.hasPrefix("-"), !title.isEmpty, title.utf16.count <= 200, names.count <= 50,
              names.allSatisfy({ $0.range(of: plain, options: .regularExpression) != nil && !$0.hasPrefix("-") }) else {
            throw ServiceContractFailure.invalidRequest
        }
        return WorkflowOwner.object([("packId", Self.text(pack)), ("scope", Self.text(scope)), ("repo", Self.text(repo)),
                                     ("title", Self.text(title)), ("skills", RepositoryOwner.strings(names))])
    }

    // MARK: CI

    /// One failed run is rerun in the repository lane before a repair is offered.
    func ciRerun(_ record: WorkflowRecord, prior: WorkflowRecord?) throws -> WorkflowOutcome {
        guard let commit = record.params["commit"]?.text?.string else { throw ServiceContractFailure.invalidRequest }
        if context.owner.journal.all().contains(where: {
            $0.id != record.id && $0.kind == "ciRerun" && $0.root == root &&
            $0.params["commit"]?.text?.string == commit && $0.step("rerun")?.state == "done"
        }) {
            return .done(WorkflowOwner.object([("ok", .bool(true)), ("rerun", .bool(true))]))
        }
        if let prior, prior.params["commit"]?.text?.string == commit, let step = prior.step("rerun"), step.state == "done" {
            try context.inherit(step)
            return .done(WorkflowOwner.object([("ok", .bool(true)), ("rerun", .bool(true))]))
        }
        let raw = try context.gh.text(root, ["run", "list", "--commit", commit, "--json", "databaseId,conclusion", "--limit", "10"])
        guard let data = raw.data(using: .utf8), let runs = try JSONSerialization.jsonObject(with: data) as? [[String: Any]],
              let run = runs.first(where: { $0["conclusion"] as? String == "failure" }),
              let id = run["databaseId"] as? Int, id > 0 else {
            return WorkflowContext.fail("No failed GitHub Actions run is available to rerun.")
        }
        try context.begin("rerun")
        do {
            try context.gh.text(root, ["run", "rerun", String(id), "--failed"], observer: context.observer(interruptible: false))
            try context.done("rerun", [("runId", .number(Double(id)))])
            return .done(WorkflowOwner.object([("ok", .bool(true)), ("rerun", .bool(true))]))
        } catch {
            context.failed("rerun", "\(error)")
            return WorkflowContext.fail("GitHub could not rerun the failed jobs.")
        }
    }

    // MARK: Skill packs

    func skills(_ record: WorkflowRecord) throws -> WorkflowOutcome {
        guard let pack = record.params["packId"]?.text?.string, let scope = record.params["scope"]?.text?.string,
              let repo = record.params["repo"]?.text?.string, let title = record.params["title"]?.text?.string,
              case .array(let list)? = record.params["skills"] else { throw ServiceContractFailure.invalidRequest }
        let names = list.compactMap { $0.text?.string }
        let home = context.owner.options.environment["HOME"] ?? NSHomeDirectory()
        let target = (scope == "user" ? home : root) + "/.claude/skills"
        var arguments = ["skills", "add", repo, "-a", "claude-code", "-y", "--copy"]
        if scope == "user" { arguments.append("-g") }
        arguments += names.isEmpty ? ["--all"] : names.flatMap { ["--skill", $0] }
        func result(_ ok: Bool, _ message: String, stderr: String? = nil) -> WorkflowOutcome {
            var fields: [(String, JSValue)] = [("ok", .bool(ok)), ("packId", Self.text(pack)), ("scope", Self.text(scope)), ("targetDir", Self.text(target)),
                                               ("installed", RepositoryOwner.strings(Self.installed(target))), ("message", Self.text(message))]
            if let stderr, !stderr.isEmpty { fields.append(("stderr", Self.text(WorkflowJournal.redact(String(stderr.suffix(16_000)))))) }
            return ok ? .done(WorkflowOwner.object(fields)) : .failed(WorkflowOwner.object(fields), state: "failed")
        }
        // `skills add --copy -y` is idempotent, so an interrupted install is simply run again.
        try context.begin("install")
        let runner = context.tool("npx", timeout: context.owner.options.skillsTimeout)
        let output: GitOutput
        // `-g` installs into `$HOME` on its own; the installer never runs with the home folder
        // as its cwd (LKM-137: a walk of `$HOME` reaches ~/Pictures and its privacy prompt).
        let directory = scope == "user" ? URL(fileURLWithPath: NSTemporaryDirectory()).standardizedFileURL.path : root
        do { output = try runner.run(directory, arguments, observer: context.observer(interruptible: true)) } catch {
            context.failed("install", "\(error)")
            return result(false, "Failed to launch installer for '\(title)': \(error)", stderr: "\(error)")
        }
        try context.check()
        let stderr = String(decoding: output.stderr, as: UTF8.self)
        if output.status == 124, stderr.hasPrefix("npx timed out") {
            context.failed("install", stderr)
            return result(false, "Install of '\(title)' timed out after \(Int(context.owner.options.skillsTimeout))s.", stderr: stderr)
        }
        guard output.status == 0 else {
            context.failed("install", stderr)
            return result(false, "Install of '\(title)' failed (exit \(output.status)).", stderr: stderr.isEmpty ? output.text : stderr)
        }
        try context.done("install", [("installed", RepositoryOwner.strings(Self.installed(target)))])
        let installed = Self.installed(target)
        return result(true, "Installed '\(title)' into \(target)\(installed.isEmpty ? "" : " (\(installed.joined(separator: ", ")))").", stderr: stderr)
    }

    /// Skill folder names in the target, best effort.
    static func installed(_ directory: String) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: directory)) ?? [])
            .filter { (try? FileManager.default.attributesOfItem(atPath: directory + "/" + $0))?[.type] as? FileAttributeType == .typeDirectory }
            .sorted()
    }
}
