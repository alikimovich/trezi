import Foundation

/// Bounded GETs for the GitHub skill import (LKM-285). One ephemeral session: no
/// cookies, cache or stored credentials, no redirects (a 3xx is answered as it is and
/// the caller refuses it), every authentication challenge except server trust
/// cancelled (so no client identity or password is ever looked up), a byte cap per
/// response and cancellation with the calling task. Only HTTPS is fetched; plain HTTP
/// to 127.0.0.1 is allowed only for the test server (`loopback`).
final class SkillsHTTP: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    struct Response: Sendable { let status: Int; let data: Data }
    enum Failure: Error, Equatable { case refused, tooLarge, cancelled, transport(String) }

    private final class Pending {
        let limit: Int
        let continuation: CheckedContinuation<Response, Error>
        var data = Data(), tooLarge = false
        init(limit: Int, continuation: CheckedContinuation<Response, Error>) { self.limit = limit; self.continuation = continuation }
    }
    private let lock = NSLock()
    private var pending: [Int: Pending] = [:]
    private let loopback: Bool
    private var session: URLSession!

    init(loopback: Bool, requestTimeout: TimeInterval = 30) {
        self.loopback = loopback
        super.init()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = requestTimeout
        configuration.waitsForConnectivity = false
        configuration.httpMaximumConnectionsPerHost = 2
        configuration.httpAdditionalHeaders = ["User-Agent": "Trezi-Skills-Import"]
        if loopback { configuration.connectionProxyDictionary = [:] }
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }

    func allowed(_ url: URL) -> Bool {
        guard url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { return false }
        if url.scheme == "https", url.port == nil, url.host != nil { return true }
        return loopback && url.scheme == "http" && url.host == "127.0.0.1"
    }

    func get(_ url: URL, accept: String, limit: Int) async throws -> Response {
        guard allowed(url) else { throw Failure.refused }
        try Task.checkCancellation()
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpMethod = "GET"
        request.httpShouldHandleCookies = false
        request.setValue(accept, forHTTPHeaderField: "Accept")
        let task = session.dataTask(with: request)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                lock.lock(); pending[task.taskIdentifier] = Pending(limit: limit, continuation: continuation); lock.unlock()
                task.resume()
            }
        } onCancel: { task.cancel() }
    }

    private func entry(_ task: URLSessionTask) -> Pending? { lock.lock(); defer { lock.unlock() }; return pending[task.taskIdentifier] }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if let waiting = entry(dataTask), response.expectedContentLength > Int64(waiting.limit) {
            lock.lock(); waiting.tooLarge = true; lock.unlock()
            completionHandler(.cancel); return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        guard let waiting = pending[dataTask.taskIdentifier], !waiting.tooLarge else { lock.unlock(); return }
        waiting.data.append(data)
        let over = waiting.data.count > waiting.limit
        if over { waiting.tooLarge = true; waiting.data = Data() }
        lock.unlock()
        if over { dataTask.cancel() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        completionHandler(Self.disposition(challenge), nil)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        completionHandler(Self.disposition(challenge), nil)
    }
    private static func disposition(_ challenge: URLAuthenticationChallenge) -> URLSession.AuthChallengeDisposition {
        challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust ? .performDefaultHandling : .cancelAuthenticationChallenge
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock(); let waiting = pending.removeValue(forKey: task.taskIdentifier); lock.unlock()
        guard let waiting else { return }
        if waiting.tooLarge { waiting.continuation.resume(throwing: Failure.tooLarge); return }
        if let error {
            let cancelled = (error as? URLError)?.code == .cancelled
            waiting.continuation.resume(throwing: cancelled ? Failure.cancelled : Failure.transport((error as? URLError)?.code.rawValue.description ?? "error"))
            return
        }
        waiting.continuation.resume(returning: Response(status: (task.response as? HTTPURLResponse)?.statusCode ?? 0, data: waiting.data))
    }
}
