import AppKit
import Combine
import SwiftUI

/// `labels` are the statuses with collapsed paths (`display-path.ts`); `statuses` keep the full text.
/// `ui` is an answer component (LKM-208, `ChatUi.swift`).
struct ChatSegment: Decodable { let kind: String; let text: String?; let at: Double?; let statuses: [String]?; let labels: [String]?; let island: IslandView?; let ui: ChatUiPayload? }
struct ChatAttachment: Decodable, Identifiable { let id: String; let kind: String?; let name: String?; let path: String?; let url: String? }
struct ChatSelection: Decodable { let tag: String; let ident: String; let source: String? }
struct ChatMessage: Decodable, Identifiable {
    let id: String; let role: String; let text: String; let segments: [ChatSegment]
    let at: Double?; let workedMs: Double?
    let attachments: [ChatAttachment]?; let selection: ChatSelection?; let revertGroup: String?
    let comment: ChatComment?; let landingCheck: ChatLandingCheck?; let liveChange: ChatLiveChange?
}
struct ChatAction: Decodable { let label: String; let action: String; let value: String?; let disabled: Bool? }
struct ChatCard: Decodable, Identifiable { let id: String; let title: String; let detail: String?; let fullDetail: String?; let actions: [ChatAction]; let agent: ChatAgentInfo? }
struct ChatQuestionOption: Decodable { let label: String; let description: String? }
struct ChatQuestion: Decodable { let header: String; let question: String; let options: [ChatQuestionOption]; let multiSelect: Bool }
struct ChatQuestionRequest: Decodable, Identifiable { let id: String; let questions: [ChatQuestion] }
struct ChatSnapshot: Decodable {
    let activity: ChatActivityState?; let streamingId: String?
    let chat: String; let messages: [ChatMessage]; let running: Bool; let cards: [ChatCard]
    let questions: [ChatQuestionRequest]
}
/// A `chatState` frame (`chat-frames.ts`): `messages` is absent when they are unchanged
/// since the last frame for this chat, so a long transcript is not decoded again (LKM-165).
struct ChatFrame: Decodable {
    let activity: ChatActivityState?; let streamingId: String?
    let chat: String; let messages: [ChatMessage]?; let running: Bool; let cards: [ChatCard]
    let questions: [ChatQuestionRequest]
}
private extension ChatSnapshot {
    // Source-value refreshes and composer updates are not new conversation content.
    var followHead: [String] { [chat, activity?.label ?? "", String(running)] + cards.map { $0.id + $0.title } + questions.map { $0.id } }
    var followContent: [String] {
        followHead + messages.flatMap { message in
            [message.id, message.text] + message.segments.flatMap { segment in
                if let island = segment.island { return [island.id, String(island.revision)] }
                if let record = segment.ui?.record { return [record.id, record.images.keys.sorted().joined(separator: ","), String(record.answer != nil)] }
                return [segment.text ?? ""] + (segment.statuses ?? [])
            }
        }
    }
}
final class ChatLayoutModel: ObservableObject {
    @Published var composerHeight: CGFloat = 0
}
final class ChatModel: ObservableObject {
    let cat = CatAnimator()
    @Published var snapshot: ChatSnapshot?
    /// Verification: actual SwiftUI transcript row body evaluations, independent of snapshots.
    var messageBodyEvaluations = 0
    @Published var revision = 0
    @Published var controlInteraction = 0
    @Published var followRevision = 0
    @Published var revealRevision = 0
    var revealMessage = ""
    var revealIsland = ""
    var revealBottom = false
    var revealRequest: IslandRevealRequest { IslandRevealRequest(revision: revealRevision, island: revealIsland, bottom: revealBottom, message: revealMessage) }
    var revealAppliedRevision = 0
    var revealAttempt = 0
    var latestSettleAttempts = 0  // diagnostics (ChatLatestSettle)
    @Published var visible = false
    let layout = ChatLayoutModel()
    var composerHeight: CGFloat {
        get { layout.composerHeight }
        set { layout.composerHeight = newValue }
    }
    var messageFrames: [String: CGRect] = [:]
    var islandPositions: [String: CGRect] = [:]
    /// Response footers and their token counters (`<id>-tokens`), for inspection.
    var footerFrames: [String: CGRect] = [:]
    /// Messages showing Copy/Revert (hover or keyboard focus), for inspection.
    var revealedActions: [String] = []
    /// Verification only: the message treated as hovered ("" = none) instead of
    /// the real pointer, so captures do not depend on where the cursor rests.
    @Published var hoverOverride: String?
    /// The live status lines as rendered this second (LKM-147), for inspection.
    var statusLines: [String] = []
    /// Sent attachment cells by attachment id, for inspection (LKM-166).
    var attachmentFrames: [String: CGRect] = [:]
    /// The sent attachment whose larger preview is open.
    @Published var attachmentPreview: String?
    /// Comment result rows the user expanded (ChatCommentRow); kept for the session only.
    @Published var expandedComments: Set<String> = []
    func toggleComment(_ id: String) { if expandedComments.remove(id) == nil { expandedComments.insert(id) } }
    /// Background agent cards (ChatAgentCard.swift): expanded requests, questions seen, frames.
    @Published var expandedAgents: Set<String> = []
    var seenAgentQuestions: Set<String> = [], agentCardFrames: [String: CGRect] = [:]
    /// Answer components (ChatUi.swift) by record id, for inspection and captures.
    var chatUiFrames: [String: CGRect] = [:]
    var bottomPosition: CGFloat = 0
    var latestButtonFrame = CGRect.zero
    /// What the conversation's SwiftUI views read (see ChatAccessibilityEcho).
    var renderedAccessibility = ChatAccessibility()
    /// Driven by the scroll probe: unpinned (or not following) and away from the end.
    @Published var showsLatest = false
    var latestButtonClickCount = 0  // acceptance diagnostics
    /// Bumped by the native latest button; the conversation scrolls to latest.
    @Published var latestRequest = 0
    func pressLatest() { latestButtonClickCount += 1; latestRequest += 1 }
    // Preserve message clearance above the floating composer.
    var bottomInset: CGFloat { ChatLayout.bottomInset(composerHeight: composerHeight) }
    /// `gesture` groups a control's live writes into one Undo step (`IslandLiveWrites`);
    /// `ended` marks its last batch.
    func islandAction(_ island: IslandView, action: String, values: [String: Any] = [:], gesture: String? = nil, ended: Bool = false) {
        guard let chat = snapshot?.chat else { return }
        controlInteraction += 1
        var message: [String: Any] = ["event":"island-action", "chat":chat, "id":island.id, "revision":island.revision,
              "sourceRevision":island.sourceRevision, "operation":UUID().uuidString, "action":action, "values":values]
        if let gesture { message["gesture"] = gesture; message["ended"] = ended }
        emit(message)
    }
    func action(_ name: String, id: String? = nil, value: String? = nil, answers: [String: String]? = nil) {
        guard let chat = snapshot?.chat else { return }
        var message: [String: Any] = ["event":"chat-action", "chat":chat, "action":name]
        if let id { message["id"] = id }; if let value { message["value"] = value }
        if let answers { message["answers"] = answers }
        emit(message)
    }
}

/// Native conversation extends behind the composer; AppKit owns both frames.
final class NativeChat: NSHostingView<ChatConversation> {
    let model = ChatModel()
    var lastState: [String: Any] = [:]
    private var lastConversation: [String: Any] = [:]
    /// Native sibling over the conversation (see ChatLatestButton).
    let latestButton = ChatLatestButton()
    private var latestObservers: Set<AnyCancellable> = []
    init() {
        super.init(rootView: ChatConversation(model: model, layout: model.layout)); isHidden = true; sizingOptions = []
        latestButton.onPress = { [weak self] in self?.model.pressLatest() }
        // @Published fires before the value changes; place on the next turn.
        model.$showsLatest.combineLatest(model.layout.$composerHeight)
            .sink { [weak self] _ in DispatchQueue.main.async { self?.layoutLatestButton() } }
            .store(in: &latestObservers)
    }
    override var isHidden: Bool { didSet { layoutLatestButton() } }
    override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        if let superview { superview.addSubview(latestButton, positioned: .above, relativeTo: self) } else { latestButton.removeFromSuperview() }
        layoutLatestButton()
    }
    override func layout() { super.layout(); layoutLatestButton() }
    func layoutLatestButton() {
        model.latestButtonFrame = latestButton.place(over: self, composerHeight: model.composerHeight, visible: model.showsLatest)
    }
    required init(rootView: ChatConversation) { fatalError("init(rootView:) has not been implemented") }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func update(_ state: [String: Any], composer: NativeComposer) {
        lastState = state
        isHidden = !(state["visible"] as? Bool ?? false)
        if model.visible != !isHidden { model.visible = !isHidden }
        // A frame that only moved the composer (text, attachments) or the column leaves
        // the conversation alone: no decode of the kept transcript, no SwiftUI pass.
        var conversation = state
        for key in ["composer", "bounds", "visible", "messages"] { conversation.removeValue(forKey: key) }
        let previous = model.snapshot
        let kept = state["messages"] == nil && previous?.chat == state["chat"] as? String
        if kept, NSDictionary(dictionary: conversation).isEqual(to: lastConversation) {
            // Nothing the conversation shows changed.
        } else if let data = try? JSONSerialization.data(withJSONObject: state), let frame = try? JSONDecoder().decode(ChatFrame.self, from: data) {
            lastConversation = conversation
            let messages = frame.messages ?? (kept ? previous?.messages : nil) ?? []
            let snapshot = ChatSnapshot(activity: frame.activity, streamingId: frame.streamingId, chat: frame.chat, messages: messages, running: frame.running, cards: frame.cards, questions: frame.questions)
            let completed = previous?.chat == snapshot.chat && previous?.running == true && !snapshot.running && !(snapshot.messages.last?.text.contains("⚠️") ?? false)
            model.cat.update(running: snapshot.running, questioning: !snapshot.questions.isEmpty || snapshot.cards.contains { $0.agent?.question != nil || $0.actions.contains { $0.action == "permission" } }, completed: completed)
            model.revealAgentQuestions(snapshot.cards)
            let follow = kept ? previous?.followHead != snapshot.followHead : previous?.followContent != snapshot.followContent
            if follow { model.followRevision += 1 }
            model.snapshot = snapshot; model.revision += 1
        }
        model.cat.show(!isHidden)
        place(state, composer: composer)
    }
    func place(_ state: [String: Any], composer: NativeComposer) {
        let visible = state["visible"] as? Bool ?? false
        if model.visible != visible { model.visible = visible }
        guard let bounds = state["bounds"] as? [String: Double] else { return }
        let x = bounds["x"] ?? 0, y = bounds["y"] ?? 0, width = bounds["width"] ?? 0, height = bounds["height"] ?? 0
        guard [x,y,width,height].allSatisfy({ $0.isFinite && abs($0) < 100000 }) else { return }
        var input = state["composer"] as? [String: Any] ?? [:]
        let value = input["text"] as? String ?? ""
        let hasContext = !(input["context"] as? String ?? "").isEmpty
        let queueHeight = ComposerQueueHost.height(count: (input["queue"] as? [Any] ?? []).count, paused: input["queuePaused"] as? Bool ?? false, note: input["queueNote"] as? String ?? "")
        let inset = ChatLayout.composerInset
        let composerHeight = Double(composer.preferredHeight(for: value, width: max(0, width - 2 * inset), availableHeight: max(0, height - inset), hasContext: hasContext, hasAttachments: !(input["attachments"] as? [Any] ?? []).isEmpty, queueHeight: queueHeight))
        frame = NSRect(x: x, y: y, width: width, height: max(0, height))
        if model.composerHeight != composerHeight { model.composerHeight = composerHeight }
        layoutLatestButton()
        input["chat"] = state["chat"]; input["visible"] = !isHidden && !(state["chat"] as? String ?? "").isEmpty
        input["bounds"] = ChatLayout.composerBounds(in: frame, height: composerHeight)
        // The centered start composer (LKM-232) places itself, with or without a transcript.
        if let visible = state["composerVisible"] as? Bool { input["visible"] = visible }
        if let bounds = state["composerFrame"] as? [String: Double] { input["bounds"] = bounds }
        input["start"] = state["start"]
        composer.update(input)
    }
    /// The conversation's SwiftUI-backed NSScrollView, found through its style probe.
    var conversationScroll: NSScrollView? {
        func probe(_ view: NSView) -> ChatScrollStyleProbe? { (view as? ChatScrollStyleProbe) ?? view.subviews.lazy.compactMap(probe).first }
        return probe(self)?.enclosingScrollView
    }
    func inspect() -> [String: Any] {
        let tail = model.snapshot?.messages.suffix(3).map { ["id":$0.id, "frame":NSStringFromRect(model.messageFrames[$0.id] ?? .zero)] } ?? []
        let state: [String: Any] = ["scroll":conversationScroll.map(ChatScrollStyleProbe.metrics) ?? [:], "messageBodyEvaluations":model.messageBodyEvaluations, "realizedRows":model.messageFrames.count, "latestSettleAttempts":model.latestSettleAttempts, "tailFrames":tail,
         "followRevision":model.followRevision, "controlInteraction":model.controlInteraction, "visibleMessageIDs":model.messageFrames.filter { $0.value.maxY > 0 && $0.value.minY < bounds.height - model.bottomInset }.map(\.key), "bottomPosition":model.bottomPosition, "composerInset":model.bottomInset, "height":bounds.height, "revealRevision":model.revealRevision, "revealAppliedRevision":model.revealAppliedRevision, "revealAttempt":model.revealAttempt, "islandPositions":model.islandPositions.mapValues { NSStringFromRect($0) }, "catPose":model.cat.pose, "catFrame":model.cat.frame, "catArtwork":!CatArtwork.frames.isEmpty, "frame":NSStringFromRect(frame), "native":true, "visible":!isHidden, "chat":model.snapshot?.chat ?? "", "messageCount":model.snapshot?.messages.count ?? 0,
         "messages":model.snapshot?.messages.map { ["id":$0.id,"role":$0.role,"text":$0.text] } ?? [],
         "comments":model.snapshot?.messages.compactMap { m in m.comment.map { ["id":m.id, "title":$0.title, "line":$0.line, "expanded":model.expandedComments.contains(m.id)] as [String: Any] } } ?? [],
         "landingChecks":model.snapshot?.messages.compactMap { m in m.landingCheck.map { ["id":m.id, "problem":$0.problem, "line":$0.line, "errors":$0.errors] as [String: Any] } } ?? [],
         "liveChanges":model.snapshot?.messages.compactMap { m in m.liveChange.map { ["id":m.id, "line":$0.line, "agent":$0.agent, "expanded":model.expandedComments.contains(m.id)] as [String: Any] } } ?? [],
         "footerFrames":model.footerFrames.mapValues { NSStringFromRect($0) }, "revealedActions":model.revealedActions, "messageFrames":model.messageFrames.mapValues { NSStringFromRect($0) },
         "statusLines":model.statusLines, "attachmentFrames":model.attachmentFrames.mapValues { NSStringFromRect($0) }, "attachmentPreview":model.attachmentPreview ?? "",
         "attachmentPopover":NSApp.windows.contains { $0.isVisible && String(describing: type(of: $0)).contains("Popover") }, "activityTokens":model.snapshot?.activity?.tokens?.label ?? "",
         "activity":model.snapshot?.activity?.label ?? "", "activityKind":model.snapshot?.activity?.kind ?? "", "activityAnimated":model.snapshot?.activity?.animated ?? false,
         "islands":model.snapshot?.messages.flatMap { $0.segments.compactMap { $0.island }.map { ["id":$0.id,"revision":$0.revision,"status":$0.status,"title":$0.title,"blocks":$0.blocks.count,"blockKinds":$0.blocks.map(\.kind),"fields":$0.fields.count,"sourceRevision":$0.sourceRevision,
                 "name":$0.name ?? "","reason":$0.reason ?? "","disabledBy":$0.disabledBy ?? "","disabledFields":$0.fields.filter { $0.disabled != nil }.map(\.id)] as [String: Any] } } ?? [],
         "cards":model.snapshot?.cards.map(\.id) ?? [],
         "cardStates":model.snapshot?.cards.map { ["id":$0.id, "title":$0.title, "detail":$0.detail ?? "", "actions":$0.actions.map(\.label)] as [String: Any] } ?? [],
         "questionCount":model.snapshot?.questions.count ?? 0]
        return state.merging(inspectAgents()) { $1 }.merging(inspectChatUi()) { $1 }
    }
}
private struct BottomPosition: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
private struct MessagePositions: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) { value.merge(nextValue()) { _, new in new } }
}
struct IslandPositions: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) { value.merge(nextValue()) { _, new in new } }
}
struct ChatConversation: View {
    @ObservedObject var model: ChatModel
    @ObservedObject var layout: ChatLayoutModel
    @ObservedObject var system = ChatSystemEnvironment.shared
    @State private var follows = true
    @State private var sticky: String?
    @State private var revealGeneration = 0
    @State private var pinRequest = 0
    @State private var attachRequest = 0
    @State private var latestGeneration = 0
    @State private var settlingLatest = false
    @State private var realizingLatest = false
    @State private var latestNudge = false
    @State private var viewportHeight: CGFloat = 0
    private func reveal(_ proxy: ScrollViewProxy, readingHeight: CGFloat, viewportHeight: CGFloat) {
        revealGeneration += 1
        let generation = revealGeneration
        let request = model.revealRequest
        model.revealAttempt = 0
        // A nested lazy child can receive scrollTo before SwiftUI has committed
        // its latest anchor geometry. Yield once, then reissue against each
        // completed layout until the measured anchor reaches the viewport. An
        // offscreen row is scrolled in first; see islandRevealScroll.
        Task { @MainActor in
            await Task.yield()
            var streak = 0
            for attempt in 1...80 {
                guard revealGeneration == generation, model.revealRevision == request.revision else { return }
                model.revealAttempt = attempt
                let target = islandRevealScroll(request, positions: model.islandPositions, viewportHeight: viewportHeight)
                proxy.scrollTo(target.id, anchor: UnitPoint(x: 0.5, y: islandRevealUnitY(target.edge, readingHeight: readingHeight, viewportHeight: viewportHeight)))
                try? await Task.sleep(nanoseconds: 20_000_000)
                guard revealGeneration == generation, model.revealRevision == request.revision else { return }
                guard let frame = model.islandPositions[request.position] else { streak = 0; continue }
                // Keep scrolling until the anchor holds the edge across several
                // layouts: rows above it can still re-measure after a hit.
                streak = islandRevealStreak(reached: islandRevealReached(request, frame: frame, readingHeight: readingHeight), streak: streak)
                if streak >= islandRevealStableChecks {
                    model.revealAppliedRevision = request.revision
                    return
                }
            }
        }
    }
    @ViewBuilder
    private func stickyRequest(proxy: ScrollViewProxy) -> some View {
        if let sticky, let message = model.snapshot?.messages.first(where: { $0.id == sticky }) {
            Button {
                follows = false
                proxy.scrollTo(sticky, anchor: .top)
            } label: {
                Text(message.text).font(.caption).lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(8)
            }
            .buttonStyle(.plain).background(.regularMaterial).help("Scroll to this request")
        }
    }
    @ViewBuilder
    private var conversationContent: some View {
        if let snapshot = model.snapshot {
            if snapshot.messages.isEmpty && snapshot.cards.isEmpty {
                Text("Ask for a change, or open a project to preview it on the right.")
                    .foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.top, 28)
            }
            ForEach(snapshot.messages) { message in
                Group {
                    if let comment = message.comment { ChatCommentRow(message: message, comment: comment, model: model) }
                    else if let check = message.landingCheck { ChatLandingCheckRow(message: message, check: check, model: model) }
                    else if let change = message.liveChange { ChatLiveChangeRow(message: message, change: change, model: model) }
                    else {
                        NativeMessageRow(message: message, running: snapshot.running && message.id == snapshot.streamingId, activity: message.id == snapshot.streamingId ? snapshot.activity : nil,
                                         latest: message.id == snapshot.messages.last?.id, model: model)
                    }
                }.id(message.id)
                    .background(GeometryReader { geometry in Color.clear.preference(key: MessagePositions.self, value: [message.id:geometry.frame(in: .named("chatScroll"))]) })
            }
            if let activity = snapshot.activity, !snapshot.messages.contains(where: { $0.id == snapshot.streamingId }) {
                ChatTurnFooter(id: "live", activity: activity, visible: model.visible) { EmptyView() }
            }
            ForEach(snapshot.cards) { card in
                if let agent = card.agent { ChatAgentCardView(card: card, agent: agent, model: model) } else { NativeChatCard(card: card, model: model) }
            }
            ForEach(snapshot.questions) { request in NativeQuestionCard(request: request, model: model) }

        }
    }
    /// See ChatLatestSettle. Requests while settling extend the running one;
    /// the user scrolling away ends it. Metrics are read live at each step.
    private func settleLatest(_ proxy: ScrollViewProxy) {
        latestGeneration += 1
        guard !settlingLatest else { return }
        settlingLatest = true
        Task { @MainActor in
            let readingHeight = { max(1, viewportHeight - model.bottomInset) }
            var stuck = 0, unresolved = 0
            model.latestSettleAttempts = await ChatLatestSettle.follow(request: { latestGeneration }, current: { follows }, step: {
                ChatLatestSettle.step(latest: model.snapshot?.messages.last?.id, frames: model.messageFrames, bottom: model.bottomPosition,
                                      readingHeight: readingHeight(), viewportHeight: viewportHeight)
            }) { step in
                // No row in view: hold the AppKit pin, relayout the stack (a
                // 1pt marker change) and scroll to the latest through SwiftUI.
                // Rows in view: the pin's short jump lands on the end exactly.
                // Relayout: the same marker change in place, then the pin.
                unresolved = step == .bottom ? unresolved + 1 : 0
                let action = ChatLatestSettle.escalated(step, unresolved: unresolved)
                if case .realize(let id) = action {
                    realizingLatest = true; latestNudge.toggle(); stuck += 1
                    let target = ChatLatestSettle.realizeTarget(latest: id, first: model.snapshot?.messages.first?.id, stuck: stuck)
                    proxy.scrollTo(target.id, anchor: target.anchor)
                } else {
                    stuck = 0; realizingLatest = false
                    if action == .relayout { latestNudge.toggle() }
                    pinRequest += 1
                }
            }
            settlingLatest = false; realizingLatest = false
            // Rest at the marker's 1pt height, so the nudges leave no offset behind.
            if latestNudge { latestNudge = false }
            if follows { pinRequest += 1 }
        }
    }
    private func conversationScroll(onMovedToEnd: @escaping () -> Void) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                conversationContent
                // Keep the scroll target in the same lazy layout as the
                // messages. Composer clearance is padding, never a target.
                // The nudge's extra point comes out of that padding, so the
                // document height and every row's place never move (LKM-149).
                Color.clear.frame(height: latestNudge ? 2 : 1).id("bottom")
                    .background(GeometryReader { geometry in Color.clear.preference(key: BottomPosition.self, value: geometry.frame(in: .named("chatScroll")).maxY) })
            }.padding(.horizontal, 18).padding(.top, 18).padding(.bottom, model.bottomInset - (latestNudge ? 1 : 0))
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(ChatScrollStyle(follows: { follows }, pinRequest: pinRequest, attachRequest: attachRequest,
                                            onPinnedChange: { follows = $0 },
                                            onLatestButtonChange: { if model.showsLatest != $0 { model.showsLatest = $0 } },
                                            onMovedToEnd: onMovedToEnd, holdsPin: { realizingLatest }))
        }
    }
    var body: some View {
        VStack(spacing: 0) {
            GeometryReader { viewport in
                ScrollViewReader { proxy in
                    let readingHeight = max(1, viewport.size.height - model.bottomInset)
                    let bottomAnchor = UnitPoint(x: 0.5, y: readingHeight / max(1, viewport.size.height))
                    let settle = { settleLatest(proxy) }
                    // Unmasked: history scrolls on under the composer and the latest
                    // button, which bring their own glass (LKM-190).
                    conversationScroll(onMovedToEnd: { if follows { settle() } })
                    .coordinateSpace(name: "chatScroll")
                    .onPreferenceChange(MessagePositions.self) { positions in
                        model.messageFrames = positions
                        sticky = model.snapshot?.messages.last(where: { $0.role == "user" && (positions[$0.id]?.maxY ?? 1) < 0 })?.id
                    }
                    .onPreferenceChange(IslandPositions.self) { model.islandPositions = $0 }
                    .onPreferenceChange(TurnFooterPositions.self) { model.footerFrames = $0 }
                    .onPreferenceChange(RevealedActions.self) { model.revealedActions = $0 }
                    .onPreferenceChange(ChatStatusLines.self) { model.statusLines = $0 }
                    .onPreferenceChange(AttachmentFrames.self) { model.attachmentFrames = $0 }
                    .onPreferenceChange(AgentCardFrames.self) { model.agentCardFrames = $0 }
                    .onPreferenceChange(ChatUiFrames.self) { model.chatUiFrames = $0 }
                    .overlay(alignment: .top) {
                        stickyRequest(proxy: proxy)
                    }
                    .onPreferenceChange(BottomPosition.self) { bottom in
                        // Pinned state follows user input only (see ChatScrollStyleProbe);
                        // a stale NSApp.currentEvent would re-pin after a programmatic pin.
                        model.bottomPosition = bottom
                    }
                    // Metric-only changes: the probe pins from settled AppKit bounds.
                    .onAppear { viewportHeight = viewport.size.height }
                    .onChange(of: viewport.size) { size in viewportHeight = size.height; if follows { pinRequest += 1 } }
                    .onChange(of: layout.composerHeight) { _ in if follows { pinRequest += 1 } }
                    .onChange(of: model.revealRevision) { _ in
                        follows = false; sticky = nil
                        reveal(proxy, readingHeight: readingHeight, viewportHeight: viewport.size.height)
                    }
                    .onChange(of: model.controlInteraction) { _ in follows = false }
                    .onChange(of: model.followRevision) { _ in if follows { proxy.scrollTo("bottom", anchor: bottomAnchor); pinRequest += 1; settle() } }
                    .onChange(of: model.snapshot?.chat) { _ in follows = true; sticky = nil; proxy.scrollTo("bottom", anchor: bottomAnchor); attachRequest += 1; settle() }
                    // The latest button itself is native (NativeChat.latestButton).
                    .onChange(of: model.latestRequest) { _ in follows = true; proxy.scrollTo("bottom", anchor: bottomAnchor); attachRequest += 1; settle() }
                }
            }
        }.background(Color.clear)
        .background(ChatAccessibilityEcho { model.renderedAccessibility = $0 })
        // System accessibility options (or the acceptance override) for all
        // SwiftUI views in the conversation, including the echo above.
        .modifier(ChatAccessibilityEnvironment(accessibility: system.accessibility))
    }
}
private struct NativeMessageRow: View {
    let message: ChatMessage
    let running: Bool
    let activity: ChatActivityState?
    let latest: Bool
    @ObservedObject var model: ChatModel
    @State private var hovered = false
    @FocusState private var focusedAction: String?
    /// Copy/Revert stay laid out and focusable; hover or keyboard focus shows them (LKM-145).
    private var revealsActions: Bool { (model.hoverOverride.map { $0 == message.id } ?? hovered) || focusedAction != nil }
    var body: some View {
        model.messageBodyEvaluations += 1
        return HStack(alignment: .top) {
            if message.role == "user" { Spacer(minLength: 30) }
            VStack(alignment: .leading, spacing: 14) {
                if !running, let elapsed = message.workedMs {
                    Text(workedDuration(elapsed)).font(.caption).foregroundStyle(.secondary)
                        .help("Elapsed time for this turn, including checks, waits and applying changes.")
                } else if running && message.role == "assistant" {
                    // Reserved, so the caption arriving on completion moves nothing (LKM-145).
                    Text(workedDuration(0)).font(.caption).hidden()
                }
                if let selection = message.selection { Text(selection.tag + selection.ident).font(.caption.monospaced()).foregroundStyle(.secondary) }
                if let attachments = message.attachments, !attachments.isEmpty { SentAttachments(attachments: attachments, model: model) }
                ForEach(Array(message.segments.enumerated()), id: \.offset) { index, segment in
                    if let island = segment.island { NativeChatIsland(island: island, model: model) }
                    else if let ui = segment.ui { NativeChatUi(payload: ui, running: running, model: model).id(ui.record?.id ?? "ui-\(index)") }
                    else if segment.kind == "tools" {
                        DisclosureGroup {
                            ForEach(Array((segment.statuses ?? []).enumerated()), id: \.offset) { _, status in Text(status).font(ChatTypography.activity).lineSpacing(3).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                        } label: {
                            // Collapsed: the short form, wrapped rather than cut mid-path; the full status is the tooltip.
                            Text(segment.labels?.last ?? segment.statuses?.last ?? "Activity").font(ChatTypography.activity).foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true).help(segment.statuses?.last ?? "")
                        }
                    } else if let text = segment.text {
                        if message.role == "user" { Text(text).textSelection(.enabled).font(ChatTypography.body).lineSpacing(ChatTypography.lineSpacing).fixedSize(horizontal: false, vertical: true) }
                        else { ChatMarkdown(source: text, streaming: running, identity: "\(message.id)#\(index)").help(messageTime(segment.at ?? message.at)) }
                    }
                }
                if message.role == "assistant" && (activity != nil || !running) {
                    ChatTurnFooter(id: message.id, activity: activity, latest: latest, visible: model.visible) {
                        HStack {
                            Button { copyChatText(message.text) } label: { Image(systemName: "doc.on.doc") }
                                .help("Copy response").accessibilityLabel("Copy response").focused($focusedAction, equals: "copy")
                            if message.revertGroup != nil {
                                Button { model.action("revert", id: message.id) } label: { Image(systemName: "arrow.uturn.backward") }
                                    .help("Revert this turn's edits").accessibilityLabel("Revert this turn's edits").focused($focusedAction, equals: "revert")
                            }
                        }.buttonStyle(ChatActionButtonStyle(revealed: revealsActions))
                    }
                } else if let activity { ChatActivity(activity: activity, visible: model.visible) }
            }.padding(message.role == "user" ? 12 : 0)
                .background { if message.role == "user" { RoundedRectangle(cornerRadius: 14).fill(.quaternary) } }
            if message.role == "assistant" { Spacer(minLength: 0) }
        }.frame(maxWidth: .infinity, alignment: message.role == "user" ? .trailing : .leading)
            .contentShape(Rectangle())
            .onHover { hovered = $0 }
            .preference(key: RevealedActions.self, value: revealsActions ? [message.id] : [])
            .help(messageTime(message.at))
    }
}
struct ChatActionButtonStyle: ButtonStyle {
    /// False hides the glyph only: the button keeps its frame, focus and label.
    var revealed = true
    func makeBody(configuration: Configuration) -> some View {
        ChatActionButton(configuration: configuration, revealed: revealed)
    }
    private struct ChatActionButton: View {
        let configuration: ButtonStyle.Configuration
        let revealed: Bool
        @Environment(\.isEnabled) private var enabled
        @State private var hovered = false
        var body: some View {
            configuration.label
                .frame(width: 28, height: 28)
                .foregroundStyle(!revealed ? Color.clear : enabled && (hovered || configuration.isPressed) ? Color.primary : Color.secondary)
                .background(Color.primary.opacity(enabled && revealed ? (configuration.isPressed ? 0.16 : hovered ? 0.08 : 0) : 0), in: RoundedRectangle(cornerRadius: 6))
                .animation(.easeOut(duration: 0.12), value: revealed)
                .contentShape(RoundedRectangle(cornerRadius: 6))
                .onHover { hovered = $0 }
        }
    }
}
private struct NativeChatCard: View {
    let card: ChatCard
    @ObservedObject var model: ChatModel
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(card.title).font(.headline)
            if let detail = card.detail, !detail.isEmpty { Text(detail).textSelection(.enabled).font(.system(size: 12)).help(card.fullDetail ?? "") }
            HStack {
                // A collapsed detail copies with its full paths.
                if let full = card.fullDetail {
                    Button { copyChatText(full) } label: { Image(systemName: "doc.on.doc") }.buttonStyle(ChatActionButtonStyle()).help("Copy with full paths")
                }
                Spacer()
                ForEach(Array(card.actions.enumerated()), id: \.offset) { _, action in
                    Button(action.label) { model.action(action.action, id: card.id, value: action.value) }.disabled(action.disabled ?? false)
                }
            }
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
    }
}

func messageTime(_ milliseconds: Double?) -> String {
    guard let milliseconds, milliseconds.isFinite else { return "" }
    return Date(timeIntervalSince1970: milliseconds / 1000).formatted(date: .abbreviated, time: .standard)
}
private func workedDuration(_ milliseconds: Double) -> String {
    let seconds = max(0, Int(milliseconds / 1000))
    let hours = seconds / 3600, minutes = (seconds % 3600) / 60
    let parts = [hours > 0 ? "\(hours)h" : nil, minutes > 0 ? "\(minutes)m" : nil, "\(seconds % 60)s"].compactMap { $0 }
    return "Worked for " + parts.joined(separator: " ")
}
