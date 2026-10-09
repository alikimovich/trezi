import Foundation

/// A Swift-owned domain served to supervised Bun over its private pipe. A Bun line
/// beginning `{"service":"<domain>"` is handed to the domain's channel and never
/// relayed to the host. (preferences: LKM-91; workspace: LKM-92; memory: LKM-93)
protocol PipeDomainOwner: Actor {
    func open() async
    func onChange(_ handler: @escaping @Sendable (Data) -> Void)
    func handle(_ line: Data) async -> Data
    func close()
    /// The answer to a request refused because the service is stopping.
    static func stoppingReply(id: JSValue) -> Data
}

extension PreferencesOwner: PipeDomainOwner {
    static func stoppingReply(id: JSValue) -> Data { reply(id: id, request: nil, result: .failed(stopping), snapshot: nil) }
}

typealias PreferencesChannel = DomainChannel<PreferencesOwner>
typealias WorkspaceChannel = DomainChannel<WorkspaceOwner>

/// Bun's endpoint for one domain: an ordered inbox (requests are handled in the
/// order Bun wrote them) and a bounded drain at shutdown.
final class DomainChannel<Owner: PipeDomainOwner>: @unchecked Sendable {
    private let lock = NSLock()
    private var accepting = true
    private let continuation: AsyncStream<Data>.Continuation
    private let finished = DispatchSemaphore(value: 0)
    private let send: @Sendable (Data) -> Void
    let owner: Owner

    init(owner: Owner, send: @escaping @Sendable (Data) -> Void) {
        self.owner = owner; self.send = send
        var captured: AsyncStream<Data>.Continuation?
        let stream = AsyncStream<Data> { captured = $0 }
        continuation = captured!
        let finished = finished
        Task {
            await owner.open()
            await owner.onChange(send)
            for await line in stream { send(await owner.handle(line)) }
            finished.signal()
        }
    }

    /// Called from the backend reader thread.
    func submit(_ line: Data) {
        lock.lock(); let open = accepting; lock.unlock()
        if open { continuation.yield(line); return }
        send(Owner.stoppingReply(id: (try? JSValue.parse(line, maxDepth: 8))?["id"] ?? .null))
    }

    /// Stops accepting requests, lets accepted ones finish (bounded), then refuses.
    @discardableResult
    func close(timeout: TimeInterval) -> Bool {
        lock.lock(); accepting = false; lock.unlock()
        continuation.finish()
        let drained = finished.wait(timeout: .now() + timeout) == .success
        let owner = owner
        Task { await owner.close() }
        return drained
    }
}

/// `{"service":"<domain>","id":n,"request":{…S01 request…}}`. Strict: unknown or
/// missing fields and a non-global scope are refused before anything is recorded.
struct PipeFrame {
    let id: JSValue
    let connection: String, requestID: String, operationID: String
    let mode: String, method: String
    let expectedRevision: ServiceRevision?
    let timeoutMilliseconds: UInt32?
    let body: [(JSText, JSValue)]

    init(_ line: Data, service: String, maxDepth: Int) throws {
        let invalid = ServiceContractFailure.invalidRequest
        let root = try JSValue.parse(line, maxDepth: maxDepth)
        guard case .object(let top) = root, top.count == 3, Set(top.map { $0.0.string }) == ["service", "id", "request"],
              root["service"]?.text?.string == service, case .number(let number)? = root["id"],
              number.rounded() == number, case .object(let requestFields)? = root["request"] else { throw invalid }
        id = .number(number)
        let allowed: Set<String> = ["connection", "requestID", "operationID", "scope", "mode", "expectedRevision",
                                    "timeoutMilliseconds", "service", "method", "body"]
        let names = Set(requestFields.map { $0.0.string })
        guard names.isSubset(of: allowed), names.count == requestFields.count,
              names.isSuperset(of: ["connection", "requestID", "operationID", "scope", "mode", "service", "method", "body"]) else { throw invalid }
        let fields = root["request"]!
        func uuid(_ key: String) throws -> String {
            guard let text = fields[key]?.text?.string, UUID(uuidString: text) != nil else { throw invalid }
            return text
        }
        guard case .object(let scope)? = fields["scope"], scope.isEmpty else { throw ServiceContractFailure.unauthorized }
        guard fields["service"]?.text?.string == service, let mode = fields["mode"]?.text?.string,
              let method = fields["method"]?.text?.string, case .object(let body)? = fields["body"] else { throw invalid }
        if let revision = fields["expectedRevision"] {
            guard case .object(let parts) = revision, parts.count == 2, let epoch = revision["epoch"]?.text?.string,
                  let counter = revision["counter"]?.text?.string, UInt64(counter) != nil else { throw invalid }
            expectedRevision = ServiceRevision(epoch: epoch, counter: counter)
        } else { expectedRevision = nil }
        if let value = fields["timeoutMilliseconds"] {
            guard case .number(let ms) = value, ms >= 0, ms <= Double(UInt32.max), ms.rounded() == ms else { throw invalid }
            timeoutMilliseconds = UInt32(ms)
        } else { timeoutMilliseconds = nil }
        connection = try uuid("connection"); requestID = try uuid("requestID"); operationID = try uuid("operationID")
        self.mode = mode; self.method = method; self.body = body
    }

    /// The ledger request. Its identity covers the exact body (UTF-16, order, types) by digest.
    func request(service: String) -> ServiceRequest {
        let exact = JSValue.object(body).serialized().string
        return ServiceRequest(connection: connection, requestID: requestID, operationID: operationID, scope: PreferencesOwner.global,
            mode: mode == "read" ? .read : .mutation, expectedRevision: expectedRevision, timeoutMilliseconds: timeoutMilliseconds,
            service: service, method: method, body: ["body": .string(PreferencesDisk.digest(Data(exact.utf8)))])
    }
}
