import SwiftUI

/// Shared rhythm for user text and assistant prose, independent of control fonts.
enum ChatTypography {
    static let body = Font.system(size: ChatRichText.fontSize, weight: .regular)
    static let activity = Font.system(size: 11, weight: .regular, design: .monospaced)
    static let lineSpacing: CGFloat = ChatRichText.lineSpacing
    static let paragraphSpacing: CGFloat = ChatRichText.blockSpacing
}

/// An assistant text segment as one selectable text view (LKM-186): SwiftUI selection
/// stops at each Text, so paragraphs, lists, headings, tables and code blocks share one
/// `ChatTextView`. `identity` names it for verification.
struct ChatMarkdown: NSViewRepresentable {
    let source: String
    var streaming = false
    var identity: String? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeNSView(context: Context) -> ChatTextView { ChatTextView.make() }
    func updateNSView(_ view: ChatTextView, context: Context) {
        view.reduceMotion = reduceMotion; view.identity = identity
        view.show(source, streaming: streaming)
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: ChatTextView, context: Context) -> CGSize? {
        nsView.fittingSize(width: proposal.width)
    }
    static func dismantleNSView(_ view: ChatTextView, coordinator: ()) { view.identity = nil }
}
