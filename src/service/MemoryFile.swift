import Foundation
import CryptoKit
import Darwin

/// One project's memory, `<profile>/trezi/project-memories/<id>.json`, in its
/// unchanged legacy format `{"content":…,"updatedAt":ms}`. `id` is the SHA-256 of
/// `projectKey(root)`. The rules and bytes are the retired Bun writer's
/// (recorded in `test/memory-owner.mjs`); the only writer since LKM-111. (S05, LKM-93)
struct MemoryRecord: Equatable, Sendable {
    /// Model context, not document storage: JS `.length` bound on read and write.
    static let maxContent = 16_000
    /// A request body larger than this is refused before it is normalized.
    static let maxBody = 64_000
    static let maxRoot = 4096

    var content: JSText
    var updatedAt: Double

    static let empty = MemoryRecord(content: [], updatedAt: 0)

    /// Absent is empty. Anything but an object with a string `content` and a number
    /// `updatedAt` is damaged: refused, and never replaced by either owner.
    static func decode(_ data: Data?) throws -> MemoryRecord {
        guard let data else { return .empty }
        guard let root = try? JSValue.parse(data), case .object = root,
              let content = root["content"]?.text, case .number(let updatedAt)? = root["updatedAt"] else {
            throw MemoryError.damaged
        }
        return MemoryRecord(content: Array(content.prefix(maxContent)), updatedAt: updatedAt)
    }

    /// `JSON.stringify({content, updatedAt})`.
    func encoded() -> Data {
        JSValue.object([(JSText("content"), .string(content)), (JSText("updatedAt"), .number(updatedAt))]).utf8()
    }

    /// The editor's value as stored: JS `trim()`, then `.slice(0, 16000)`.
    static func normalize(_ content: JSText) -> JSText { Array(content.jsTrimmed.prefix(maxContent)) }

    /// The file name: hex SHA-256 of the UTF-8 of `projectKey(root)`.
    static func fileID(root: JSText) -> String {
        SHA256.hash(data: Data(WorkspaceDocument.projectKey(root).string.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func validRoot(_ root: JSText) -> Bool {
        guard !root.isEmpty, root.count <= maxRoot, root.hasPrefix("/") else { return false }
        var index = 0
        while index < root.count {
            let unit = root[index]
            if (0xD800...0xDBFF).contains(unit) {
                guard index + 1 < root.count, (0xDC00...0xDFFF).contains(root[index + 1]) else { return false }
                index += 2; continue
            }
            if (0xDC00...0xDFFF).contains(unit) { return false }
            index += 1
        }
        return true
    }
}

enum MemoryError: Error {
    case damaged
    /// `<profile>/trezi` is missing while an older session store exists: Bun must
    /// create its alias first (it does before its first memory request).
    case sessionStoreNotReady
}

/// `save` is a manual editor save: the user's final override. `propose` is a
/// generated evaluation result: it never erases memory and, like every mutation,
/// commits only on the revision it was evaluated against.
enum MemoryOperation: Equatable {
    case save(root: JSText, content: JSText)
    case propose(root: JSText, content: JSText)

    static let methods: Set<String> = ["save", "propose"]

    var root: JSText { switch self { case .save(let root, _), .propose(let root, _): return root } }
    var content: JSText { switch self { case .save(_, let content), .propose(_, let content): return content } }

    /// Strict: exactly `{root, content}`; `propose` needs non-empty content.
    init(method: String, body: [(JSText, JSValue)]) throws {
        let invalid = ServiceContractFailure.invalidRequest
        guard body.count == 2, Set(body.map { $0.0.string }) == ["root", "content"] else { throw invalid }
        let fields = JSValue.object(body)
        guard let root = fields["root"]?.text, MemoryRecord.validRoot(root),
              let content = fields["content"]?.text, content.count <= MemoryRecord.maxBody else { throw invalid }
        switch method {
        case "save": self = .save(root: root, content: content)
        case "propose":
            guard !MemoryRecord.normalize(content).isEmpty else { throw invalid }
            self = .propose(root: root, content: content)
        default: throw invalid
        }
    }
}

/// Where memory files live. `<profile>/trezi` may be Bun's alias of an older
/// `praxis`/`dsgn` session store (`nativeSessionPath`); the service never creates
/// it beside one, so it can never split the store in two.
struct MemoryStore: Sendable {
    let profile: URL
    /// Test seam, handed to every file's `PreferencesDisk`.
    var fault: (@Sendable (PreferencesWriteStep) throws -> Void)? = nil
    var afterRename: (@Sendable () -> Void)? = nil

    var sessions: URL { profile.appendingPathComponent("trezi") }
    var directory: URL { sessions.appendingPathComponent("project-memories") }

    func disk(_ id: String) -> PreferencesDisk {
        var disk = PreferencesDisk(path: directory.appendingPathComponent("\(id).json").path)
        disk.fault = fault; disk.afterRename = afterRename
        return disk
    }

    /// Creates the directory for a first write, never a second session store.
    func prepareDirectory() throws {
        var status = stat()
        if lstat(sessions.path, &status) != 0 {
            guard errno == ENOENT else { throw PreferencesError.unreadable(errno) }
            for legacy in ["praxis", "dsgn"] {
                if lstat(profile.appendingPathComponent(legacy).path, &status) == 0 { throw MemoryError.sessionStoreNotReady }
            }
            guard mkdir(sessions.path, 0o755) == 0 || errno == EEXIST else { throw PreferencesError.unreadable(errno) }
        }
        guard mkdir(directory.path, 0o755) == 0 || errno == EEXIST else { throw PreferencesError.unreadable(errno) }
    }
}

extension JSText {
    /// JS `String.prototype.trim()`: WhiteSpace and LineTerminator code units.
    static func isJSSpace(_ unit: UInt16) -> Bool {
        switch unit {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
        default: return false
        }
    }
    var jsTrimmed: JSText {
        var units = Array(drop(while: JSText.isJSSpace))
        while let last = units.last, JSText.isJSSpace(last) { units.removeLast() }
        return units
    }
}
