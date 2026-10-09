import Foundation
import Darwin

final class ServiceRuntime: NSObject, NSXPCListenerDelegate {
    let queue = DispatchQueue(label: "dev.trezi.service.owner")
    /// Pipe writes never block the owner queue: a full stdin pipe must not stop the
    /// reader from draining Bun's stdout, or the two pipes deadlock.
    let writer = DispatchQueue(label: "dev.trezi.service.backend-writer")
    let epoch = UUID().uuidString
    let hostRequirement: String
    let supervisor = BackendSupervisor()
    var exclusion: ProfileExclusion?
    /// S03 substrate, opened (and recovered) under the profile lock. No domain
    /// writes through it yet; nil if the store could not be proven whole, which
    /// future ledger-backed domains must treat as `recoveryRequired`.
    var ledger: OperationLedger?
    /// S03 preferences writer: Bun's requests arrive on its private pipe.
    var preferences: PreferencesChannel?
    /// S04 workspace writer (projects, order, selection), on the same pipe.
    var workspace: WorkspaceChannel?
    /// S05 project memory writer (one ledger domain per project), on the same pipe.
    var memory: MemoryChannel?
    /// S06 managed project runtimes (servers, installs, static site), on the same pipe.
    var runtime: RuntimeOwner?
    /// S07 repository coordinator (Git, worktrees, landings, recovery), on the same pipe.
    var repository: RepositoryOwner?
    /// S08/S09 source transactions (hash-bound commits, Undo, file operations, drafts),
    /// run in the repository coordinator's lanes, on the same pipe.
    var source: SourceOwner?
    /// S11 conversation coordinator (chat records, live checkpoints, turns, approvals,
    /// spawn admission), on the same pipe.
    var conversation: ConversationOwner?
    /// S10 provider owner (session grants, permissions, tool authorization, Stop's
    /// deadline, resume persistence, supervised helpers), on the same pipe.
    var provider: ProviderOwner?
    /// S12 editing coordinator (islands, controls sidecars, deferred navigation), on
    /// the same pipe; sidecar commits run in the repository's lanes.
    var editing: EditingOwner?
    /// S13 workflow owner (publication, remote Git actions, project setup, Trezi's
    /// update and the diagnosis memory; durable receipts).
    var workflow: WorkflowOwner?
    /// S14 platform owner (the Simulator preview and its Metro group, scoped media
    /// grants, pasted attachments, the running-servers recovery), on the same pipe.
    var platform: PlatformOwner?
    var child: BackendChild?
    var launch: ServiceLaunch?
    var peerPID: pid_t?
    var active: ServiceSession?
    var stopping = false
    var buffered: [Data] = []
    var bufferedBytes = 0
    var generation = 0
    var signals: [DispatchSourceSignal] = []

    init(hostExecutable: String) throws {
        hostRequirement = try ServiceXPC.signingRequirement(executable: hostExecutable)
        super.init()
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: queue)
            source.setEventHandler { [weak self] in self?.stop() }
            source.resume(); signals.append(source)
        }
    }

    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        guard connection.effectiveUserIdentifier == geteuid() else { return false }
        connection.setCodeSigningRequirement(hostRequirement)
        let session = ServiceSession(owner: self, connection: connection)
        connection.exportedInterface = NSXPCInterface(with: TreziServiceRemote.self)
        connection.exportedObject = session
        connection.remoteObjectInterface = NSXPCInterface(with: TreziServiceEvents.self)
        connection.invalidationHandler = { [weak self, weak session] in
            guard let self, let session else { return }
            self.queue.async { self.disconnected(session) }
        }
        connection.interruptionHandler = connection.invalidationHandler
        connection.resume()
        return true
    }

    func handle(_ frame: ServiceControl, session: ServiceSession, reply: @escaping (Data) -> Void) {
        func answer(_ failure: ServiceContractFailure? = nil, hello: ServiceHelloAck? = nil) {
            reply((try? ServiceXPC.encode(ServiceControlReply(requestID: frame.requestID, failure: failure, hello: hello))) ?? Data())
        }
        do {
            guard !stopping else { throw ServiceContractFailure.unavailable }
            if frame.kind == .hello {
                guard session.identity == nil, let hello = frame.hello, let requested = frame.launch else {
                    throw ServiceContractFailure.invalidRequest
                }
                try ServiceXPC.validateHello(hello, connection: frame.connection)
                guard active == nil, peerPID == nil || peerPID == session.connection.processIdentifier else {
                    throw ServiceContractFailure.busy
                }
                if let launch {
                    // Reattach names this instance's epoch; a second first launch is refused.
                    guard frame.resume == epoch else { throw ServiceContractFailure.recoveryRequired }
                    guard launch == requested else { throw ServiceContractFailure.unauthorized }
                } else {
                    // launchd restarted a lost service: never start Bun for a stale client.
                    guard frame.resume == nil else { throw ServiceContractFailure.recoveryRequired }
                    guard requested.bun.hasPrefix("/"), requested.backend.hasPrefix("/"), requested.profile.hasPrefix("/") else {
                        throw ServiceContractFailure.invalidRequest
                    }
                    guard access(requested.bun, X_OK) == 0, access(requested.backend, R_OK) == 0 else {
                        throw ServiceContractFailure.unavailable
                    }
                    exclusion = try ProfileExclusion(profile: requested.profile)
                    // Under the lock, before Bun: stop any project group a crashed
                    // owner left behind (never a pid that is now someone else's).
                    let journal = RuntimeJournal(profile: requested.profile)
                    journal.sweep()
                    ProfilePaths.migrateSessions(profile: requested.profile) { try? session.diagnostics?.write(contentsOf: Data($0.utf8)) }
                    do {
                        ledger = try OperationLedger(directory: URL(fileURLWithPath: requested.profile)
                            .appendingPathComponent("service/ledger"))
                    } catch {
                        // Files are left exactly as found for diagnosis.
                        try? session.diagnostics?.write(contentsOf: Data("Trezi service: operation ledger unavailable (\(error)); its files were left untouched.\n".utf8))
                    }
                    var environment = requested.environment
                    environment["TREZI_SERVICE_LOCKED"] = "1"
                    environment["TREZI_SERVICE_SUPERVISED"] = "1"
                    environment["TREZI_SERVICE_PID"] = String(getpid())
                    environment["TREZI_SERVICE_EXECUTABLE"] = CommandLine.arguments[0]
                    environment["TREZI_USER_DATA"] = requested.profile
                    launch = requested
                    // LKM-168: the product log, in the folder the host's launch environment names.
                    ProductLog.configure(process: "service", environment: requested.environment)
                    ProductLog.info("lifecycle", "Service started pid=\(getpid())")
                    do {
                        child = try supervisor.start(executable: requested.bun,
                            arguments: [requested.backend] + requested.arguments, environment: environment,
                            profileDescriptor: exclusion?.guardDescriptor, guardianExecutable: CommandLine.arguments[0],
                            diagnostics: session.diagnostics?.fileDescriptor) { [weak self] status in
                            guard let self else { return }
                            if status == 0 { ProductLog.info("backend", "Backend exited status=0") }
                            else { ProductLog.error("backend", "Backend exited status=\(status)") }
                            self.queue.async { self.stop(backendStatus: status == 0 ? 0 : 1) }
                        }
                        ProductLog.info("backend", "Backend started pid=\(child?.pid ?? 0)")
                    } catch {
                        ProductLog.error("backend", "Backend failed to start: \(error)")
                        launch = nil; ledger = nil; exclusion?.release(); exclusion = nil
                        throw ServiceContractFailure.unavailable
                    }
                    if let input = child?.input {
                        let writer = writer
                        let send: @Sendable (Data) -> Void = { frame in
                            var line = frame; line.append(10)
                            writer.async { try? input.write(contentsOf: line) }
                        }
                        let profile = URL(fileURLWithPath: requested.profile)
                        preferences = PreferencesChannel(owner: PreferencesOwner(
                            disk: PreferencesDisk(path: profile.appendingPathComponent("preferences.json").path), ledger: ledger), send: send)
                        workspace = WorkspaceChannel(owner: WorkspaceOwner(
                            disk: PreferencesDisk(path: profile.appendingPathComponent("workspace.json").path), ledger: ledger), send: send)
                        memory = MemoryChannel(owner: MemoryOwner(store: MemoryStore(profile: profile), ledger: ledger), send: send)
                        runtime = RuntimeOwner(options: RuntimeOwner.Options(environment: requested.environment,
                            watchdog: CommandLine.arguments[0], journal: journal), send: send)
                        let bun = child?.pid ?? 0, host = session.connection.processIdentifier
                        platform = PlatformOwner(options: PlatformOwner.Options(profile: requested.profile, environment: requested.environment,
                            watchdog: CommandLine.arguments[0], journal: journal, protectedPIDs: { [bun, host] },
                            open: PlatformOpen.Tools(environment: requested.environment)), send: send)
                        let diagnostics = session.diagnostics
                        let log: @Sendable (String) -> Void = { line in
                            if let diagnostics { try? diagnostics.write(contentsOf: Data((line + "\n").utf8)) } else { fputs(line + "\n", stderr) }
                        }
                        let repository = RepositoryOwner(options: RepositoryOwner.Options(profile: requested.profile,
                            environment: requested.environment, log: log), send: send)
                        self.repository = repository
                        source = SourceOwner(options: SourceOwner.Options(profile: requested.profile), repository: repository, send: send)
                        let conversation = ConversationOwner(options: ConversationOwner.Options(profile: requested.profile), send: send)
                        self.conversation = conversation
                        editing = EditingOwner(options: EditingOwner.Options(profile: requested.profile,
                            turn: { [weak conversation] chat in conversation?.turn(of: chat) ?? (false, nil) }), repository: repository, send: send)
                        workflow = WorkflowOwner(options: WorkflowOwner.Options(profile: requested.profile,
                            environment: requested.environment, bun: requested.bun), repository: repository, send: send)
                        var providerOptions = ProviderOwner.Options(profile: requested.profile, environment: requested.environment,
                            watchdog: CommandLine.arguments[0], journal: journal)
                        // Debug-level cold-start timings go to the service log (LKM-135).
                        providerOptions.log = log
                        // The backend is `<out>/Trezi.app/Contents/Resources/backend/index.cjs`: the Keychain
                        // helper is that app's `Helpers/TreziSecrets` (LKM-137: a separate binary whose
                        // code hash survives rebuilds, so a Keychain approval does too), and the
                        // checkout is `<out>/../..`.
                        var app = URL(fileURLWithPath: requested.backend)
                        for _ in 0..<4 { app.deleteLastPathComponent() }
                        let keychain = app.appendingPathComponent("Contents/Helpers/TreziSecrets").path
                        providerOptions.data = ProviderData.Tools(crypto: access(keychain, X_OK) == 0 ? [keychain] : nil,
                            checkout: app.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path,
                            environment: requested.environment)
                        // Built-in adapters always run in supervised helpers (LKM-111).
                        providerOptions.helper = ProviderHelperCommand.builtIn(backend: requested.backend, bun: requested.bun)
                        provider = ProviderOwner(options: providerOptions, send: send)
                    }
                    readBackend()
                }
                peerPID = session.connection.processIdentifier
                session.identity = frame.connection
                active = session; generation += 1
                let helloAck = ServiceHelloAck(connection: frame.connection, version: ServiceXPC.version,
                    serviceEpoch: epoch, capabilities: ServiceXPC.capabilities,
                    limits: ServiceLimits(maxBytes: ServiceXPC.maxLegacyBytes, maxDepth: 64, maxCollection: 100_000),
                    cursor: ServiceCursor(serviceEpoch: epoch, sequence: "0"))
                answer(hello: helloAck)
                for data in buffered { session.deliver(data) }
                buffered.removeAll(); bufferedBytes = 0
                return
            }
            guard active === session, session.identity == frame.connection else { throw ServiceContractFailure.unauthorized }
            guard !session.seen.contains(frame.requestID) else { throw ServiceContractFailure.invalidRequest }
            // Requests are never automatically replayed across reconnect. Bound per-connection IDs.
            guard session.seen.count < 100_000 else { throw ServiceContractFailure.busy }
            session.seen.insert(frame.requestID)
            switch frame.kind {
            case .legacy:
                guard let payload = frame.payload,
                      var object = try JSONSerialization.jsonObject(with: payload) as? [String: Any],
                      object["event"] is String else { throw ServiceContractFailure.invalidRequest }
                var forward = payload
                if object["event"] as? String == "ipc", var message = object["message"] as? [String: Any],
                   message["channel"] as? String == "trezi:preview:element-picked", var trace = message["trace"] as? [String: Any] {
                    trace["serviceAt"] = Date().timeIntervalSince1970 * 1000
                    message["trace"] = trace; object["message"] = message
                    forward = (try? JSONSerialization.data(withJSONObject: object)) ?? payload
                }
                var line = forward; line.append(10)
                guard let input = child?.input else { throw ServiceContractFailure.unavailable }
                // Accepted in order; exit/EOF (not a write error) decides the lifecycle.
                writer.async { try? input.write(contentsOf: line) }
                answer()
            case .wait:
                guard session.waits.count < 128 else { throw ServiceContractFailure.busy }
                session.waits[frame.requestID] = reply
                queue.asyncAfter(deadline: .now() + 30) { [weak session] in
                    if let completion = session?.waits.removeValue(forKey: frame.requestID) {
                        completion((try? ServiceXPC.encode(ServiceControlReply(requestID: frame.requestID, failure: .deadlineExceeded))) ?? Data())
                    }
                }
            case .cancel:
                guard let target = frame.target, let completion = session.waits.removeValue(forKey: target) else {
                    throw ServiceContractFailure.notFound
                }
                completion(try ServiceXPC.encode(ServiceControlReply(requestID: target, failure: .cancelled)))
                answer()
            case .shutdown:
                stop { answer() }
            case .hello: break
            }
        } catch {
            ProductLog.warn("xpc", "Request \(frame.kind) refused: \(error)")
            answer(error as? ServiceContractFailure ?? .ioFailure)
        }
    }

    func readBackend() {
        guard let output = child?.output else { return }
        // Handed to the reader directly (not via `queue`), so Bun's preference,
        // workspace, memory, runtime, repository, source, conversation, provider, editing, workflow and platform requests are still served while `stop` waits for Bun to exit.
        let preferences = preferences, workspace = workspace, memory = memory, runtime = runtime, repository = repository, source = source
        let conversation = conversation, provider = provider, editing = editing, workflow = workflow, platform = platform
        let preferencesPrefix = Data("{\"service\":\"preferences\"".utf8)
        let workspacePrefix = Data("{\"service\":\"workspace\"".utf8)
        let memoryPrefix = Data("{\"service\":\"memory\"".utf8)
        let runtimePrefix = Data("{\"service\":\"runtime\"".utf8)
        let repositoryPrefix = Data("{\"service\":\"repository\"".utf8)
        let sourcePrefix = Data("{\"service\":\"source\"".utf8)
        let conversationPrefix = Data("{\"service\":\"conversation\"".utf8)
        let providerPrefix = Data("{\"service\":\"provider\"".utf8)
        let editingPrefix = Data("{\"service\":\"editing\"".utf8)
        let workflowPrefix = Data("{\"service\":\"workflow\"".utf8)
        let platformPrefix = Data("{\"service\":\"platform\"".utf8)
        DispatchQueue.global().async { [weak self] in
            var pending = Data()
            do {
                while true {
                    let bytes = try output.readAvailable(upTo: 64 * 1024)
                    if bytes.isEmpty { break }
                    pending.append(bytes)
                    while let end = pending.firstIndex(of: 10) {
                        let line = Data(pending[..<end]); pending.removeSubrange(...end)
                        guard line.count <= ServiceXPC.maxLegacyBytes else { throw ServiceContractFailure.invalidRequest }
                        if line.starts(with: preferencesPrefix) { preferences?.submit(line); continue }
                        if line.starts(with: workspacePrefix) { workspace?.submit(line); continue }
                        if line.starts(with: memoryPrefix) { memory?.submit(line); continue }
                        if line.starts(with: runtimePrefix) || line.starts(with: RuntimeOwner.helperPrefix) { runtime?.submit(line); continue }
                        if line.starts(with: repositoryPrefix) { repository?.submit(line); continue }
                        if line.starts(with: sourcePrefix) { source?.submit(line); continue }
                        if line.starts(with: conversationPrefix) { conversation?.submit(line); continue }
                        if line.starts(with: providerPrefix) || line.starts(with: ProviderOwner.helperPrefix) { provider?.submit(line); continue }
                        if line.starts(with: editingPrefix) { editing?.submit(line); continue }
                        if line.starts(with: workflowPrefix) { workflow?.submit(line); continue }
                        if line.starts(with: platformPrefix) { platform?.submit(line); continue }
                        guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any], object["method"] is String else { continue }
                        self?.queue.async { [weak self] in self?.deliver(line) }
                    }
                    guard pending.count <= ServiceXPC.maxLegacyBytes else { throw ServiceContractFailure.invalidRequest }
                }
            } catch { /* A malformed/oversized private bridge fails closed. */ }
            // EOF normally accompanies exit; let the reaped status win before failing closed.
            self?.queue.asyncAfter(deadline: .now() + 1) { [weak self] in self?.stop() }
        }
    }

    func deliver(_ data: Data) {
        guard !stopping else { return }
        if let active { active.deliver(data) }
        else {
            guard bufferedBytes + data.count <= ServiceXPC.maxLegacyBytes * 2 else { stop(); return }
            buffered.append(data); bufferedBytes += data.count
        }
    }

    func disconnected(_ session: ServiceSession) {
        for (id, completion) in session.waits {
            completion((try? ServiceXPC.encode(ServiceControlReply(requestID: id, failure: .unavailable))) ?? Data())
        }
        session.waits.removeAll()
        guard active === session else { return }
        ProductLog.warn("xpc", "App connection lost; stopping in 5 s unless it reconnects")
        active = nil; generation += 1
        let expected = generation
        queue.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let self, self.generation == expected, self.active == nil else { return }
            self.stop()
        }
    }

    /// backendStatus: 0 for a clean Bun exit; any failure (or a lost private bridge) reports 1.
    func stop(backendStatus: Int32 = 1, completion: (() -> Void)? = nil) {
        guard !stopping else { completion?(); return }
        stopping = true
        ProductLog.info("lifecycle", "Service stopping backendStatus=\(backendStatus)")
        // No owner switch: retain every store and let Bun finish its existing shutdown.
        // Let accepted host frames (final persisted state) reach Bun before EOF; bounded.
        let drained = DispatchSemaphore(value: 0)
        writer.async { drained.signal() }
        _ = drained.wait(timeout: .now() + 2)
        supervisor.shutdown()
        try? child?.input.close(); try? child?.output.close()
        // Bun has exited; its project servers have not. Drain every owned group and
        // site before anything is released (bounded), so no rollback overlaps them.
        runtime?.close(timeout: 5); runtime = nil
        // The simulator preview and its Metro group end the same way (bounded); media
        // grants and attachment uploads are memory only and end with the service.
        platform?.close(timeout: 5); platform = nil
        // Bun's leases end with Bun; a Git effect still running finishes (bounded) so its
        // journal entry settles. One cut short is reported as interrupted next launch.
        // Source requests are refused first: a source write queued behind a released
        // lease answers "stopping" instead of starting; one already writing finishes
        // (bounded), and one cut short is rolled back from its journal next launch.
        source?.refuse()
        editing?.refuse()
        // A workflow queued behind a released lease answers "stopping"; one already
        // running finishes its step (bounded) and is reported interrupted next launch.
        workflow?.refuse()
        repository?.close(timeout: 5); repository = nil
        source?.close(timeout: 5); source = nil
        // Island decisions and drafts already answered are on disk; a sidecar commit
        // queued behind a released lease answered "stopping" above.
        editing?.close(timeout: 2); editing = nil
        workflow?.close(timeout: 2); workflow = nil
        // Bun has exited: its chats were closed (saved to History) or are left as
        // checkpoints, which the next launch recovers. A decision already underway finishes.
        conversation?.close(timeout: 2); conversation = nil
        // Bun has exited: its provider sessions are over. Helpers are stopped (bounded);
        // sessions still listed are reported by the next launch.
        provider?.close(timeout: 2); provider = nil
        // Bun has exited: refuse new preference/workspace/memory requests and let accepted
        // ones finish (bounded). One still running at exit is recovered from the ledger.
        preferences?.close(timeout: 2); preferences = nil
        workspace?.close(timeout: 2); workspace = nil
        memory?.close(timeout: 2); memory = nil
        // The ledger needs no drain: each transition is synced before it is acknowledged.
        ledger = nil
        exclusion?.release(); exclusion = nil
        if let directory = launch?.environment["TREZI_NATIVE_TEST_DIR"] {
            FileManager.default.createFile(atPath: directory + "/service-stopped", contents: Data())
        }
        completion?()
        active?.deliver(Data("{\"method\":\"serviceStopped\",\"status\":\(backendStatus)}".utf8))
        queue.asyncAfter(deadline: .now() + 0.1) { ProductLog.flush(); exit(0) }
    }
}

final class ServiceSession: NSObject, TreziServiceRemote {
    weak var owner: ServiceRuntime?
    let connection: NSXPCConnection
    var identity: String?
    var seen = Set<String>()
    var waits: [String: (Data) -> Void] = [:]
    var diagnostics: FileHandle?
    init(owner: ServiceRuntime, connection: NSXPCConnection) { self.owner = owner; self.connection = connection }
    func attachDiagnostics(_ output: FileHandle, withReply reply: @escaping (Bool) -> Void) {
        guard let owner else { reply(false); return }
        // Same serial queue as exchange, so it precedes the hello sent after it.
        owner.queue.async {
            guard self.identity == nil, owner.launch == nil else { reply(false); return }
            self.diagnostics = output; reply(true)
        }
    }
    func exchange(_ data: Data, withReply reply: @escaping (Data) -> Void) {
        guard let owner else { reply(Data()); return }
        owner.queue.async {
            do { owner.handle(try ServiceXPC.decode(data), session: self, reply: reply) }
            catch { reply((try? ServiceXPC.encode(ServiceControlReply(requestID: "", failure: error as? ServiceContractFailure ?? .invalidRequest))) ?? Data()) }
        }
    }
    func deliver(_ data: Data) {
        (connection.remoteObjectProxyWithErrorHandler { _ in } as? TreziServiceEvents)?.receive(data)
    }
}
