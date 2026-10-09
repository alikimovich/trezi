import Foundation
import Darwin

/// The two outward-facing tools that used to run in Bun (S15), now recorded workflows:
/// - `feedback`: the in-app feedback issue on Trezi's own repository. Bun composes the
///   title and body (`shared/feedback-body.ts`, at most 65,536 UTF-16 units — well inside
///   the 32 MiB pipe frame) and the service runs `gh issue create` from Trezi's checkout.
///   The intent is on disk before the issue is created; a retry after an uncertain create
///   looks the exact title up on GitHub and answers that issue instead of filing another.
/// - `skills`: `npx skills add` for a curated pack. Bun's catalog picks the pack; the
///   service accepts only a GitHub `owner/name` and plain skill names, builds the argv
///   itself (never a shell string), and runs it in the project (for `-g`, a temporary) folder.
struct WorkflowTools {
    let context: WorkflowContext
    var root: String { context.root }

    private static func text(_ value: String) -> JSValue { .string(JSText(value)) }

    // MARK: Params (validated at intake)

    static func feedbackParams(_ body: Body) throws -> JSValue {
        let title = try body.string("title"), text = try body.string("body")
        guard !title.isEmpty, title.utf16.count <= 256, !text.isEmpty else { throw ServiceContractFailure.invalidRequest }
        return WorkflowOwner.object([("title", Self.text(title)), ("body", Self.text(text))])
    }

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

    // MARK: Feedback

    func feedback(_ record: WorkflowRecord, prior: WorkflowRecord?) throws -> WorkflowOutcome {
        guard let title = record.params["title"]?.text?.string, let body = record.params["body"]?.text?.string else { throw ServiceContractFailure.invalidRequest }
        // Preflight: fail before touching gh.
        guard context.succeeds(["rev-parse", "--is-inside-work-tree"]) else {
            return WorkflowContext.fail("Trezi isn’t a git checkout, so feedback can’t be filed.")
        }
        guard context.hasOrigin() else { return WorkflowContext.fail("No “origin” remote on the Trezi checkout.") }
        guard context.ghInstalled() else { return WorkflowContext.fail("GitHub CLI (gh) not found — install it to send feedback.") }
        // An earlier attempt cut short between sending and its receipt: ask GitHub first.
        if let prior, Self.sameFeedback(prior, title: title, body: body), let step = prior.step("issue"),
           step.state == "intent" || step.state == "uncertain", let url = existing(title: title, body: body) {
            try context.inherit(step)
            try context.done("issue", [("url", Self.text(url)), ("reconciled", .bool(true))])
            return .done(WorkflowOwner.object([("ok", .bool(true)), ("url", Self.text(url))]))
        }
        try context.begin("issue")
        let result: GitOutput
        do { result = try context.gh.run(root, ["issue", "create", "--title", title, "--body", body], observer: context.observer(interruptible: false)) } catch {
            context.failed("issue", "\(error)")
            return WorkflowContext.fail(Self.friendly(WorkflowJournal.redact("\(error)")))
        }
        context.fault("feedback.issue")
        guard result.status == 0 else {
            let detail = String(decoding: result.stderr, as: UTF8.self)
            // gh can fail after GitHub acted (a lost reply): an identical issue means it was filed.
            if let url = existing(title: title, body: body) {
                try context.done("issue", [("url", Self.text(url)), ("reconciled", .bool(true))])
                return .done(WorkflowOwner.object([("ok", .bool(true)), ("url", Self.text(url))]))
            }
            context.failed("issue", detail)
            return WorkflowContext.fail(Self.friendly(WorkflowJournal.redact(Self.summary(detail))))
        }
        let url = result.text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .first { $0.range(of: #"^https?://"#, options: .regularExpression) != nil }
        let reconciled = prior.map { Self.sameFeedback($0, title: title, body: body) && $0.step("issue")?.state == "uncertain" } ?? false
        try context.done("issue", url.map { fields in
            reconciled ? [("url", Self.text(fields)), ("reconciled", .bool(true))] : [("url", Self.text(fields))]
        } ?? [])
        return .done(WorkflowOwner.object([("ok", .bool(true))] + (url.map { [("url", Self.text($0))] } ?? [])))
    }

    /// Same feedback title and body as a prior workflow (field-wise; not JSValue object identity).
    static func sameFeedback(_ prior: WorkflowRecord, title: String, body: String) -> Bool {
        prior.param("title") == title && prior.param("body") == body
    }

    /// The URL of a recent issue with exactly this title and body.
    private func existing(title: String, body: String) -> String? {
        guard let data = try? context.gh.data(root, ["issue", "list", "--state", "all", "--limit", "30", "--json", "title,body,url"]),
              case .array(let items)? = try? JSValue.parse(data, maxDepth: 8) else { return nil }
        // GitHub normalizes line endings and trailing space.
        let plain = { (text: String) in text.replacingOccurrences(of: "\r\n", with: "\n").trimmingCharacters(in: .whitespacesAndNewlines) }
        return items.first { $0["title"]?.text?.string == title && plain($0["body"]?.text?.string ?? "") == plain(body) }.flatMap { $0["url"]?.text?.string }
    }

    /// `gh`'s own message: the command (without the body) and the first lines of stderr.
    static func summary(_ stderr: String) -> String {
        (["Command failed: gh issue create"] + stderr.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)).prefix(3).joined(separator: "\n")
    }

    static func friendly(_ message: String) -> String {
        message.range(of: #"gh auth login|authentication|not logged"#, options: [.regularExpression, .caseInsensitive]) != nil
            ? "GitHub CLI isn’t authenticated — run `gh auth login`, then try again." : message
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
