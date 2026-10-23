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

/// One frosted panel behind and above the composer (LKM-302). Rows are flat lines on the
/// panel, told apart by their height and a hairline between them; no row has its own fill,
/// border or shadow.
struct ComposerQueue: View {
    /// The panel sits `inset` inside the composer's sides, so its trailing edge meets the send
    /// button's, and tucks `overlap` (the composer's corner radius) under the composer at every
    /// row count, so its lower corners never show (LKM-198).
    static let inset: CGFloat = 10, overlap: CGFloat = 24, radius: CGFloat = 18
    /// The header and each row are `rowHeight` tall with their content centred and no gap,
    /// with `padding` above the first and below the last line in the visible part.
    static let rowHeight: CGFloat = 28, padding: CGFloat = 8
    /// The leading glyph takes the + button's 30 pt column and the trailing buttons Send's,
    /// so the panel's columns line up with the composer's controls below it.
    static let control: CGFloat = 30
    /// Text starts `textGap` after the glyph column.
    static let textGap: CGFloat = 4
    static var textX: CGFloat { control + textGap }
    /// The header's divider is `ruleInset` in from both panel edges; a row's separator spans the
    /// panel's full width, under the glyph and the buttons too (LKM-318).
    static let ruleInset: CGFloat = 12, rule: CGFloat = 0.5
    static let visibleRows = 3
    /// A faint rim that keeps the frosted panel's edge legible on a light or dark chat.
    static let rim = Color(nsColor: NSColor(name: nil) {
        $0.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? .white.withAlphaComponent(0.12) : .black.withAlphaComponent(0.08)
    })

    @ObservedObject var model: ComposerQueueModel
    var measured: ([String: CGRect]) -> Void = { _ in }
    let action: (String, String?) -> Void
    private var paused: Bool { model.paused }
    private var note: String { model.note }
    private var canSend: Bool { model.canSend }
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Self.radius, style: .continuous)
        VStack(spacing: 0) {
            VStack(spacing: 0) {
                if ComposerQueue.hasHeader(paused: paused, note: note) { header }
                ScrollView {
                    VStack(spacing: 0) {
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
        .background(.thinMaterial, in: shape)
        .overlay { shape.strokeBorder(Self.rim, lineWidth: Self.rule) }
        .coordinateSpace(name: "queue")
        .onPreferenceChange(QueueFrames.self) { measured($0) }
    }
    /// Why the queue waits: a pause glyph and Send now when paused, otherwise the note.
    private var header: some View {
        HStack(spacing: 0) {
            glyph(paused ? "pause.circle" : "clock").queueFrame("header-glyph")
            Text(note.isEmpty ? "Paused — these won't send until you choose" : note)
                .foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                .padding(.leading, Self.textGap).frame(maxWidth: .infinity, alignment: .leading)
                .help(note)
            if paused {
                Button { action("queue-resume", nil) } label: {
                    Text("Send now").padding(.horizontal, 8).frame(height: Self.rowHeight).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!canSend).queueFrame("resume")
                .help(canSend ? "Send the queued messages now" : note)
            }
        }
        .font(.system(size: 12)).padding(.trailing, paused ? 4 : Self.ruleInset)
        .frame(height: Self.rowHeight)
        .overlay(alignment: .bottom) {
            hairline.padding(.horizontal, Self.ruleInset).queueFrame("divider")
        }
        .queueFrame("header")
    }
    private func row(_ message: QueuedComposerMessage, index: Int) -> some View {
        HStack(spacing: 0) {
            glyph(message.url == nil ? "arrow.turn.down.right" : "globe").queueFrame("glyph-\(index)")
            HStack(spacing: 8) {
                if let url = message.url {
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
            }.padding(.leading, Self.textGap)
            Button { action("queue-edit", message.id) } label: { controlLabel("pencil") }
                .buttonStyle(.plain).foregroundStyle(.secondary).queueFrame("edit-\(index)")
                .help("Edit queued message").accessibilityLabel("Edit queued message: \(message.label)")
            Button { action("queue-remove", message.id) } label: { controlLabel("trash") }
                .buttonStyle(.plain).foregroundStyle(.secondary).queueFrame("remove-\(index)")
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
        .font(.system(size: 13))
        .frame(height: Self.rowHeight)
        .overlay(alignment: .top) {
            // A hairline above every row but the first, from the panel's leading to its trailing edge.
            if index > 0 {
                hairline.queueFrame("separator-\(index)")
            }
        }
        .queueFrame("row-\(index)")
        .help(message.label)
    }
    private func glyph(_ symbol: String) -> some View {
        Image(systemName: symbol).font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
            .frame(width: Self.control, height: Self.rowHeight).accessibilityHidden(true)
    }
    private var hairline: some View {
        Rectangle().fill(Color(nsColor: .separatorColor)).frame(height: Self.rule)
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
    /// The visible part, above the composer: padding, the header and up to three rows.
    static func height(count: Int, paused: Bool, note: String = "") -> CGFloat {
        guard count > 0 else { return 0 }
        let lines = min(count, ComposerQueue.visibleRows) + (ComposerQueue.hasHeader(paused: paused, note: note) ? 1 : 0)
        return 2 * ComposerQueue.padding + CGFloat(lines) * ComposerQueue.rowHeight
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
            frames[key].map { ["top": Double($0.minY), "bottom": Double($0.maxY), "midY": Double($0.midY), "minX": Double(frame.minX + $0.minX),
                               "midX": Double(frame.minX + $0.midX), "maxX": Double(frame.minX + $0.maxX), "width": Double($0.width), "height": Double($0.height)] }
        }
        var rows: [[String: Any]] = []
        for index in 0..<count {
            guard let row = line("row-\(index)") else { continue }
            var measured: [String: Any] = ["row": row]
            for part in ["text", "glyph", "edit", "remove", "more", "separator"] { measured[part] = line("\(part)-\(index)") ?? NSNull() }
            rows.append(measured)
        }
        // LKM-302: one panel; its edges and columns in the superview's x, rows as measured.
        let panel: [String: Any] = ["minX": Double(frame.minX), "maxX": Double(frame.maxX), "radius": Double(ComposerQueue.radius),
                                    "textX": Double(frame.minX + ComposerQueue.textX), "ruleInset": Double(ComposerQueue.ruleInset), "rule": Double(ComposerQueue.rule)]
        var header: Any = NSNull()
        if let measured = line("header") {
            header = ["frame": measured, "glyph": line("header-glyph") ?? NSNull(), "divider": line("divider") ?? NSNull(),
                      "resume": line("resume") ?? NSNull(), "paused": model.paused]
        }
        return ["visible": Double(frame.maxY - composerTop), "height": Double(frame.height), "hidden": isHidden, "panel": panel, "header": header, "rows": rows,
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
