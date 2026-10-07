import AppKit
import SwiftUI

/// A background agent's card (LKM-193, `NativeChatCard.agent`, `chat-agent-card.ts`).
struct ChatAgentTarget: Decodable { let label: String; let source: String }
struct ChatAgentInfo: Decodable {
    let status: String; let statusLabel: String
    let request: String; let preview: String
    let target: ChatAgentTarget?
    let question: ChatQuestionRequest?
}

/// The request (its preview, the whole of it after a click), the file:line it targets as
/// an editor link, the status, and a pending question answered in place exactly like a
/// chat question. Cancel always cancels.
struct ChatAgentCardView: View {
    let card: ChatCard
    let agent: ChatAgentInfo
    @ObservedObject var model: ChatModel
    private var expanded: Bool { model.expandedAgents.contains(card.id) }
    private var expandable: Bool { agent.preview != agent.request }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(card.title).font(.headline)
                Spacer()
                Text(agent.statusLabel).font(.caption.weight(.medium))
                    .foregroundStyle(agent.status == "waiting" ? Color.orange : Color.secondary)
                    .accessibilityLabel("Status: \(agent.statusLabel)")
            }
            Button { if expandable { model.toggleAgent(card.id) } } label: {
                Text(expanded ? agent.request : agent.preview).font(.system(size: 12))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(expandable ? (expanded ? "Show less" : "Show the whole request") : "")
            .accessibilityValue(expandable ? (expanded ? "Expanded" : "Collapsed") : "")
            if let target = agent.target {
                Button(target.label) { model.action("spawn-open-target", id: card.id) }
                    .buttonStyle(.link).font(.system(size: 12, design: .monospaced))
                    .help("Open \(target.label) in the editor")
            }
            if let detail = card.detail, !detail.isEmpty { Text(detail).font(.system(size: 12)).foregroundStyle(.secondary) }
            if let question = agent.question {
                Divider()
                NativeQuestionCard(request: question, model: model, framed: false).id(question.id)
            }
            HStack {
                Spacer()
                ForEach(Array(card.actions.enumerated()), id: \.offset) { _, action in
                    Button(action.label) { model.action(action.action, id: card.id, value: action.value) }.disabled(action.disabled ?? false)
                }
            }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
        .background(GeometryReader { geometry in Color.clear.preference(key: AgentCardFrames.self, value: [card.id:geometry.frame(in: .named("chatScroll"))]) })
    }
}
struct AgentCardFrames: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) { value.merge(nextValue()) { _, new in new } }
}
extension ChatModel {
    func toggleAgent(_ id: String) { if expandedAgents.remove(id) == nil { expandedAgents.insert(id) } }
    /// Agent question ids not seen before: each one brings its card into view once.
    func revealAgentQuestions(_ cards: [ChatCard]) {
        let ids = Set(cards.compactMap { $0.agent?.question?.id })
        if !ids.subtracting(seenAgentQuestions).isEmpty { pressLatest() }
        seenAgentQuestions = ids
    }
}
extension NativeChat {
    /// Agent cards for inspection (LKM-193).
    func inspectAgents() -> [String: Any] {
        ["agentCards":model.snapshot?.cards.compactMap { card in card.agent.map { agent -> [String: Any] in
            ["id":card.id, "title":card.title, "status":agent.status, "statusLabel":agent.statusLabel, "preview":agent.preview,
             "expanded":model.expandedAgents.contains(card.id), "target":agent.target?.label ?? "", "question":agent.question?.id ?? "",
             "options":agent.question?.questions.first?.options.map(\.label) ?? [], "actions":card.actions.map(\.label),
             "frame":NSStringFromRect(model.agentCardFrames[card.id] ?? .zero)]
        } } ?? []]
    }
}

/// LKM-193 verification (test profile): the chat with a background agent's question card
/// in a forced light or dark window appearance, captured in the foreground. The appearance
/// is the window's own; system settings are never touched.
extension Host {
    @MainActor
    func verifyAgentCard(_ c: [String: Any]) async throws -> [String: Any] {
        if c["restore"] as? Bool == true {
            window.appearance = nil; chat.model.expandedAgents = []
            return [:]
        }
        if let dark = c["dark"] as? Bool { window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua) }
        let id = c["card"] as? String ?? "", toggle = c["toggle"] as? [String] ?? []
        let before = chat.model.agentCardFrames[id] ?? .zero
        for id in toggle { chat.model.toggleAgent(id) }
        chat.model.pressLatest()
        // Settled: the card is laid out (resized, after a toggle) and holds its frame
        // across two samples.
        var last = CGRect.zero
        for _ in 0..<60 {
            try await Task.sleep(nanoseconds: 50_000_000)
            let frame = chat.model.agentCardFrames[id] ?? .zero
            if frame == last && frame != .zero && (toggle.isEmpty || frame.height != before.height) { break }
            last = frame
        }
        let reading = NSRect(x: 0, y: 0, width: chat.bounds.width, height: max(1, chat.bounds.height - chat.model.bottomInset))
        let captured = try await captureVisibleRegion(window: window, view: chat, region: reading, recognize: false)
        let frame = chat.model.agentCardFrames[id] ?? .zero
        return ["png": captured["png"] ?? "", "appearance": window.effectiveAppearance.name.rawValue,
                "readingHeight": Double(reading.height), "frame": NSStringFromRect(frame),
                "inView": frame.height > 0 && frame.maxY > 0 && frame.minY < reading.height]
    }
}
