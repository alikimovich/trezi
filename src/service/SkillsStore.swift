import Foundation
import Darwin

/// Which provider seams may offer a skill. The user's choice; a seam also checks what
/// its provider supports.
struct SkillProviders: Equatable, Sendable {
    var claude = true, codex = true, gemini = true
    static let names = ["claude", "codex", "gemini"]

    var value: JSValue { .object([(JSText("claude"), .bool(claude)), (JSText("codex"), .bool(codex)), (JSText("gemini"), .bool(gemini))]) }
    /// Strict: exactly the three booleans.
    init(claude: Bool = true, codex: Bool = true, gemini: Bool = true) { self.claude = claude; self.codex = codex; self.gemini = gemini }
    init?(_ value: JSValue?) {
        guard case .object(let fields)? = value, fields.count == 3, Set(fields.map { $0.0.string }) == Set(Self.names),
              case .bool(let claude)? = value?["claude"], case .bool(let codex)? = value?["codex"], case .bool(let gemini)? = value?["gemini"] else { return nil }
        self.init(claude: claude, codex: codex, gemini: gemini)
    }
}

/// Where a skill came from. GitHub provenance names the exact commit it was taken at,
/// and (GitHub import, LKM-285) the ref that was asked for and the license evidence's
/// repository path; those two are omitted when absent, so older records keep their bytes.
enum SkillSource: Equatable, Sendable {
    case manual
    case github(repository: String, subpath: String, commit: String, license: String?, ref: String? = nil, licenseFile: String? = nil)

    static let githubFields: Set<String> = ["kind", "repository", "subpath", "commit", "license", "ref", "licenseFile"]

    var value: JSValue {
        switch self {
        case .manual: return .object([(JSText("kind"), .string(JSText("manual")))])
        case .github(let repository, let subpath, let commit, let license, let ref, let licenseFile):
            var fields: [(JSText, JSValue)] = [(JSText("kind"), .string(JSText("github"))), (JSText("repository"), .string(JSText(repository))),
                (JSText("subpath"), .string(JSText(subpath))), (JSText("commit"), .string(JSText(commit))),
                (JSText("license"), license.map { .string(JSText($0)) } ?? .null)]
            if let ref { fields.append((JSText("ref"), .string(JSText(ref)))) }
            if let licenseFile { fields.append((JSText("licenseFile"), .string(JSText(licenseFile)))) }
            return .object(fields)
        }
    }

    init?(_ value: JSValue?) {
        guard case .object(let fields)? = value, let kind = value?["kind"]?.text?.string else { return nil }
        switch kind {
        case "manual" where fields.count == 1: self = .manual
        case "github" where (5...7).contains(fields.count) && Set(fields.map { $0.0.string }).isSubset(of: Self.githubFields):
            guard let repository = value?["repository"]?.text?.string, Self.validRepository(repository),
                  let subpath = value?["subpath"]?.text?.string, subpath.isEmpty || SkillsPackage.validPath(subpath),
                  let commit = value?["commit"]?.text?.string, Self.validCommit(commit) else { return nil }
            let license: String?
            switch value?["license"] {
            case .null?: license = nil
            case .string(let text)? where (1...100).contains(text.count): license = text.string
            default: return nil
            }
            var ref: String?, licenseFile: String?
            if let item = value?["ref"] { guard let text = item.text?.string, SkillsGitHubAddress.validRef(text) else { return nil }; ref = text }
            if let item = value?["licenseFile"] {
                guard let text = item.text?.string, text.utf8.count <= SkillsLimits.maxPath * 2 else { return nil }
                let parts = text.split(separator: "/", omittingEmptySubsequences: false)
                guard parts.count <= SkillsLimits.maxDepth * 2, parts.allSatisfy({ SkillsPackage.validComponent(String($0)) }) else { return nil }
                licenseFile = text
            }
            self = .github(repository: repository, subpath: subpath, commit: commit, license: license, ref: ref, licenseFile: licenseFile)
        default: return nil
        }
    }

    /// The same repository folder (GitHub names are case-insensitive).
    func sameFolder(as other: SkillSource) -> Bool {
        guard case .github(let a, let folder, _, _, _, _) = self, case .github(let b, let otherFolder, _, _, _, _) = other else { return false }
        return a.lowercased() == b.lowercased() && folder == otherFolder
    }

    /// `owner/name` with GitHub's characters.
    static func validRepository(_ value: String) -> Bool {
        let parts = value.split(separator: "/", omittingEmptySubsequences: false)
        return parts.count == 2 && parts.allSatisfy { part in
            (1...100).contains(part.utf8.count) && part != "." && part != ".."
                && part.utf8.allSatisfy { (0x41...0x5A).contains($0) || (0x61...0x7A).contains($0) || (0x30...0x39).contains($0) || $0 == 0x2D || $0 == 0x5F || $0 == 0x2E }
        }
    }
    /// A full 40-character lowercase SHA-1 (or 64-character SHA-256) commit ID.
    static func validCommit(_ value: String) -> Bool {
        (value.utf8.count == 40 || value.utf8.count == 64) && value.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
    }
}

struct SkillHistoryEntry: Equatable, Sendable {
    /// `create` and `import` (manual), `install` and `update` (from a source), `edit`.
    static let kinds: Set<String> = ["create", "import", "install", "update", "edit"]
    let revision: String; let createdAt: Double; let kind: String
}

/// One skill in the manifest. `revision` is what new sessions get; `installed` is the
/// revision as created or as last taken from its source, so `modified` means edited since.
struct SkillRecord: Equatable, Sendable {
    let id: String
    var name: String, description: String
    var revision: String, installed: String
    var history: [SkillHistoryEntry]
    var enabled: Bool
    var removedAt: Double?
    var providers: SkillProviders
    var source: SkillSource
    var files: Int, bytes: Int
    let createdAt: Double
    var updatedAt: Double

    var modified: Bool { revision != installed }
    var active: Bool { removedAt == nil }
    /// Revisions this record keeps on disk.
    var kept: Set<String> { Set(history.map(\.revision) + [revision, installed]) }
}

/// `<profile>/skills/manifest.json`: the only mutable registry file, replaced atomically
/// through the operation ledger. Absent means empty; anything off-format is damaged.
struct SkillsManifest: Equatable, Sendable {
    static let format = "trezi-skills-registry-v1"
    var skills: [SkillRecord] = []

    func record(_ id: String) -> SkillRecord? { skills.first { $0.id == id } }
    func active(named name: String, except id: String? = nil) -> SkillRecord? { skills.first { $0.active && $0.name == name && $0.id != id } }

    func encoded() -> Data {
        JSValue.object([(JSText("format"), .string(JSText(Self.format))), (JSText("skills"), .array(skills.map { skill in
            .object([
                (JSText("id"), .string(JSText(skill.id))), (JSText("name"), .string(JSText(skill.name))),
                (JSText("description"), .string(JSText(skill.description))), (JSText("revision"), .string(JSText(skill.revision))),
                (JSText("installed"), .string(JSText(skill.installed))),
                (JSText("history"), .array(skill.history.map { .object([(JSText("revision"), .string(JSText($0.revision))),
                    (JSText("createdAt"), .number($0.createdAt)), (JSText("kind"), .string(JSText($0.kind)))]) })),
                (JSText("enabled"), .bool(skill.enabled)), (JSText("removedAt"), skill.removedAt.map(JSValue.number) ?? .null),
                (JSText("providers"), skill.providers.value), (JSText("source"), skill.source.value),
                (JSText("files"), .number(Double(skill.files))), (JSText("bytes"), .number(Double(skill.bytes))),
                (JSText("createdAt"), .number(skill.createdAt)), (JSText("updatedAt"), .number(skill.updatedAt))
            ])
        }))]).utf8()
    }

    static func decode(_ data: Data?) throws -> SkillsManifest {
        guard let data else { return SkillsManifest() }
        let damaged = SkillsPackageError.damaged("manifest")
        guard data.count <= SkillsLimits.maxManifestBytes, let root = try? JSValue.parse(data, maxDepth: 8),
              root["format"]?.text?.string == format, case .array(let items)? = root["skills"], items.count <= SkillsLimits.maxSkills else { throw damaged }
        func text(_ value: JSValue?) throws -> String { guard let text = value?.text?.string else { throw damaged }; return text }
        func number(_ value: JSValue?) throws -> Double { guard case .number(let number)? = value, number.isFinite, number >= 0 else { throw damaged }; return number }
        func count(_ value: JSValue?, in bounds: ClosedRange<Int>) throws -> Int {
            let value = try number(value)
            guard let integer = Int(exactly: value), bounds.contains(integer) else { throw damaged }
            return integer
        }
        func digest(_ value: JSValue?) throws -> String { let text = try text(value); guard SkillsPackage.validDigest(text) else { throw damaged }; return text }
        var manifest = SkillsManifest(), ids = Set<String>(), names = Set<String>()
        for item in items {
            guard case .array(let history)? = item["history"], !history.isEmpty, history.count <= SkillsLimits.maxHistory,
                  case .bool(let enabled)? = item["enabled"], let providers = SkillProviders(item["providers"]),
                  let source = SkillSource(item["source"]) else { throw damaged }
            let removedAt: Double?
            if case .null? = item["removedAt"] { removedAt = nil } else { removedAt = try number(item["removedAt"]) }
            let record = SkillRecord(id: try text(item["id"]), name: try text(item["name"]), description: try text(item["description"]),
                revision: try digest(item["revision"]), installed: try digest(item["installed"]),
                history: try history.map { entry in
                    let kind = try text(entry["kind"])
                    guard SkillHistoryEntry.kinds.contains(kind) else { throw damaged }
                    return SkillHistoryEntry(revision: try digest(entry["revision"]), createdAt: try number(entry["createdAt"]), kind: kind)
                },
                enabled: enabled, removedAt: removedAt, providers: providers, source: source,
                files: try count(item["files"], in: 1...SkillsLimits.maxFiles),
                bytes: try count(item["bytes"], in: 0...SkillsLimits.maxPackageBytes),
                createdAt: try number(item["createdAt"]), updatedAt: try number(item["updatedAt"]))
            guard UUID(uuidString: record.id) != nil, record.id == record.id.lowercased(), SkillsPackage.validName(record.name),
                  ids.insert(record.id).inserted, !record.active || names.insert(record.name).inserted,
                  record.history.last?.revision == record.revision else { throw damaged }
            manifest.skills.append(record)
        }
        guard manifest.encoded() == data else { throw damaged }
        return manifest
    }
}

/// One session's pinned revisions: what a provider session was started with, so an
/// edit, removal or purge never changes content under it (and its resume reads the same).
struct SkillPin: Equatable, Sendable { let skill: String; let name: String; let revision: String; let providers: SkillProviders }
struct SkillSnapshot: Equatable, Sendable {
    static let format = "trezi-skills-snapshot-v1"
    let session: String; let createdAt: Double; let pins: [SkillPin]

    var value: JSValue {
        .object([(JSText("session"), .string(JSText(session))), (JSText("createdAt"), .number(createdAt)),
            (JSText("pins"), .array(pins.map { .object([(JSText("skill"), .string(JSText($0.skill))), (JSText("name"), .string(JSText($0.name))),
                (JSText("revision"), .string(JSText($0.revision))), (JSText("providers"), $0.providers.value)]) }))])
    }
    func encoded() -> Data {
        guard case .object(let fields) = value else { return Data() }
        return JSValue.object([(JSText("format"), .string(JSText(Self.format)))] + fields).utf8()
    }
    static func decode(_ data: Data) throws -> SkillSnapshot {
        let damaged = SkillsPackageError.damaged("snapshot")
        guard let root = try? JSValue.parse(data, maxDepth: 6), root["format"]?.text?.string == format,
              let session = root["session"]?.text?.string, case .number(let createdAt)? = root["createdAt"], case .array(let items)? = root["pins"] else { throw damaged }
        let pins: [SkillPin] = try items.map { item in
            guard let skill = item["skill"]?.text?.string, let name = item["name"]?.text?.string, let revision = item["revision"]?.text?.string,
                  SkillsPackage.validDigest(revision), let providers = SkillProviders(item["providers"]) else { throw damaged }
            return SkillPin(skill: skill, name: name, revision: revision, providers: providers)
        }
        let snapshot = SkillSnapshot(session: session, createdAt: createdAt, pins: pins)
        guard snapshot.encoded() == data else { throw damaged }
        return snapshot
    }
    /// 1–200 of `A-Z a-z 0-9 . _ : -`, e.g. a chat ID.
    static func validSession(_ value: String) -> Bool {
        (1...SkillsLimits.maxSession).contains(value.utf8.count)
            && value.utf8.allSatisfy { (0x41...0x5A).contains($0) || (0x61...0x7A).contains($0) || (0x30...0x39).contains($0) || [0x2E, 0x5F, 0x3A, 0x2D].contains($0) }
    }
}

/// The registry's files, all in Trezi's application data, never in a project or a
/// provider's home:
///
///     <profile>/skills/manifest.json            ledger-backed, atomic replace
///     <profile>/skills/objects/<sha256>         one file's bytes, 0400, immutable
///     <profile>/skills/revisions/<sha256>.json  a revision's file list, 0400, immutable
///     <profile>/skills/snapshots/<sha256(session)>.json   a session's pins
///
/// Objects and revisions are written (temp, `F_FULLFSYNC`, rename) before the manifest
/// names them, so a crash leaves at most unreferenced files, which `sweep` removes.
struct SkillsStore: Sendable {
    let root: URL
    /// Test seams for the manifest write (`PreferencesDisk`).
    var fault: (@Sendable (PreferencesWriteStep) throws -> Void)? = nil
    var afterRename: (@Sendable () -> Void)? = nil

    init(profile: URL) { root = profile.appendingPathComponent("skills") }

    var manifest: PreferencesDisk {
        var disk = PreferencesDisk(path: root.appendingPathComponent("manifest.json").path)
        disk.fault = fault; disk.afterRename = afterRename
        return disk
    }
    func path(_ kind: String, _ name: String) -> String { root.appendingPathComponent(kind).appendingPathComponent(name).path }

    /// The registry folder is a real folder or absent, never a link someone put there.
    var safe: Bool {
        var status = stat()
        if lstat(root.path, &status) != 0 { return errno == ENOENT }
        return status.st_mode & S_IFMT == S_IFDIR
    }

    func prepare() throws {
        for path in [root.path] + ["objects", "revisions", "snapshots"].map({ root.appendingPathComponent($0).path }) {
            guard mkdir(path, 0o700) == 0 || errno == EEXIST else { throw SkillsPackageError.io("\(path) could not be created (errno \(errno)).") }
            var status = stat()
            guard lstat(path, &status) == 0, status.st_mode & S_IFMT == S_IFDIR else { throw SkillsPackageError.refused("\(path) is not a folder.") }
        }
    }

    /// Bounded read of a registry file that is never followed through a link.
    func read(_ path: String, limit: Int) throws -> Data? {
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if fd < 0 { if errno == ENOENT { return nil }; throw SkillsPackageError.damaged(path) }
        defer { close(fd) }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count == 0 { return data }
            if count < 0 { if errno == EINTR { continue }; throw SkillsPackageError.io(path) }
            data.append(contentsOf: buffer[..<count])
            guard data.count <= limit else { throw SkillsPackageError.damaged(path) }
        }
    }

    /// Writes content-addressed bytes once. An existing file that hashes right is kept;
    /// a damaged one is replaced by the right bytes (same name, same content).
    func writeImmutable(_ kind: String, _ name: String, _ data: Data, digest: String) throws {
        let target = path(kind, name)
        if let existing = try? read(target, limit: SkillsLimits.maxManifestBytes), SkillsPackage.digest(existing) == digest { return }
        let temporary = path(kind, ".\(name).\(UUID().uuidString.lowercased()).tmp")
        try writeTemporary(temporary, data, mode: S_IRUSR)
        guard rename(temporary, target) == 0 else { let code = errno; unlink(temporary); throw SkillsPackageError.io("rename (errno \(code))") }
        try syncDirectory(kind)
    }

    func writeObject(_ data: Data) throws -> String {
        let digest = SkillsPackage.digest(data)
        try writeImmutable("objects", digest, data, digest: digest)
        return digest
    }
    func readObject(_ entry: SkillEntry) throws -> Data {
        guard let data = try read(path("objects", entry.digest), limit: SkillsLimits.maxFileBytes),
              data.count == entry.size, SkillsPackage.digest(data) == entry.digest else { throw SkillsPackageError.damaged("object") }
        return data
    }
    func writeRevision(_ revision: SkillRevision) throws -> String {
        let data = revision.encoded(), id = SkillsPackage.digest(data)
        try writeImmutable("revisions", id + ".json", data, digest: id)
        return id
    }
    func readRevision(_ id: String) throws -> SkillRevision {
        guard SkillsPackage.validDigest(id), let data = try read(path("revisions", id + ".json"), limit: SkillsLimits.maxManifestBytes),
              SkillsPackage.digest(data) == id else { throw SkillsPackageError.damaged("revision") }
        return try SkillRevision.decode(data)
    }

    func snapshotName(_ session: String) -> String { SkillsPackage.digest(Data(session.utf8)) + ".json" }
    func readSnapshot(_ session: String) throws -> SkillSnapshot? {
        guard let data = try read(path("snapshots", snapshotName(session)), limit: SkillsLimits.maxManifestBytes) else { return nil }
        let snapshot = try SkillSnapshot.decode(data)
        guard snapshot.session == session else { throw SkillsPackageError.damaged("snapshot") }
        return snapshot
    }
    func writeSnapshot(_ snapshot: SkillSnapshot) throws {
        let name = snapshotName(snapshot.session), temporary = path("snapshots", ".\(name).\(UUID().uuidString.lowercased()).tmp")
        try writeTemporary(temporary, snapshot.encoded(), mode: S_IRUSR | S_IWUSR)
        guard rename(temporary, path("snapshots", name)) == 0 else { let code = errno; unlink(temporary); throw SkillsPackageError.io("rename (errno \(code))") }
        try syncDirectory("snapshots")
    }
    /// Removes a session's pins; false when it had none.
    func removeSnapshot(_ session: String) throws -> Bool {
        guard unlink(path("snapshots", snapshotName(session))) == 0 else {
            if errno == ENOENT { return false }
            throw SkillsPackageError.io("unlink (errno \(errno))")
        }
        try syncDirectory("snapshots")
        return true
    }
    /// Every stored snapshot, oldest first. One damaged file throws: nothing may be
    /// collected while a pin cannot be read.
    func snapshots() throws -> [SkillSnapshot] {
        try names("snapshots").filter { !$0.hasPrefix(".") }.map { name in
            guard let data = try read(path("snapshots", name), limit: SkillsLimits.maxManifestBytes) else { throw SkillsPackageError.damaged("snapshot") }
            let snapshot = try SkillSnapshot.decode(data)
            guard snapshotName(snapshot.session) == name else { throw SkillsPackageError.damaged("snapshot") }
            return snapshot
        }.sorted { ($0.createdAt, $0.session) < ($1.createdAt, $1.session) }
    }

    func names(_ kind: String) throws -> [String] {
        do { return try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(kind).path) }
        catch CocoaError.fileReadNoSuchFile { return [] }
        catch { throw SkillsPackageError.io("\(kind) could not be listed.") }
    }

    /// Removes leftover temp files and every revision and object no record or pin keeps.
    /// Called only with the manifest and every snapshot read whole, before serving.
    @discardableResult
    func sweep(keep: Set<String>) -> (revisions: Int, objects: Int) {
        var revisions = 0, objects = 0, reachable = Set<String>()
        unlink(manifest.temporaryPath)
        for id in keep { if let revision = try? readRevision(id) { reachable.formUnion(revision.files.map(\.digest)) } }
        for kind in ["objects", "revisions", "snapshots"] {
            for name in (try? names(kind)) ?? [] where name.hasPrefix(".") && name.hasSuffix(".tmp") { unlink(path(kind, name)) }
        }
        for name in (try? names("revisions")) ?? [] where name.hasSuffix(".json") && !keep.contains(String(name.dropLast(5))) && !name.hasPrefix(".") {
            if unlink(path("revisions", name)) == 0 { revisions += 1 }
        }
        // An unreadable kept revision could still need any object: keep them all then.
        guard keep.allSatisfy({ (try? readRevision($0)) != nil }) else { return (revisions, 0) }
        for name in (try? names("objects")) ?? [] where !name.hasPrefix(".") && !reachable.contains(name) {
            if unlink(path("objects", name)) == 0 { objects += 1 }
        }
        return (revisions, objects)
    }

    private func writeTemporary(_ path: String, _ data: Data, mode: mode_t) throws {
        let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode)
        guard fd >= 0 else { throw SkillsPackageError.io("create (errno \(errno))") }
        let bytes = [UInt8](data)
        var offset = 0
        while offset < bytes.count {
            let written = bytes[offset...].withUnsafeBytes { Darwin.write(fd, $0.baseAddress!, $0.count) }
            if written < 0 { if errno == EINTR { continue }; close(fd); unlink(path); throw SkillsPackageError.io("write") }
            offset += written
        }
        if fcntl(fd, F_FULLFSYNC) != 0 && fsync(fd) != 0 { close(fd); unlink(path); throw SkillsPackageError.io("flush") }
        close(fd)
    }

    private func syncDirectory(_ kind: String) throws {
        let fd = open(root.appendingPathComponent(kind).path, O_RDONLY | O_CLOEXEC)
        guard fd >= 0 else { throw SkillsPackageError.io("sync") }
        defer { close(fd) }
        guard fsync(fd) == 0 else { throw SkillsPackageError.io("sync") }
    }
}
