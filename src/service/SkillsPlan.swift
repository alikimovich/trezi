import Foundation

/// One manifest mutation of the Skills registry (LKM-284), applied to an in-memory
/// manifest inside the owner's ledger effect. New package content is written to the
/// immutable store first; nothing becomes visible until the owner renames the manifest.
struct SkillsPlan {
    enum Refusal: Error { case conflict(String), notFound }

    let store: SkillsStore
    let now: Double

    func apply(_ operation: SkillsRequest, to manifest: inout SkillsManifest) throws -> [String: ServiceJSON] {
        switch operation {
        case .create(let files): return try add(files, kind: "create", source: .manual, to: &manifest)
        case .importFolder(let path):
            let read = try SkillsPackage.readDirectory(path)
            var result = try add(read.files, kind: "import", source: .manual, to: &manifest)
            result["skipped"] = .array(read.skipped.map { .string($0) })
            return result
        case .install(let files, let source, let replacing):
            guard let replacing else { return try add(files, kind: "install", source: source, to: &manifest) }
            return try update(replacing, files, source, &manifest)
        case .edit(let skill, let base, let changes): return try edit(skill, base, changes, &manifest)
        case .enable(let skill, let enabled):
            return try change(skill, &manifest) { record in
                guard record.enabled != enabled else { return false }
                record.enabled = enabled; return true
            }
        case .providers(let skill, let providers):
            return try change(skill, &manifest) { record in
                guard record.providers != providers else { return false }
                record.providers = providers; return true
            }
        case .remove(let skill):
            return try change(skill, &manifest) { record in
                guard record.active else { return false }
                record.removedAt = now; return true
            }
        case .restore(let skill):
            guard let found = manifest.record(skill) else { throw Refusal.notFound }
            if !found.active, manifest.active(named: found.name) != nil {
                throw Refusal.conflict("Another skill is named \(found.name). Rename or remove it before restoring this one.")
            }
            return try change(skill, &manifest) { record in
                guard !record.active else { return false }
                record.removedAt = nil; return true
            }
        case .purge(let skill):
            guard let found = manifest.record(skill) else { throw Refusal.notFound }
            guard !found.active else { throw Refusal.conflict("Remove the skill before deleting it permanently.") }
            manifest.skills.removeAll { $0.id == skill }
            return ["changed": .bool(true), "skill": .string(skill)]
        default: throw Refusal.notFound
        }
    }

    /// Validates, then stores the files and their revision record.
    private func save(_ files: [SkillFile]) throws -> (id: String, revision: SkillRevision) {
        let meta = try SkillsPackage.validate(files)
        let entries = try files.map { SkillEntry(path: $0.path, digest: try store.writeObject($0.data), size: $0.data.count) }
        let revision = SkillRevision(name: meta.name, description: meta.description, files: entries.sorted { $0.path < $1.path })
        return (try store.writeRevision(revision), revision)
    }

    private func add(_ files: [SkillFile], kind: String, source: SkillSource, to manifest: inout SkillsManifest) throws -> [String: ServiceJSON] {
        let meta = try SkillsPackage.validate(files)
        guard manifest.active(named: meta.name) == nil else { throw Refusal.conflict("A skill named \(meta.name) already exists.") }
        guard manifest.skills.count < SkillsLimits.maxSkills else { throw SkillsPackageError.invalid("Trezi keeps at most \(SkillsLimits.maxSkills) skills.") }
        let (id, revision) = try save(files)
        let record = SkillRecord(id: UUID().uuidString.lowercased(), name: revision.name, description: revision.description,
            revision: id, installed: id, history: [SkillHistoryEntry(revision: id, createdAt: now, kind: kind)], enabled: true, removedAt: nil,
            providers: SkillProviders(), source: source, files: revision.files.count, bytes: revision.bytes, createdAt: now, updatedAt: now)
        manifest.skills.append(record)
        return ["changed": .bool(true), "skill": .string(record.id), "skillRevision": .string(id)]
    }

    /// A new source revision (e.g. a later GitHub commit): it becomes the current and
    /// the installed revision; earlier ones stay in the history.
    private func update(_ skill: String, _ files: [SkillFile], _ source: SkillSource, _ manifest: inout SkillsManifest) throws -> [String: ServiceJSON] {
        guard let index = manifest.skills.firstIndex(where: { $0.id == skill }) else { throw Refusal.notFound }
        var record = manifest.skills[index]
        guard record.active else { throw Refusal.conflict("Restore the skill before updating it.") }
        let meta = try SkillsPackage.validate(files)
        guard manifest.active(named: meta.name, except: skill) == nil else { throw Refusal.conflict("A skill named \(meta.name) already exists.") }
        let (id, revision) = try save(files)
        if record.revision != id { record.history = Self.appending(record.history, SkillHistoryEntry(revision: id, createdAt: now, kind: "update")) }
        record.revision = id; record.installed = id; record.source = source
        record.name = revision.name; record.description = revision.description; record.files = revision.files.count; record.bytes = revision.bytes
        let changed = record != manifest.skills[index]
        if changed { record.updatedAt = now; manifest.skills[index] = record }
        return ["changed": .bool(changed), "skill": .string(skill), "skillRevision": .string(id)]
    }

    /// Save as a new revision: `base` must be the revision the editor opened, so an
    /// edit never overwrites a newer one. Files not named in `changes` carry over.
    private func edit(_ skill: String, _ base: String, _ changes: [SkillChange], _ manifest: inout SkillsManifest) throws -> [String: ServiceJSON] {
        guard let index = manifest.skills.firstIndex(where: { $0.id == skill }) else { throw Refusal.notFound }
        var record = manifest.skills[index]
        guard record.active else { throw Refusal.conflict("Restore the skill before editing it.") }
        guard record.revision == base else { throw Refusal.conflict("This skill changed since it was opened. Open it again, then edit.") }
        let previous = try store.readRevision(base)
        var files: [String: (size: Int, data: Data?, entry: SkillEntry?)] = [:]
        for entry in previous.files { files[entry.path] = (entry.size, nil, entry) }
        var named = Set<String>()
        for change in changes {
            guard SkillsPackage.validPath(change.path), named.insert(change.path).inserted else {
                throw SkillsPackageError.invalid("“\(change.path.prefix(80))” is not an allowed file path in a skill.")
            }
            if let data = change.data {
                _ = try SkillsPackage.text(SkillFile(path: change.path, data: data))
                files[change.path] = (data.count, data, nil)
            } else {
                guard change.path != SkillsPackage.entryFile else { throw SkillsPackageError.invalid("SKILL.md cannot be deleted.") }
                guard files.removeValue(forKey: change.path) != nil else { throw SkillsPackageError.invalid("The skill has no file \(change.path).") }
            }
        }
        try SkillsPackage.check(files.map { ($0.key, $0.value.size) })
        var meta = (name: previous.name, description: previous.description)
        if let data = files[SkillsPackage.entryFile]?.data { meta = try SkillsPackage.metadata(of: SkillFile(path: SkillsPackage.entryFile, data: data)) }
        guard manifest.active(named: meta.name, except: skill) == nil else { throw Refusal.conflict("A skill named \(meta.name) already exists.") }
        let entries = try files.map { path, file in
            try file.entry ?? SkillEntry(path: path, digest: store.writeObject(file.data ?? Data()), size: file.size)
        }.sorted { $0.path < $1.path }
        let revision = SkillRevision(name: meta.name, description: meta.description, files: entries)
        let id = try store.writeRevision(revision)
        guard id != record.revision else { return ["changed": .bool(false), "skill": .string(skill), "skillRevision": .string(id)] }
        record.history = Self.appending(record.history, SkillHistoryEntry(revision: id, createdAt: now, kind: "edit"))
        record.revision = id; record.name = meta.name; record.description = meta.description
        record.files = entries.count; record.bytes = revision.bytes; record.updatedAt = now
        manifest.skills[index] = record
        return ["changed": .bool(true), "skill": .string(skill), "skillRevision": .string(id)]
    }

    private func change(_ skill: String, _ manifest: inout SkillsManifest, _ body: (inout SkillRecord) -> Bool) throws -> [String: ServiceJSON] {
        guard let index = manifest.skills.firstIndex(where: { $0.id == skill }) else { throw Refusal.notFound }
        var record = manifest.skills[index]
        guard body(&record) else { return ["changed": .bool(false), "skill": .string(skill)] }
        record.updatedAt = now
        manifest.skills[index] = record
        return ["changed": .bool(true), "skill": .string(skill)]
    }

    /// History is bounded; the oldest entries drop (pinned revisions stay on disk).
    static func appending(_ history: [SkillHistoryEntry], _ entry: SkillHistoryEntry) -> [SkillHistoryEntry] {
        Array((history + [entry]).suffix(SkillsLimits.maxHistory))
    }
}
