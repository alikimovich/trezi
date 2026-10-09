import Foundation
import CryptoKit
import Darwin

/// Canonical path authorization and byte-exact file I/O for the source service
/// (S08). Every path that reaches the owner is untrusted: it must name a file inside
/// the project root after every symlink is resolved, and never one inside Git's
/// store, a Trezi sidecar or installed dependencies.
enum SourcePaths {
    /// Directories source edits and file operations never touch, at any depth.
    /// `.dsgn` is the sidecar's pre-rename name; old repositories still carry it.
    static let protected: Set<String> = [".git", ".trezi", ".praxis", ".dsgn", "node_modules"]
    /// A text transaction or read is bounded (the whole batch also crosses the pipe).
    static let maxFileBytes = 16 * 1024 * 1024

    struct Target: Sendable {
        /// Repo-relative POSIX path as the user sees it.
        let rel: String
        /// The lexical path inside the resolved root (a symlink stays a symlink here).
        let lexical: String
        /// The real file to read or write: `lexical`, or a symlink's target inside the root.
        let real: String
        let exists: Bool
    }

    /// Repo-relative POSIX path, or nil: empty, absolute, traversing, NUL or protected.
    static func relative(_ input: String) -> String? {
        let posix = input.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\\", with: "/")
        guard !posix.isEmpty, !posix.contains("\0"), !posix.hasPrefix("/"),
              posix.range(of: #"^[A-Za-z]:"#, options: .regularExpression) == nil else { return nil }
        let segments = posix.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard !segments.isEmpty else { return nil }
        for segment in segments where segment == "." || segment == ".." || protected.contains(segment) { return nil }
        return segments.joined(separator: "/")
    }

    /// The resolved project root: an existing directory that is not the file system root.
    static func root(_ root: String) throws -> String {
        var isDirectory: ObjCBool = false
        guard root.hasPrefix("/"), let real = RepositoryPaths.realpath(root), real != "/",
              FileManager.default.fileExists(atPath: real, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw RepositoryRefusal(.unauthorized, "The project folder is not available.")
        }
        return real
    }

    /// Authorizes `input` (absolute under `given` or its real path, or repo-relative).
    static func target(given: String, root: String, path input: String) throws -> Target {
        let refused = RepositoryRefusal(.unauthorized, "That path is not allowed.")
        var candidate = input
        if input.hasPrefix("/") {
            let lexical = (input as NSString).standardizingPath
            candidate = ""
            for base in [(given as NSString).standardizingPath, root] where lexical.hasPrefix(base + "/") {
                candidate = String(lexical.dropFirst(base.count + 1)); break
            }
        }
        guard let rel = relative(candidate) else { throw refused }
        let lexical = root + "/" + rel
        // The deepest existing ancestor decides where a new or missing file would land.
        var ancestor = (lexical as NSString).deletingLastPathComponent
        while !FileManager.default.fileExists(atPath: ancestor), ancestor.count > root.count {
            ancestor = (ancestor as NSString).deletingLastPathComponent
        }
        guard let parent = RepositoryPaths.realpath(ancestor), RepositoryPaths.contains(root, parent) else { throw refused }
        var info = stat()
        guard lstat(lexical, &info) == 0 else { return Target(rel: rel, lexical: lexical, real: lexical, exists: false) }
        if (info.st_mode & S_IFMT) == S_IFLNK {
            // A link inside the project may point at another project file, never out of it.
            guard let real = RepositoryPaths.realpath(lexical), RepositoryPaths.contains(root, real), real != root,
                  relative(String(real.dropFirst(root.count + 1))) != nil else { throw refused }
            return Target(rel: rel, lexical: lexical, real: real, exists: true)
        }
        return Target(rel: rel, lexical: lexical, real: lexical, exists: true)
    }

    static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    static func isRegularFile(_ path: String) -> Bool {
        var info = stat()
        return stat(path, &info) == 0 && (info.st_mode & S_IFMT) == S_IFREG
    }

    /// The file's bytes (bounded), or nil when it is missing or not a regular file.
    static func read(_ path: String) throws -> Data? {
        guard isRegularFile(path) else { return nil }
        guard let handle = FileHandle(forReadingAtPath: path) else { return nil }
        defer { try? handle.close() }
        let data = try handle.read(upToCount: maxFileBytes + 1) ?? Data()
        guard data.count <= maxFileBytes else { throw RepositoryRefusal(.invalidRequest, "The file is too large to edit here.") }
        return data
    }

    /// Replaces `path` atomically (temporary file in the same directory, synced, renamed
    /// over it), keeping an existing file's permissions. A reader never sees a torn file.
    static func write(_ data: Data, to path: String) throws {
        let directory = (path as NSString).deletingLastPathComponent
        var mode: mode_t = 0o644
        var info = stat()
        if stat(path, &info) == 0 { mode = info.st_mode & 0o7777 }
        let temporary = directory + "/." + (path as NSString).lastPathComponent + ".trezi-" + UUID().uuidString.prefix(8) + ".tmp"
        let fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        var failed: Int32 = 0
        data.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let written = Darwin.write(fd, buffer.baseAddress! + offset, buffer.count - offset)
                if written < 0 { if errno == EINTR { continue }; failed = errno; return }
                offset += written
            }
        }
        if failed == 0, fchmod(fd, mode) != 0 { failed = errno }
        if failed == 0, fsync(fd) != 0 { failed = errno }
        close(fd)
        if failed == 0, rename(temporary, path) != 0 { failed = errno }
        if failed != 0 { unlink(temporary); throw POSIXError(POSIXErrorCode(rawValue: failed) ?? .EIO) }
        syncDirectory(directory)
    }

    static func syncDirectory(_ directory: String) {
        let fd = open(directory, O_RDONLY | O_CLOEXEC)
        if fd >= 0 { fsync(fd); close(fd) }
    }
}
