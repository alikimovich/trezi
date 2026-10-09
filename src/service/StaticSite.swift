import Foundation
import CoreServices
import Darwin

/// A static response. `file` streams a file of the given length; `events` holds the
/// connection open as a live-reload stream after writing its first bytes.
struct StaticResponse {
    enum Body { case bytes(Data), file(String, Int), events(Data) }
    var status: Int
    var headers: [(String, String)]
    var body: Body
    var headOnly = false
}

/// The Swift static site for plain HTML/CSS/JS projects (S06, which replaced
/// Bun's static server): files under the project root, HTML stamped with
/// `data-trezi-source` by the JS stamping helper and given a live-reload snippet, an
/// SSE stream at `/__trezi_reload`, and an FSEvents watcher that bumps the version.
/// Paths are contained lexically (as before) and, new in S06, by real path: a
/// symlink inside the project that leads outside it is refused, never served.
final class StaticSite: @unchecked Sendable {
    static let reloadPath = "/__trezi_reload"
    static let mime: [String: String] = [
        ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".cjs": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8",
        ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
        ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
        ".eot": "application/vnd.ms-fontobject", ".wasm": "application/wasm", ".mp4": "video/mp4", ".webm": "video/webm",
        ".mp3": "audio/mpeg", ".pdf": "application/pdf"
    ]

    /// Injected before `</body>`: reload when the tree's version differs from the one
    /// this page was served at. Level-triggered, so a change made while no stream was
    /// open is announced as soon as the stream reconnects.
    static func snippet(_ version: Int) -> String {
        "<script>(function(){try{var v=\"\(version)\",es=new EventSource(\"\(reloadPath)?v=\"+v);es.onmessage=function(e){if(e.data!==v)location.reload()}}catch(e){}})();</script>"
    }

    let root: String
    let canonicalRoot: String
    private let stamp: @Sendable (String, String) -> String
    private let log: @Sendable (String) -> Void
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "dev.trezi.runtime.static")
    private var version = 0
    private var clients: [EventClient] = []
    private var broadcastPending = false
    private var closed = false
    private var watcher: StaticWatcher?

    /// `stamp(html, relativePath)` returns stamped HTML or its input unchanged.
    init(root: String, stamp: @escaping @Sendable (String, String) -> String, log: @escaping @Sendable (String) -> Void) {
        var trimmed = root
        while trimmed.count > 1 && trimmed.hasSuffix("/") { trimmed.removeLast() }
        self.root = trimmed
        canonicalRoot = Self.realPath(trimmed) ?? trimmed
        self.stamp = stamp; self.log = log
    }

    var currentVersion: Int { lock.lock(); defer { lock.unlock() }; return version }
    var clientCount: Int { lock.lock(); defer { lock.unlock() }; return clients.count }
    var watching: Bool { lock.lock(); defer { lock.unlock() }; return watcher != nil }

    /// Best-effort live reload; a watcher that cannot start is reported, not fatal.
    func watch() {
        let watcher = StaticWatcher(root: canonicalRoot) { [weak self] relative in
            if relative.range(of: "(^|/)(\\.git|node_modules)(/|$)", options: .regularExpression) != nil { return }
            self?.changed()
        }
        lock.lock()
        if !closed { self.watcher = watcher }
        let open = !closed
        lock.unlock()
        if watcher == nil {
            let line = "Live reload unavailable: cannot watch \(root): the file event stream could not start."
            log(line); fputs(line + "\n", stderr)
        } else if !open { watcher?.stop() }
    }

    /// A file changed: bump now (a page served during the debounce is already
    /// current), announce to open streams 80 ms later.
    func changed() {
        lock.lock()
        version += 1
        let schedule = !broadcastPending && !closed
        if schedule { broadcastPending = true }
        lock.unlock()
        guard schedule else { return }
        queue.asyncAfter(deadline: .now() + 0.08) { [weak self] in self?.broadcast() }
    }

    private func broadcast() {
        lock.lock()
        broadcastPending = false
        let message = Data("data: \(version)\n\n".utf8), targets = clients
        lock.unlock()
        for client in targets where !client.send(message) { drop(client) }
    }

    /// Registers an open event stream; false once the site is closed.
    func attach(_ client: EventClient) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !closed else { return false }
        clients.append(client)
        return true
    }

    /// Ends a stream (a closed peer, a failed write, or close()); its reader then
    /// sees EOF and releases the descriptor.
    func drop(_ client: EventClient) {
        lock.lock()
        clients.removeAll { $0 === client }
        lock.unlock()
        client.end()
    }

    /// Stops the watcher and every stream. Requests already being answered finish.
    func close() {
        lock.lock()
        closed = true
        let targets = clients, watcher = watcher
        clients = []; self.watcher = nil
        lock.unlock()
        watcher?.stop()
        for client in targets { client.end() }
    }

    // MARK: Responses

    func respond(method: String, target: String) -> StaticResponse {
        let path = String(target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
        if path == Self.reloadPath {
            var opening = "retry: 1000\n\n"
            let current = currentVersion
            if let seen = Self.queryValue(target, "v"), seen != String(current) { opening += "data: \(current)\n\n" }
            return StaticResponse(status: 200, headers: [("Content-Type", "text/event-stream"), ("Cache-Control", "no-cache")],
                                  body: .events(Data(opening.utf8)))
        }
        guard method == "GET" || method == "HEAD" else {
            return text(405, "Method Not Allowed", headers: [("Allow", "GET, HEAD")])
        }
        let headOnly = method == "HEAD"
        guard let absolute = within(target) else { return text(403, "Forbidden") }
        var file = absolute
        var info = stat()
        var found = stat(file, &info) == 0
        if found && info.st_mode & S_IFMT == S_IFDIR {
            file = absolute + "/" + (RuntimeDetect.staticEntry(absolute) ?? "index.html")
            found = stat(file, &info) == 0
        }
        guard found, info.st_mode & S_IFMT == S_IFREG else {
            let body = "<!doctype html><meta charset=utf-8><title>404</title><body style=\"font:14px system-ui;padding:2rem\">Not found: \(target.replacingOccurrences(of: "<", with: "&lt;"))</body>"
            return StaticResponse(status: 404, headers: [("Content-Type", "text/html; charset=utf-8")], body: .bytes(Data(body.utf8)), headOnly: headOnly)
        }
        // New in S06: a symlink that leads out of the project is never followed.
        guard let real = Self.realPath(file), real == canonicalRoot || real.hasPrefix(canonicalRoot == "/" ? "/" : canonicalRoot + "/") else {
            return text(403, "Forbidden")
        }
        let type = Self.mime[Self.extensionName(file).lowercased()] ?? "application/octet-stream"
        guard type.hasPrefix("text/html") else {
            return StaticResponse(status: 200, headers: [("Content-Type", type), ("Cache-Control", "no-cache")],
                                  body: .file(file, Int(info.st_size)), headOnly: headOnly)
        }
        // Capture the version before reading: a racing change costs one extra reload, never a stale page.
        let served = currentVersion
        guard let data = FileManager.default.contents(atPath: file) else { return text(500, "Internal error") }
        let relative = String(file.dropFirst(root == "/" ? 1 : root.count + 1))
        var html = stamp(String(decoding: data, as: UTF8.self), relative)
        let script = Self.snippet(served)
        if let range = html.range(of: "</body>") { html.replaceSubrange(range, with: script + "</body>") } else { html += script }
        return StaticResponse(status: 200, headers: [("Content-Type", type), ("Cache-Control", "no-cache")],
                              body: .bytes(Data(html.utf8)), headOnly: headOnly)
    }

    private func text(_ status: Int, _ body: String, headers: [(String, String)] = []) -> StaticResponse {
        StaticResponse(status: status, headers: headers, body: .bytes(Data(body.utf8)))
    }

    /// `resolveWithinRoot`: decode (strictly), POSIX-normalize, drop leading `../`,
    /// resolve under the root; nil when the result is outside it.
    func within(_ target: String) -> String? {
        let path = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0]
            .split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)[0]
        guard let decoded = Self.decodeURIComponent(String(path)), !decoded.contains("\0") else { return nil }
        var clean = Self.normalize(decoded)
        while clean.hasPrefix("../") || clean.hasPrefix("..\\") { clean.removeFirst(3) }
        let absolute = Self.normalize(root + "/" + (clean.hasPrefix("/") ? String(clean.dropFirst()) : clean))
        let resolved = absolute.count > 1 && absolute.hasSuffix("/") ? String(absolute.dropLast()) : absolute
        guard resolved == root || resolved.hasPrefix(root == "/" ? "/" : root + "/") else { return nil }
        return resolved
    }

    // MARK: Helpers

    /// Node's `path.posix.normalize` (without the trailing-slash nuance callers drop).
    static func normalize(_ path: String) -> String {
        let absolute = path.hasPrefix("/")
        var stack: [Substring] = []
        for segment in path.split(separator: "/", omittingEmptySubsequences: true) where segment != "." {
            if segment == ".." {
                if let last = stack.last, last != ".." { stack.removeLast() } else if !absolute { stack.append(segment) }
            } else { stack.append(segment) }
        }
        let joined = stack.joined(separator: "/")
        if absolute { return "/" + joined }
        return joined.isEmpty ? "." : joined
    }

    /// `decodeURIComponent`: nil for a malformed escape or invalid UTF-8 (URIError).
    static func decodeURIComponent(_ text: String) -> String? {
        var bytes: [UInt8] = []
        var units = Array(text.utf8)[...]
        while let byte = units.first {
            units = units.dropFirst()
            guard byte == 0x25 else { bytes.append(byte); continue }
            let pair = Array(units.prefix(2))
            guard pair.count == 2, pair.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 | 0x20 >= 0x61 && $0 | 0x20 <= 0x66) }),
                  let value = UInt8(String(decoding: pair, as: UTF8.self), radix: 16) else { return nil }
            bytes.append(value); units = units.dropFirst(2)
        }
        return String(bytes: bytes, encoding: .utf8)
    }

    /// `new URL(target, base).searchParams.get(name)`.
    static func queryValue(_ target: String, _ name: String) -> String? {
        guard let query = target.split(separator: "?", maxSplits: 1).dropFirst().first else { return nil }
        for pair in query.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)[0].split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let key = String(parts[0]).replacingOccurrences(of: "+", with: " ")
            guard (key.removingPercentEncoding ?? key) == name else { continue }
            let value = parts.count > 1 ? String(parts[1]).replacingOccurrences(of: "+", with: " ") : ""
            return value.removingPercentEncoding ?? value
        }
        return nil
    }

    /// Node's `path.extname`.
    static func extensionName(_ path: String) -> String {
        let base = path.split(separator: "/").last.map(String.init) ?? ""
        guard let dot = base.lastIndex(of: "."), dot != base.startIndex else { return "" }
        return String(base[dot...])
    }

    static func realPath(_ path: String) -> String? {
        guard let resolved = Darwin.realpath(path, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }
}

/// One open event stream. Its descriptor is closed only under its own lock, so a
/// broadcast can never write to a descriptor number the process has reused.
final class EventClient: @unchecked Sendable {
    private let fd: Int32
    private let lock = NSLock()
    private var open = true
    init(_ fd: Int32) { self.fd = fd }
    func send(_ data: Data) -> Bool { lock.lock(); defer { lock.unlock() }; return open && StaticServer.writeAll(fd, data) }
    func end() { lock.lock(); if open { shutdown(fd, SHUT_RDWR) }; lock.unlock() }
    func release() { lock.lock(); if open { open = false; close(fd) }; lock.unlock() }
}

/// A recursive FSEvents watch of one directory, delivering root-relative paths.
final class StaticWatcher: @unchecked Sendable {
    private final class Box { let root: String; let change: (String) -> Void
        init(root: String, change: @escaping (String) -> Void) { self.root = root; self.change = change } }
    private var stream: FSEventStreamRef?
    private let box: Box
    private let queue = DispatchQueue(label: "dev.trezi.runtime.watch")
    private let lock = NSLock()

    init?(root: String, change: @escaping (String) -> Void) {
        box = Box(root: root, change: change)
        var context = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(box).toOpaque(), retain: nil, release: nil, copyDescription: nil)
        let flags = UInt32(kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer | kFSEventStreamCreateFlagWatchRoot)
        let callback: FSEventStreamCallback = { _, info, count, paths, eventFlags, _ in
            guard let info else { return }
            let box = Unmanaged<Box>.fromOpaque(info).takeUnretainedValue()
            let list = unsafeBitCast(paths, to: NSArray.self)
            for index in 0..<count where eventFlags[index] & UInt32(kFSEventStreamEventFlagHistoryDone) == 0 {
                guard let path = list[index] as? String else { continue }
                let relative = path == box.root ? "" : path.hasPrefix(box.root + "/") ? String(path.dropFirst(box.root.count + 1)) : path
                box.change(relative)
            }
        }
        guard let created = FSEventStreamCreate(kCFAllocatorDefault, callback, &context, [root] as CFArray,
                                                FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.03, flags) else { return nil }
        FSEventStreamSetDispatchQueue(created, queue)
        guard FSEventStreamStart(created) else {
            FSEventStreamInvalidate(created); FSEventStreamRelease(created)
            return nil
        }
        stream = created
    }

    func stop() {
        lock.lock(); let current = stream; stream = nil; lock.unlock()
        guard let current else { return }
        FSEventStreamStop(current)
        FSEventStreamInvalidate(current)
        // Invalidation is synchronous with the queue: no callback runs after this.
        queue.sync {}
        FSEventStreamRelease(current)
    }

    deinit { stop() }
}
