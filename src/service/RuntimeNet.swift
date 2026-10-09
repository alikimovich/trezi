import Foundation
import Darwin

/// Ports, readiness probes and printed-URL parsing for managed project servers
/// (S06). The pure helpers match `src/main/devserver-net.ts` exactly (JS regex
/// classes are spelled out: ICU's `\s`, `\d` and `\b` are Unicode-aware, JS's are not).
enum RuntimeNet {
    /// Loopback only, IPv4: never the framework default port, never a stale server.
    static let previewHost = "127.0.0.1"
    /// 7777, not 6666: the IRC ports are on the fetch blocked-port list.
    static let portBase = 7777

    /// https://fetch.spec.whatwg.org/#port-blocking — a server there could not be loaded.
    static let blockedPorts: Set<Int> = [
        1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
        103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
        512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
        995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
        6669, 6679, 6697, 10080
    ]

    enum Bind { case free, inUse, error }

    /// Binds and listens like Node (`SO_REUSEADDR`), then closes. `address` nil is the
    /// dual-stack wildcard `::`; otherwise an IPv4 address.
    static func tryBind(port: Int, address: String?) -> Bind {
        let family = address == nil ? AF_INET6 : AF_INET
        let fd = socket(family, SOCK_STREAM, 0)
        guard fd >= 0 else { return .error }
        defer { close(fd) }
        var one: Int32 = 1, zero: Int32 = 0
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
        let result: Int32
        if family == AF_INET6 {
            setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &zero, socklen_t(MemoryLayout<Int32>.size))
            var socketAddress = sockaddr_in6()
            socketAddress.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
            socketAddress.sin6_family = sa_family_t(AF_INET6)
            socketAddress.sin6_port = in_port_t(UInt16(port).bigEndian)
            socketAddress.sin6_addr = in6addr_any
            result = withUnsafePointer(to: &socketAddress) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in6>.size)) } }
        } else {
            var socketAddress = sockaddr_in()
            socketAddress.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            socketAddress.sin_family = sa_family_t(AF_INET)
            socketAddress.sin_port = in_port_t(UInt16(port).bigEndian)
            guard let address, inet_pton(AF_INET, address, &socketAddress.sin_addr) == 1 else { return .error }
            result = withUnsafePointer(to: &socketAddress) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        }
        guard result == 0 else { return errno == EADDRINUSE ? .inUse : .error }
        guard listen(fd, 1) == 0 else { return errno == EADDRINUSE ? .inUse : .error }
        return .free
    }

    /// The loopback bind alone misses a wildcard occupant (`SO_REUSEADDR`), which
    /// would answer our readiness probe with a stranger's app. The wildcard probes
    /// (dual-stack `::` as Node's `listen(port)`, and IPv4 `0.0.0.0`) only ever vote
    /// "occupied" on an explicit EADDRINUSE: a refusal for any other reason (no IPv6,
    /// a sandbox) says nothing about the port.
    static func isPortFree(_ port: Int) -> Bool {
        tryBind(port: port, address: previewHost) == .free && tryBind(port: port, address: nil) != .inUse
            && tryBind(port: port, address: "0.0.0.0") != .inUse
    }

    /// The first free, loadable port at or above `base` that is not `reserved`.
    static func freePort(from base: Int, reserved: Set<Int>, attempts: Int = 200,
                         isFree: (Int) -> Bool = isPortFree) -> Int? {
        var port = base
        while port < base + attempts && port <= 65535 {
            if !blockedPorts.contains(port) && !reserved.contains(port) && isFree(port) { return port }
            port += 1
        }
        return nil
    }

    // MARK: Readiness

    /// GET with a timeout and no redirects; the HTTP status, or nil if unreachable.
    /// Only the response head is awaited: a streaming body never holds a probe.
    static func probe(_ url: String, timeout: TimeInterval = 1.5) -> Int? {
        guard let target = URL(string: url), ["http", "https"].contains(target.scheme?.lowercased() ?? "") else { return nil }
        return ProbeSession.shared.status(target, timeout: timeout)
    }

    /// Polls the candidates (as `waitForReachable`: 120 rounds, 500 ms apart) until one
    /// answers; nil if none did or `settled` became true.
    static func waitForReachable(_ urls: [String], settled: () -> Bool, rounds: Int = 120,
                                 probe: (String) -> Int? = { RuntimeNet.probe($0) }) -> String? {
        for _ in 0..<rounds {
            for url in urls {
                if settled() { return nil }
                if probe(url) != nil { return url }
            }
            if settled() { return nil }
            usleep(500_000)
        }
        return nil
    }

    // MARK: Printed URLs (parity with devserver-net.ts)

    /// JS `\s` (WhiteSpace + LineTerminator), spelled out for ICU.
    static let jsSpace = "\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"
    static let urlExpression = try! NSRegularExpression(
        pattern: "(https?://(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0)(?::[0-9]+)?[^\(jsSpace))]*)", options: [.caseInsensitive])
    static let ansiExpression = try! NSRegularExpression(pattern: "\\u001B\\[[0-9;]*[A-Za-z]")
    static let hostExpression = try! NSRegularExpression(pattern: "^(https?://)(\\[[^\\]]+\\]|[^/:]+)(:[0-9]+)?(/[^\\n\\r\\u2028\\u2029]*)?$")

    static func firstURL(_ text: String) -> String? {
        let ns = text as NSString
        guard let match = urlExpression.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return ns.substring(with: match.range(at: 1))
    }

    static func stripAnsi(_ text: String) -> String {
        ansiExpression.stringByReplacingMatches(in: text, range: NSRange(location: 0, length: (text as NSString).length), withTemplate: "")
    }

    static func normalizeURL(_ raw: String) -> String {
        var value = raw
        if let range = value.range(of: "0.0.0.0") { value.replaceSubrange(range, with: "localhost") }
        while let last = value.last, ".,)".contains(last) { value.removeLast() }
        if value.hasSuffix("/") { value.removeLast() }
        return value
    }

    /// Loopback variants of a localhost-ish URL, IPv4 first: `localhost` can resolve
    /// to IPv4 while the server bound IPv6 only, so each concrete host is tried.
    static func hostVariants(_ url: String) -> [String] {
        let ns = url as NSString
        guard let match = hostExpression.firstMatch(in: url, range: NSRange(location: 0, length: ns.length)) else { return [url] }
        func group(_ index: Int) -> String {
            let range = match.range(at: index)
            return range.location == NSNotFound ? "" : ns.substring(with: range)
        }
        let scheme = group(1), host = group(2), port = group(3), path = group(4)
        guard ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"].contains(host) else { return [url] }
        func build(_ candidate: String) -> String {
            let value = scheme + candidate + port + path
            return value.hasSuffix("/") ? String(value.dropLast()) : value
        }
        return [build("127.0.0.1"), build("localhost"), build("[::1]")]
    }
}

/// One ephemeral, proxy-free URLSession for readiness probes. The response head
/// settles a probe; its body is cancelled.
final class ProbeSession: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    static let shared = ProbeSession()
    private let lock = NSLock()
    private var waiting: [Int: (DispatchSemaphore, Int?)] = [:]
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [:]
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    func status(_ url: URL, timeout: TimeInterval) -> Int? {
        let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        let task = session.dataTask(with: request)
        let signal = DispatchSemaphore(value: 0)
        lock.lock(); waiting[task.taskIdentifier] = (signal, nil); lock.unlock()
        task.resume()
        let timedOut = signal.wait(timeout: .now() + timeout + 0.5) == .timedOut
        if timedOut { task.cancel() }
        lock.lock(); let result = waiting.removeValue(forKey: task.taskIdentifier)?.1; lock.unlock()
        return timedOut ? nil : result
    }

    private func finish(_ task: URLSessionTask, status: Int?) {
        lock.lock()
        if let entry = waiting[task.taskIdentifier] {
            if entry.1 == nil { waiting[task.taskIdentifier] = (entry.0, status) }
            entry.0.signal()
        }
        lock.unlock()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        finish(dataTask, status: (response as? HTTPURLResponse)?.statusCode)
        completionHandler(.cancel)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        finish(task, status: (task.response as? HTTPURLResponse)?.statusCode)
    }
}
