import Foundation

/// A session's pinned skills laid out as read-only files for one provider (LKM-287):
///
///     <profile>/skills/projections/<sha256(session)>/<provider>/
///         catalog.json                       metadata only: id, name, description, revision, entry path
///                                            (at most about 6.5 KB a skill, so under 3.4 MB for the
///                                            512 skills the registry allows; a skill's files are
///                                            listed by its own folder, never here)
///         .claude-plugin/plugin.json         Claude only: the `trezi-library` plugin
///         skills/<name>/SKILL.md, …          each pinned revision's files, 0400
///
/// Claude loads the folder as a skills-only local plugin (namespaced
/// `trezi-library:<name>`); Codex, custom endpoints and Gemini get the catalog in their
/// first turn and read a body only when they need it. The layout is derived from the
/// snapshot alone, so it never moves under a session: an intact projection is reused,
/// a damaged one is rebuilt in a temporary folder and swapped in whole. Every revision
/// is checked against the skills-only scope again (one stored before LKM-285 may hold a
/// script or a hook manifest); one outside it, or unreadable, is omitted and reported.
/// Nothing here runs a file, and no projection ever lands in a project or a provider's home.
enum SkillsProjection {
    static let format = "trezi-skills-catalog-v1"
    static let plugin = "trezi-library"
    static let catalog = "catalog.json"

    struct Omission { let skill: String; let name: String; let reason: String }
    struct Built { let path: String; let skills: [SkillPin]; let omitted: [Omission] }

    /// The plugin manifest Claude reads; nothing else (no hooks, MCP, agents or commands).
    static func manifest() -> Data {
        JSValue.object([(JSText("name"), .string(JSText(plugin))),
                        (JSText("description"), .string(JSText("Skills from Trezi’s library, pinned for this session.")))]).utf8()
    }
}

extension SkillsStore {
    func projectionFolder(_ session: String) -> String {
        root.appendingPathComponent("projections").appendingPathComponent(SkillsPackage.digest(Data(session.utf8))).path
    }
    func projectionPath(_ session: String, _ provider: String) -> String { projectionFolder(session) + "/" + provider }

    /// Lays out `snapshot`'s pins offered to `provider`, or reuses an intact layout.
    func project(_ snapshot: SkillSnapshot, provider: String) throws -> SkillsProjection.Built {
        guard SkillProviders.names.contains(provider) else { throw SkillsPackageError.invalid("Unknown provider \(provider).") }
        var files: [(String, Data)] = [], included: [SkillPin] = [], omitted: [SkillsProjection.Omission] = []
        var entries: [JSValue] = [], names = Set<String>()
        for pin in snapshot.pins.sorted(by: { ($0.name, $0.skill) < ($1.name, $1.skill) }) where pin.providers.offers(provider) {
            let revision: SkillRevision, data: [SkillFile]
            do {
                revision = try readRevision(pin.revision)
                data = try revision.files.map { SkillFile(path: $0.path, data: try readObject($0)) }
            } catch { omitted.append(.init(skill: pin.skill, name: pin.name, reason: "unreadable")); continue }
            do { try SkillsScope.check(data) } catch {
                omitted.append(.init(skill: pin.skill, name: pin.name, reason: "outside the skills-only scope")); continue
            }
            guard SkillsPackage.validName(revision.name), names.insert(revision.name).inserted else {
                omitted.append(.init(skill: pin.skill, name: pin.name, reason: "duplicate name")); continue
            }
            let folder = "skills/" + revision.name
            files += data.map { (folder + "/" + $0.path, $0.data) }
            included.append(pin)
            entries.append(.object([
                (JSText("skill"), .string(JSText(pin.skill))), (JSText("name"), .string(JSText(revision.name))),
                (JSText("description"), .string(JSText(revision.description))), (JSText("revision"), .string(JSText(pin.revision))),
                (JSText("entry"), .string(JSText(folder + "/" + SkillsPackage.entryFile)))
            ]))
        }
        if provider == "claude" { files.append((".claude-plugin/plugin.json", SkillsProjection.manifest())) }
        let catalog = JSValue.object([
            (JSText("format"), .string(JSText(SkillsProjection.format))), (JSText("session"), .string(JSText(snapshot.session))),
            (JSText("provider"), .string(JSText(provider))),
            (JSText("plugin"), provider == "claude" ? .string(JSText(SkillsProjection.plugin)) : .null),
            (JSText("skills"), .array(entries)),
            (JSText("omitted"), .array(omitted.map { .object([(JSText("skill"), .string(JSText($0.skill))),
                (JSText("name"), .string(JSText($0.name))), (JSText("reason"), .string(JSText($0.reason)))]) }))
        ]).utf8()
        files.append((SkillsProjection.catalog, catalog))
        let target = projectionPath(snapshot.session, provider)
        if !intact(target, files) { try lay(files, at: target, session: snapshot.session, provider: provider) }
        return .init(path: target, skills: included, omitted: omitted)
    }

    /// True when every expected file is there with the expected bytes, and nothing else.
    private func intact(_ target: String, _ files: [(String, Data)]) -> Bool {
        guard plainFolder(target) else { return false }
        let expected = Set(files.map(\.0))
        guard let found = FileManager.default.enumerator(atPath: target)?.allObjects as? [String] else { return false }
        // Only the expected files, inside real folders (a link in the path is a rebuild).
        guard found.allSatisfy({ path in
            expected.contains(path) || (expected.contains { $0.hasPrefix(path + "/") } && plainFolder(target + "/" + path))
        }) else { return false }
        return files.allSatisfy { path, data in (try? read(target + "/" + path, limit: data.count)) == data }
    }

    private func plainFolder(_ path: String) -> Bool {
        var status = stat()
        return lstat(path, &status) == 0 && status.st_mode & S_IFMT == S_IFDIR
    }

    /// Builds the layout in a temporary folder beside the target, then swaps it in.
    private func lay(_ files: [(String, Data)], at target: String, session: String, provider: String) throws {
        try prepare()
        let folder = projectionFolder(session)
        for path in [root.appendingPathComponent("projections").path, folder] {
            guard mkdir(path, 0o700) == 0 || errno == EEXIST else { throw SkillsPackageError.io("\(path) could not be created (errno \(errno)).") }
            guard plainFolder(path) else { throw SkillsPackageError.refused("\(path) is not a folder.") }
        }
        let temporary = folder + "/.\(provider).\(UUID().uuidString.lowercased()).tmp"
        guard mkdir(temporary, 0o700) == 0 else { throw SkillsPackageError.io("projection (errno \(errno))") }
        do {
            for (path, data) in files {
                var parent = temporary
                for part in path.split(separator: "/").dropLast() {
                    parent += "/" + part
                    guard mkdir(parent, 0o700) == 0 || errno == EEXIST, plainFolder(parent) else { throw SkillsPackageError.io("projection folder") }
                }
                try writeProjected(temporary + "/" + path, data)
            }
            var status = stat()
            if lstat(target, &status) == 0 {
                guard renamex_np(temporary, target, UInt32(RENAME_SWAP)) == 0 else { throw SkillsPackageError.io("swap (errno \(errno))") }
            } else if rename(temporary, target) != 0 { throw SkillsPackageError.io("rename (errno \(errno))") }
        } catch {
            try? FileManager.default.removeItem(atPath: temporary)
            throw error
        }
        // After a swap the temporary name holds the old layout.
        try? FileManager.default.removeItem(atPath: temporary)
        let fd = open(folder, O_RDONLY | O_CLOEXEC)
        if fd >= 0 { fsync(fd); close(fd) }
    }

    private func writeProjected(_ path: String, _ data: Data) throws {
        let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, S_IRUSR)
        guard fd >= 0 else { throw SkillsPackageError.io("create (errno \(errno))") }
        defer { close(fd) }
        let bytes = [UInt8](data)
        var offset = 0
        while offset < bytes.count {
            let written = bytes[offset...].withUnsafeBytes { Darwin.write(fd, $0.baseAddress!, $0.count) }
            if written < 0 { if errno == EINTR { continue }; throw SkillsPackageError.io("write") }
            offset += written
        }
        guard fsync(fd) == 0 else { throw SkillsPackageError.io("flush") }
    }

    /// Removes a session's projections (on `release`); false when it had none.
    @discardableResult
    func removeProjections(_ session: String) -> Bool {
        let folder = projectionFolder(session)
        guard plainFolder(folder) else { return false }
        return (try? FileManager.default.removeItem(atPath: folder)) != nil
    }

    /// Removes the projections of sessions that no longer have a snapshot, and leftovers.
    func sweepProjections(sessions: [SkillSnapshot]) {
        let base = root.appendingPathComponent("projections").path
        guard plainFolder(base) else { return }
        let kept = Set(sessions.map { SkillsPackage.digest(Data($0.session.utf8)) })
        for name in (try? FileManager.default.contentsOfDirectory(atPath: base)) ?? [] {
            let path = base + "/" + name
            if !kept.contains(name) { try? FileManager.default.removeItem(atPath: path); continue }
            for leftover in (try? FileManager.default.contentsOfDirectory(atPath: path)) ?? [] where leftover.hasPrefix(".") && leftover.hasSuffix(".tmp") {
                try? FileManager.default.removeItem(atPath: path + "/" + leftover)
            }
        }
    }
}

extension SkillProviders {
    func offers(_ provider: String) -> Bool {
        switch provider {
        case "claude": return claude
        case "codex": return codex
        case "gemini": return gemini
        default: return false
        }
    }
}
