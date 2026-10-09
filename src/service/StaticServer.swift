import Foundation
import Darwin

/// The HTTP/1.1 socket layer of a `StaticSite`: an IPv4 loopback listener and one
/// short-lived connection per request (`Connection: close`). An event stream stays
/// open until its peer leaves or the site closes. `serve(_:site:)` takes any
/// connected stream socket, so fixtures exercise it over a socketpair.
final class StaticServer: @unchecked Sendable {
    static let maxHead = 16 * 1024
    let port: Int
    let site: StaticSite
    private let source: DispatchSourceRead
    private let lock = NSLock()
    private var closed = false

    private init(port: Int, site: StaticSite, source: DispatchSourceRead) { self.port = port; self.site = site; self.source = source }

    /// Listens on `host:port` (`SO_REUSEADDR`, as Node's listen) and starts the watcher.
    static func listen(site: StaticSite, host: String, port: Int) throws -> StaticServer {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw ManagedProcessError.spawn("socket", errno) }
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
        _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(UInt16(port).bigEndian)
        guard inet_pton(AF_INET, host, &address.sin_addr) == 1 else { Darwin.close(fd); throw ManagedProcessError.spawn("address \(host)", EINVAL) }
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        guard bound == 0, Darwin.listen(fd, 128) == 0 else {
            let code = errno; Darwin.close(fd)
            throw ManagedProcessError.spawn("listen \(code == EADDRINUSE ? "EADDRINUSE: address already in use" : "") \(host):\(port)", code)
        }
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: DispatchQueue(label: "dev.trezi.runtime.accept"))
        let server = StaticServer(port: port, site: site, source: source)
        source.setEventHandler {
            while true {
                let connection = accept(fd, nil, nil)
                if connection < 0 { break }
                _ = fcntl(connection, F_SETFL, fcntl(connection, F_GETFL) & ~O_NONBLOCK)
                _ = fcntl(connection, F_SETFD, FD_CLOEXEC)
                DispatchQueue.global(qos: .userInitiated).async { serve(connection, site: site) }
            }
        }
        source.setCancelHandler { Darwin.close(fd) }
        source.resume()
        site.watch()
        return server
    }

    /// Stops accepting, then ends every stream and the watcher.
    func close() {
        lock.lock(); let first = !closed; closed = true; lock.unlock()
        guard first else { return }
        source.cancel()
        site.close()
    }

    // MARK: One connection

    static func serve(_ fd: Int32, site: StaticSite) {
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        var timeout = timeval(tv_sec: 10, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        guard let head = readHead(fd) else {
            _ = writeAll(fd, response(status: 431, headers: [], length: 0)); Darwin.close(fd); return
        }
        let line = head.split(separator: "\r\n", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
        let parts = line.split(separator: " ", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[2].hasPrefix("HTTP/1."), !parts[0].isEmpty, parts[1].hasPrefix("/") || parts[1].contains("://") else {
            if !head.isEmpty { _ = writeAll(fd, response(status: 400, headers: [], length: 0)) }
            Darwin.close(fd); return
        }
        let reply = site.respond(method: String(parts[0]), target: String(parts[1]))
        switch reply.body {
        case .events(let opening):
            let client = EventClient(fd)
            guard client.send(response(status: reply.status, headers: reply.headers, length: nil) + opening), site.attach(client) else {
                client.release(); return
            }
            // Held until the peer leaves (EOF) or the site ends it (shutdown).
            var noTimeout = timeval(tv_sec: 0, tv_usec: 0)
            setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &noTimeout, socklen_t(MemoryLayout<timeval>.size))
            var buffer = [UInt8](repeating: 0, count: 512)
            while true {
                let count = read(fd, &buffer, buffer.count)
                if count < 0 && errno == EINTR { continue }
                if count <= 0 { break }
            }
            site.drop(client)
            client.release()
        case .bytes(let data):
            _ = writeAll(fd, response(status: reply.status, headers: reply.headers, length: data.count) + (reply.headOnly ? Data() : data))
            Darwin.close(fd)
        case .file(let path, let length):
            if writeAll(fd, response(status: reply.status, headers: reply.headers, length: length)), !reply.headOnly {
                streamFile(path, to: fd)
            }
            Darwin.close(fd)
        }
    }

    /// The request head (through the blank line), or nil if it exceeds 16 KiB or
    /// the peer stops sending. An empty string means the peer closed first.
    static func readHead(_ fd: Int32) -> String? {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        let terminator = Data("\r\n\r\n".utf8)
        while data.range(of: terminator) == nil {
            guard data.count <= maxHead else { return nil }
            let count = read(fd, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            if count < 0 { return nil }
            if count == 0 { return data.isEmpty ? "" : nil }
            data.append(contentsOf: buffer[..<count])
        }
        guard let end = data.range(of: terminator), end.lowerBound <= maxHead else { return nil }
        return String(decoding: data[..<end.lowerBound], as: UTF8.self)
    }

    static let reasons = [200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
                          431: "Request Header Fields Too Large", 500: "Internal Server Error"]

    static func response(status: Int, headers: [(String, String)], length: Int?) -> Data {
        var head = "HTTP/1.1 \(status) \(reasons[status] ?? "OK")\r\n"
        for (name, value) in headers { head += "\(name): \(value)\r\n" }
        if let length { head += "Content-Length: \(length)\r\n" }
        head += "Connection: close\r\n\r\n"
        return Data(head.utf8)
    }

    static func streamFile(_ path: String, to fd: Int32) {
        let file = open(path, O_RDONLY | O_CLOEXEC)
        guard file >= 0 else { return }
        defer { Darwin.close(file) }
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = read(file, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            if count <= 0 || !writeAll(fd, Data(buffer[..<count])) { return }
        }
    }

    /// Writes everything or reports failure (a closed peer, a send timeout).
    @discardableResult
    static func writeAll(_ fd: Int32, _ data: Data) -> Bool {
        data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return true }
            var offset = 0
            while offset < raw.count {
                let written = write(fd, base + offset, raw.count - offset)
                if written < 0 && errno == EINTR { continue }
                if written <= 0 { return false }
                offset += written
            }
            return true
        }
    }
}
