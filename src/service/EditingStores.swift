import Foundation
import Darwin

/// The project sidecars in a user's `.trezi/`: the controls store (S12,
/// `control-panels.json`), the reviewer notes
/// (`annotations.json`, S05's writer, moved with S15) and the starter design tokens
/// (`tokens.json`, S15). Bun validates and renders the next store text; the service
/// commits it only if the file still holds the bytes Bun read (`expectedHash`, nil for
/// "absent"), in the repository's lane. The agent can never write these (its sandbox
/// denies `.trezi/`), and no other Trezi path writes them.
enum EditingSidecar {
    static let names: Set<String> = ["control-panels.json", "annotations.json", "tokens.json"]
    static let maxBytes = 1024 * 1024

    enum Outcome { case written(String), conflict }

    static func commit(root: String, name: String, expected: String?, content: Data) throws -> Outcome {
        let refused = RepositoryRefusal(.unauthorized, "The .trezi folder is not a plain folder inside the project.")
        let directory = root + "/.trezi", path = directory + "/" + name
        var info = stat()
        if lstat(directory, &info) == 0 {
            guard (info.st_mode & S_IFMT) == S_IFDIR else { throw refused }
        } else {
            guard errno == ENOENT, mkdir(directory, 0o755) == 0 || errno == EEXIST,
                  lstat(directory, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR else { throw refused }
        }
        guard let real = RepositoryPaths.realpath(directory), real == directory else { throw refused }
        var current: Data?
        if lstat(path, &info) == 0 {
            guard (info.st_mode & S_IFMT) == S_IFREG else { throw refused }
            guard info.st_size <= maxBytes, let data = try SourcePaths.read(path) else {
                throw RepositoryRefusal(.invalidRequest, "The \(name) store is too large; it was left untouched.")
            }
            current = data
        }
        guard current.map(SourcePaths.hash) == expected else { return .conflict }
        try SourcePaths.write(content, to: path)
        return .written(SourcePaths.hash(content))
    }
}

/// Deferred preview navigation (S12): an agent's `open_preview` request waits for the
/// turn that made it to land, then opens once in that chat's project. A failed or
/// parked turn, a newer user turn and closing or leaving the chat drop it. Bun performs
/// the load (it knows the project's server) after `take` hands the path over.
struct EditingNavigation {
    struct Pending { let root: String; let path: String; let turn: String?; var awaiting: Bool }
    private(set) var pending: [String: Pending] = [:]

    /// `previewPath` in src/shared/preview-navigation.ts: project-root paths only.
    static func valid(_ path: String) -> Bool {
        path.hasPrefix("/") && !path.hasPrefix("//") && path.utf16.count <= 8192 && !path.utf16.contains { $0 <= 0x20 || $0 == 0x5C }
    }

    mutating func request(chat: String, root: String, path: String, turn: String?) -> Bool {
        pending[chat] = Pending(root: root, path: path, turn: turn, awaiting: turn != nil)
        return turn == nil
    }

    /// kind: landed | failed | begin | close. Answers whether a request is ready to open.
    mutating func event(chat: String, kind: String, turn: String?) -> Bool {
        guard var request = pending[chat] else { return false }
        switch kind {
        case "landed": if request.turn == nil || request.turn == turn { request.awaiting = false }
        case "failed": if turn == nil || request.turn == nil || request.turn == turn { pending[chat] = nil; return false }
        case "begin": if turn != request.turn { pending[chat] = nil; return false }
        default: pending[chat] = nil; return false
        }
        pending[chat] = request
        return !request.awaiting
    }

    mutating func take(chat: String) -> Pending? {
        guard let request = pending[chat], !request.awaiting else { return nil }
        pending[chat] = nil
        return request
    }
}
