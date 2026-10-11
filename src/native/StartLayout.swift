import AppKit
import SwiftUI

/// LKM-232: the centered start composer. The chat's own composer sits in the middle of a
/// quiet surface under "What do you want to create?"; the first accepted message moves
/// that same composer and chat into the left column while the preview appears.
final class StartTransition {
    var chat: String?
    /// 0 is centered, 1 is docked in the left column.
    var progress: CGFloat = 1
    var target: CGFloat = 1
    var timer: Timer?
    var glides = 0
    /// The centered composer's frame, for the heading and notice around it.
    var frame = NSRect.zero
    /// Integration-only: Reduce Motion without changing the system setting.
    var reduceMotion: Bool?
    var reduced: Bool { reduceMotion ?? NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
    /// The toolbar's address follows the start surface, not the hidden page ("" = the page).
    var tint = ""
}

struct StartAction: Identifiable { let label: String; let action: String; let value: String?; let disabled: Bool; var id: String { action + (value ?? "") } }
final class StartModel: ObservableObject {
    @Published var chat = ""
    @Published var heading = ""
    @Published var home = false
    @Published var notice = ""
    @Published var progress = false
    @Published var actions: [StartAction] = []
    @Published var recents: [WelcomeRecent] = []
    @Published var composer = NSRect.zero
}
struct StartContent: View {
    @ObservedObject var model: StartModel
    func run(_ action: String, _ value: String? = nil) {
        var event: [String: Any] = ["event":"chat-action", "chat":model.chat, "action":action]
        if let value { event["value"] = value }
        emit(event)
    }
    var body: some View {
        ZStack(alignment: .topLeading) {
            Color(nsColor: .windowBackgroundColor)
            Text(model.heading).font(.system(size: 26, weight: .semibold)).foregroundStyle(.primary)
                .multilineTextAlignment(.center).lineLimit(2).minimumScaleFactor(0.7)
                .accessibilityAddTraits(.isHeader)
                .frame(width: max(0, model.composer.width), height: 56, alignment: .bottom)
                .padding(.leading, max(0, model.composer.minX)).padding(.top, max(0, model.composer.minY - 72))
            VStack(spacing: 14) {
                if !model.notice.isEmpty || !model.actions.isEmpty {
                    VStack(spacing: 8) {
                        HStack(spacing: 8) {
                            if model.progress { ProgressView().controlSize(.small) }
                            Text(model.notice).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        }
                        if !model.actions.isEmpty {
                            HStack(spacing: 8) {
                                ForEach(model.actions) { action in
                                    Button(action.label) { run(action.action, action.value) }.disabled(action.disabled)
                                }
                            }
                        }
                    }.accessibilityElement(children: .contain).accessibilityLabel("Start status")
                }
                if model.home {
                    HStack(spacing: 8) {
                        ForEach(model.recents.prefix(4)) { recent in
                            Button(recent.name) { run("start-recent", recent.root) }.help(recent.root)
                        }
                        Button("Open Project…") { run("start-open") }
                        Button("New Project…") { run("start-new") }
                    }.controlSize(.small).buttonStyle(.bordered).lineLimit(1)
                }
            }
            .frame(width: max(0, model.composer.width))
            .padding(.leading, max(0, model.composer.minX)).padding(.top, model.composer.maxY + 18)
        }
    }
}
final class NativeStart: NSHostingView<StartContent> {
    let model = StartModel()
    var appearanceChanged: (() -> Void)?
    init() { super.init(rootView: StartContent(model: model)); sizingOptions = []; isHidden = true }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); appearanceChanged?() }
    required init(rootView: StartContent) { fatalError("init(rootView:) has not been implemented") }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func update(_ start: [String: Any], chat: String, composer: NSRect) {
        if model.chat != chat { model.chat = chat }
        let heading = start["heading"] as? String ?? ""
        if model.heading != heading { model.heading = heading }
        let home = start["home"] as? Bool ?? false
        if model.home != home { model.home = home }
        if model.composer != composer { model.composer = composer }
        let notice = start["notice"] as? [String: Any]
        let text = notice?["text"] as? String ?? "", progress = notice?["progress"] as? Bool ?? false
        if model.notice != text { model.notice = text }
        if model.progress != progress { model.progress = progress }
        let actions = (notice?["actions"] as? [[String: Any]] ?? []).compactMap { item -> StartAction? in
            guard let label = item["label"] as? String, let action = item["action"] as? String else { return nil }
            return StartAction(label: label, action: action, value: item["value"] as? String, disabled: item["disabled"] as? Bool ?? false)
        }
        if model.actions.map(\.id) != actions.map(\.id) || model.actions.map(\.label) != actions.map(\.label) || model.actions.map(\.disabled) != actions.map(\.disabled) { model.actions = actions }
        let recents = ((start["project"] as? [String: Any])?["recents"] as? [[String: Any]] ?? []).compactMap { item -> WelcomeRecent? in
            guard let root = item["root"] as? String, let name = item["name"] as? String else { return nil }
            return WelcomeRecent(root: root, name: name)
        }
        if model.recents.map(\.root) != recents.map(\.root) { model.recents = recents }
    }
    func inspect() -> [String: Any] {
        ["visible":!isHidden, "alpha":Double(alphaValue), "heading":model.heading, "home":model.home, "notice":model.notice, "progress":model.progress,
         "actions":model.actions.map { ["label":$0.label, "action":$0.action, "value":$0.value ?? "", "disabled":$0.disabled] }, "recents":model.recents.map(\.name),
         "composer":["x":Double(model.composer.minX), "y":Double(model.composer.minY), "width":Double(model.composer.width), "height":Double(model.composer.height)], "frame":NSStringFromRect(frame)]
    }
}

extension WorkspaceLayout {
    var startState: [String: Any] { chatState["start"] as? [String: Any] ?? [:] }
    /// The chat asks for the centered composer: always for the no-project draft, and for a
    /// project's new chat unless its open failed (the error and Retry own the window then).
    var wantsCentered: Bool {
        guard startState["centered"] as? Bool == true else { return false }
        if startState["home"] as? Bool == true { return true }
        let failed = (shellState["previewStatus"] as? [String: Any])?["kind"] as? String == "error"
        return shellState["project"] is String && !failed
    }
    var starting: Bool { start.progress < 1 }
    /// Another chat snaps to its layout; the same chat's first send glides to the left
    /// column (0.32 s ease-out), or snaps with Reduce Motion.
    func syncStart() {
        let chat = chatState["chat"] as? String ?? ""
        let target: CGFloat = wantsCentered ? 0 : 1
        guard chat != start.chat || target != start.target else { return }
        let glide = chat == start.chat && target == 1 && start.progress < 1 && !start.reduced
        let appeared = target == 0 && (chat != start.chat || start.target != 0)
        start.chat = chat; start.target = target
        start.timer?.invalidate(); start.timer = nil
        if appeared, let host { DispatchQueue.main.async { if host.window.firstResponder !== host.composer.text, host.composer.superview != nil { host.window.makeFirstResponder(host.composer.text) } } }
        guard glide else { start.progress = target; return }
        let from = start.progress, began = Date.timeIntervalSinceReferenceDate
        start.glides += 1
        start.timer = Timer.scheduledTimer(withTimeInterval: 1 / 60, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            let t = min(1, (Date.timeIntervalSinceReferenceDate - began) / 0.32)
            self.start.progress = from + (1 - from) * (1 - pow(1 - t, 3))
            if t >= 1 { timer.invalidate(); self.start.timer = nil }
            self.layout()
        }
    }
    /// About 46% of the content width, 560 pt or the window less margins at least, 860 at most;
    /// a little above the middle, below its heading.
    func centeredComposerFrame(in bounds: NSRect, height: CGFloat) -> NSRect {
        let width = min(860, max(min(560, bounds.width - 48), bounds.width * 0.46))
        let top = max(88, (bounds.height - height) * 0.42)
        return NSRect(x: ((bounds.width - width) / 2).rounded(), y: top.rounded(), width: max(0, width), height: height)
    }
    /// The composer between its centered and docked frames, for `nativeChatState`.
    func startComposer(_ state: inout [String: Any], column: CGFloat) {
        guard let host, starting else { return }
        let bounds = host.canvas.bounds, inset = ChatLayout.composerInset
        let input = chatState["composer"] as? [String: Any] ?? [:]
        let value = input["text"] as? String ?? ""
        let hasContext = !(input["context"] as? String ?? "").isEmpty, hasAttachments = !(input["attachments"] as? [Any] ?? []).isEmpty
        let queue = ComposerQueueHost.height(count: (input["queue"] as? [Any] ?? []).count, paused: input["queuePaused"] as? Bool ?? false, note: input["queueNote"] as? String ?? "")
        func height(_ width: CGFloat, _ room: CGFloat) -> CGFloat { host.composer.preferredHeight(for: value, width: width, availableHeight: room, hasContext: hasContext, hasAttachments: hasAttachments, queueHeight: queue) }
        let docked = ChatLayout.composerFrame(in: NSRect(x: 0, y: 0, width: column, height: bounds.height), height: height(max(0, column - 2 * inset), max(0, bounds.height - inset)))
        let width = min(860, max(min(560, bounds.width - 48), bounds.width * 0.46))
        let centered = centeredComposerFrame(in: bounds, height: height(width, max(0, bounds.height * 0.6)))
        start.frame = centered
        let p = start.progress
        let frame = NSRect(x: centered.minX + (docked.minX - centered.minX) * p, y: centered.minY + (docked.minY - centered.minY) * p,
                           width: centered.width + (docked.width - centered.width) * p, height: centered.height + (docked.height - centered.height) * p)
        state["composerVisible"] = true
        state["composerFrame"] = ["x":Double(frame.minX), "y":Double(frame.minY), "width":Double(frame.width), "height":Double(frame.height)]
        if p <= 0 { state["visible"] = false }
    }
    /// The surface fades out as the chat docks; the welcome screen gives way to the start screen.
    func placeStart(_ bounds: NSRect) {
        guard let host else { return }
        host.startSurface.frame = bounds
        host.startSurface.isHidden = !starting
        host.startSurface.alphaValue = 1 - start.progress
        if starting { host.startSurface.update(startState, chat: chatState["chat"] as? String ?? "", composer: start.frame) }
        // The page's titlebar fill and edge line (PreviewSurface) arrive with the preview.
        host.previewSurface.alphaValue = starting ? start.progress : 1
        let appearance = host.window.effectiveAppearance
        let tint = starting && start.progress < 0.5 ? appearance.name.rawValue : ""
        if tint != start.tint, let preview = host.views["preview"] {
            start.tint = tint
            var color: NSColor = preview.underPageBackgroundColor ?? .white
            if !tint.isEmpty { appearance.performAsCurrentDrawingAppearance { color = NSColor.windowBackgroundColor.usingColorSpace(.sRGB) ?? color } }
            host.shell.updatePreviewColor(color)
        }
        let welcome = host.welcome.wanted && !(starting && startState["home"] as? Bool == true)
        if host.welcome.isHidden == welcome { host.welcome.isHidden = !welcome; host.welcome.model.cat.show(welcome) }
    }
    func startInspect() -> [String: Any] {
        ["wantsCentered":wantsCentered, "progress":Double(start.progress), "target":Double(start.target), "glides":start.glides, "animating":start.timer != nil,
         "chat":start.chat ?? "", "reduceMotion":start.reduced, "start":startState, "surface":host?.startSurface.inspect() ?? [:],
         "column":NSStringFromRect(host?.chatColumn.frame ?? .zero), "columnHidden":host?.chatColumn.isHidden ?? true, "chatAlpha":Double(host?.chat.alphaValue ?? 0),
         "welcomeHidden":host?.welcome.isHidden ?? true, "pageSurfaceAlpha":Double(host?.previewSurface.alphaValue ?? 0), "tint":start.tint]
    }
}
