import SwiftUI

/// What changed in the live checkout during a turn that Trezi did not do (LKM-215,
/// `NativeChatMessage.liveChange`): the agent's own direct writes, or the user's editor.
struct ChatLiveChange: Decodable { let line: String; let detail: String; let agent: Bool }

/// One compact row: a symbol, the line and Details, which shows the files, the commits
/// and what they mean. The agent's own writes are a warning; anything else is a note.
/// Expansion is per message, for the session (shared with comment rows).
struct ChatLiveChangeRow: View {
    let message: ChatMessage
    let change: ChatLiveChange
    @ObservedObject var model: ChatModel
    private var expanded: Bool { model.expandedComments.contains(message.id) }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: change.agent ? "exclamationmark.triangle" : "info.circle")
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(change.agent ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                    .accessibilityLabel(change.agent ? "Warning" : "Note")
                Text(change.line).font(ChatTypography.body).lineLimit(1).truncationMode(.middle).help(change.line)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button(expanded ? "Hide details" : "Details") { model.toggleComment(message.id) }
                    .buttonStyle(.link).controlSize(.small)
                    .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            }
            if expanded { ChatMarkdown(source: change.detail) }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background { RoundedRectangle(cornerRadius: ChatCommentRow.cornerRadius).fill(.quaternary.opacity(0.5)) }
        .accessibilityElement(children: .contain)
        .help(messageTime(message.at))
    }
}
