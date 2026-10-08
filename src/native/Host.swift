import AppKit
import WebKit

var serviceClient: ServiceClient?
let serviceMode = HostLaunch.arguments.contains("--service")
/// Service mode: setup-time events wait for the client instead of reaching the terminal.
var earlyServiceFrames: [Data] = []
func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value), let line = String(data: data, encoding: .utf8) else { return }
    if let serviceClient { serviceClient.send(data); return }
    if serviceMode { earlyServiceFrames.append(data); return }
    print(line); fflush(stdout)
}

// The Keychain helper is `Contents/Helpers/TreziSecrets` (`Secrets.swift`, LKM-137).
if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--session" {
    if let data = try? JSONSerialization.data(withJSONObject: SecuritySessionProbe.report()) { FileHandle.standardOutput.write(data) }
    exit(0)
}

final class Canvas: NSView { var changed: (() -> Void)?; override var isFlipped: Bool { true }; override func layout() { super.layout(); changed?() } }
final class Host: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var shell: NativeShell!
    var composer: NativeComposer!
    var chat: NativeChat!
    var welcome: NativeWelcome!
    var previewStatus: NativePreviewStatus!
    var sheets: NativeSheets!
    let editingInspector = NativeEditingInspector()
    let inspectorSlot = PreviewInspectorSlot()
    let layers = NativeLayers()
    let downloads = PreviewDownloads()
    let activity = NativeActivity()
    let activityIndicator = ActivityIndicator()
    let toast = NativeToast()
    let previewLoad = NativePreviewLoad()
    let speedBadge = NativePreviewSpeed()
    let statesSwitcher = NativeStatesSwitcher()
    var sourceEditors: [String: NativeSourceEditor] = [:]
    var sourceRoot = ""
    var dockedSource: NativeSourceEditor? { sourceEditors[sourceRoot].flatMap { $0.state["visible"] as? Bool == true && $0.state["popped"] as? Bool != true ? $0 : nil } }
    var chatDivider: NativeChatDivider!
    var nativeLayout: WorkspaceLayout!
    var previewSurface: PreviewSurface!
    var previewOverlay: PreviewOverlay!
    let canvas = Canvas()
    let chatColumn = Canvas()
    var views: [String: WKWebView] = [:]
    var targets: [String: URL] = [:]
    var urlObservers: [String: NSKeyValueObservation] = [:]
    var preferences: [String: Any] = [:]
    var recentMenu = NSMenu(title: "Open Recent")
    /// Element picks the page reported; the island pointer verification reads it.
    var previewPicks = 0
    /// The page's viewport rects native views cover, as last sent (`PreviewCover.swift`).
    var previewCover: [[String: Double]] = []
    let world = WKContentWorld.world(name: "TreziPreview")
    let directory: String
    let ephemeral: Bool
    var serviceTerminated = false
    var serviceTerminating = false
    var serviceFailed = false
    /// Backend-reported status; the launcher returns the host's exit code in service mode.
    var exitStatus: Int32 = 0
    var serviceSignals: [DispatchSourceSignal] = []
    var restartRequested = false
    var restartProject: String?
    init(directory: String, ephemeral: Bool) { self.directory = directory; self.ephemeral = ephemeral; super.init() }
    func makeView(_ id: String) -> WKWebView {
        let config = WKWebViewConfiguration()
        precondition(id == "preview", "Only the project preview may create a WebView")
        PreviewInspector.enable(config.preferences)
        config.websiteDataStore = .nonPersistent()
        let contentWorld = world
        config.userContentController.add(self, contentWorld: contentWorld, name: "trezi")
        installPreviewScripts(config.userContentController, speed: speedBadge.speed)
        // WebKit keeps its own tracking areas; the page shields what native views cover (LKM-173).
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = self; view.uiDelegate = self; view.isInspectable = true
        views[id] = view; canvas.addSubview(view)
        canvas.addSubview(inspectorSlot, positioned: .above, relativeTo: view); PreviewInspector.confine(view, to: inspectorSlot)
        inspectorSlot.changed = { [weak self] in self?.nativeLayout?.layout() }
        urlObservers[id] = view.observe(\.url, options: [.new]) { view, _ in
            emit(["event":"url", "view":id, "url":view.url?.absoluteString ?? ""])
        }
        view.isHidden = true; view.wantsLayer = true
        return view
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        startProductLog()
        if let path = Bundle.main.path(forResource: "Trezi", ofType: "icns"), let icon = NSImage(contentsOfFile: path) { NSApp.applicationIconImage = icon }
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1320, height: 860), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "Trezi"; window.minSize = NSSize(width: 850, height: 550)
        window.contentView = canvas; window.delegate = self
        _ = makeView("preview")
        shell = NativeShell(window: window, canvas: canvas)
        previewSurface = PreviewSurface(preview: views["preview"]!, canvas: canvas, container: canvas.superview!)
        previewSurface.colorChanged = { [weak self] color in self?.shell.updatePreviewColor(color) }
        shell.updatePreviewColor(views["preview"]!.underPageBackgroundColor)
        previewSurface.leading = { [weak self] in self?.shell.previewLeading ?? 0 }
        previewStatus = NativePreviewStatus(); canvas.addSubview(previewStatus)
        canvas.addSubview(previewLoad); canvas.addSubview(speedBadge); canvas.addSubview(statesSwitcher)
        canvas.addSubview(editingInspector)
        canvas.addSubview(layers)
        chatColumn.wantsLayer = true; chatColumn.layer?.masksToBounds = true; canvas.addSubview(chatColumn)
        chat = NativeChat(); chatColumn.addSubview(chat)
        composer = NativeComposer(frame: .zero); chatColumn.addSubview(composer)
        chatDivider = NativeChatDivider(); chatDivider.isHidden = true; canvas.addSubview(chatDivider)
        chatDivider.changed = { [weak self] width in self?.nativeLayout.resized(width) }
        welcome = NativeWelcome(); welcome.frame = canvas.bounds; canvas.addSubview(welcome)
        sheets = NativeSheets(parent: window); activity.parent = window; downloads.parent = window
        activityIndicator.install(in: shell.sidebar.view)
        nativeLayout = WorkspaceLayout(host: self)
        previewOverlay = PreviewOverlay(host: self)
        toast.coverChanged = { [weak self] in self?.sendPreviewCover() }
        canvas.changed = { [weak self] in self?.nativeLayout.layout() }
        window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        installMenus()
        if serviceMode {
            connectService()
        } else {
          DispatchQueue.global().async { [weak self] in
            while let line = readLine() {
                guard let data = line.data(using: .utf8), let c = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                DispatchQueue.main.async { self?.dispatch(c) }
            }
            DispatchQueue.main.async { self?.terminateHost() }
        }
          emit(["event":"ready", "pid": Int(getpid())])
        }
    }
    // Menus: `HostMenus.swift`. Test-broker commands: `HostInspect.swift` (LKM-160).
    func reply(_ id: Int, _ value: Any = NSNull(), error: String? = nil) {
        if let error = error { emit(["event":"reply", "id":id, "error":error]) }
        else { emit(["event":"reply", "id":id, "value":value]) }
    }
    func command(_ c: [String: Any]) {
        let id = c["id"] as? Int ?? 0
        let name = c["view"] as? String ?? "main"
        let view = views[name]
        switch c["method"] as? String {
        case "serviceRestart":
            restartRequested = true
            restartProject = c["project"] as? String
            terminateHost()
        case "serviceStopped":
            if let status = c["status"] as? Int, status != 0 { exitStatus = 1 }
            terminateHost()
        case "preferences":
            preferences = c["values"] as? [String: Any] ?? [:]
        case "webViews": reply(id, views.keys.sorted())
        case "securitySession": reply(id, SecuritySessionProbe.report())
        case "chatState":
            let state = c["state"] as? [String: Any] ?? [:]
            nativeLayout.chatState = state
            chat.update(nativeLayout.nativeChatState(), composer: composer); nativeLayout.layout()
        case "layoutSizes": nativeLayout.restoreSizes(c["sizes"] as? [String: Double] ?? [:])
        case "layoutWidth": nativeLayout.desiredWidth = CGFloat(c["width"] as? Double ?? 440); nativeLayout.layout()
        case "inspectorState": editingInspector.update(c["state"] as? [String: Any] ?? [:]); nativeLayout.layout()
        case "layersState": layers.update(c["state"] as? [String: Any] ?? [:]); nativeLayout.layout()
        case "sourceActive":
            sourceRoot = c["root"] as? String ?? ""
            for (root, editor) in sourceEditors where editor.state["popped"] as? Bool != true { editor.isHidden = root != sourceRoot || editor.state["visible"] as? Bool != true }
            nativeLayout.layout()
        case "sourceHighlight": sourceEditors[c["root"] as? String ?? ""]?.applyHighlight(c)
        case "sourceState":
            let state = c["state"] as? [String: Any] ?? [:], root = state["root"] as? String ?? ""
            let editor = sourceEditors[root] ?? NativeSourceEditor(); sourceEditors[root] = editor
            editor.update(state)
            if state["popped"] as? Bool == true {
                if editor.popout == nil { let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 700), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false); panel.isReleasedWhenClosed = false; panel.delegate = editor; panel.title = "Trezi · Code"; panel.contentMinSize = NSSize(width: 760, height: 420); panel.center(); editor.popout = panel }
                if let container = editor.popout?.contentView, editor.superview !== container {
                    editor.removeFromSuperview()
                    // Let the window own the editor's bounds after leaving the dock.
                    editor.translatesAutoresizingMaskIntoConstraints = false
                    container.addSubview(editor)
                    NSLayoutConstraint.activate([
                        editor.leadingAnchor.constraint(equalTo: container.leadingAnchor),
                        editor.trailingAnchor.constraint(equalTo: container.trailingAnchor),
                        editor.topAnchor.constraint(equalTo: container.topAnchor),
                        editor.bottomAnchor.constraint(equalTo: container.bottomAnchor)
                    ])
                }
                editor.isHidden = false
                if state["visible"] as? Bool == true { if editor.popout?.isVisible != true { editor.popout?.makeKeyAndOrderFront(nil) } } else { editor.popout?.orderOut(nil) }
            } else {
                editor.popout?.orderOut(nil)
                if editor.superview !== canvas {
                    editor.removeFromSuperview()
                    editor.translatesAutoresizingMaskIntoConstraints = true
                    editor.autoresizingMask = []
                    canvas.addSubview(editor)
                }
                editor.isHidden = root != sourceRoot || state["visible"] as? Bool != true
            }
            nativeLayout.layout()
        case "activityState": activity.update(c)
        case "activityUnread": activityIndicator.update(count: c["count"] as? Int ?? 0, level: c["level"] as? String ?? "info")
        case "sheetState": sheets.update(c["state"] as? [String: Any] ?? [:])
        case "sheetClose": sheets.close(c["id"] as? String ?? "")
        case "toastState": toast.show(c["state"] as? [String: Any] ?? [:], in: canvas)
        case "composerState": composer.update(c["state"] as? [String: Any] ?? [:])
        case "composerFocus": window.makeFirstResponder(composer.text)
        case "shellState":
            let state = c["state"] as? [String: Any] ?? [:]
            shell.update(state); previewStatus.update(state); previewLoad.update(state); nativeLayout.update(state)
            if let home = state["homeState"] as? [String: Any] { welcome.update(home) }
        case "captureFeedback":
            let content = window.contentView?.superview ?? shell.split.view
            guard let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) else { reply(id, NSNull()); return }
            content.cacheDisplay(in: content.bounds, to: bitmap)
            let image = NSImage(size: content.bounds.size); image.addRepresentation(bitmap)
            let size = NSSize(width: 900, height: 900 * content.bounds.height / max(1, content.bounds.width))
            let scaled = NSImage(size: size)
            scaled.lockFocus(); image.draw(in: NSRect(origin: .zero, size: size)); scaled.unlockFocus()
            if let tiff = scaled.tiffRepresentation, let result = NSBitmapImageRep(data: tiff)?.representation(using: .jpeg, properties: [.compressionFactor:0.6]) { reply(id, "data:image/jpeg;base64," + result.base64EncodedString()) }
            else { reply(id, NSNull()) }
        case "recents": updateRecents(c["recents"] as? [[String: String]] ?? [])
        case "load":
            guard let raw = c["url"] as? String, let url = URL(string: raw), let view = view else { return }
            targets[name] = url
            let hard = c["hard"] as? Bool == true
            ProductLog.info("preview", "Preview load \(Host.logURL(url))\(hard ? " without cache" : "")")
            if hard { PreviewCache.reload(view, url: url) } else { view.load(URLRequest(url: url)) }
        case "reload":
            let hard = c["hard"] as? Bool == true
            ProductLog.info("preview", "Preview reload \(Host.logURL(view?.url))\(hard ? " without cache" : "")")
            if hard, let view { PreviewCache.reload(view, url: nil) } else { view?.reload() }
            reply(id)
        case "bounds":
            if name == "preview" { nativeLayout.layout(); return }
            guard let b = c["bounds"] as? [String: Double], let view = view else { return }
            let values = [b["x"] ?? 0, b["y"] ?? 0, b["width"] ?? 0, b["height"] ?? 0]
            guard values.allSatisfy({ $0.isFinite && abs($0) < 100000 }) else { return }
            view.frame = NSRect(x: values[0], y: values[1], width: max(0, values[2]), height: max(0, values[3]))
        case "visible":
            if name == "preview" { nativeLayout.previewVisible = c["visible"] as? Bool ?? false; nativeLayout.layout() }
            else { view?.isHidden = !(c["visible"] as? Bool ?? false) }
        case "radius":
            if name == "preview" { nativeLayout.layout(); return }
            let radius = CGFloat(c["radius"] as? Double ?? 0)
            view?.layer?.cornerRadius = radius; view?.layer?.masksToBounds = true
            if name == "preview" { view?.autoresizingMask = radius == 0 && view?.frame.isEmpty == false ? [.width, .height] : []; previewSurface.needsDisplay = true }
        case "deliver":
            guard var message = c["message"] as? [String: Any] else { return }
            if message["channel"] as? String == "trezi:preview:timing-ack", var args = message["args"] as? [[String: Any]], !args.isEmpty {
                args[0]["hostReturnAt"] = Date().timeIntervalSince1970 * 1000
                message["args"] = args
            }
            guard let data = try? JSONSerialization.data(withJSONObject: message), let json = String(data: data, encoding: .utf8) else { return }
            view?.evaluateJavaScript("globalThis.__treziNativeDispatch?.(\(json))", in: nil, in: name == "preview" ? world : .page) { _ in }
        case "evaluate":
            guard let view = view, let code = c["code"] as? String else { reply(id, error: "Missing evaluation target"); return }
            view.callAsyncJavaScript("return JSON.stringify((await (\(code))) ?? null) ?? 'null';", arguments: [:], in: nil, in: PreviewAgent.world(for: c, preview: world)) { result in
                switch result {
                case .success(let value):
                    guard let json = value as? String, let data = json.data(using: .utf8), let decoded = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { self.reply(id, error: "Invalid JSON evaluation result"); return }
                    self.reply(id, decoded)
                case .failure(let error): self.reply(id, error: (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String ?? error.localizedDescription)
                }
            }
        case "previewSpeed": setPreviewSpeed(c)
        case "statesState": statesSwitcher.update(c["state"] as? [String: Any]); nativeLayout.layout()
        case "workbenches": shell.updateWorkbenches(c["items"] as? [[String: Any]] ?? [])
        case "previewViewport": reply(id, PreviewAgent.setViewport(c, layout: nativeLayout, view: views["preview"]))
        case "previewOverlay": previewOverlay.apply(c)
        case "capture":
            if let agent = c["agent"] as? [String: Any] {
                guard let view else { reply(id, error: "Snapshot unavailable"); return }
                PreviewAgent.capture(agent, view: view) { value, error in if let value { self.reply(id, value) } else { self.reply(id, error: error ?? "Snapshot unavailable") } }
                return
            }
            if c["rect"] != nil && PreviewAgent.snapshot(for: c, view: view) == nil { reply(id, error: "The element is outside the visible preview"); return }
            view?.takeSnapshot(with: PreviewAgent.snapshot(for: c, view: view)) { image, error in
                if c["thumbnail"] as? Bool == true {
                    // LKM-195: a chat row's thumbnail, 160 px wide at most (tens of KB), not the agent frame.
                    // LKM-208: an answer component's option preview asks for up to 480.
                    guard let image = image, image.size.width > 0 else { self.reply(id, error: error?.localizedDescription ?? "Snapshot unavailable"); return }
                    let width = min(CGFloat(min(480, max(80, c["width"] as? Double ?? 160))), image.size.width), height = max(1, image.size.height * width / image.size.width)
                    let small = NSImage(size: NSSize(width: width, height: height)); small.lockFocus(); image.draw(in: NSRect(x: 0, y: 0, width: width, height: height)); small.unlockFocus()
                    let jpeg = small.tiffRepresentation.flatMap { NSBitmapImageRep(data: $0)?.representation(using: .jpeg, properties: [.compressionFactor: 0.6]) } ?? Data()
                    self.reply(id, ["jpeg": jpeg.base64EncodedString(), "width": Int(width), "height": Int(height)])
                    return
                }
                guard let image = image, let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) else { self.reply(id, error: error?.localizedDescription ?? "Snapshot unavailable"); return }
                let width = min(900, image.size.width), height = image.size.height * width / image.size.width
                let small = NSImage(size: NSSize(width: width, height: height)); small.lockFocus(); image.draw(in: NSRect(x: 0, y: 0, width: width, height: height)); small.unlockFocus()
                let jpeg = small.tiffRepresentation.flatMap { NSBitmapImageRep(data: $0)?.representation(using: .jpeg, properties: [.compressionFactor: 0.65]) } ?? Data()
                self.reply(id, ["png":png.base64EncodedString(), "jpeg":jpeg.base64EncodedString(), "width":bitmap.pixelsWide, "height":bitmap.pixelsHigh])
            }
        case "pick", "pickNew":
            if c["method"] as? String == "pick" {
                let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
                panel.beginSheetModal(for: sheets.panel ?? window) { result in self.reply(id, result == .OK ? panel.url?.path as Any? ?? NSNull() : NSNull()) }
            } else {
                let panel = NSSavePanel(); panel.nameFieldStringValue = "my-app"; panel.canCreateDirectories = true
                panel.beginSheetModal(for: sheets.panel ?? window) { result in self.reply(id, result == .OK ? panel.url?.path as Any? ?? NSNull() : NSNull()) }
            }
        case "fullscreen": reply(id, window.styleMask.contains(.fullScreen))
        case "nativeEdit": NSApp.sendAction(Selector((c["action"] as? String ?? "undo") + ":"), to: nil, from: nil)
        case "quit":
            if let status = c["status"] as? Int, status != 0 { exitStatus = 1 }
            terminateHost()
        default: if !logCommand(c, id: id) && !testBroker(c, id: id) { reply(id, error: "Unsupported native host command") }
        }
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let name = views.first(where: { $0.value === message.webView })?.key,
              var body = message.body as? [String: Any], let data = try? JSONSerialization.data(withJSONObject: body), data.count <= 16 * 1024 * 1024 else { return }
        if var trace = body["trace"] as? [String: Any], body["channel"] as? String == "trezi:preview:element-picked" {
            trace["hostAt"] = Date().timeIntervalSince1970 * 1000
            body["trace"] = trace
        }
        if body["channel"] as? String == "trezi:preview:element-picked" { previewPicks += 1 }
        // Scroll and selection geometry for the native rulers and guides stays in the host.
        if name == "preview", body["channel"] as? String == "trezi:preview:overlay-geometry" { previewOverlay?.receive(body["args"]); return }
        // Source identity is supplied by the host, never by page-controlled JSON.
        emit(["event":"ipc", "view":name, "message":body])
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let name = views.first(where: { $0.value === webView })?.key else { return }
        ProductLog.info("preview", "Preview loaded \(Host.logURL(webView.url))")
        emit(["event":"loaded", "view":name, "url":webView.url?.absoluteString ?? ""])
    }
    var recentCrashes: [TimeInterval] = []
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        previewNavigationFailed(webView, error, committed: false)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        let now = Date.timeIntervalSinceReferenceDate
        recentCrashes = recentCrashes.filter { now - $0 < 30 }; recentCrashes.append(now)
        ProductLog.error("preview", "Preview web content process crashed (\(recentCrashes.count) in 30 s)\(recentCrashes.count <= 2 ? "; reloading" : "")")
        if recentCrashes.count <= 2 { webView.reload() }
        else { emit(["event":"load-error", "view":"preview", "message":"The preview stopped repeatedly. Use Run to restart it, or inspect the activity log."]) }
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let name = views.first(where: { $0.value === webView })?.key, let target = targets[name], let url = action.request.url else { decisionHandler(.cancel); return }
        // The app shell stays on its own URL. The preview's main frame stays on
        // its exact assigned origin; subframes never receive a privileged bridge.
        if action.targetFrame?.isMainFrame == false { decisionHandler(name == "preview" ? .allow : .cancel); return }
        let sameOrigin = url.scheme == target.scheme && url.host == target.host && url.port == target.port
        let allowed = name == "preview" ? (sameOrigin || url.absoluteString == "about:blank") : (sameOrigin && url.path == target.path)
        if allowed && action.shouldPerformDownload { decisionHandler(.download) }
        else if allowed && action.targetFrame != nil { decisionHandler(.allow) }
        else {
            if action.navigationType == .linkActivated && ["https", "http"].contains(url.scheme ?? "") { emit(["event":"external", "url":url.absoluteString]) }
            decisionHandler(.cancel)
        }
    }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        guard let target = targets["preview"], origin.host == target.host, origin.protocol == target.scheme, origin.port == (target.port ?? (target.scheme == "https" ? 443 : 80)) else { decisionHandler(.deny); return }
        let alert = NSAlert(); alert.messageText = "Allow this preview to use \(type == .camera ? "your camera" : type == .microphone ? "your microphone" : "your camera and microphone")?"; alert.informativeText = "\(origin.protocol)://\(origin.host):\(origin.port)"; alert.addButton(withTitle: "Allow Once"); alert.addButton(withTitle: "Don’t Allow")
        alert.beginSheetModal(for: window) { response in decisionHandler(response == .alertFirstButtonReturn ? .grant : .deny) }
    }
    func windowDidEnterFullScreen(_ notification: Notification) { emit(["event":"fullscreen", "value":true]) }
    func windowDidExitFullScreen(_ notification: Notification) { emit(["event":"fullscreen", "value":false]) }
    func windowWillClose(_ notification: Notification) {
        if let closed = notification.object as? NSWindow, closed === window { NSApp.terminate(nil); return }
    }
    func terminateHost() {
        for window in NSApp.windows { if let sheet = window.attachedSheet { window.endSheet(sheet); sheet.orderOut(nil) } }
        NSApp.terminate(nil)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

}
guard HostLaunch.arguments.count >= 3 else {
    fputs("TreziHost is started by Trezi: open -a Trezi, the trezi command, or bun run dev.\n", stderr)
    exit(64)
}
let application = NSApplication.shared
let host = Host(directory: HostLaunch.arguments[1], ephemeral: HostLaunch.arguments[2] == "ephemeral")
application.setActivationPolicy(.regular); application.delegate = host; application.run()
