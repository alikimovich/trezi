import Foundation
import CryptoKit
import Darwin

/// Why a ledger directory cannot be opened. Every case leaves the files exactly as
/// found: a store that cannot be proven whole is never rewritten or replaced
/// implicitly, since a fresh ledger would forget receipts and execute duplicates.
enum LedgerOpenError: Error, Equatable {
    case busy                      // another process holds the ledger lock
    case corrupt(String)           // checksum/sequence/generation evidence failed
    case unsupportedFormat(String) // written by another (newer) build; never downgraded
    case io(String)
}

/// Durable layout (`<profile>/service/ledger/`):
///   LOCK            flock; never unlinked
///   snapshot.json   one checksummed line: the whole state at `generation`
///   journal.jsonl   checksummed lines: header(generation, epoch), then records 1...n
///   quarantine/     byte-exact copies of torn journals, kept for diagnosis
/// A line is `<sha256 hex of json> <json>\n`. Records are appended and fully
/// synced before the caller acknowledges them, so an unterminated final line was
/// never acknowledged; it is the only damage repaired automatically.
final class LedgerStore<State: Codable> {
    static var format: String { "trezi-ledger-1" }
    let directory: URL
    private(set) var generation: UInt64 = 0
    /// Records in the current journal; the next record must carry `records + 1`.
    private(set) var records: UInt64 = 0
    private var journal: FileHandle?
    private let lock: Int32
    /// Test seam: called after the snapshot rename, before the journal reset.
    var afterSnapshotRename: (() -> Void)?

    private struct Header: Codable { let kind: String; let format: String; let generation: UInt64; let epoch: String }
    private struct Probe: Decodable { let format: String }
    private struct SnapshotFile: Codable { let format: String; let generation: UInt64; let epoch: String; let state: State }
    private struct Numbered: Decodable { let n: UInt64? }

    init(directory: URL) throws {
        self.directory = directory
        do { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }
        catch { throw LedgerOpenError.io("cannot create \(directory.path)") }
        lock = open(directory.appendingPathComponent("LOCK").path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
        guard lock >= 0 else { throw LedgerOpenError.io("cannot open ledger lock") }
        guard flock(lock, LOCK_EX | LOCK_NB) == 0 else { close(lock); throw LedgerOpenError.busy }
    }

    deinit { try? journal?.close(); flock(lock, LOCK_UN); close(lock) }

    var snapshotURL: URL { directory.appendingPathComponent("snapshot.json") }
    var journalURL: URL { directory.appendingPathComponent("journal.jsonl") }

    /// Reads the snapshot and every journal record after it. Files are created only
    /// in an empty directory, from `initial`.
    func load(initial: () -> (epoch: String, state: State)) throws -> (epoch: String, state: State, records: [Data]) {
        let manager = FileManager.default
        guard manager.fileExists(atPath: snapshotURL.path) else {
            guard !manager.fileExists(atPath: journalURL.path) else { throw LedgerOpenError.corrupt("journal without snapshot") }
            let fresh = initial()
            try writeSnapshot(state: fresh.state, epoch: fresh.epoch, generation: 1)
            return (fresh.epoch, fresh.state, [])
        }
        guard let bytes = manager.contents(atPath: snapshotURL.path) else { throw LedgerOpenError.io("cannot read snapshot") }
        let snapshotLines = Self.split(bytes)
        guard snapshotLines.count == 1, snapshotLines[0].terminated, let json = Self.verify(snapshotLines[0].bytes) else {
            throw LedgerOpenError.corrupt("snapshot checksum")
        }
        guard let probe = try? JSONDecoder().decode(Probe.self, from: json) else { throw LedgerOpenError.corrupt("snapshot shape") }
        guard probe.format == Self.format else { throw LedgerOpenError.unsupportedFormat(probe.format) }
        guard let snapshot = try? JSONDecoder().decode(SnapshotFile.self, from: json) else {
            throw LedgerOpenError.corrupt("snapshot shape")
        }
        generation = snapshot.generation
        let epoch = snapshot.epoch

        guard let journalBytes = manager.contents(atPath: journalURL.path), !journalBytes.isEmpty else {
            // Crash between the first snapshot and its journal.
            try resetJournal(epoch: epoch)
            return (epoch, snapshot.state, [])
        }
        var lines = Self.split(journalBytes)
        let torn = lines.last.map { !$0.terminated } ?? false
        if torn { lines.removeLast() }
        guard let first = lines.first else {
            try quarantine(journalBytes, reason: "torn-header")
            try resetJournal(epoch: epoch)
            return (epoch, snapshot.state, [])
        }
        guard let headerJSON = Self.verify(first.bytes),
              let header = try? JSONDecoder().decode(Header.self, from: headerJSON), header.kind == "header" else {
            throw LedgerOpenError.corrupt("journal header")
        }
        guard header.format == Self.format else { throw LedgerOpenError.unsupportedFormat(header.format) }
        guard header.epoch == epoch, header.generation <= snapshot.generation else {
            throw LedgerOpenError.corrupt("journal generation \(header.generation) is not covered by snapshot \(snapshot.generation)")
        }
        if header.generation < snapshot.generation {
            // Crash after compaction renamed the snapshot: every record is already in it.
            try resetJournal(epoch: epoch)
            return (epoch, snapshot.state, [])
        }
        var out: [Data] = []
        for (index, line) in lines.dropFirst().enumerated() {
            guard let json = Self.verify(line.bytes),
                  let numbered = try? JSONDecoder().decode(Numbered.self, from: json),
                  numbered.n == UInt64(index + 1) else {
                throw LedgerOpenError.corrupt("journal record \(index + 1)")
            }
            out.append(json)
        }
        try openJournal()
        if torn {
            try quarantine(journalBytes, reason: "torn-tail")
            let valid = lines.reduce(0) { $0 + $1.bytes.count + 1 }
            do { try journal?.truncate(atOffset: UInt64(valid)); try Self.fullSync(journal!.fileDescriptor) }
            catch { throw LedgerOpenError.io("cannot truncate torn journal") }
        }
        records = UInt64(out.count)
        return (epoch, snapshot.state, out)
    }

    /// Appends one record and syncs it to stable storage before returning.
    func append(_ record: Data) throws {
        guard let journal else { throw ServiceContractFailure.unavailable }
        do {
            try journal.seekToEnd()
            try journal.write(contentsOf: Self.line(record))
            try Self.fullSync(journal.fileDescriptor)
        } catch {
            // A failed write may have left a partial line. Refuse further writes until
            // reopened, when the tail is repaired or reported as corruption.
            try? journal.close(); self.journal = nil
            throw ServiceContractFailure.ioFailure
        }
        records += 1
    }

    /// Compaction: the snapshot rename is the commit point, then a fresh journal.
    func compact(state: State, epoch: String) throws {
        try writeSnapshot(state: state, epoch: epoch, generation: generation + 1)
    }

    private func writeSnapshot(state: State, epoch: String, generation next: UInt64) throws {
        let json: Data
        do { json = try Self.encode(SnapshotFile(format: Self.format, generation: next, epoch: epoch, state: state)) }
        catch { throw LedgerOpenError.io("cannot encode snapshot") }
        try replace(snapshotURL, with: Self.line(json))
        generation = next
        afterSnapshotRename?()
        try resetJournal(epoch: epoch)
    }

    private func resetJournal(epoch: String) throws {
        try? journal?.close(); journal = nil
        let header = Header(kind: "header", format: Self.format, generation: generation, epoch: epoch)
        guard let json = try? Self.encode(header) else { throw LedgerOpenError.io("cannot encode journal header") }
        try replace(journalURL, with: Self.line(json))
        records = 0
        try openJournal()
    }

    private func openJournal() throws {
        do { journal = try FileHandle(forUpdating: journalURL) }
        catch { throw LedgerOpenError.io("cannot open journal") }
    }

    /// Temporary file, full sync, rename, directory sync.
    private func replace(_ url: URL, with data: Data) throws {
        let temporary = url.appendingPathExtension("tmp")
        let fd = open(temporary.path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw LedgerOpenError.io("cannot create \(temporary.lastPathComponent)") }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        do { try handle.write(contentsOf: data); try Self.fullSync(fd); try handle.close() }
        catch { try? handle.close(); throw LedgerOpenError.io("cannot write \(temporary.lastPathComponent)") }
        guard rename(temporary.path, url.path) == 0 else { throw LedgerOpenError.io("cannot replace \(url.lastPathComponent)") }
        let dir = open(directory.path, O_RDONLY | O_CLOEXEC)
        if dir >= 0 { fsync(dir); close(dir) }
    }

    private func quarantine(_ data: Data, reason: String) throws {
        let folder = directory.appendingPathComponent("quarantine")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let name = "journal-g\(generation)-\(reason)-\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString.prefix(8)).jsonl"
        // The copy must be durable before the original is truncated. O_EXCL: never
        // overwrite an earlier copy.
        let fd = open(folder.appendingPathComponent(name).path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw LedgerOpenError.io("cannot preserve damaged journal") }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        do { try handle.write(contentsOf: data); try Self.fullSync(fd); try handle.close() }
        catch { throw LedgerOpenError.io("cannot preserve damaged journal") }
        let dir = open(folder.path, O_RDONLY | O_CLOEXEC)
        if dir >= 0 { fsync(dir); close(dir) }
    }

    static func fullSync(_ fd: Int32) throws {
        // F_FULLFSYNC flushes the drive cache; fsync alone does not on macOS.
        if fcntl(fd, F_FULLFSYNC) != 0, fsync(fd) != 0 { throw ServiceContractFailure.ioFailure }
    }

    static func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.withoutEscapingSlashes, .sortedKeys]
        return try encoder.encode(value)
    }

    private static func line(_ json: Data) -> Data {
        var line = Data(ledgerDigest(json).utf8); line.append(32); line.append(json); line.append(10)
        return line
    }

    private static func verify(_ line: Data) -> Data? {
        guard line.count > 65, line[line.startIndex + 64] == 32 else { return nil }
        let json = Data(line.suffix(from: line.startIndex + 65))
        guard String(data: line.prefix(64), encoding: .utf8) == ledgerDigest(json) else { return nil }
        return json
    }

    private static func split(_ data: Data) -> [(bytes: Data, terminated: Bool)] {
        var out: [(bytes: Data, terminated: Bool)] = []
        var start = data.startIndex
        while start < data.endIndex {
            if let end = data[start...].firstIndex(of: 10) {
                out.append((Data(data[start..<end]), true)); start = end + 1
            } else {
                out.append((Data(data[start...]), false)); break
            }
        }
        return out
    }
}

/// Explicit owner/operator recovery: move an unreadable store aside, whole and
/// untouched, so a fresh ledger (new epoch) can start. Never automatic.
func quarantineLedgerStore(at directory: URL) throws -> URL {
    let target = directory.deletingLastPathComponent()
        .appendingPathComponent("\(directory.lastPathComponent).corrupt-\(Int(Date().timeIntervalSince1970 * 1000))")
    try FileManager.default.moveItem(at: directory, to: target)
    return target
}

func ledgerDigest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
