import SwiftUI

/// A comment agent's result (LKM-178, `NativeChatMessage.comment`), or a turn Trezi wrote
/// itself (LKM-600, `NativeChatMessage.action`): same title, line and expandable detail.
struct ChatComment: Decodable { let title: String; let line: String; let detail: String }

/// One collapsed line, "Comment applied: <the comment>", in a bubble lighter than the
/// user's. A click (on the line or its chevron) shows the summary and the result's
/// actions; a second click collapses it. Expansion is per message, for the session.
struct ChatCommentRow: View {
    let message: ChatMessage
    let comment: ChatComment
    @ObservedObject var model: ChatModel
    /// The chat bubble radius (the user bubble in NativeMessageRow).
    static let cornerRadius: CGFloat = 14
    private var expanded: Bool { model.expandedComments.contains(message.id) }
    private var summary: String { comment.line.isEmpty ? comment.title : "\(comment.title): \(comment.line)" }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { model.toggleComment(message.id) } label: {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                    headline.font(ChatTypography.body).lineLimit(1).truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }.contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(summary)
            .accessibilityLabel(summary)
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            .accessibilityHint(expanded ? "Hides the summary" : "Shows the summary")
            if expanded {
                if !comment.detail.isEmpty { ChatMarkdown(source: comment.detail) }
                HStack {
                    // LKM-600: an app-written turn copies the exact instruction it sent.
                    let copy = message.action == nil ? "Copy result" : "Copy instruction"
                    Button { copyChatText(message.text) } label: { Image(systemName: "doc.on.doc") }
                        .help(copy).accessibilityLabel(copy)
                    if message.revertGroup != nil {
                        Button { model.action("revert", id: message.id) } label: { Image(systemName: "arrow.uturn.backward") }
                            .help("Revert this comment's edits").accessibilityLabel("Revert this comment's edits")
                    }
                }.buttonStyle(ChatActionButtonStyle())
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        // The user bubble's semantic fill at half strength: lighter in both appearances.
        .background { RoundedRectangle(cornerRadius: Self.cornerRadius).fill(.quaternary.opacity(0.5)) }
        .help(messageTime(message.at))
    }
    private var headline: Text {
        comment.line.isEmpty ? Text(comment.title).fontWeight(.medium)
            : Text(comment.title + ": ").fontWeight(.medium) + Text(comment.line).foregroundColor(.secondary)
    }
}
