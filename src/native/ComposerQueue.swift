import AppKit
import SwiftUI

struct QueuedComposerMessage: Decodable, Identifiable {
    let id: String
    let text: String
    let attachments: Int
    let chatUiId: String?
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

/// How a newly queued message appears (LKM-294): it fades in while rising `rise` pt into
/// place. With Reduce Motion it only fades.
struct ComposerQueueMotion: Equatable {
    let rise: CGFloat
    let duration: Double
    init(reduceMotion: Bool) { rise = reduceMotion ? 0 : 8; duration = reduceMotion ? 0.15 : 0.24 }
    var animation: Animation { .easeOut(duration: duration) }
    var dictionary: [String: Any] { ["rise": Double(rise), "duration": duration] }
    /// The ids in `next` that were not queued before while the same chat stayed shown; only
    /// these animate. Another chat's queue, or the first one shown, appears without motion.
    static func inserted(previous: [String], next: [String], sameChat: Bool) -> [String] {
        guard sameChat else { return [] }
        let known = Set(previous)
        return next.filter { !known.contains($0) }
    }
}

/// What the queue shows. The host changes it in place instead of replacing its root view, so
/// each row keeps its identity (`message.id`) across updates (LKM-294).
final class ComposerQueueModel: ObservableObject {
    @Published var messages: [QueuedComposerMessage] = []
    @Published var paused = false
    /// Why the queue is not sending yet, including an answer waiting for a provider turn.
    @Published var note = ""
    @Published var canSend = true
    @Published var motion = ComposerQueueMotion(reduceMotion: false)
    /// Ids whose row has not appeared yet and enters with motion. Not published: a row reads it
    /// once when it is created and consumes it when it appears, so a remount never replays.
    var entering: Set<String> = []
}

/// A row's own appearance: it starts transparent and `rise` pt low, then settles. The change is
/// the row's own `@State`, so its animation covers only this row's opacity and offset. Layout,
/// and every other row, never sit in an animated transaction (LKM-294).
private struct ComposerQueueEntrance: ViewModifier {
    let id: String
    let motion: ComposerQueueMotion
    let consume: (String) -> Void
    @State private var shown: Bool
    init(id: String, entering: Bool, motion: ComposerQueueMotion, consume: @escaping (String) -> Void) {
        self.id = id; self.motion = motion; self.consume = consume
        _shown = State(initialValue: !entering)
    }
    func body(content: Content) -> some View {
        content.opacity(shown ? 1 : 0).offset(y: shown ? 0 : motion.rise)
            .onAppear {
                consume(id)
                guard !shown else { return }
                withAnimation(motion.animation) { shown = true }
            }
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
    /// Each message is its own card, `cardInset` inside the box's sides (LKM-294).
    static let cardInset: CGFloat = 4, cardRadius: CGFloat = 8
    /// The composer's placeholder starts 19 pt in: 12 pt scroll inset plus its 7 pt draw origin.
    static let textInset: CGFloat = 19 - inset
    /// Trailing buttons take the send button's 30 pt column.
    static let control: CGFloat = 30
    static let visibleRows = 3
    /// A light card on the box's material: near-white in light mode, a faint white wash in dark.
    static let cardFill = Color(nsColor: NSColor(name: nil) {
        $0.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? .white.withAlphaComponent(0.09) : .white.withAlphaComponent(0.88)
    })

    @ObservedObject var model: ComposerQueueModel
    var measured: ([String: CGRect]) -> Void = { _ in }
    let action: (String, String?) -> Void
    private var paused: Bool { model.paused }
    private var note: String { model.note }
    private var canSend: Bool { model.canSend }
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
                        ForEach(Array(model.messages.enumerated()), id: \.element.id) { index, message in
                            row(message, index: index).modifier(ComposerQueueEntrance(
                                id: message.id, entering: model.entering.contains(message.id), motion: model.motion,
                                consume: { model.entering.remove($0) }))
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
                    Text((message.chatUiId == nil ? "" : "Answer queued · ") + message.label.replacingOccurrences(of: "\n", with: " "))
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
        .background { card }
        .help(message.label)
    }
    /// Draws inside the row, so the row frames, text inset and control column stay as measured.
    private var card: some View {
        let shape = RoundedRectangle(cornerRadius: Self.cardRadius, style: .continuous)
        return shape.fill(Self.cardFill)
            .overlay { shape.strokeBorder(Color(nsColor: .separatorColor), lineWidth: 0.5) }
            .shadow(color: .black.opacity(0.06), radius: 1, y: 0.5)
            .padding(.horizontal, Self.cardInset)
    }
    private func controlLabel(_ symbol: String) -> some View {
        Image(systemName: symbol).frame(width: Self.control, height: Self.rowHeight).contentShape(Rectangle())
    }
    /// The reason row shows for a paused queue and for any queue with a note.
    static func hasHeader(paused: Bool, note: String) -> Bool { paused || !note.isEmpty }
}

final class ComposerQueueHost: NSHostingView<AnyView> {
    private var signature = Data()
    private let model = ComposerQueueModel()
    private var chat: String?
    var action: ((String, String?) -> Void)?
    private(set) var count = 0
    /// Row, text and control frames from the last SwiftUI pass, top-left origin in this view.
    private(set) var frames: [String: CGRect] = [:]
    /// Updates that animated a message in, and the ids the latest update animated.
    private(set) var insertions = 0
    private(set) var lastInserted: [String] = []
    /// The ids of the latest insertion; unlike `lastInserted`, a later unrelated update keeps it.
    private(set) var lastInsertion: [String] = []
    /// Test-only Reduce Motion; nil follows macOS (or the chat acceptance override).
    var reduceMotionOverride: Bool?
    var reduceMotion: Bool { reduceMotionOverride ?? ChatSystemEnvironment.shared.accessibility.reduceMotion }
    /// The visible part, above the composer: padding, the note line and up to three rows.
    static func height(count: Int, paused: Bool, note: String = "") -> CGFloat {
        guard count > 0 else { return 0 }
        let lines = min(count, ComposerQueue.visibleRows) + (ComposerQueue.hasHeader(paused: paused, note: note) ? 1 : 0)
        return 2 * ComposerQueue.padding + CGFloat(lines) * ComposerQueue.rowHeight + CGFloat(lines - 1) * ComposerQueue.spacing
    }
    init() {
        super.init(rootView: AnyView(EmptyView())); sizingOptions = []; isHidden = true
        rootView = AnyView(ComposerQueue(model: model, measured: { [weak self] in self?.frames = $0 }) { [weak self] name, id in self?.action?(name, id) })
    }
    required init(rootView: AnyView) { fatalError("init(rootView:) has not been implemented") }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    /// Only messages newly queued in the shown chat animate; a note, pause or canSend change,
    /// a removal or another chat's queue changes the rows without motion (LKM-294).
    func update(_ entries: [[String: Any]], paused: Bool, note: String = "", canSend: Bool = true, chat: String = "") {
        let data = (try? JSONSerialization.data(withJSONObject: ["entries": entries, "paused": paused, "note": note, "canSend": canSend, "chat": chat], options: [.sortedKeys])) ?? Data()
        guard data != signature else { return }
        signature = data
        let items = (try? JSONSerialization.data(withJSONObject: entries)).flatMap { try? JSONDecoder().decode([QueuedComposerMessage].self, from: $0) } ?? []
        lastInserted = ComposerQueueMotion.inserted(previous: model.messages.map(\.id), next: items.map(\.id), sameChat: chat == self.chat)
        self.chat = chat
        count = items.count; isHidden = items.isEmpty
        model.paused = paused; model.note = note; model.canSend = canSend
        model.motion = ComposerQueueMotion(reduceMotion: reduceMotion)
        // The list itself never animates: a row that is already shown keeps its width and opacity.
        // A new row animates its own appearance (`ComposerQueueEntrance`).
        model.entering = Set(lastInserted)
        if !lastInserted.isEmpty { insertions += 1; lastInsertion = lastInserted }
        var transaction = Transaction(); transaction.disablesAnimations = true
        withTransaction(transaction) { model.messages = items }
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
        return ["visible": Double(frame.maxY - composerTop), "height": Double(frame.height), "header": line("header") ?? NSNull(), "rows": rows,
                "cards": ["inset": Double(ComposerQueue.cardInset), "radius": Double(ComposerQueue.cardRadius)],
                "motion": model.motion.dictionary.merging(["insertions": insertions, "lastInserted": lastInserted, "lastInsertion": lastInsertion, "reduceMotion": reduceMotion]) { _, new in new }]
    }
    /// Test-only: waits for the insertion after `after`, then captures `view` `shots` times,
    /// `interval` seconds apart, with the rows' measured frames at each capture.
    func captureInsertion(of view: NSView, after: Int, shots: Int, interval: Double) async throws -> [[String: Any]] {
        let start = Date()
        while insertions <= after {
            guard Date().timeIntervalSince(start) < 5 else { throw NSError(domain: "Trezi", code: 1, userInfo: [NSLocalizedDescriptionKey: "No queue insertion after \(after)"]) }
            try await Task.sleep(nanoseconds: 4_000_000)
        }
        let inserted = Date()
        var captures: [[String: Any]] = []
        for _ in 0..<max(1, min(shots, 30)) {
            view.layoutSubtreeIfNeeded()
            guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { break }
            view.cacheDisplay(in: view.bounds, to: bitmap)
            captures.append(["ms": Date().timeIntervalSince(inserted) * 1000, "png": bitmap.representation(using: .png, properties: [:])?.base64EncodedString() ?? "",
                             "rows": (0..<count).compactMap { frames["row-\($0)"].map { Double($0.minY) } }])
            try await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
        }
        return captures
    }
}
