import Foundation

/// Unsaved source editor drafts (S08): `<profile>/service/source/drafts/<root>.json`,
/// one file per resolved project root. A draft carries the hash of the file it was
/// typed against, so after a restart it comes back as a conflict (never silently
/// saved over) when the file changed in the meantime. Only the editor's own save,
/// reload or discard removes one.
final class SourceDrafts: @unchecked Sendable {
    struct Draft: Codable, Sendable {
        let path: String
        let base: String
        let text: String
        let updated: String
    }
    struct File: Codable { let root: String; var drafts: [Draft] }

    static let maxDrafts = 64
    static let maxBytes = 32 * 1024 * 1024

    let directory: URL
    private let lock = NSLock()

    init(profile: String) {
        directory = URL(fileURLWithPath: profile).appendingPathComponent("service/source/drafts")
    }

    private func url(_ root: String) -> URL { directory.appendingPathComponent(SourcePaths.hash(Data(root.utf8)) + ".json") }

    /// A damaged file is refused, never read as empty (and never overwritten).
    private func load(_ root: String) throws -> File {
        guard let data = try? Data(contentsOf: url(root)) else { return File(root: root, drafts: []) }
        guard let file = try? JSONDecoder().decode(File.self, from: data), file.root == root else {
            throw RepositoryRefusal(.recoveryRequired, "The saved drafts for this project are unreadable; they were left untouched.")
        }
        return file
    }

    func list(root: String) throws -> [Draft] {
        lock.lock(); defer { lock.unlock() }
        return try load(root).drafts
    }

    func save(root: String, _ draft: Draft) throws {
        lock.lock(); defer { lock.unlock() }
        var file = try load(root)
        file.drafts.removeAll { $0.path == draft.path }
        file.drafts.append(draft)
        guard file.drafts.count <= Self.maxDrafts, file.drafts.reduce(0, { $0 + $1.text.utf8.count }) <= Self.maxBytes else {
            throw RepositoryRefusal(.invalidRequest, "Too many unsaved drafts in this project.")
        }
        try store(root, file)
    }

    func clear(root: String, path: String) throws {
        lock.lock(); defer { lock.unlock() }
        var file = try load(root)
        guard file.drafts.contains(where: { $0.path == path }) else { return }
        file.drafts.removeAll { $0.path == path }
        if file.drafts.isEmpty { try? FileManager.default.removeItem(at: url(root)); return }
        try store(root, file)
    }

    private func store(_ root: String, _ file: File) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        try SourcePaths.write(try encoder.encode(file), to: url(root).path)
    }
}
