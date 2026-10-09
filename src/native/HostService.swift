import AppKit

// AppKit retains presentation; all service traffic crosses the signed XPC boundary.
extension Host {
    func connectService() {
            do {
                let args = HostLaunch.arguments
                func option(_ key: String) throws -> String {
                    guard let index = args.firstIndex(of: key), index + 1 < args.count else { throw ServiceContractFailure.invalidRequest }
                    return args[index + 1]
                }
                let launch = try ServiceLaunch(bun: option("--bun"), backend: option("--backend"),
                    profile: option("--profile"),
                    arguments: args.firstIndex(of: "--").map { Array(args.dropFirst($0 + 1)) } ?? [],
                    environment: HostLaunch.environment)
                let executable = Bundle.main.bundleURL.appendingPathComponent("Contents/XPCServices/dev.trezi.service.xpc/Contents/MacOS/TreziService").path
                let client = try ServiceClient(launch: launch, serviceExecutable: executable)
                serviceClient = client
                // Terminal signals drain through the service instead of killing the host.
                for number in [SIGINT, SIGTERM, SIGHUP] {
                    signal(number, SIG_IGN)
                    let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
                    source.setEventHandler { [weak self] in self?.terminateHost() }
                    source.resume(); serviceSignals.append(source)
                }
                for frame in earlyServiceFrames { client.send(frame) }
                earlyServiceFrames.removeAll()
                client.start(onReady: { emit(["event": "ready", "pid": Int(getpid())]) }, onMessage: { [weak self] data in
                    guard let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
                    self?.dispatch(command)
                }, onFailure: { [weak self] message in
                    fputs("\(message)\n", stderr); self?.serviceFailed = true; self?.terminateHost()
                })
            } catch {
                fputs("Service launch failed: \(error)\n", stderr); ProductLog.error("xpc", "Service launch failed: \(error)")
                serviceFailed = true; terminateHost()
            }

    }
    // `open -a Trezi <folder>`, `trezi <folder>`, or a folder dropped on the Dock icon:
    // Bun opens it as a project once attached (queued until then, like every early frame).
    func application(_ sender: NSApplication, open urls: [URL]) {
        for url in urls where url.isFileURL {
            var directory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: url.path, isDirectory: &directory), directory.boolValue else { continue }
            emit(["event": "open-project", "root": url.resolvingSymlinksInPath().path])
        }
    }
    // NSApp.terminate exits the process itself; a failure status must be applied here.
    func applicationWillTerminate(_ notification: Notification) {
        let status = serviceFailed ? 1 : exitStatus
        ProductLog.info("lifecycle", "App quit status=\(status)"); ProductLog.flush()
        if status != 0 { fflush(stdout); fflush(stderr); exit(status) }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let client = serviceClient, !serviceTerminated else { return .terminateNow }
        // Cancel, drain, then terminate again. `.terminateLater` would park AppKit in a
        // modal-panel run loop, which is not guaranteed to service the main queue that
        // carries the client's replies and timeouts; the drain could then never finish.
        // Repeated Quit/signals join the first drain.
        guard !serviceTerminating else { return .terminateCancel }
        serviceTerminating = true
        // Bounded shutdown even if the service never answers.
        DispatchQueue.global().asyncAfter(deadline: .now() + 20) {
            fputs("Trezi service drain timed out; exiting\n", stderr); exit(1)
        }
        client.shutdown { [weak self] in
            guard let self else { return }
            self.serviceTerminated = true
            // Shutdown acknowledgement follows drain and profile release.
            if self.restartRequested { HostLaunch.relaunch(directory: self.directory, project: self.restartProject) }
            NSApp.terminate(nil)
        }
        return .terminateCancel
    }
}
