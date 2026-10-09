import Foundation
import Darwin

/// The source transaction journal (S08): `<profile>/service/source/journal`.
///
/// Before a transaction writes its first file, its entry (every file with the hash it
/// must hold before and the hash it will hold after) and the pre-image of every file
/// are written and synced. The entry is removed once every file is written. A
/// transaction that failed midway is rolled back in process; one a crash cut short
/// is rolled back when the next service opens the journal. Rollback only ever
/// restores a file that still holds exactly the bytes the transaction wrote: a file
/// someone changed since is kept as it is, and its pre-image is kept beside the
/// report in `recovered/<operation>/`. Nothing newer is overwritten.
final class SourceJournal: @unchecked Sendable {
    struct File: Codable, Sendable {
        let path: String
        let before: String
        let after: String
    }
    struct Entry: Codable, Sendable {
        let operationID: String
        let kind: String
        let root: String
        let started: String
        let files: [File]
    }
    /// What recovery did with an interrupted transaction.
    struct Report: Codable, Sendable {
        let operationID: String
        let kind: String
        let root: String
        let started: String
        /// Put back to the pre-image (the transaction's own bytes were still there).
        var restored: [String] = []
        /// Never written, or already back to the pre-image.
        var unchanged: [String] = []
        /// Changed by someone else since; kept, with the pre-image preserved at `copies[i]`.
        var kept: [String] = []
        var copies: [String] = []
    }

    let directory: URL
    private var journal: URL { directory.appendingPathComponent("journal") }
    private var recovered: URL { directory.appendingPathComponent("recovered") }
    private let lock = NSLock()

    init(profile: String) {
        directory = URL(fileURLWithPath: profile).appendingPathComponent("service/source")
    }

    /// Creates the layout and rolls back what a crashed owner left. Throws (leaving
    /// every file as found) when an entry cannot be read: mutations are then refused.
    func open() throws {
        for folder in [journal, recovered] {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        let names = try FileManager.default.contentsOfDirectory(atPath: journal.path).filter { $0.hasSuffix(".json") }.sorted()
        let entries = try names.map { name -> Entry in
            do { return try JSONDecoder().decode(Entry.self, from: Data(contentsOf: journal.appendingPathComponent(name))) }
            catch { throw RepositoryRefusal(.recoveryRequired, "Source journal entry \(name) is unreadable; it was left untouched.") }
        }
        for entry in entries { settle(entry, report: rollback(entry)) }
        // Pre-image folders whose entry never reached the disk belong to nothing.
        for name in try FileManager.default.contentsOfDirectory(atPath: journal.path) where !name.hasSuffix(".json") {
            try? FileManager.default.removeItem(at: journal.appendingPathComponent(name))
        }
    }

    private func blobs(_ id: String) -> URL { journal.appendingPathComponent(id + ".pre") }

    /// Pre-images first, then the entry; each synced before the first effect.
    func begin(_ entry: Entry, preimages: [Data]) throws {
        let folder = blobs(entry.operationID)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        for (index, data) in preimages.enumerated() { try SourcePaths.write(data, to: folder.appendingPathComponent(String(index)).path) }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        try SourcePaths.write(try encoder.encode(entry), to: journal.appendingPathComponent(entry.operationID + ".json").path)
    }

    /// The transaction settled (every file written, or rolled back in process).
    func finish(_ id: String) {
        try? FileManager.default.removeItem(at: journal.appendingPathComponent(id + ".json"))
        SourcePaths.syncDirectory(journal.path)
        try? FileManager.default.removeItem(at: blobs(id))
    }

    /// Puts back every file that still holds the transaction's bytes.
    func rollback(_ entry: Entry) -> Report {
        var report = Report(operationID: entry.operationID, kind: entry.kind, root: entry.root, started: entry.started)
        for (index, file) in entry.files.enumerated() {
            let current = (try? SourcePaths.read(file.path)).flatMap { $0 }.map(SourcePaths.hash)
            let pre = blobs(entry.operationID).appendingPathComponent(String(index))
            if current == file.before { report.unchanged.append(file.path); continue }
            if current == file.after, let data = try? Data(contentsOf: pre), SourcePaths.hash(data) == file.before,
               (try? SourcePaths.write(data, to: file.path)) != nil {
                report.restored.append(file.path); continue
            }
            report.kept.append(file.path)
            let copy = recovered.appendingPathComponent(entry.operationID).appendingPathComponent("files")
            try? FileManager.default.createDirectory(at: copy, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let target = copy.appendingPathComponent(String(index))
            try? FileManager.default.copyItem(at: pre, to: target)
            report.copies.append(target.path)
        }
        return report
    }

    /// Records a crash-interrupted transaction for `status`, then removes its entry.
    private func settle(_ entry: Entry, report: Report) {
        let folder = recovered.appendingPathComponent(entry.operationID)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        if let data = try? encoder.encode(report) { try? SourcePaths.write(data, to: folder.appendingPathComponent("report.json").path) }
        finish(entry.operationID)
    }

    /// Transactions a previous service left unfinished, and what recovery did.
    func reports() -> [Report] {
        lock.lock(); defer { lock.unlock() }
        let names = (try? FileManager.default.contentsOfDirectory(atPath: recovered.path)) ?? []
        return names.sorted().compactMap { name in
            (try? Data(contentsOf: recovered.appendingPathComponent(name).appendingPathComponent("report.json")))
                .flatMap { try? JSONDecoder().decode(Report.self, from: $0) }
        }
    }

    /// Forgets a report; preserved pre-images stay for the user to inspect.
    func acknowledge(_ id: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard UUID(uuidString: id) != nil else { return false }
        let report = recovered.appendingPathComponent(id).appendingPathComponent("report.json")
        guard FileManager.default.fileExists(atPath: report.path) else { return false }
        try? FileManager.default.removeItem(at: report)
        let folder = recovered.appendingPathComponent(id)
        if ((try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []).isEmpty { try? FileManager.default.removeItem(at: folder) }
        return true
    }
}
