import Foundation

/// Connection state is serialized on the main queue, alongside AppKit input.
/// Never retries a legacy frame after an uncertain transport outcome: a frame that
/// was in flight when the connection dropped is dropped, not replayed.
///
/// LKM-347: a lost service is first reattached by epoch. When the service itself
/// died (launchd starts a fresh instance, which refuses the old epoch), the client
/// restarts it with a fresh hello: a new epoch and a new Bun, whose launch marks the
/// running turn interrupted. At most `restartLimit` restarts a minute, each with up
/// to `restartLimit` tries; past that `onFailure` reports why, and the host asks.
final class ServiceClient: NSObject, TreziServiceEvents {
    static let restartLimit = 3
    private let launch: ServiceLaunch
    private let requirement: String
    private var connection: NSXPCConnection?
    private var identity = UUID().uuidString
    private var epoch: String?
    private var ready = false
    private var stopped = false
    private var failed = false
    private var shutdownComplete = false
    /// The service announced it drained Bun and released the profile: its status is
    /// authoritative. Reconnecting would only wait on a launchd respawn; the host
    /// decides whether to `restart`.
    private var serviceEnded = false
    private var shutdownCallbacks: [() -> Void] = []
    private var attempts = 0
    private var pending: [String: (ServiceControlReply?) -> Void] = [:]
    // Frames produced before the handshake or while reconnecting were never
    // submitted, so sending them once ready is not a replay. Bounded; overflow fails closed.
    private var outbox: [Data] = []
    private var outboxBytes = 0
    /// Why the service is being restarted; nil when not restarting.
    private var restarting: String?
    private var restartTries = 0
    private var restartTimes: [Date] = []
    private var lastRefusal = "no reply"
    private var onReady: (() -> Void)?
    private var onMessage: ((Data) -> Void)?
    private var onFailure: ((String) -> Void)?
    private var onRestarting: ((String) -> Void)?
    private var onRestarted: (() -> Void)?
    let report = ServiceExitReport()
    private(set) var servicePID: pid_t = 0
    var isReady: Bool { ready && !stopped && !failed }

    init(launch: ServiceLaunch, serviceExecutable: String) throws {
        self.launch = launch
        requirement = try ServiceXPC.signingRequirement(executable: serviceExecutable)
        super.init()
    }
    func start(onReady: @escaping () -> Void, onMessage: @escaping (Data) -> Void,
               onFailure: @escaping (String) -> Void, onRestarting: ((String) -> Void)? = nil,
               onRestarted: (() -> Void)? = nil) {
        self.onReady = onReady; self.onMessage = onMessage; self.onFailure = onFailure
        self.onRestarting = onRestarting; self.onRestarted = onRestarted
        connect()
    }
    private func connect() {
        guard !stopped, !failed else { return }
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
        // Long enough for launchd's ~10 s respawn throttle after a short-lived instance.
        exchange(frame, timeout: 15) { [weak self, weak channel] response in
            guard let self, !self.stopped, !self.failed, let channel, self.connection === channel else { return }
            guard let hello = response?.hello, response?.failure == nil,
                  hello.connection == self.identity, hello.version == ServiceXPC.version,
                  hello.capabilities == ServiceXPC.capabilities,
                  self.epoch == nil || self.epoch == hello.serviceEpoch else {
                self.refused(channel, response?.failure?.rawValue ?? (response == nil ? "no reply" : "mismatched reply")); return
            }
            let restarted = self.restarting != nil, initial = self.epoch == nil && !restarted
            self.epoch = hello.serviceEpoch; self.ready = true; self.attempts = 0
            self.servicePID = channel.processIdentifier; self.report.watch(self.servicePID)
            if restarted {
                ProductLog.info("xpc", "Service restarted pid=\(self.servicePID) after \(self.restartTries) tries: \(self.restarting ?? "")")
                self.restarting = nil; self.restartTries = 0
            }
            // Queued frames preceded readiness, as they did on the legacy pipe.
            let queued = self.outbox; self.outbox.removeAll(); self.outboxBytes = 0
            for payload in queued { self.send(payload) }
            if initial { self.onReady?() } else if restarted { self.onRestarted?() }
        }
    }
    /// A hello was refused or went unanswered on the current channel.
    private func refused(_ channel: NSXPCConnection, _ failure: String) {
        lastRefusal = failure
        connection = nil; ready = false; channel.invalidate()
        if restarting != nil { retryRestart(); return }
        // A first launch that is refused fails closed, as before.
        guard epoch != nil else { fail("Service negotiation failed closed (\(failure))"); return }
        // Reattach refused: the instance that answered is not the one that held the epoch.
        beginRestart("The background service stopped unexpectedly")
    }
    private func exchange(_ frame: ServiceControl, timeout: Double = 10, completion: @escaping (ServiceControlReply?) -> Void) {
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
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
            self?.pending.removeValue(forKey: frame.requestID)?(nil)
        }
    }
    func send(_ payload: Data) {
        guard !stopped, !failed, !serviceEnded else { return }
        // Frames for the Bun that died are not delivered to its replacement.
        guard restarting == nil else { return }
        guard ready, let channel = connection else {
            guard outboxBytes + payload.count <= ServiceXPC.maxLegacyBytes else {
                fail("Service is disconnected; action was not submitted"); return
            }
            outbox.append(payload); outboxBytes += payload.count
            return
        }
        var frame = ServiceControl(connection: identity, kind: .legacy); frame.payload = payload
        exchange(frame) { [weak self, weak channel] reply in
            guard let self, let channel, self.connection === channel else { return }
            // `unavailable`: the service is stopping, and `serviceStopped` follows.
            if reply?.failure == .unavailable { ProductLog.warn("xpc", "Action dropped: the service is stopping"); return }
            if let failure = reply?.failure { self.fail("Service refused an action (\(failure.rawValue)); it was not replayed"); return }
            // No reply: the transport is in doubt. Drop the frame and recover the connection.
            if reply == nil { channel.invalidate(); self.lost(channel) }
        }
    }
    func receive(_ data: Data) {
        DispatchQueue.main.async { [weak self] in
            guard data.count <= ServiceXPC.maxLegacyBytes, let self, !self.stopped else { return }
            if data.count < 256, let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               event["method"] as? String == "serviceStopped" {
                // The replaced service's last word, if it arrives late, is not news.
                guard self.restarting == nil else { return }
                self.serviceEnded = true; self.ready = false
                let channel = self.connection; self.connection = nil
                channel?.invalidate()
            }
            self.onMessage?(data)
        }
    }
    /// After `serviceStopped`: start a fresh service (and Bun) for this host.
    func restart(_ reason: String) {
        guard !stopped, !failed, restarting == nil else { return }
        serviceEnded = false
        if let channel = connection { connection = nil; ready = false; channel.invalidate() }
        beginRestart(reason)
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
        let wasReady = ready, inFlight = pending.count
        connection = nil; ready = false
        guard !stopped, !failed else { return }
        ProductLog.warn("xpc", "Service connection lost (attempt \(attempts), \(inFlight) pending)")
        // In-flight frames have an uncertain outcome: dropped, never replayed.
        pending.removeAll()
        if restarting != nil { retryRestart(); return }
        if wasReady { report.lost(attempt: attempts, pending: inFlight) }
        guard attempts < 3 else { beginRestart("The background service stopped responding"); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.connect() }
    }
    private func beginRestart(_ reason: String) {
        guard !stopped, !failed else { return }
        let now = Date()
        restartTimes = restartTimes.filter { now.timeIntervalSince($0) < 60 }
        guard restartTimes.count < Self.restartLimit else {
            fail("\(reason). It stopped \(restartTimes.count + 1) times within a minute, so Trezi stopped restarting it."); return
        }
        restartTimes.append(now)
        restarting = reason; restartTries = 0
        epoch = nil; ready = false; outbox.removeAll(); outboxBytes = 0
        ProductLog.warn("xpc", "Restarting the service: \(reason)")
        onRestarting?(reason)
        retryRestart()
    }
    /// One more fresh hello, after 1, 2, then 4 s (the dead instance's guardian may
    /// still hold the profile lock while it drains Bun).
    private func retryRestart() {
        guard restartTries < Self.restartLimit else {
            fail("\(restarting ?? "The background service stopped"), and Trezi could not restart it after \(restartTries) tries (\(lastRefusal))."); return
        }
        restartTries += 1; attempts = 0
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(1 << (restartTries - 1))) { [weak self] in
            guard let self, self.restarting != nil, self.connection == nil else { return }
            self.connect()
        }
    }
    private func fail(_ message: String) {
        guard !stopped, !failed, !serviceEnded else { return }
        failed = true; ready = false; restarting = nil
        ProductLog.error("xpc", message)
        onFailure?(message)
    }
}
