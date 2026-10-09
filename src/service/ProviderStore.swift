import Foundation
import Darwin

/// What the provider owner keeps on disk (S10), under `<profile>/service/providers/`:
///
/// - `sessions.json`: every provider session the service holds open, rewritten at each
///   lifecycle change (open, turn, terminal, resume, close). A session still listed at
///   the next launch was cut off by a crash: it is reported by `status` (interrupted if
///   a turn was in flight) and the list starts empty.
/// - `resume.json`: the newest resumable provider thread id per session record (at most
///   500), so a chat restored after a crash resumes its provider thread even if its record
///   was saved before the provider reported one.
///
/// Only the service reads or writes either file. A damaged file is moved aside
/// (`*.damaged-<ms>.json`), never read as empty and overwritten in place.
struct ProviderStore {
    struct Entry: Equatable {
        var session: String, chat: String, provider: String, host: String, phase: String
        var record: String?, resume: String?
    }
    struct Recovery: Equatable {
        var session: String, chat: String, provider: String, record: String?, resume: String?, interrupted: Bool
    }

    let directory: URL
    var fault: (@Sendable (String) -> Void)?
    static let maxResumes = 500

    init(profile: URL) { directory = profile.appendingPathComponent("service/providers") }

    var sessionsPath: String { directory.appendingPathComponent("sessions.json").path }
    var resumePath: String { directory.appendingPathComponent("resume.json").path }

    /// Sessions a previous service left open. The list is emptied afterwards.
    func recover() -> [Recovery] {
        guard let object = read(sessionsPath), let list = object["sessions"] as? [[String: Any]] else { return [] }
        let recovered: [Recovery] = list.compactMap { item in
            guard let session = item["session"] as? String, let chat = item["chat"] as? String,
                  let provider = item["provider"] as? String, let phase = item["phase"] as? String else { return nil }
            return Recovery(session: session, chat: chat, provider: provider, record: item["record"] as? String,
                            resume: item["resume"] as? String, interrupted: phase == "running" || phase == "cancelling")
        }
        try? writeSessions([])
        return recovered
    }

    func writeSessions(_ entries: [Entry]) throws {
        let list: [[String: Any]] = entries.map { entry in
            var item: [String: Any] = ["session": entry.session, "chat": entry.chat, "provider": entry.provider,
                                       "host": entry.host, "phase": entry.phase]
            if let record = entry.record { item["record"] = record }
            if let resume = entry.resume { item["resume"] = resume }
            return item
        }
        try write(["version": 1, "sessions": list], to: sessionsPath, point: "sessions.write")
    }

    func resume(record: String) -> (provider: String, resume: String)? {
        guard let object = read(resumePath), let list = object["records"] as? [[String: Any]] else { return nil }
        guard let item = list.last(where: { $0["record"] as? String == record }),
              let provider = item["provider"] as? String, let resume = item["resume"] as? String else { return nil }
        return (provider, resume)
    }

    func setResume(record: String, provider: String, resume: String, at: Double) throws {
        var list = (read(resumePath)?["records"] as? [[String: Any]]) ?? []
        list.removeAll { $0["record"] as? String == record }
        list.append(["record": record, "provider": provider, "resume": resume, "at": at])
        if list.count > Self.maxResumes { list.removeFirst(list.count - Self.maxResumes) }
        try write(["version": 1, "records": list], to: resumePath, point: "resume.write")
    }

    // MARK: Files

    /// The file's object, nil when absent. A file that does not parse is moved aside.
    private func read(_ path: String) -> [String: Any]? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], object["version"] as? Int == 1 { return object }
        let aside = path.replacingOccurrences(of: ".json", with: ".damaged-\(Int(Date().timeIntervalSince1970 * 1000)).json")
        _ = rename(path, aside)
        return nil
    }

    /// Temp file beside it (0600, no symlink followed), synced, then renamed over it.
    private func write(_ object: [String: Any], to path: String, point: String) throws {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let temporary = path + ".tmp"
        let fd = open(temporary, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        var offset = 0
        let complete = data.withUnsafeBytes { buffer -> Bool in
            while offset < buffer.count {
                let written = Darwin.write(fd, buffer.baseAddress! + offset, buffer.count - offset)
                if written < 0 && errno == EINTR { continue }
                if written <= 0 { return false }
                offset += written
            }
            return true
        }
        fault?(point)
        let synced = complete && fsync(fd) == 0
        close(fd)
        guard synced, rename(temporary, path) == 0 else {
            unlink(temporary)
            throw POSIXError(.EIO)
        }
    }
}
