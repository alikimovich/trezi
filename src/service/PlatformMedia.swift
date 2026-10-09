import Foundation
import CryptoKit
import Darwin

/// Scoped media capabilities for the native source editor (S14, which replaced
/// Bun's `trezi-media://` token registry). A grant names one file the
/// owner authorized inside a project (the source service's path rules: no traversal,
/// no Git store, sidecars or dependencies, symlinks only to project files), one view
/// (the source editor), its size, identity (device, inode, modification time) and
/// SHA-256, and an expiry. Resolving checks all of them again: a different view is
/// refused, an expired or unknown token is refused, and a file that changed or moved
/// since the grant revokes it. Tokens are random, not derived from the path.
final class MediaScopes: @unchecked Sendable {
    static let views: Set<String> = ["source"]
    /// Extension → (kind, MIME), the twin of `src/main/media-types.ts`.
    static let types: [String: (String, String)] = [
        ".png": ("image", "image/png"), ".jpg": ("image", "image/jpeg"), ".jpeg": ("image", "image/jpeg"),
        ".gif": ("image", "image/gif"), ".webp": ("image", "image/webp"), ".avif": ("image", "image/avif"),
        ".bmp": ("image", "image/bmp"), ".ico": ("image", "image/x-icon"),
        ".mp4": ("video", "video/mp4"), ".m4v": ("video", "video/mp4"), ".webm": ("video", "video/webm"),
        ".ogv": ("video", "video/ogg"), ".mov": ("video", "video/quicktime"),
        ".mp3": ("audio", "audio/mpeg"), ".m4a": ("audio", "audio/mp4"), ".aac": ("audio", "audio/aac"),
        ".wav": ("audio", "audio/wav"), ".oga": ("audio", "audio/ogg"), ".ogg": ("audio", "audio/ogg"),
        ".flac": ("audio", "audio/flac")
    ]

    struct Identity: Equatable { let device: Int64, inode: UInt64, size: Int64, modified: Int64 }

    struct Grant {
        let token: String
        let root: String
        let canonical: String
        let rel: String
        let view: String
        let kind: String
        let mediaType: String
        let identity: Identity
        let hash: String
        let real: String
        var expires: Date

        func value(url: Bool) -> JSValue {
            var fields: [(JSText, JSValue)] = [(JSText("kind"), .string(JSText(kind))), (JSText("mediaType"), .string(JSText(mediaType))),
                                              (JSText("bytes"), .number(Double(identity.size))), (JSText("sha256"), .string(JSText(hash))),
                                              (JSText("expires"), .number((expires.timeIntervalSince1970 * 1000).rounded()))]
            if url { fields = [(JSText("token"), .string(JSText(token))), (JSText("url"), .string(JSText("trezi-media://f/\(token)")))] + fields }
            else { fields = [(JSText("path"), .string(JSText(real)))] + fields }
            return .object(fields)
        }
    }

    let ttl: TimeInterval
    let maxTokens: Int
    let maxBytes: Int64
    private let now: @Sendable () -> Date
    private let lock = NSLock()
    private var grants: [String: Grant] = [:]
    private var order: [String] = []

    init(ttl: TimeInterval, maxTokens: Int, maxBytes: Int64, now: @escaping @Sendable () -> Date) {
        self.ttl = ttl; self.maxTokens = maxTokens; self.maxBytes = maxBytes; self.now = now
    }

    var count: Int { lock.lock(); defer { lock.unlock() }; return grants.count }

    static func identity(_ path: String) -> Identity? {
        var info = stat()
        guard stat(path, &info) == 0, info.st_mode & S_IFMT == S_IFREG else { return nil }
        return Identity(device: Int64(info.st_dev), inode: UInt64(info.st_ino), size: Int64(info.st_size),
                        modified: Int64(info.st_mtimespec.tv_sec) * 1_000_000_000 + Int64(info.st_mtimespec.tv_nsec))
    }

    static func token() -> String {
        var generator = SystemRandomNumberGenerator()
        return (0..<4).map { _ in String(format: "%016llx", generator.next() as UInt64) }.joined()
    }

    /// The authorized real file for `path` inside `root` (the source service's rules).
    private static func authorize(root: String, path: String) throws -> (canonical: String, rel: String, real: String) {
        do {
            let canonical = try SourcePaths.root(root)
            let target = try SourcePaths.target(given: root, root: canonical, path: path)
            guard target.exists else { throw PlatformRefusal(.notFound, "The media file is not available.") }
            return (canonical, target.rel, target.real)
        } catch let refusal as RepositoryRefusal {
            throw PlatformRefusal(refusal.code == .unauthorized ? .unauthorized : refusal.code, refusal.message)
        }
    }

    /// Hashes the file, refusing one that changes while it is read.
    private static func hash(_ path: String, identity: Identity) throws -> String {
        guard let handle = FileHandle(forReadingAtPath: path) else { throw PlatformRefusal(.notFound, "The media file is not available.") }
        defer { try? handle.close() }
        var hasher = SHA256()
        var total: Int64 = 0
        while true {
            let chunk = try handle.read(upToCount: 1 << 20) ?? Data()
            if chunk.isEmpty { break }
            total += Int64(chunk.count)
            guard total <= identity.size else { break }
            hasher.update(data: chunk)
        }
        guard total == identity.size, Self.identity(path) == identity else {
            throw PlatformRefusal(.conflict, "The media file changed while it was being read.")
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    func grant(root: String, path: String, view: String) throws -> Grant {
        guard Self.views.contains(view) else { throw PlatformRefusal(.unauthorized, "Media is only granted to the source editor.") }
        let (canonical, rel, real) = try Self.authorize(root: root, path: path)
        guard let type = Self.types[StaticSite.extensionName(rel).lowercased()] else {
            throw PlatformRefusal(.invalidRequest, "Not a previewable media file.")
        }
        guard let identity = Self.identity(real) else { throw PlatformRefusal(.notFound, "The media file is not available.") }
        guard identity.size <= maxBytes else { throw PlatformRefusal(.invalidRequest, "The media file is too large to preview here.") }
        let grant = Grant(token: Self.token(), root: root, canonical: canonical, rel: rel, view: view, kind: type.0, mediaType: type.1,
                          identity: identity, hash: try Self.hash(real, identity: identity), real: real, expires: now().addingTimeInterval(ttl))
        lock.lock(); defer { lock.unlock() }
        // One grant per file and view: re-opening a file revokes its older token.
        for (token, old) in grants where old.canonical == canonical && old.rel == rel && old.view == view { revoke(token) }
        grants[grant.token] = grant
        order.append(grant.token)
        while order.count > maxTokens { grants.removeValue(forKey: order.removeFirst()) }
        return grant
    }

    /// Must hold `lock`.
    private func revoke(_ token: String) {
        grants.removeValue(forKey: token)
        order.removeAll { $0 == token }
    }

    func resolve(token: String, view: String) throws -> Grant {
        lock.lock()
        guard var grant = grants[token] else { lock.unlock(); throw PlatformRefusal(.notFound, "This media link is unknown or was revoked.") }
        guard grant.view == view else { lock.unlock(); throw PlatformRefusal(.unauthorized, "This media link was granted to another view.") }
        guard now() < grant.expires else { revoke(token); lock.unlock(); throw PlatformRefusal(.deadlineExceeded, "This media link expired.") }
        lock.unlock()
        // Re-authorized every time: a file swapped for a link out of the project is refused.
        let current: (canonical: String, rel: String, real: String)
        do { current = try Self.authorize(root: grant.root, path: grant.rel) } catch {
            lock.lock(); revoke(token); lock.unlock()
            throw error
        }
        guard current.canonical == grant.canonical, current.real == grant.real, Self.identity(current.real) == grant.identity else {
            lock.lock(); revoke(token); lock.unlock()
            throw PlatformRefusal(.conflict, "The media file changed since it was opened.")
        }
        lock.lock(); defer { lock.unlock() }
        guard grants[token] != nil else { throw PlatformRefusal(.notFound, "This media link is unknown or was revoked.") }
        grant.expires = now().addingTimeInterval(ttl)
        grants[token] = grant
        return grant
    }
}

/// Pasted composer images (formerly `attachments:save` in Bun):
/// the bytes arrive in bounded chunks against an upload scope that fixes their media
/// type, size and SHA-256 and expires when idle; only a complete, matching upload is
/// written, under `<profile>/trezi/attachments` (a real directory, never a link), with
/// the legacy file names. Each save prunes regular files older than seven days.
final class AttachmentUploads: @unchecked Sendable {
    static let extensions: [String: String] = [
        "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp",
        "image/svg+xml": "svg", "image/avif": "avif", "image/bmp": "bmp", "image/tiff": "tiff"
    ]
    static let maxAge: TimeInterval = 7 * 24 * 60 * 60

    struct Upload { let mediaType: String; let name: String?; let bytes: Int; let sha256: String; var data: Data; var touched: Date }

    let directory: String
    let maxBytes: Int
    let maxUploads: Int
    let idle: TimeInterval
    private let now: @Sendable () -> Date
    private let lock = NSLock()
    private var uploads: [String: Upload] = [:]

    init(profile: String, maxBytes: Int, maxUploads: Int = 4, idle: TimeInterval = 60, now: @escaping @Sendable () -> Date) {
        directory = profile + "/trezi/attachments"
        self.maxBytes = maxBytes; self.maxUploads = maxUploads; self.idle = idle; self.now = now
    }

    var count: Int { lock.lock(); defer { lock.unlock() }; return uploads.count }

    /// `safeStem` + `attachmentFileName` from the retired attachments.ts.
    static func fileName(mediaType: String, name: String?, stamp: String) -> String {
        let ext = extensions[mediaType.lowercased()] ?? "png"
        var stem = ""
        if let name {
            let base = name.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""
            var withoutExt = base
            if let dot = base.lastIndex(of: "."), dot != base.startIndex { withoutExt = String(base[..<dot]) }
            let replaced = withoutExt.replacingOccurrences(of: "[^A-Za-z0-9._-]+", with: "-", options: .regularExpression)
                .replacingOccurrences(of: "^[.-]+", with: "", options: .regularExpression)
                .replacingOccurrences(of: "-{2,}", with: "-", options: .regularExpression)
            // Only ASCII survives the replacement, so 40 characters are 40 UTF-16 units.
            stem = String(replaced.prefix(40)).replacingOccurrences(of: "[.-]+$", with: "", options: .regularExpression)
        }
        return "\(stamp)-\(stem.isEmpty ? "pasted-image" : stem).\(ext)"
    }

    private func expire() {
        let cutoff = now().addingTimeInterval(-idle)
        uploads = uploads.filter { $0.value.touched >= cutoff }
    }

    func open(mediaType: String, name: String?, bytes: Int, sha256: String) throws -> String {
        guard mediaType.lowercased().hasPrefix("image/"), mediaType.utf8.count <= 128 else {
            throw PlatformRefusal(.invalidRequest, "Only images can be attached.")
        }
        guard bytes > 0, bytes <= maxBytes else { throw PlatformRefusal(.invalidRequest, "The image is empty or too large to attach.") }
        guard sha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil, (name?.utf16.count ?? 0) <= 1024 else {
            throw PlatformRefusal(.invalidRequest, "Invalid attachment.")
        }
        lock.lock(); defer { lock.unlock() }
        expire()
        guard uploads.count < maxUploads else { throw PlatformRefusal(.busy, "Too many images are being attached at once.") }
        let id = MediaScopes.token()
        uploads[id] = Upload(mediaType: mediaType, name: name, bytes: bytes, sha256: sha256, data: Data(), touched: now())
        return id
    }

    func chunk(upload id: String, offset: Int, data: Data) throws {
        lock.lock(); defer { lock.unlock() }
        expire()
        guard var upload = uploads[id] else { throw PlatformRefusal(.notFound, "The attachment upload expired or is unknown.") }
        guard offset == upload.data.count, upload.data.count + data.count <= upload.bytes, !data.isEmpty else {
            uploads.removeValue(forKey: id)
            throw PlatformRefusal(.invalidRequest, "The attachment bytes do not match its upload.")
        }
        upload.data.append(data)
        upload.touched = now()
        uploads[id] = upload
    }

    /// Writes the complete upload; the upload is gone afterwards whatever the outcome.
    func commit(upload id: String) throws -> String {
        lock.lock()
        expire()
        let upload = uploads.removeValue(forKey: id)
        lock.unlock()
        guard let upload else { throw PlatformRefusal(.notFound, "The attachment upload expired or is unknown.") }
        guard upload.data.count == upload.bytes, SourcePaths.hash(upload.data) == upload.sha256 else {
            throw PlatformRefusal(.conflict, "The attachment bytes do not match their hash.")
        }
        let folder = try prepareDirectory()
        let stamp = String(Int64((now().timeIntervalSince1970 * 1000).rounded(.down)))
        let path = folder + "/" + Self.fileName(mediaType: upload.mediaType, name: upload.name, stamp: stamp)
        do { try SourcePaths.write(upload.data, to: path) } catch {
            throw PlatformRefusal(.ioFailure, "The image could not be saved: \(error)")
        }
        prune()
        return path
    }

    /// `<profile>/trezi` may be a link to the legacy session folder; `attachments`
    /// itself must be a real directory of this user.
    private func prepareDirectory() throws -> String {
        let parent = (directory as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard let realParent = StaticSite.realPath(parent) else { throw PlatformRefusal(.unavailable, "The attachments folder is not available.") }
        let folder = realParent + "/attachments"
        if mkdir(folder, 0o700) != 0 && errno != EEXIST { throw PlatformRefusal(.unavailable, "The attachments folder is not available.") }
        var info = stat()
        guard lstat(folder, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid() else {
            throw PlatformRefusal(.unauthorized, "The attachments folder is not a plain folder.")
        }
        return folder
    }

    /// Regular files only (a link is never followed or removed); never throws.
    @discardableResult
    func prune() -> Int {
        guard let folder = try? prepareDirectory(), let entries = try? FileManager.default.contentsOfDirectory(atPath: folder) else { return 0 }
        let cutoff = now().timeIntervalSince1970 - Self.maxAge
        var removed = 0
        for entry in entries {
            let path = folder + "/" + entry
            var info = stat()
            guard lstat(path, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
                  TimeInterval(info.st_mtimespec.tv_sec) + TimeInterval(info.st_mtimespec.tv_nsec) / 1e9 < cutoff else { continue }
            if unlink(path) == 0 { removed += 1 }
        }
        return removed
    }
}
