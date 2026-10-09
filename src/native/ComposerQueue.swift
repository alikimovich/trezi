import AppKit
import SwiftUI

struct QueuedComposerMessage: Decodable, Identifiable {
    let id: String
    let text: String
    let attachments: Int
    var label: String { text.isEmpty ? "\(attachments) attachment\(attachments == 1 ? "" : "s")" : text }
    var url: URL? {
        guard let url = URL(string: text), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil,
              !text.contains(where: { $0.isWhitespace }) else { return nil }
        return url
    }
}

/// Frames of the queue's rows and texts in the box's own space, for the smoke geometry check.
private struct QueueFrames: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) { value.merge(nextValue()) { _, new in new } }
}
private extension View {
    func queueFrame(_ key: String) -> some View {
        background(GeometryReader { Color.clear.preference(key: QueueFrames.self, value: [key: $0.frame(in: .named("queue"))]) })
    }
}

struct ComposerQueue: View {
    /// The box sits `inset` inside the composer's sides, so its trailing edge meets the send
    /// button's, and tucks `overlap` (the composer's corner radius) under the composer at every
    /// row count, so its lower corners never show (LKM-198).
    static let inset: CGFloat = 10, overlap: CGFloat = 24, radius: CGFloat = 18
    /// The note line and each row are `rowHeight` tall with their content centred, `spacing`
    /// apart, with `padding` above the first and below the last in the visible part.
    static let rowHeight: CGFloat = 24, spacing: CGFloat = 4, padding: CGFloat = 10
    /// The composer's placeholder starts 19 pt in: 12 pt scroll inset plus its 7 pt draw origin.
    static let textInset: CGFloat = 19 - inset
    /// Trailing buttons take the send button's 30 pt column.
    static let control: CGFloat = 30
    static let visibleRows = 3

    let messages: [QueuedComposerMessage]
    let paused: Bool
    /// Why the queue is not sending yet (LKM-151 paused, LKM-169 Resolve or sign-in; a
    /// running turn or a landing has none, LKM-191), and whether a paused queue can be sent now.
    var note = ""
    var canSend = true
    var measured: ([String: CGRect]) -> Void = { _ in }
    let action: (String, String?) -> Void
    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: Self.spacing) {
                if ComposerQueue.hasHeader(paused: paused, note: note) {
                    HStack(spacing: 8) {
                        Text(note.isEmpty ? "Paused — these won't send until you choose" : note)
                            .foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .help(note)
                        if paused {
                            Button("Send now") { action("queue-resume", nil) }.buttonStyle(.plain).disabled(!canSend)
                                .help(canSend ? "Send the queued messages now" : note)
                        }
                    }
                    .font(.system(size: 11)).padding(.leading, Self.textInset).padding(.trailing, Self.textInset)
                    .frame(height: Self.rowHeight).queueFrame("header")
                }
                ScrollView {
                    VStack(spacing: Self.spacing) {
                        ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                            row(message, index: index)
                        }
                    }
                }.scrollIndicators(.automatic)
            }
            .padding(.vertical, Self.padding)
            // The composer covers this strip, its lower corners included.
            Color.clear.frame(height: Self.overlap)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: Self.radius))
        .overlay { RoundedRectangle(cornerRadius: Self.radius).strokeBorder(Color(nsColor: .separatorColor).opacity(0.45), lineWidth: 0.5) }
        .coordinateSpace(name: "queue")
        .onPreferenceChange(QueueFrames.self) { measured($0) }
    }
    private func row(_ message: QueuedComposerMessage, index: Int) -> some View {
        HStack(spacing: 0) {
            HStack(spacing: 8) {
                if let url = message.url {
                    Image(systemName: "globe").foregroundStyle(.secondary).accessibilityHidden(true)
                    Link(destination: url) {
                        Text(message.label).lineLimit(1).truncationMode(.middle)
                            .foregroundStyle(Color(nsColor: .linkColor)).queueFrame("text-\(index)")
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }.buttonStyle(.plain)
                } else {
                    Text(message.label.replacingOccurrences(of: "\n", with: " "))
                        .lineLimit(1).truncationMode(.tail).queueFrame("text-\(index)")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if message.attachments > 0 && !message.text.isEmpty {
                    Label("\(message.attachments)", systemImage: "paperclip").font(.system(size: 10)).foregroundStyle(.secondary)
                }
            }
            Button { action("queue-edit", message.id) } label: { controlLabel("pencil") }
                .buttonStyle(.plain).foregroundStyle(.secondary)
                .help("Edit queued message").accessibilityLabel("Edit queued message: \(message.label)")
            Button { action("queue-remove", message.id) } label: { controlLabel("trash") }
                .buttonStyle(.plain).foregroundStyle(.secondary)
                .help("Remove queued message").accessibilityLabel("Remove queued message: \(message.label)")
            Menu {
                Button("Edit message") { action("queue-edit", message.id) }
                Button("Copy message") { copyChatText(message.text) }.disabled(message.text.isEmpty)
                Button("Remove from queue") { action("queue-remove", message.id) }
            } label: { Image(systemName: "ellipsis") }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .frame(width: Self.control, height: Self.rowHeight).queueFrame("more-\(index)")
                .help("Queued message actions").accessibilityLabel("Queued message actions")
        }
        .font(.system(size: 13)).padding(.leading, Self.textInset)
        .frame(height: Self.rowHeight).queueFrame("row-\(index)")
        .help(message.label)
    }
    private func controlLabel(_ symbol: String) -> some View {
        Image(systemName: symbol).frame(width: Self.control, height: Self.rowHeight).contentShape(Rectangle())
    }
    /// The reason row shows for a paused queue and for any queue with a note.
    static func hasHeader(paused: Bool, note: String) -> Bool { paused || !note.isEmpty }
}

final class ComposerQueueHost: NSHostingView<AnyView> {
    private var signature = Data()
    var action: ((String, String?) -> Void)?
    private(set) var count = 0
    /// Row, text and control frames from the last SwiftUI pass, top-left origin in this view.
    private(set) var frames: [String: CGRect] = [:]
    /// The visible part, above the composer: padding, the note line and up to three rows.
    static func height(count: Int, paused: Bool, note: String = "") -> CGFloat {
        guard count > 0 else { return 0 }
        let lines = min(count, ComposerQueue.visibleRows) + (ComposerQueue.hasHeader(paused: paused, note: note) ? 1 : 0)
        return 2 * ComposerQueue.padding + CGFloat(lines) * ComposerQueue.rowHeight + CGFloat(lines - 1) * ComposerQueue.spacing
    }
    init() { super.init(rootView: AnyView(EmptyView())); sizingOptions = []; isHidden = true }
    required init(rootView: AnyView) { fatalError("init(rootView:) has not been implemented") }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func update(_ entries: [[String: Any]], paused: Bool, note: String = "", canSend: Bool = true) {
        let data = (try? JSONSerialization.data(withJSONObject: ["entries": entries, "paused": paused, "note": note, "canSend": canSend], options: [.sortedKeys])) ?? Data()
        guard data != signature else { return }
        signature = data
        let items = (try? JSONSerialization.data(withJSONObject: entries)).flatMap { try? JSONDecoder().decode([QueuedComposerMessage].self, from: $0) } ?? []
        count = items.count; isHidden = items.isEmpty; frames = [:]
        rootView = items.isEmpty ? AnyView(EmptyView()) : AnyView(ComposerQueue(messages: items, paused: paused, note: note, canSend: canSend,
            measured: { [weak self] in self?.frames = $0 }) { [weak self] name, id in self?.action?(name, id) })
    }
    /// Measured layout for the smoke check: `top`/`bottom` count down from this view's top edge,
    /// `visible` is the part above the composer, and x values are in the superview's space.
    func inspect(composerTop: CGFloat) -> [String: Any] {
        func line(_ key: String) -> [String: Double]? {
            frames[key].map { ["top": Double($0.minY), "bottom": Double($0.maxY), "midY": Double($0.midY), "minX": Double(frame.minX + $0.minX), "midX": Double(frame.minX + $0.midX)] }
        }
        var rows: [[String: Any]] = []
        for index in 0..<count {
            guard let row = line("row-\(index)") else { continue }
            rows.append(["row": row, "text": line("text-\(index)") ?? [:], "more": line("more-\(index)") ?? [:]])
        }
        return ["visible": Double(frame.maxY - composerTop), "height": Double(frame.height), "header": line("header") ?? NSNull(), "rows": rows]
    }
}
