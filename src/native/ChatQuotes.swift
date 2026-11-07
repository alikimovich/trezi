import SwiftUI

/// LKM-555: one excerpt a user message replied to and the comment on it (`SentQuote`).
struct ChatSentQuote: Decodable { let excerpt: String; let comment: String }

/// The replies at the top of the user bubble: each excerpt beside a bar, as the composer's
/// card showed it, with its comment under it. The full excerpt is selectable and its tooltip.
struct ChatSentQuotes: View {
    let quotes: [ChatSentQuote]
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(quotes.enumerated()), id: \.offset) { index, quote in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .top, spacing: 8) {
                        RoundedRectangle(cornerRadius: 1).fill(.secondary).frame(width: 2)
                        Text(quote.excerpt).font(.system(size: 12)).foregroundStyle(.secondary)
                            .lineLimit(4).truncationMode(.tail).textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }.fixedSize(horizontal: false, vertical: true)
                    if !quote.comment.isEmpty {
                        Text(quote.comment).font(ChatTypography.body).lineSpacing(ChatTypography.lineSpacing)
                            .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .help(quote.excerpt)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Reply \(index + 1) of \(quotes.count): quoted \(quote.excerpt)" + (quote.comment.isEmpty ? "" : ". Comment: \(quote.comment)"))
            }
        }
    }
}
