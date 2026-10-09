import Foundation

/// Connection state is serialized on the main queue, alongside AppKit input.
/// Never retries a legacy mutation after an uncertain transport outcome.
final class ServiceClient: NSObject, TreziServiceEvents {
    private let launch: ServiceLaunch
    private let requirement: String
    private var connection: NSXPCConnection?
    private var identity = UUID().uuidString
    private var epoch: String?
    private var ready = false
    private var stopped = false
    private var failed = false
    private var shutdownComplete = false
    /// The service announced it drained Bun and released the profile: final, and
    /// its status is authoritative. Reconnecting would only wait on a launchd respawn.
    private var serviceEnded = false
    private var shutdownCallbacks: [() -> Void] = []
    private var attempts = 0
    private var pending: [String: (ServiceControlReply?) -> Void] = [:]
    // Frames produced before the handshake or while reconnecting were never
    // submitted, so sending them once ready is not a replay. Bounded; overflow fails closed.
    private var outbox: [Data] = []
    private var outboxBytes = 0
    private var onReady: (() -> Void)?
    private var onMessage: ((Data) -> Void)?
    private var onFailure: ((String) -> Void)?
    var isReady: Bool { ready && !stopped && !failed }

    init(launch: ServiceLaunch, serviceExecutable: String) throws {
        self.launch = launch
        requirement = try ServiceXPC.signingRequirement(executable: serviceExecutable)
        super.init()
    }
    func start(onReady: @escaping () -> Void, onMessage: @escaping (Data) -> Void,
               onFailure: @escaping (String) -> Void) {
        self.onReady = onReady; self.onMessage = onMessage; self.onFailure = onFailure
        connect()
    }
    private func connect() {
        guard !stopped else { return }
        attempts += 1; identity = UUID().uuidString
        let channel = NSXPCConnection(serviceName: ServiceXPC.name)
        channel.setCodeSigningRequirement(requirement)
        channel.remoteObjectInterface = NSXPCInterface(with: TreziServiceRemote.self)
        channel.exportedInterface = NSXPCInterface(with: TreziServiceEvents.self)
        channel.exportedObject = self
        channel.invalidationHandler = { [weak self, weak channel] in
            DispatchQueue.main.async { if let channel { self?.lost(channel) } }
        }
        channel.interruptionHandler = channel.invalidationHandler
        connection = channel; channel.resume()
        if epoch == nil {
            (channel.remoteObjectProxyWithErrorHandler { _ in } as? TreziServiceRemote)?
                .attachDiagnostics(FileHandle.standardError) { _ in }
        }
        var frame = ServiceControl(connection: identity, kind: .hello)
        frame.hello = ServiceHello(connection: identity, role: .ui, versions: [ServiceXPC.version],
            schemaHash: ServiceXPC.schema, capabilities: ServiceXPC.capabilities)
        frame.launch = launch
        frame.resume = epoch
        exchange(frame) { [weak self] response in
            guard let self, !self.stopped else { return }
            guard let hello = response?.hello, response?.failure == nil,
                  hello.connection == self.identity, hello.version == ServiceXPC.version,
                  hello.capabilities == ServiceXPC.capabilities else {
                self.fail("Service negotiation failed closed"); return
            }
            guard self.epoch == nil || self.epoch == hello.serviceEpoch else {
                self.fail("Service restarted; retained drafts require a fresh launch"); return
            }
            let initial = self.epoch == nil
            self.epoch = hello.serviceEpoch; self.ready = true; self.attempts = 0
            // Queued frames preceded readiness, as they did on the legacy pipe.
            let queued = self.outbox; self.outbox.removeAll(); self.outboxBytes = 0
            for payload in queued { self.send(payload) }
            if initial { self.onReady?() }
        }
    }
    private func exchange(_ frame: ServiceControl, completion: @escaping (ServiceControlReply?) -> Void) {
        guard let channel = connection, let data = try? ServiceXPC.encode(frame) else { completion(nil); return }
        pending[frame.requestID] = completion
        let finish: (Data?) -> Void = { [weak self] data in
            DispatchQueue.main.async {
                guard let self, let callback = self.pending.removeValue(forKey: frame.requestID) else { return }
                let reply = data.flatMap { try? JSONDecoder().decode(ServiceControlReply.self, from: $0) }
                callback(reply?.requestID == frame.requestID ? reply : nil)
            }
        }
        guard let remote = channel.remoteObjectProxyWithErrorHandler({ _ in finish(nil) }) as? TreziServiceRemote else { finish(nil); return }
        remote.exchange(data) { finish($0) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            self?.pending.removeValue(forKey: frame.requestID)?(nil)
        }
    }
    func send(_ payload: Data) {
        guard !stopped, !failed, !serviceEnded else { return }
        guard ready else {
            guard outboxBytes + payload.count <= ServiceXPC.maxLegacyBytes else {
                fail("Service is disconnected; action was not submitted"); return
            }
            outbox.append(payload); outboxBytes += payload.count
            return
        }
        var frame = ServiceControl(connection: identity, kind: .legacy); frame.payload = payload
        exchange(frame) { [weak self] reply in
            if reply == nil || reply?.failure != nil { self?.fail("Service action outcome is uncertain; it was not replayed") }
        }
    }
    func receive(_ data: Data) {
        DispatchQueue.main.async { [weak self] in
            guard data.count <= ServiceXPC.maxLegacyBytes, let self, !self.stopped else { return }
            if data.count < 256, let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               event["method"] as? String == "serviceStopped" {
                self.serviceEnded = true; self.ready = false
                let channel = self.connection; self.connection = nil
                channel?.invalidate()
            }
            self.onMessage?(data)
        }
    }
    func shutdown(completion: @escaping () -> Void) {
        if shutdownComplete { completion(); return }
        shutdownCallbacks.append(completion)
        guard !stopped else { return }
        stopped = true; ready = false
        exchange(ServiceControl(connection: identity, kind: .shutdown)) { [weak self] _ in
            guard let self else { return }
            self.connection?.invalidate(); self.connection = nil
            self.shutdownComplete = true
            let callbacks = self.shutdownCallbacks; self.shutdownCallbacks.removeAll()
            for callback in callbacks { callback() }
        }
    }
    func disconnectAndReconnect() {
        guard let channel = connection else { return }
        channel.invalidate(); lost(channel)
    }
    private func lost(_ channel: NSXPCConnection) {
        guard connection === channel else { return }
        connection = nil; ready = false
        guard !stopped, !failed else { return }
        ProductLog.warn("xpc", "Service connection lost (attempt \(attempts), \(pending.count) pending)")
        if !pending.isEmpty { fail("Service disconnected with an uncertain request; no replay attempted"); return }
        guard attempts < 3 else { fail("Service reconnect failed"); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.connect() }
    }
    private func fail(_ message: String) {
        guard !stopped, !failed, !serviceEnded else { return }
        failed = true; ready = false
        ProductLog.error("xpc", message)
        onFailure?(message)
    }
}
