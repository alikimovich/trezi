import Foundation
import Darwin

/// The simulator's loopback "sim bridge" (S14; formerly the Node `http` server in
/// `src/main/simulator.ts`): the device page at `/`, an MJPEG stream of captured frames
/// at `/stream` and input at `/control`, on 127.0.0.1 only. Every request must name
/// this bridge's own host (DNS rebinding keeps the attacker's name in `Host`); the
/// stream and control routes also need the per-bridge token baked into the page, which
/// a cross-origin page cannot read (no CORS headers). Bodies are bounded (4 KiB), the
/// stream is capped at eight viewers, and a slow viewer is dropped, never waited on.
final class SimulatorBridge: @unchecked Sendable {
    static let boundary = "treziframe"
    static let maxStreams = 8
    static let maxBody = 4096

    /// Input for a device with idb; nil when the preview is view-only.
    struct Interaction: Sendable {
        let send: @Sendable (SimulatorTools.Command) throws -> Void
        let selecting: @Sendable () -> Bool
        let select: @Sendable (Double, Double) -> Void
    }

    let port: Int
    let token: String
    private let page: Data
    private let interaction: Interaction?
    private let listener: DispatchSourceRead
    private let condition = NSCondition()
    private var clients: [EventClient] = []
    private var latest: Data?
    private var first: String??
    private var closed = false
    private var capture: FrameCapture?

    private init(port: Int, token: String, page: Data, interaction: Interaction?, listener: DispatchSourceRead) {
        self.port = port; self.token = token; self.page = page; self.interaction = interaction; self.listener = listener
    }

    var url: String { "http://127.0.0.1:\(port)/?treziSim=1" }
    var streams: Int { condition.lock(); defer { condition.unlock() }; return clients.count }

    static func listen(port: Int, frame: SimulatorTools.Frame, interaction: Interaction?) throws -> SimulatorBridge {
        let token = String(MediaScopes.token().prefix(32))
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw PlatformRefusal(.unavailable, "socket: \(String(cString: strerror(errno)))") }
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
        _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(UInt16(port).bigEndian)
        _ = inet_pton(AF_INET, "127.0.0.1", &address.sin_addr)
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        guard bound == 0, Darwin.listen(fd, 64) == 0 else {
            let code = errno; Darwin.close(fd)
            throw PlatformRefusal(.unavailable, "listen 127.0.0.1:\(port): \(String(cString: strerror(code)))")
        }
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: DispatchQueue(label: "dev.trezi.simulator.accept"))
        let page = Data(SimulatorTools.page(interactive: interaction != nil, token: token, frame: frame).utf8)
        let bridge = SimulatorBridge(port: port, token: token, page: page, interaction: interaction, listener: source)
        source.setEventHandler { [weak bridge] in
            while true {
                let connection = Darwin.accept(fd, nil, nil)
                if connection < 0 { break }
                _ = fcntl(connection, F_SETFL, fcntl(connection, F_GETFL) & ~O_NONBLOCK)
                _ = fcntl(connection, F_SETFD, FD_CLOEXEC)
                guard let bridge else { Darwin.close(connection); continue }
                DispatchQueue.global(qos: .userInitiated).async { bridge.serve(connection) }
            }
        }
        source.setCancelHandler { Darwin.close(fd) }
        source.resume()
        return bridge
    }

    // MARK: Frames

    /// Starts capturing; a capture failure before the first frame fails readiness.
    func start(_ capture: FrameCapture) {
        condition.lock()
        guard !closed else { condition.unlock(); capture.stop(); return }
        self.capture = capture
        condition.unlock()
        capture.start(onFrame: { [weak self] jpeg in self?.deliver(jpeg) },
                      onError: { [weak self] message in self?.failed(message) })
    }

    func deliver(_ jpeg: Data) {
        condition.lock()
        latest = jpeg
        if first == nil { first = .some(nil); condition.broadcast() }
        let targets = clients
        condition.unlock()
        let part = Self.part(jpeg)
        for client in targets where !client.send(part) { drop(client) }
    }

    private func failed(_ message: String) {
        condition.lock()
        if first == nil { first = .some(message); condition.broadcast() }
        condition.unlock()
    }

    /// Nil once a real frame arrived; the reason otherwise (a capture error, the
    /// deadline, a stop). Waits in short slices so `cancelled` is honoured promptly.
    func waitForFirstFrame(timeout: TimeInterval, cancelled: () -> Bool) -> String? {
        let deadline = Date().addingTimeInterval(timeout)
        condition.lock(); defer { condition.unlock() }
        while first == nil && !closed {
            if cancelled() { return "cancelled" }
            if Date() >= deadline { return "Simulator booted, but no frame was captured." }
            _ = condition.wait(until: min(deadline, Date().addingTimeInterval(0.1)))
        }
        if closed && first == nil { return "cancelled" }
        return first ?? nil
    }

    static func part(_ jpeg: Data) -> Data {
        Data("--\(boundary)\r\nContent-Type: image/jpeg\r\nContent-Length: \(jpeg.count)\r\n\r\n".utf8) + jpeg + Data("\r\n".utf8)
    }

    /// Stops accepting, capturing and every stream. Idempotent.
    func close() {
        condition.lock()
        let firstClose = !closed
        closed = true
        let targets = clients, capture = capture
        clients = []
        condition.broadcast()
        condition.unlock()
        guard firstClose else { return }
        listener.cancel()
        capture?.stop()
        for client in targets { client.end() }
    }

    private func drop(_ client: EventClient) {
        condition.lock(); clients.removeAll { $0 === client }; condition.unlock()
        client.end()
    }

    // MARK: One connection

    static let reasons = [200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 413: "Payload Too Large",
                          431: "Request Header Fields Too Large", 503: "Service Unavailable"]

    static func head(_ status: Int, _ headers: [(String, String)], length: Int?, keepAlive: Bool = false) -> Data {
        var text = "HTTP/1.1 \(status) \(reasons[status] ?? "OK")\r\n"
        for (name, value) in headers { text += "\(name): \(value)\r\n" }
        if let length { text += "Content-Length: \(length)\r\n" }
        text += keepAlive ? "Connection: keep-alive\r\n\r\n" : "Connection: close\r\n\r\n"
        return Data(text.utf8)
    }

    /// The request head and whatever body bytes arrived with it, or nil (too large, stalled).
    static func readRequest(_ fd: Int32) -> (String, Data)? {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        let terminator = Data("\r\n\r\n".utf8)
        while data.range(of: terminator) == nil {
            guard data.count <= StaticServer.maxHead else { return nil }
            let count = read(fd, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            if count <= 0 { return nil }
            data.append(contentsOf: buffer[..<count])
        }
        let end = data.range(of: terminator)!
        guard end.lowerBound <= StaticServer.maxHead else { return nil }
        return (String(decoding: data[..<end.lowerBound], as: UTF8.self), Data(data[end.upperBound...]))
    }

    private func respond(_ fd: Int32, _ status: Int, _ headers: [(String, String)] = [], _ body: Data = Data()) {
        _ = StaticServer.writeAll(fd, Self.head(status, headers, length: body.count) + body)
        Darwin.close(fd)
    }

    private func json(_ fd: Int32, _ fields: [(String, JSValue)]) {
        respond(fd, 200, [("Content-Type", "application/json")], JSValue.object(fields.map { (JSText($0.0), $0.1) }).utf8())
    }

    func serve(_ fd: Int32) {
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        var timeout = timeval(tv_sec: 10, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        guard let (head, early) = Self.readRequest(fd) else { return respond(fd, 431) }
        let lines = head.components(separatedBy: "\r\n")
        let parts = lines[0].split(separator: " ", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[2].hasPrefix("HTTP/1.") else { return respond(fd, 400) }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        guard headers["host"] == "127.0.0.1:\(port)" || headers["host"] == "localhost:\(port)" else { return respond(fd, 403) }
        let target = String(parts[1]), method = String(parts[0])
        let path = String(target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0])
        let tokenOK = StaticSite.queryValue(target, "token") == token
        if path == "/" {
            return respond(fd, 200, [("Content-Type", "text/html; charset=utf-8"), ("Cache-Control", "no-store")], page)
        }
        if path == "/control" && method == "POST" {
            guard tokenOK else { return respond(fd, 403) }
            guard let length = headers["content-length"].flatMap(Int.init), length >= 0 else { return respond(fd, 400) }
            guard length <= Self.maxBody else { return respond(fd, 413) }
            var body = early.prefix(length)
            var buffer = [UInt8](repeating: 0, count: 4096)
            while body.count < length {
                let count = read(fd, &buffer, min(buffer.count, length - body.count))
                if count < 0 && errno == EINTR { continue }
                if count <= 0 { return respond(fd, 400) }
                body.append(contentsOf: buffer[..<count])
            }
            guard let interaction else { return json(fd, [("degraded", .bool(true))]) }
            guard let value = try? JSValue.parse(Data(body), maxDepth: 8), let command = SimulatorTools.command(value) else { return respond(fd, 400) }
            // A tap in select mode is an element pick (hit-test), not a tap-through.
            if case let .tap(x, y) = command, interaction.selecting() {
                interaction.select(x, y)
                return json(fd, [("selected", .bool(true))])
            }
            do {
                try interaction.send(command)
                return json(fd, [("ok", .bool(true))])
            } catch {
                return json(fd, [("ok", .bool(false)), ("error", .string(JSText("\(error)")))])
            }
        }
        if path == "/stream" {
            guard tokenOK else { return respond(fd, 403) }
            // A viewer that cannot keep up is dropped rather than stalling every other one.
            var send = timeval(tv_sec: 2, tv_usec: 0)
            setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &send, socklen_t(MemoryLayout<timeval>.size))
            condition.lock()
            guard !closed, clients.count < Self.maxStreams else { condition.unlock(); return respond(fd, 503) }
            let client = EventClient(fd)
            clients.append(client)
            let current = latest
            condition.unlock()
            let opening = Self.head(200, [("Content-Type", "multipart/x-mixed-replace; boundary=\(Self.boundary)"), ("Cache-Control", "no-store"),
                                          ("Pragma", "no-cache")], length: nil, keepAlive: true)
            if !client.send(opening + (current.map(Self.part) ?? Data())) { drop(client) }
            var none = timeval(tv_sec: 0, tv_usec: 0)
            setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &none, socklen_t(MemoryLayout<timeval>.size))
            var buffer = [UInt8](repeating: 0, count: 512)
            while true {
                let count = read(fd, &buffer, buffer.count)
                if count < 0 && errno == EINTR { continue }
                if count <= 0 { break }
            }
            drop(client)
            client.release()
            return
        }
        respond(fd, 404)
    }
}

/// Polls a frame source (`simctl io … screenshot`) at a modest rate, one capture in
/// flight at a time, until stopped.
final class FrameCapture: @unchecked Sendable {
    private let interval: TimeInterval
    private let capture: @Sendable () throws -> Data?
    private let queue = DispatchQueue(label: "dev.trezi.simulator.frames")
    private let lock = NSLock()
    private var timer: DispatchSourceTimer?
    private var stopped = false
    private var inflight = false
    private let onStop: @Sendable () -> Void

    init(interval: TimeInterval, capture: @escaping @Sendable () throws -> Data?, onStop: @escaping @Sendable () -> Void = {}) {
        self.interval = max(0.06, interval); self.capture = capture; self.onStop = onStop
    }

    func start(onFrame: @escaping @Sendable (Data) -> Void, onError: @escaping @Sendable (String) -> Void) {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .userInitiated))
        timer.schedule(deadline: .now(), repeating: interval)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            self.lock.lock()
            guard !self.stopped, !self.inflight else { self.lock.unlock(); return }
            self.inflight = true
            self.lock.unlock()
            self.queue.async {
                defer { self.lock.lock(); self.inflight = false; self.lock.unlock() }
                do {
                    if let jpeg = try self.capture(), !jpeg.isEmpty, !self.isStopped { onFrame(jpeg) }
                } catch {
                    if !self.isStopped { onError("\(error)") }
                }
            }
        }
        lock.lock()
        if stopped { lock.unlock(); return }
        self.timer = timer
        lock.unlock()
        timer.resume()
    }

    var isStopped: Bool { lock.lock(); defer { lock.unlock() }; return stopped }

    func stop() {
        lock.lock()
        let first = !stopped
        stopped = true
        let current = timer
        timer = nil
        lock.unlock()
        current?.cancel()
        guard first else { return }
        // The capture in flight (bounded by its own deadline) finishes before cleanup.
        queue.async { self.onStop() }
    }
}
