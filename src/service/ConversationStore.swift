import Foundation
import CryptoKit
import Darwin

/// Chat persistence for the conversation coordinator (S11, LKM-97).
///
/// - `<profile>/trezi/sessions/<id>.json`: the unchanged session records ("previous
///   agents" and each project's current chat) as `JSON.stringify(record)`, the shape
///   `sessions-store.ts` reads, so records written before the service still read as is.
///   Same rules: a `current` save replaces the project's other current record, and
///   History keeps the newest 50 per project. Bun reads the directory directly (it is
///   written atomically); only the service writes it.
/// - `<profile>/service/conversation/live/<sha256(chat)>.json`: a checkpoint of every
///   live chat — its record as of the last transition, whether it was the project's
///   active chat, and its turn phase — rewritten at each transition. A clean close
///   moves the record into `sessions/` and deletes the checkpoint. What is left at the
///   next launch belongs to chats a crash cut off: `recover()` saves each one without
///   ever replacing a newer record (a copy goes to `recovered/` instead).
struct ConversationStore {
    static let maxHistoryPerProject = 50
    static let interruptedNote = "Trezi stopped before this turn finished. Send the message again to continue."

    let profile: URL
    var sessionsRoot: URL { profile.appendingPathComponent("trezi") }
    var sessions: URL { sessionsRoot.appendingPathComponent("sessions") }
    var service: URL { profile.appendingPathComponent("service/conversation") }
    var live: URL { service.appendingPathComponent("live") }
    var recovered: URL { service.appendingPathComponent("recovered") }

    /// Test hook: named points inside writes (a fixture crashes there).
    var fault: (@Sendable (String) -> Void)? = nil

    static func validID(_ id: String) -> Bool {
        !id.isEmpty && id.utf8.count <= 128 && id.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A) || $0 == 0x5F || $0 == 0x2D }
    }

    static func isCurrent(_ record: JSValue) -> Bool {
        let slot = record["slot"]?.text?.string
        return slot == "current" || slot == "main"
    }

    // MARK: Session records

    private func file(_ id: String) -> PreferencesDisk { PreferencesDisk(path: sessions.appendingPathComponent("\(id).json").path) }

    /// Creates `sessions/` for a first write, never a second session store beside an
    /// older `praxis`/`dsgn` one (Bun aliases those before its first chat).
    private func prepare() throws {
        var status = stat()
        if lstat(sessionsRoot.path, &status) != 0 {
            guard errno == ENOENT else { throw PreferencesError.unreadable(errno) }
            for legacy in ["praxis", "dsgn"] where lstat(profile.appendingPathComponent(legacy).path, &status) == 0 {
                throw MemoryError.sessionStoreNotReady
            }
            guard mkdir(sessionsRoot.path, 0o755) == 0 || errno == EEXIST else { throw PreferencesError.unreadable(errno) }
        }
        guard mkdir(sessions.path, 0o755) == 0 || errno == EEXIST else { throw PreferencesError.unreadable(errno) }
    }

    func read(_ id: String) -> JSValue? {
        guard Self.validID(id), let data = try? file(id).read(), let record = try? JSValue.parse(data), case .object = record else { return nil }
        return record
    }

    /// Every readable record in `readdir` order (as `readdirSync`); unreadable ones are skipped, never rewritten.
    func all() -> [(name: String, record: JSValue)] {
        guard let dir = opendir(sessions.path) else { return [] }
        defer { closedir(dir) }
        var out: [(String, JSValue)] = []
        while let entry = readdir(dir) {
            let name = withUnsafePointer(to: entry.pointee.d_name) { String(cString: UnsafeRawPointer($0).assumingMemoryBound(to: CChar.self)) }
            guard name.hasSuffix(".json"),
                  let data = try? PreferencesDisk(path: sessions.appendingPathComponent(name).path).read(),
                  let record = try? JSValue.parse(data), record["id"]?.text != nil else { continue }
            out.append((name, record))
        }
        return out
    }

    private func write(_ id: String, _ record: JSValue) throws {
        try prepare()
        let disk = file(id)
        try disk.prepare(record.utf8())
        fault?("session.write")
        try disk.replace()
        try? disk.syncDirectory()
    }

    func remove(_ id: String) {
        guard Self.validID(id) else { return }
        unlink(file(id).path)
    }

    /// `sessions-store.ts` `save` / `saveCurrent`.
    func save(_ input: JSValue, current: Bool) throws {
        var record = input
        guard let id = record["id"]?.text?.string, Self.validID(id) else { throw ConversationStoreError.unsafeID }
        let project = record["projectKey"]?.text
        if current {
            ConversationState.set(&record, "slot", .string(JSText("current")))
            for (_, other) in all() where other["projectKey"]?.text == project && Self.isCurrent(other) {
                if let otherID = other["id"]?.text?.string, otherID != id { remove(otherID) }
            }
        }
        try write(id, record)
        prune(project)
    }

    /// History (non-current) records beyond the newest 50 of the project, oldest first out.
    private func prune(_ project: JSText?) {
        let history = all().map(\.record).filter { $0["projectKey"]?.text == project && !Self.isCurrent($0) }
        let ordered = history.enumerated().sorted { a, b in
            let x = Self.number(a.element["startedAt"]), y = Self.number(b.element["startedAt"])
            return x != y ? x > y : a.offset < b.offset
        }.map(\.element)
        for stale in ordered.dropFirst(Self.maxHistoryPerProject) { if let id = stale["id"]?.text?.string { remove(id) } }
    }

    static func number(_ value: JSValue?) -> Double { if case .number(let n)? = value { return n }; return .nan }

    /// `sessions:rename`: one line, collapsed whitespace, 120 UTF-16 units.
    static func cleanTitle(_ text: JSText) -> JSText {
        var out: JSText = [], space = false
        for unit in text {
            if JSText.isJSSpace(unit) { space = true; continue }
            if space && !out.isEmpty { out.append(0x20) }
            space = false; out.append(unit)
        }
        return Array(out.prefix(120))
    }

    // MARK: Live checkpoints

    static func checkpointName(_ chat: String) -> String {
        SHA256.hash(data: Data(chat.utf8)).map { String(format: "%02x", $0) }.joined() + ".json"
    }

    func checkpoint(_ chat: ConversationChat, active: Bool, savedAt: Double) throws {
        guard mkdir(service.path, 0o700) == 0 || errno == EEXIST, mkdir(live.path, 0o700) == 0 || errno == EEXIST else {
            throw PreferencesError.unreadable(errno)
        }
        let value = RepositoryOwner.object([("chat", .string(JSText(chat.chat))), ("project", .string(JSText(chat.project))),
            ("root", .string(JSText(chat.root))), ("active", .bool(active)), ("phase", .string(JSText(chat.phase.rawValue))),
            ("turn", chat.turn.map { .string(JSText($0)) } ?? .null), ("savedAt", .number(savedAt)),
            ("record", chat.record), ("options", chat.options)])
        let disk = PreferencesDisk(path: live.appendingPathComponent(Self.checkpointName(chat.chat)).path)
        try disk.prepare(value.utf8())
        fault?("checkpoint.write")
        try disk.replace()
        try? disk.syncDirectory()
    }

    func dropCheckpoint(_ chat: String) { unlink(live.appendingPathComponent(Self.checkpointName(chat)).path) }

    /// A chat a crash cut off, and what recovery did with its record.
    struct Recovery {
        var chat: String, id: String, project: String
        var interrupted: Bool
        /// "restored" (saved as found), "kept" (a newer record already existed; the
        /// checkpoint was copied beside the report), or "damaged" (moved aside unread).
        var outcome: String
        var copy: String?

        var value: JSValue {
            var fields: [(String, JSValue)] = [("chat", .string(JSText(chat))), ("id", .string(JSText(id))),
                ("project", .string(JSText(project))), ("interrupted", .bool(interrupted)), ("outcome", .string(JSText(outcome)))]
            if let copy { fields.append(("copy", .string(JSText(copy)))) }
            return RepositoryOwner.object(fields)
        }
    }

    /// Saves every leftover checkpoint into `sessions/`, never over newer work.
    func recover() -> [Recovery] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: live.path) else { return [] }
        // A write cut off before its rename left only its temporary file: the checkpoint it
        // was replacing still stands.
        for name in names where name.hasSuffix(".json.tmp") { unlink(live.appendingPathComponent(name).path) }
        var reports: [Recovery] = []
        for name in names.sorted() where name.hasSuffix(".json") {
            let path = live.appendingPathComponent(name).path
            guard let data = try? PreferencesDisk(path: path).read(), let value = try? JSValue.parse(data),
                  let chat = value["chat"]?.text?.string, let project = value["project"]?.text?.string,
                  case .object = value["record"], let id = value["record"]?["id"]?.text?.string, Self.validID(id),
                  case .number(let savedAt)? = value["savedAt"] else {
                reports.append(Recovery(chat: "", id: "", project: "", interrupted: false, outcome: "damaged", copy: aside(path, name)))
                continue
            }
            var record = value["record"]!
            let interrupted = (value["phase"]?.text?.string ?? "idle") != "idle"
            guard case .array(let transcript)? = record["transcript"], transcript.contains(where: { $0["role"]?.text?.string == "user" }) else {
                unlink(path); continue // never engaged: nothing to keep (as a clean close)
            }
            if interrupted, case .object(var fields) = record, let index = fields.lastIndex(where: { $0.0 == JSText("transcript") }),
               case .array(var entries) = fields[index].1 {
                entries.append(RepositoryOwner.object([("role", .string(JSText("status"))), ("text", .string(JSText(Self.interruptedNote))),
                                                       ("at", .number(savedAt))]))
                fields[index].1 = .array(entries); record = .object(fields)
            }
            ConversationState.set(&record, "endedAt", .number(savedAt))
            var report = Recovery(chat: chat, id: id, project: project, interrupted: interrupted, outcome: "restored")
            // A record saved after this checkpoint (a later launch, either owner) is newer work.
            if let existing = read(id), Self.number(existing["endedAt"]) > savedAt {
                report.outcome = "kept"; report.copy = aside(path, name)
                reports.append(report); continue
            }
            let projectKey = record["projectKey"]?.text
            let others = all().map(\.record).filter { $0["projectKey"]?.text == projectKey && Self.isCurrent($0) && $0["id"]?.text?.string != id }
            let current = value["active"] == .bool(true) && !others.contains { Self.number($0["endedAt"]) > savedAt }
            if !current { ConversationState.set(&record, "slot", nil) }
            do {
                if current {
                    // An older current record is demoted to History, not deleted.
                    for var other in others {
                        guard let otherID = other["id"]?.text?.string else { continue }
                        ConversationState.set(&other, "slot", nil)
                        try write(otherID, other)
                    }
                    ConversationState.set(&record, "slot", .string(JSText("current")))
                }
                try write(id, record)
                unlink(path)
            } catch {
                report.outcome = "kept"; report.copy = aside(path, name)
            }
            reports.append(report)
        }
        return reports
    }

    /// Moves a checkpoint beside the reports (never deleted); answers where it went.
    private func aside(_ path: String, _ name: String) -> String? {
        guard mkdir(recovered.path, 0o700) == 0 || errno == EEXIST else { return nil }
        let target = recovered.appendingPathComponent("\(Int(Date().timeIntervalSince1970 * 1000))-\(name)").path
        return rename(path, target) == 0 ? target : nil
    }
}

enum ConversationStoreError: Error { case unsafeID }
