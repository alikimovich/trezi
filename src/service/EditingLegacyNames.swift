import Foundation
import Darwin

/// The one-time project migration to Trezi names (LKM-132). A project set up before
/// the rename keeps `.praxis/praxis-*` setup helpers, config imports of them and
/// `data-praxis-*` stamps; readers accept all of those (AGENTS.md "Legacy names"),
/// so the migration is a tidy-up, never a requirement. It rewrites the project's
/// files only when the working tree is clean (so the change is the only diff and
/// reverts with one checkout) or when the user confirmed; it never commits.
/// Runs in the repository's lane, like the sidecar migration it follows.
enum EditingLegacyNames {
    /// Text rewrites, longest first. Case-sensitive: only the names Trezi wrote.
    static let rewrites: [(String, String)] = [
        (".praxis/praxis-", ".trezi/trezi-"), (".praxis/", ".trezi/"),
        ("data-praxis-", "data-trezi-"), ("praxis:animation-replay", "trezi:animation-replay"),
    ]
    static let maxBytes = 2 * 1024 * 1024
    /// Where a legacy file that differs from the current one is kept (nothing is lost).
    static let keptDirectory = ".trezi/legacy/praxis"
    private static let metadata: Set<String> = [".trezi", ".praxis", ".dsgn", ".git", "node_modules"]

    struct Plan {
        /// Project-relative files that still reference a legacy name.
        var files: [String]
        /// Legacy helper files still in place (`.praxis/…`, `.trezi/praxis-*`).
        var helpers: [String]
        /// No meaningful uncommitted change (a folder outside git is never clean).
        var clean: Bool
        var legacy: Bool { !files.isEmpty || !helpers.isEmpty }

        var value: JSValue {
            RepositoryOwner.object([("legacy", .bool(legacy)), ("clean", .bool(clean)),
                                    ("files", .array(files.map { .string(JSText($0)) })),
                                    ("helpers", .array(helpers.map { .string(JSText($0)) }))])
        }
    }

    static func plan(root: String, git: RepositoryGit) throws -> Plan {
        Plan(files: try referencing(root: root, git: git), helpers: try legacyHelpers(root: root), clean: clean(root: root, git: git))
    }

    private static func clean(root: String, git: RepositoryGit) -> Bool {
        (try? RepositoryPaths.meaningfulChanges(git, root).isEmpty) ?? false
    }

    /// Rewrites the project when it is clean or `confirmed`; otherwise changes nothing
    /// (and a dirty tree is refused before any file is read: detection runs this often).
    /// New helpers are published before any reference moves to them, and the legacy
    /// ones go last, so an interrupted run leaves a working, resumable project.
    static func migrate(root: String, git: RepositoryGit, confirmed: Bool) throws -> JSValue {
        let clean = clean(root: root, git: git)
        guard clean || confirmed else { return RepositoryOwner.object([("migrated", .bool(false)), ("dirty", .bool(true))]) }
        let plan = Plan(files: try referencing(root: root, git: git), helpers: try legacyHelpers(root: root), clean: clean)
        guard plan.legacy else { return RepositoryOwner.object([("migrated", .bool(false)), ("dirty", .bool(!clean))]) }
        _ = try EditingProject.migrate(root: root)
        var kept: [String] = []
        let helpers = try legacyHelpers(root: root)
        for helper in helpers { try publish(root: root, legacy: helper) }
        for file in plan.files { try rewrite(root + "/" + file) }
        for helper in helpers { if let path = try retire(root: root, legacy: helper), !kept.contains(path) { kept.append(path) } }
        removeEmpty(root + "/.praxis")
        return RepositoryOwner.object([("migrated", .bool(true)), ("dirty", .bool(!plan.clean)),
                                       ("files", .array(plan.files.map { .string(JSText($0)) })),
                                       ("kept", .array(kept.map { .string(JSText($0)) }))])
    }

    // MARK: Plan

    /// Files (tracked or untracked, not ignored) with a legacy reference: `git grep`,
    /// or a bounded walk for a folder outside git. Metadata folders are never rewritten.
    private static func referencing(root: String, git: RepositoryGit) throws -> [String] {
        var arguments = ["grep", "-l", "-z", "-I", "-F", "--untracked", "--no-color"]
        for (from, _) in rewrites { arguments += ["-e", from] }
        arguments += ["--", "."] + metadata.map { ":(exclude,glob)**/\($0)/**" }
        let output = try git.run(root, arguments)
        if output.status == 1 { return [] }
        if output.status == 0 {
            return output.stdout.split(separator: 0).map { String(decoding: $0, as: UTF8.self) }
                .filter { !$0.isEmpty && regular(root + "/" + $0) }.sorted()
        }
        return walk(root)
    }

    private static func walk(_ root: String) -> [String] {
        guard let items = FileManager.default.enumerator(atPath: root) else { return [] }
        // Bounded: a large folder outside git is scanned in part, never for long.
        var found: [String] = [], seen = 0, bytes = 0
        while let rel = items.nextObject() as? String, seen < 20_000, bytes < 64 * 1024 * 1024 {
            let name = (rel as NSString).lastPathComponent
            if metadata.contains(name) || name.hasPrefix(".") { items.skipDescendants(); continue }
            guard regular(root + "/" + rel), let text = text(root + "/" + rel) else { continue }
            seen += 1; bytes += text.utf8.count
            if rewrites.contains(where: { text.contains($0.0) }) { found.append(rel) }
        }
        return found.sorted()
    }

    /// `.praxis/` files and the `.trezi/praxis-*` copies the sidecar migration made.
    private static func legacyHelpers(root: String) throws -> [String] {
        var found: [String] = []
        if let folder = kind(root + "/.praxis") {
            guard folder == S_IFDIR else { throw refused("Legacy metadata must be a real directory: .praxis") }
            for rel in FileManager.default.enumerator(atPath: root + "/.praxis")?.allObjects as? [String] ?? []
            where kind(root + "/.praxis/" + rel) != S_IFDIR { found.append(".praxis/" + rel) }
        }
        for name in (try? FileManager.default.contentsOfDirectory(atPath: root + "/.trezi")) ?? [] where name.hasPrefix("praxis-") {
            found.append(".trezi/" + name)
        }
        return found.sorted()
    }

    // MARK: Effects

    /// `praxis-x.cjs` → `trezi-x.cjs`, both in `.trezi/`.
    private static func tail(_ legacy: String) -> String { String(legacy.drop { $0 != "/" }.dropFirst()) }
    private static func current(_ legacy: String) -> String {
        let rest = tail(legacy)
        return ".trezi/" + (rest.hasPrefix("praxis-") ? "trezi-" + rest.dropFirst(7) : rest)
    }

    /// A helper's own text names its siblings and stamps: the case-preserving rename.
    private static func renamed(_ data: Data) -> Data {
        guard var text = String(data: data, encoding: .utf8) else { return data }
        for (from, to) in [("praxis", "trezi"), ("Praxis", "Trezi"), ("PRAXIS", "TREZI")] { text = text.replacingOccurrences(of: from, with: to) }
        return Data(text.utf8)
    }

    /// Publishes the renamed helper when the current name is free (an existing one wins).
    private static func publish(root: String, legacy: String) throws {
        let source = root + "/" + legacy, target = root + "/" + current(legacy)
        guard kind(source) == S_IFREG else { throw refused("Unsupported legacy metadata entry: \(legacy)") }
        if kind(target) != nil { return }
        try makeDirectory((target as NSString).deletingLastPathComponent)
        try create(renamed(try Data(contentsOf: URL(fileURLWithPath: source))), at: target)
    }

    /// Removes the legacy helper once the current one matches it; a differing one moves
    /// to `.trezi/legacy/praxis/` and its new path is answered. Nothing is dropped: an
    /// identical kept copy is reused, a different one gets its own name.
    private static func retire(root: String, legacy: String) throws -> String? {
        let source = root + "/" + legacy
        let data = try Data(contentsOf: URL(fileURLWithPath: source))
        let existing = try? Data(contentsOf: URL(fileURLWithPath: root + "/" + current(legacy)))
        var kept: String? = nil
        if existing != renamed(data) {
            var rel = keptDirectory + "/" + tail(legacy)
            let prior = try? Data(contentsOf: URL(fileURLWithPath: root + "/" + rel))
            if prior != data {
                if prior != nil || kind(root + "/" + rel) != nil { rel += "." + UUID().uuidString.lowercased().prefix(8) }
                try makeDirectory(root + "/" + (rel as NSString).deletingLastPathComponent)
                try create(data, at: root + "/" + rel)
            }
            kept = rel
        }
        guard unlink(source) == 0 else { throw posix() }
        return kept
    }

    /// Rewrites one file in place through a temporary file (mode kept, links refused).
    private static func rewrite(_ path: String) throws {
        guard regular(path), var text = text(path) else { return }
        for (from, to) in rewrites { text = text.replacingOccurrences(of: from, with: to) }
        var info = stat()
        guard lstat(path, &info) == 0 else { throw posix() }
        let temporary = path + ".trezi-" + UUID().uuidString.lowercased()
        defer { unlink(temporary) }
        try create(Data(text.utf8), at: temporary, mode: info.st_mode & 0o7777)
        guard rename(temporary, path) == 0 else { throw posix() }
    }

    private static func removeEmpty(_ directory: String) {
        guard kind(directory) == S_IFDIR else { return }
        for name in (try? FileManager.default.contentsOfDirectory(atPath: directory)) ?? [] { removeEmpty(directory + "/" + name) }
        rmdir(directory)
    }

    // MARK: Files

    private static func refused(_ message: String) -> RepositoryRefusal { RepositoryRefusal(.invalidRequest, message) }
    private static func posix() -> POSIXError { POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }

    private static func kind(_ path: String) -> mode_t? {
        var info = stat()
        return lstat(path, &info) == 0 ? info.st_mode & S_IFMT : nil
    }

    private static func regular(_ path: String) -> Bool {
        var info = stat()
        return lstat(path, &info) == 0 && info.st_mode & S_IFMT == S_IFREG && info.st_size <= maxBytes
    }

    /// UTF-8 text without NUL bytes, else nil (binary files are never rewritten).
    private static func text(_ path: String) -> String? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)), !data.contains(0) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func makeDirectory(_ path: String) throws {
        if let found = kind(path) {
            guard found == S_IFDIR else { throw refused("Metadata must be a real directory: \(path)") }
            return
        }
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    }

    private static func create(_ data: Data, at path: String, mode: mode_t = 0o644) throws {
        let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode)
        guard fd >= 0 else { throw posix() }
        defer { close(fd) }
        let failed = data.withUnsafeBytes { buffer -> Bool in
            var offset = 0
            while offset < buffer.count {
                let written = Darwin.write(fd, buffer.baseAddress! + offset, buffer.count - offset)
                if written < 0 { if errno == EINTR { continue }; return true }
                offset += written
            }
            return false
        }
        if failed || fchmod(fd, mode) != 0 { let code = errno; unlink(path); throw POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO) }
    }
}
