import Foundation
import Darwin

/// Project setup and Trezi's own update (S13).
/// - Instrumentation: Bun detects the framework and proposes the helper files (their
///   sources stay JS); the service writes each one only if it is absent, inside a plain
///   `.trezi/` folder, and answers their hashes (`src/main/setup.ts`).
/// - Removal: only the fixed list of Trezi helper paths, never through a linked folder.
/// - New project: Bun proposes the starter files and the package manager it found
///   (bun, else npm); the service writes them, makes the first commit and runs the
///   install. A failed install is resumed by the next request, without rewriting.
/// - Update: pull (fast-forward only), install, build of the Trezi checkout; a retry
///   skips a pull whose receipt still matches HEAD.
struct WorkflowSetup {
    let context: WorkflowContext
    var root: String { context.root }

    static let helpers: Set<String> = [".trezi/trezi-source.cjs", ".trezi/trezi-rn-source.cjs", ".trezi/trezi-svelte-stamp.mjs",
                                       ".trezi/trezi-next-loader.cjs", ".trezi/trezi-next.cjs", ".trezi/trezi-mdx.mjs", ".trezi/trezi-vite.mjs"]
    /// `uninstall` order (setup.ts): current helpers, the dsgn-era files, the praxis-era helpers.
    static let removable: [String] = {
        let current = [".trezi/trezi-source.cjs", ".trezi/trezi-rn-source.cjs", ".trezi/trezi-svelte-stamp.mjs",
                       ".trezi/trezi-next-loader.cjs", ".trezi/trezi-next.cjs", ".trezi/trezi-mdx.mjs", ".trezi/trezi-vite.mjs"]
        let legacy = ["dsgn-source-plugin.cjs", ".dsgn/dsgn-source.cjs", ".dsgn/dsgn-rn-source.cjs", ".dsgn/dsgn-svelte-stamp.mjs"]
        return current + legacy + current.map { $0.replacingOccurrences(of: "trezi", with: "praxis") }
    }()

    private static func text(_ value: String) -> JSValue { .string(JSText(value)) }

    /// `[{path, content}]` naming only known helpers (validated at intake).
    static func helperFiles(_ value: JSValue?) throws -> JSValue {
        let items = try SourceOwner.objects(value, ["path", "content"])
        guard !items.isEmpty, items.count <= helpers.count else { throw ServiceContractFailure.invalidRequest }
        var seen = Set<String>()
        for item in items {
            let path = try Body.text(item["path"])
            _ = try Body.text(item["content"])
            guard helpers.contains(path), seen.insert(path).inserted else { throw ServiceContractFailure.invalidRequest }
        }
        return .array(items)
    }

    /// `{relative path: content}` for a new project: bounded, no absolute or parent paths.
    static func projectFiles(_ value: JSValue?) throws -> JSValue {
        guard case .object(let fields)? = value, !fields.isEmpty, fields.count <= 32 else { throw ServiceContractFailure.invalidRequest }
        var total = 0
        for (key, content) in fields {
            let path = key.string
            let parts = path.split(separator: "/", omittingEmptySubsequences: false)
            guard !path.hasPrefix("/"), path.utf16.count <= 255, !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }),
                  !path.contains("\0"), parts.first != ".git" else { throw ServiceContractFailure.invalidRequest }
            total += try Body.text(content).utf8.count
        }
        guard total <= 1024 * 1024 else { throw ServiceContractFailure.invalidRequest }
        return value!
    }

    // MARK: Instrumentation helpers

    private func plainFolder(_ name: String, create: Bool) throws -> Bool {
        let path = root + "/" + name
        var info = stat()
        if lstat(path, &info) != 0 {
            guard create, errno == ENOENT else { return false }
            guard mkdir(path, 0o755) == 0 || errno == EEXIST else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            guard lstat(path, &info) == 0 else { return false }
        }
        guard (info.st_mode & S_IFMT) == S_IFDIR, let real = RepositoryPaths.realpath(path),
              real == (RepositoryPaths.realpath(root) ?? root) + "/" + name else {
            throw RepositoryRefusal(.unauthorized, "The \(name) folder is not a plain folder inside the project.")
        }
        return true
    }

    func setup(_ record: WorkflowRecord) throws -> WorkflowOutcome {
        guard case .array(let files)? = record.params["files"] else { throw ServiceContractFailure.invalidRequest }
        do {
            try context.begin("write")
            _ = try plainFolder(".trezi", create: true)
            var written = false
            var helpers: [JSValue] = []
            for file in files {
                let relative = file["path"]!.text!.string, path = root + "/" + relative
                var info = stat()
                if lstat(path, &info) != 0 {
                    try SourcePaths.write(Data(file["content"]!.text!.string.utf8), to: path)
                    written = true
                }
                guard lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, let data = try SourcePaths.read(path) else {
                    throw RepositoryRefusal(.unauthorized, "\(relative) is not a regular file; it was left untouched.")
                }
                helpers.append(WorkflowOwner.object([("path", Self.text(relative)), ("sha256", Self.text(SourcePaths.hash(data)))]))
            }
            try context.done("write", [("written", .bool(written))])
            return .done(WorkflowOwner.object([("ok", .bool(true)), ("written", .bool(written)), ("helpers", .array(helpers))]))
        } catch let cancel as WorkflowCancelled {
            throw cancel
        } catch {
            context.failed("write", "\(error)")
            return WorkflowContext.fail(WorkflowJournal.redact("\(error)"))
        }
    }

    func uninstall(_ record: WorkflowRecord) throws -> WorkflowOutcome {
        do {
            try context.begin("remove")
            var removed: [String] = []
            for relative in Self.removable {
                // Never through a linked folder: that would delete outside the project.
                if let slash = relative.firstIndex(of: "/"), try !plainFolder(String(relative[..<slash]), create: false) { continue }
                let path = root + "/" + relative
                var info = stat()
                guard stat(path, &info) == 0 else { continue }
                guard unlink(path) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
                removed.append(relative)
            }
            try context.done("remove", [("files", RepositoryOwner.strings(removed))])
            return .done(WorkflowOwner.object([("ok", .bool(true)), ("files", RepositoryOwner.strings(removed))]))
        } catch let cancel as WorkflowCancelled {
            throw cancel
        } catch {
            context.failed("remove", "\(error)")
            return WorkflowContext.fail(WorkflowJournal.redact("\(error)"))
        }
    }

    // MARK: New project

    func create(_ record: WorkflowRecord, prior: WorkflowRecord?) throws -> WorkflowOutcome {
        guard case .object(let files)? = record.params["files"] else { throw ServiceContractFailure.invalidRequest }
        let install = record.param("install")
        var warning: String?
        // An earlier run wrote this project and stopped at its install: resume there.
        if let prior, prior.step("write")?.state == "done", prior.step("install")?.state != "done", access(root, F_OK) == 0 {
            try context.inherit(prior.step("write")!)
            if let git = prior.step("git") { try context.inherit(git); warning = git.receipt["warning"]?.text?.string }
        } else {
            let entries = (try? FileManager.default.contentsOfDirectory(atPath: root)) ?? []
            if !entries.filter({ $0 != ".DS_Store" }).isEmpty { return WorkflowContext.fail("\(root) already exists and isn't empty.") }
            do {
                try context.begin("write")
                try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
                for (key, content) in files {
                    let path = root + "/" + key.string
                    try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
                    try SourcePaths.write(Data(content.text!.string.utf8), to: path)
                }
                try context.done("write", [("files", .number(Double(files.count)))])
            } catch let cancel as WorkflowCancelled {
                throw cancel
            } catch {
                context.failed("write", "\(error)")
                return WorkflowContext.fail("Could not write the project files: \(WorkflowJournal.redact("\(error)"))")
            }
            // Git first: the first commit captures the clean starter even if the install fails.
            try context.begin("git")
            let git = context.tool("git", timeout: 10)
            do { try git.data(root, ["init", "-b", "main"]) } catch {
                warning = "Project created, but `git init` failed: \(error). Trezi needs a repository " +
                    "to create work branches and to publish, so run `git init` in \(root) before publishing."
            }
            if warning == nil {
                do {
                    try git.data(root, ["add", "-A"])
                    try git.data(root, ["commit", "-m", "Initial commit from Trezi"])
                } catch {
                    warning = "Project created and `git init` succeeded, but the first commit failed: \(error). " +
                        "If git has no identity here, set one with `git config --global user.email \"you@example.com\"` " +
                        "and `git config --global user.name \"Your Name\"`, then commit."
                }
            }
            try context.done("git", warning.map { [("warning", Self.text($0))] } ?? [])
        }
        if let install {
            try context.begin("install")
            let manager = context.tool(install, timeout: context.owner.options.installTimeout)
            let result = try? manager.run(root, ["install"], observer: context.observer(interruptible: true))
            if result?.status != 0 {
                try context.check()
                let detail = result.map { GitFailure(arguments: ["install"], status: $0.status, stdout: $0.text,
                                                     stderr: String(decoding: $0.stderr, as: UTF8.self), tool: install).description } ?? "\(install) was not found"
                context.failed("install", detail)
                return WorkflowContext.fail("Project created, but \(install) install failed: \(WorkflowJournal.redact(detail))")
            }
            try context.done("install")
        }
        var fields: [(String, JSValue)] = [("ok", .bool(true)), ("root", Self.text(root))]
        if let warning { fields.append(("warning", Self.text(WorkflowJournal.redact(warning)))) }
        return .done(WorkflowOwner.object(fields))
    }

    // MARK: Trezi update

    func update(_ record: WorkflowRecord, prior: WorkflowRecord?) throws -> WorkflowOutcome {
        let head = try? context.run(["rev-parse", "HEAD"])
        let dirty = (try? context.run(["status", "--porcelain"])) ?? ""
        if !dirty.isEmpty { return WorkflowContext.fail("Your Trezi installation has local changes. Commit or stash them before updating.") }
        // A pull this update already made (receipt still at HEAD) is not repeated.
        if let prior, let pull = prior.step("pull"), pull.state == "done", let after = pull.receipt["after"]?.text?.string, after == head {
            try context.inherit(pull)
        } else {
            try context.begin("pull")
            do {
                try context.run(["pull", "--ff-only"], observer: context.observer(interruptible: false))
            } catch {
                context.failed("pull", "\(error)")
                return WorkflowContext.fail(Self.output(error))
            }
            let after = (try? context.run(["rev-parse", "HEAD"])) ?? ""
            context.fault("update.pull")
            try context.done("pull", [("before", head.map(Self.text) ?? .null), ("after", Self.text(after))])
        }
        guard let bun = context.owner.options.bun ?? ManagedProcess.resolve("bun", path: context.owner.options.environment["PATH"]) else {
            return WorkflowContext.fail("Bun was not found; Trezi could not be rebuilt.")
        }
        for (step, arguments, timeout) in [("install", ["install", "--frozen-lockfile"], context.owner.options.installTimeout),
                                           ("build", ["run", "build:native"], context.owner.options.buildTimeout)] {
            try context.begin(step)
            let result = try? context.tool("bun", executable: bun, timeout: timeout).run(root, arguments, observer: context.observer(interruptible: true))
            guard let result, result.status == 0 else {
                try context.check()
                let output = result.map { String(String(decoding: $0.stdout + $0.stderr, as: UTF8.self).suffix(16_000)) } ?? ""
                let message = output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Update exited with \(result?.status ?? 127)" : output
                context.failed(step, message)
                return WorkflowContext.fail(WorkflowJournal.redact(message))
            }
            try context.done(step)
        }
        return .done(WorkflowOwner.object([("ok", .bool(true)), ("head", Self.text((try? context.run(["rev-parse", "HEAD"])) ?? ""))]))
    }

    /// What the legacy runner reported for a failed command: its output, else its status.
    static func output(_ error: Error) -> String {
        guard let failure = error as? GitFailure else { return WorkflowJournal.redact("\(error)") }
        let output = (failure.stdout + failure.stderr).trimmingCharacters(in: .whitespacesAndNewlines)
        return WorkflowJournal.redact(output.isEmpty ? "Update exited with \(failure.status)" : String(output.suffix(16_000)))
    }
}

/// The per-machine diagnosis memory, `<profile>/diagnostics.json` (unchanged format:
/// `JSON.stringify(store, null, 2)`, root → signature → entry). The diagnosis itself is
/// a Bun helper's proposal (rules, or one tool-less model turn); only what the user was
/// offered and did is stored here. A damaged file is never overwritten.
final class WorkflowDiagnoses: @unchecked Sendable {
    let path: String
    private let lock = NSLock()

    init(profile: String) { path = profile + "/diagnostics.json" }

    private func load() throws -> [(JSText, JSValue)] {
        guard let data = FileManager.default.contents(atPath: path) else { return [] }
        guard case .object(let store)? = try? JSValue.parse(data, maxDepth: 32) else {
            throw RepositoryRefusal(.recoveryRequired, "The saved diagnoses file is unreadable; it was left untouched.")
        }
        return store
    }

    private func save(_ store: [(JSText, JSValue)]) throws {
        try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try SourcePaths.write(Data(Self.pretty(.object(store)).utf8), to: path)
    }

    static func now() -> String {
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return format.string(from: Date())
    }

    func recall(root: String, signature: String) throws -> JSValue {
        lock.lock(); defer { lock.unlock() }
        guard let store = try? load(), let entry = JSValue.object(store)[root]?[signature], case .object = entry else { return .null }
        var fields: [(String, JSValue)] = [("signature", .string(JSText(signature))), ("summary", entry["summary"] ?? .string([]))]
        if let detail = entry["detail"] { fields.append(("detail", detail)) }
        fields += [("steps", entry["steps"] ?? .array([])), ("seenBefore", .bool(true)), ("status", entry["status"] ?? .null)]
        return WorkflowOwner.object(fields)
    }

    /// Stores a proposed diagnosis (validated: summary, optional detail, steps).
    func remember(root: String, diagnosis: JSValue) throws {
        guard let signature = diagnosis["signature"]?.text?.string, signature.range(of: #"^[0-9a-f]{1,16}$"#, options: .regularExpression) != nil,
              let summary = diagnosis["summary"], summary.text != nil, case .array(let steps)? = diagnosis["steps"], steps.count <= 50,
              diagnosis.utf8().count <= 64 * 1024 else { throw ServiceContractFailure.invalidRequest }
        for step in steps {
            guard case .object(let fields) = step, step["text"]?.text != nil,
                  fields.allSatisfy({ ["text", "command", "scope"].contains($0.0.string) && $0.1.text != nil }) else { throw ServiceContractFailure.invalidRequest }
        }
        var entry: [(String, JSValue)] = [("summary", summary)]
        if let detail = diagnosis["detail"] { guard detail.text != nil else { throw ServiceContractFailure.invalidRequest }; entry.append(("detail", detail)) }
        let status = diagnosis["status"]?.text?.string ?? "proposed"
        guard ["proposed", "applied", "dismissed"].contains(status) else { throw ServiceContractFailure.invalidRequest }
        entry += [("steps", .array(steps)), ("status", .string(JSText(status))), ("at", .string(JSText(Self.now())))]
        try change(root: root) { projects in Self.set(&projects, signature, WorkflowOwner.object(entry)) }
    }

    func setStatus(root: String, signature: String, status: String) throws {
        try change(root: root) { projects in
            guard let index = projects.firstIndex(where: { $0.0 == JSText(signature) }), case .object(var entry) = projects[index].1 else { return false }
            Self.set(&entry, "status", .string(JSText(status)))
            Self.set(&entry, "at", .string(JSText(Self.now())))
            projects[index].1 = .object(entry)
            return true
        }
    }

    private func change(root: String, _ edit: (inout [(JSText, JSValue)]) -> Bool) throws {
        lock.lock(); defer { lock.unlock() }
        var store = try load()
        let key = JSText(root)
        var projects: [(JSText, JSValue)] = []
        let index = store.firstIndex { $0.0 == key }
        if let index, case .object(let existing) = store[index].1 { projects = existing }
        guard edit(&projects) else { return }
        if let index { store[index].1 = .object(projects) } else { store.append((key, .object(projects))) }
        try save(store)
    }

    @discardableResult
    private static func set(_ fields: inout [(JSText, JSValue)], _ key: String, _ value: JSValue) -> Bool {
        let name = JSText(key)
        if let index = fields.firstIndex(where: { $0.0 == name }) { fields[index].1 = value } else { fields.append((name, value)) }
        return true
    }

    /// `JSON.stringify(value, null, 2)`.
    static func pretty(_ value: JSValue, indent: String = "") -> String { JSValue.pretty(value, indent: indent) }
}
