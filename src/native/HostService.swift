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
                    fputs("\(message)\n", stderr); self?.serviceUnrecoverable(message)
                }, onRestarting: { [weak self] reason in self?.serviceRestarting(reason) },
                   onRestarted: { [weak self] in self?.serviceRestarted() })
            } catch {
                fputs("Service launch failed: \(error)\n", stderr); ProductLog.error("xpc", "Service launch failed: \(error)")
                serviceFailed = true; terminateHost()
            }

    }
    /// The smoke suite's failures exit with their status (`scripts/start-native.mjs`):
    /// no restart and no alert there.
    var serviceRecovers: Bool { HostLaunch.environment["TREZI_NATIVE_TEST_DIR"] == nil }
    /// LKM-347: Bun or the service stopped on its own (`serviceStopped`, non-zero).
    /// Restart it and keep the window, unless the host itself is quitting.
    func serviceStoppedUnexpectedly(status: Int) -> Bool {
        guard serviceRecovers, !serviceTerminating, !quitForced, !restartRequested, let client = serviceClient else { return false }
        client.restart("Trezi's background service stopped (status \(status))")
        return true
    }
    /// The service died: the window stays while the client restarts it. What belonged to
    /// the old Bun goes; the new one rebuilds the rest after `ready`.
    func serviceRestarting(_ reason: String) {
        // A quit that was asking the old Bun goes ahead: there is nothing left to ask.
        if quit.phase != .idle { quitProceed(); if quit.phase == .confirmed { return } }
        dismissQuitUI()
        for key in views.keys where key.hasPrefix("agent:") {
            views.removeValue(forKey: key)?.removeFromSuperview()
            urlObservers.removeValue(forKey: key); targets.removeValue(forKey: key); agentRoutes.removeValue(forKey: key)
        }
        agentBrowsers.removeAll(); agentBrowserStatuses.removeAll(); agentBrowserLoads.removeAll()
        sheets.close(sheets.model.state?.id ?? "")
        for editor in sourceEditors.values { editor.isHidden = true; editor.popout?.orderOut(nil) }
        nativeLayout.layout()
        toast.show(["id": "service-restart", "message": "\(reason). Restarting it…", "seconds": 30.0], in: canvas)
    }
    func serviceRestarted() {
        toast.show(["id": "service-restart", "message": "Trezi restarted its background service. A turn that was running stopped; send it again to continue.",
                    "seconds": 8.0], in: canvas)
        emit(["event": "ready", "pid": Int(getpid())])
    }
    /// Never a silent exit: the service could not be restarted, so say why and offer a relaunch.
    func serviceUnrecoverable(_ message: String) {
        serviceFailed = true
        guard serviceRecovers, !serviceTerminating, !quitForced else { terminateHost(); return }
        dismissQuitUI(); toast.hide()
        if let sheet = window.attachedSheet { window.endSheet(sheet); sheet.orderOut(nil) }
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Trezi's background service stopped"
        alert.informativeText = "\(message)\n\nYour chats are saved. Relaunch Trezi to continue. A turn that was running will show as interrupted."
        alert.addButton(withTitle: "Relaunch Trezi")
        alert.addButton(withTitle: "Quit")
        NSApp.requestUserAttention(.criticalRequest)
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }
            if response == .alertFirstButtonReturn { self.restartRequested = true; self.restartProject = nil; self.serviceFailed = false }
            self.terminateHost()
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
        guard serviceClient != nil, !serviceTerminated else { return .terminateNow }
        // Cancel, drain, then terminate again. `.terminateLater` would park AppKit in a
        // modal-panel run loop, which is not guaranteed to service the main queue that
        // carries the client's replies and timeouts; the drain could then never finish.
        // Repeated Quit/signals join the first drain.
        guard !serviceTerminating else { return .terminateCancel }
        // LKM-221: a user quit while agents work asks first (`QuitPrompt.swift`). Only a
        // logout or restart uses `.terminateLater`, since cancelling would abort it; the
        // drain's own backstop still bounds it.
        if quitShouldAsk() { return requestQuit(later: Self.systemQuit) }
        drainService { NSApp.terminate(nil) }
        return .terminateCancel
    }
    func drainService(then finish: @escaping () -> Void) {
        guard let client = serviceClient, !serviceTerminating else { return }
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
            finish()
        }
    }
}
