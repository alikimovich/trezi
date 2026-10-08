import AppKit
import SwiftUI

/// LKM-208: an answer component (`chat_ui`) inside the assistant message that showed it.
/// Options and form send one `chat-ui` action with the answer JSON; Bun checks it again,
/// saves it with the message and sends it as the user's next turn (`chat-actions.ts`).
struct NativeChatUi: View {
    let payload: ChatUiPayload
    /// The message is still streaming: missing images are skeletons, not "No preview".
    let running: Bool
    @ObservedObject var model: ChatModel
    var body: some View {
        Group {
            if let record = payload.record {
                if let options = record.component.options, record.component.kind == "options" {
                    ChatUiOptionsView(record: record, options: options, running: running, model: model)
                } else {
                    ChatUiFormView(record: record, fields: record.component.fields ?? [], model: model)
                }
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Label("This answer component could not be shown", systemImage: "exclamationmark.triangle").font(.system(size: 12, weight: .medium))
                    ForEach(Array(payload.problems.prefix(4).enumerated()), id: \.offset) { _, problem in
                        Text(problem).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
        .background(GeometryReader { geometry in
            Color.clear.preference(key: ChatUiFrames.self, value: [payload.record?.id ?? "invalid":geometry.frame(in: .named("chatScroll"))])
        })
    }
}
struct ChatUiFrames: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) { value.merge(nextValue()) { _, new in new } }
}

private struct ChatUiHeader: View {
    let component: ChatUiComponent
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(component.title).font(.headline).accessibilityAddTraits(.isHeader)
            if let prompt = component.prompt { Text(prompt).font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
        }
    }
}

/// Decoded preview images, so a frame that re-sends the message does not decode again.
enum ChatUiImages {
    private static let cache = NSCache<NSString, NSImage>()
    static func image(_ src: String) -> NSImage? {
        let key = "\(src.count):\(src.hashValue)" as NSString
        if let image = cache.object(forKey: key) { return image }
        guard let data = ChatUiFormat.imageData(src), let image = NSImage(data: data) else { return nil }
        cache.setObject(image, forKey: key)
        return image
    }
}

/// 2–4 variants as tiles; one pick (or "None of these" with what to change) and Apply.
struct ChatUiOptionsView: View {
    let record: ChatUiRecord
    let options: [ChatUiOption]
    let running: Bool
    @ObservedObject var model: ChatModel
    /// The picked option id; "" is "None of these".
    @State private var selected: String?
    @State private var comment = ""
    @State private var sent = false
    private var answered: Bool { record.answer != nil }
    private var picked: String? { record.answer.map { $0.none ? "" : $0.choice ?? "" } ?? selected }
    private var ready: Bool {
        guard let selected, !sent else { return false }
        return !selected.isEmpty || !comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ChatUiHeader(component: record.component)
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10, alignment: .top), GridItem(.flexible(), spacing: 10, alignment: .top)], alignment: .leading, spacing: 10) {
                ForEach(Array(options.enumerated()), id: \.element.id) { index, option in tile(index, option) }
            }
            if answered { answerLine } else { controls }
        }
        .onChange(of: model.revision) { _ in sent = false }
    }
    private func tile(_ index: Int, _ option: ChatUiOption) -> some View {
        let isPicked = picked == option.id
        return Button { selected = option.id } label: {
            VStack(alignment: .leading, spacing: 6) {
                ChatUiPreview(image: record.images[option.id], missing: record.missing?[option.id], running: running)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(ChatUiFormat.letter(index)).font(.system(size: 11, weight: .bold)).foregroundStyle(isPicked ? Color.accentColor : .secondary)
                    Text(option.title).font(.system(size: 13, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
                }
                Text(option.note).font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if let tags = option.tags, !tags.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(tags, id: \.self) { tag in
                            Text(tag).font(.system(size: 10, weight: .medium)).padding(.horizontal, 6).padding(.vertical, 2)
                                .background(.quaternary, in: Capsule()).lineLimit(1)
                        }
                    }
                }
            }
            .padding(8).frame(maxWidth: .infinity, alignment: .leading).contentShape(RoundedRectangle(cornerRadius: 8))
            .background(Color(nsColor: .controlBackgroundColor).opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(isPicked ? Color.accentColor : Color(nsColor: .separatorColor), lineWidth: isPicked ? 2 : 1))
            .opacity(answered && !isPicked ? 0.55 : 1)
        }
        .buttonStyle(.plain).disabled(answered)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Option \(ChatUiFormat.letter(index)): \(option.title). \(option.note)")
        .accessibilityValue(record.images[option.id] == nil ? "No preview image" : "Has a preview image")
        .accessibilityAddTraits(isPicked ? [.isButton, .isSelected] : .isButton)
        .help(record.images[option.id]?.route.map { "Captured from \($0)" } ?? "")
    }
    private var controls: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle("None of these", isOn: Binding(get: { selected == "" }, set: { selected = $0 ? "" : nil }))
                .toggleStyle(.checkbox).font(.system(size: 12))
            if selected != nil {
                TextField(selected == "" ? "What should change?" : "Comment (optional)", text: $comment, axis: .vertical)
                    .lineLimit(1...4).textFieldStyle(.roundedBorder).font(.system(size: 12))
                    .accessibilityLabel(selected == "" ? "What should change" : "Comment")
            }
            HStack {
                Spacer()
                Button(applyLabel) { send() }.buttonStyle(.borderedProminent).disabled(!ready)
                    .help(selected == "" && !ready ? "Say what to change when none fit." : "")
            }
        }
    }
    private var applyLabel: String {
        guard let selected, let index = options.firstIndex(where: { $0.id == selected }) else { return selected == "" ? "Send" : "Apply" }
        return "Apply option \(ChatUiFormat.letter(index))"
    }
    private var answerLine: some View {
        let answer = record.answer
        let index = options.firstIndex { $0.id == answer?.choice }
        let text = index.map { "Picked option \(ChatUiFormat.letter($0)): \(options[$0].title)" } ?? "None of these"
        return VStack(alignment: .leading, spacing: 2) {
            Label(text, systemImage: "checkmark.circle.fill").font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)
            if let comment = answer?.comment, !comment.isEmpty { Text(comment).font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
        }.accessibilityElement(children: .combine)
    }
    private func send() {
        guard ready, let selected else { return }
        sent = true
        model.action("chat-ui", id: record.id, value: ChatUiFormat.pick(selected.isEmpty ? nil : selected, comment: comment))
    }
}

/// An option's image, its skeleton while the agent may still capture it, or "No preview".
private struct ChatUiPreview: View {
    let image: ChatUiImage?
    let missing: String?
    let running: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 6)
        Color.clear.aspectRatio(16 / 10, contentMode: .fit).frame(maxWidth: .infinity)
            .overlay {
                if let image, let picture = ChatUiImages.image(image.src) {
                    Image(nsImage: picture).resizable().aspectRatio(contentMode: .fill).accessibilityHidden(true)
                } else if missing == nil && running {
                    shape.fill(.quaternary).opacity(pulse ? 0.45 : 1)
                        .onAppear { if !reduceMotion { withAnimation(.easeInOut(duration: 0.9).repeatForever()) { pulse = true } } }
                        .accessibilityLabel("Preview loading")
                } else {
                    ZStack {
                        shape.fill(.quaternary)
                        Label("No preview", systemImage: "photo").font(.caption).foregroundStyle(.secondary)
                    }.help(missing ?? "")
                }
            }
            .clipShape(shape)
    }
}

/// Typed fields and one Submit; read-only values once answered.
struct ChatUiFormView: View {
    let record: ChatUiRecord
    let fields: [ChatUiField]
    @ObservedObject var model: ChatModel
    @State private var state: ChatUiFormState
    @State private var sent = false
    init(record: ChatUiRecord, fields: [ChatUiField], model: ChatModel) {
        self.record = record; self.fields = fields; self.model = model
        _state = State(initialValue: ChatUiFormState(record.component))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ChatUiHeader(component: record.component)
            if let answer = record.answer {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(fields, id: \.id) { field in
                        HStack(alignment: .firstTextBaseline) {
                            Text(field.label).font(.system(size: 12)).foregroundStyle(.secondary)
                            Spacer(minLength: 12)
                            Text(ChatUiFormat.value(answer.values?[field.id], unit: field.unit)).font(.system(size: 12, weight: .medium)).multilineTextAlignment(.trailing)
                        }.accessibilityElement(children: .combine)
                    }
                    Label("Submitted", systemImage: "checkmark.circle.fill").font(.caption).foregroundStyle(.secondary).padding(.top, 4)
                }
            } else {
                ForEach(fields, id: \.id) { field in ChatUiFieldView(field: field, value: binding(field.id)) }
                let problems = state.problems(record.component)
                HStack {
                    if let first = problems.first { Text(first).font(.caption).foregroundStyle(.secondary) }
                    Spacer()
                    Button(record.component.submitLabel ?? "Submit") {
                        sent = true
                        model.action("chat-ui", id: record.id, value: state.answer(record.component))
                    }.buttonStyle(.borderedProminent).disabled(!problems.isEmpty || sent)
                }
            }
        }
        .onChange(of: model.revision) { _ in sent = false }
    }
    private func binding(_ id: String) -> Binding<ChatUiValue?> {
        Binding(get: { state.values[id] }, set: { state.values[id] = $0 })
    }
}

private struct ChatUiFieldView: View {
    let field: ChatUiField
    @Binding var value: ChatUiValue?
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            if field.type != "toggle" {
                Text(field.isRequired ? field.label : "\(field.label) (optional)").font(.system(size: 12, weight: .medium)).accessibilityHidden(true)
            }
            control.accessibilityLabel(field.label).accessibilityHint(field.help ?? "")
            if let help = field.help { Text(help).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).accessibilityHidden(true) }
        }
    }
    @ViewBuilder private var control: some View {
        switch field.type {
        case "choice": choice
        case "text":
            TextField(field.placeholder ?? "", text: text, axis: field.multiline == true ? .vertical : .horizontal)
                .lineLimit(field.multiline == true ? 3...6 : 1...1).textFieldStyle(.roundedBorder)
        case "number":
            HStack {
                TextField(range ?? "", value: number, format: .number).textFieldStyle(.roundedBorder).frame(maxWidth: 140)
                if let unit = field.unit { Text(unit).foregroundStyle(.secondary) }
                if let range { Text(range).font(.caption).foregroundStyle(.tertiary) }
            }
        case "slider":
            let bounds = (field.min ?? 0)...max(field.max ?? 1, (field.min ?? 0) + 1)
            let slider = Binding<Double>(get: { number.wrappedValue ?? bounds.lowerBound }, set: { number.wrappedValue = $0 })
            HStack {
                SnappedSlider(value: slider, bounds: bounds, step: field.step ?? (bounds.upperBound - bounds.lowerBound) / 1000)
                Text(ChatUiFormat.value(.number(slider.wrappedValue), unit: field.unit)).font(.system(size: 12).monospacedDigit()).frame(minWidth: 56, alignment: .trailing)
            }.accessibilityValue(ChatUiFormat.value(.number(slider.wrappedValue), unit: field.unit))
        case "color": ChatUiColorField(field: field, value: text)
        default:
            Toggle(field.label, isOn: Binding(get: { if case .flag(let on)? = value { on } else { false } }, set: { value = .flag($0) }))
                .toggleStyle(.switch).font(.system(size: 12, weight: .medium))
        }
    }
    private var range: String? {
        switch (field.min, field.max) {
        case let (min?, max?): "\(ChatUiFormat.number(min))–\(ChatUiFormat.number(max))"
        case let (min?, nil): "≥ \(ChatUiFormat.number(min))"
        case let (nil, max?): "≤ \(ChatUiFormat.number(max))"
        default: nil
        }
    }
    private var text: Binding<String> {
        Binding(get: { if case .text(let v)? = value { v } else { "" } }, set: { value = $0.isEmpty ? nil : .text($0) })
    }
    private var number: Binding<Double?> {
        Binding(get: { if case .number(let v)? = value { v } else { nil } }, set: { value = $0.map(ChatUiValue.number) })
    }
    @ViewBuilder private var choice: some View {
        let options = field.options ?? []
        if field.multiple == true {
            let picked: [String] = { if case .list(let v)? = value { v } else { [] } }()
            VStack(alignment: .leading, spacing: 4) {
                ForEach(options, id: \.value) { option in
                    Toggle(option.label, isOn: Binding(get: { picked.contains(option.value) }, set: { on in
                        let next = options.map(\.value).filter { $0 == option.value ? on : picked.contains($0) }
                        value = next.isEmpty ? nil : .list(next)
                    })).toggleStyle(.checkbox)
                }
            }
        } else {
            Picker(field.label, selection: Binding(get: { if case .text(let v)? = value { v } else { "" } }, set: { value = .text($0) })) {
                ForEach(options, id: \.value) { option in Text(option.label).tag(option.value) }
            }.pickerStyle(.radioGroup).labelsHidden()
        }
    }
}

/// Token suggestions as swatches, plus any color typed or picked (sent as #rrggbb).
private struct ChatUiColorField: View {
    let field: ChatUiField
    @Binding var value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let suggestions = field.suggestions, !suggestions.isEmpty {
                HStack(spacing: 8) {
                    ForEach(suggestions, id: \.name) { suggestion in
                        let isPicked = value == suggestion.name
                        Button { value = suggestion.name } label: {
                            Circle().fill(Color(nsColor: ChatUiColor.parse(suggestion.value) ?? .clear)).frame(width: 20, height: 20)
                                .overlay(Circle().strokeBorder(isPicked ? Color.accentColor : Color(nsColor: .separatorColor), lineWidth: isPicked ? 2 : 1))
                        }
                        .buttonStyle(.plain).help("\(suggestion.name) \(suggestion.value)")
                        .accessibilityLabel(suggestion.name).accessibilityAddTraits(isPicked ? [.isButton, .isSelected] : .isButton)
                    }
                }
            }
            HStack {
                TextField("Token or #rrggbb", text: $value).textFieldStyle(.roundedBorder).frame(maxWidth: 200)
                ColorPicker("Custom color", selection: Binding(get: { Color(nsColor: swatch ?? .gray) }, set: { value = ChatUiColor.hex(NSColor($0)) }), supportsOpacity: false)
                    .labelsHidden()
            }
        }
    }
    /// The color the value stands for: a suggestion's token or a typed hex value.
    private var swatch: NSColor? {
        ChatUiColor.parse(field.suggestions?.first { $0.name == value }?.value ?? value)
    }
}

extension NativeChat {
    /// Answer components for inspection (LKM-208).
    func inspectChatUi() -> [String: Any] {
        ["chatUi":model.snapshot?.messages.flatMap { message in message.segments.compactMap(\.ui).map { payload -> [String: Any] in
            let record = payload.record
            return ["message":message.id, "id":record?.id ?? "", "kind":record?.component.kind ?? "", "problems":payload.problems,
                    "options":record?.component.options?.map(\.id) ?? [], "fields":record?.component.fields?.map(\.type) ?? [],
                    "images":record?.images.keys.sorted() ?? [], "missing":record?.missing?.keys.sorted() ?? [],
                    "answered":record?.answer != nil, "frame":NSStringFromRect(model.chatUiFrames[record?.id ?? "invalid"] ?? .zero)]
        } } ?? []]
    }
}

/// LKM-208 verification (test profile): the chat showing an answer component in a forced
/// light or dark window appearance, captured in the foreground. Like `verifyAgentCard`, the
/// appearance is the window's own; system settings are never touched.
extension Host {
    @MainActor
    func verifyChatUi(_ c: [String: Any]) async throws -> [String: Any] {
        if c["restore"] as? Bool == true { window.appearance = nil; return [:] }
        if let dark = c["dark"] as? Bool { window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua) }
        // Not `id`: the bridge stamps its request id there.
        let id = c["component"] as? String ?? ""
        chat.model.pressLatest()
        var last = CGRect.zero
        for _ in 0..<60 {
            try await Task.sleep(nanoseconds: 50_000_000)
            let frame = chat.model.chatUiFrames[id] ?? .zero
            if frame == last && frame != .zero { break }
            last = frame
        }
        let reading = NSRect(x: 0, y: 0, width: chat.bounds.width, height: max(1, chat.bounds.height - chat.model.bottomInset))
        let captured = try await captureVisibleRegion(window: window, view: chat, region: reading, recognize: false)
        let frame = chat.model.chatUiFrames[id] ?? .zero
        return ["png": captured["png"] ?? "", "appearance": window.effectiveAppearance.name.rawValue,
                "readingHeight": Double(reading.height), "frame": NSStringFromRect(frame),
                "inView": frame.height > 0 && frame.minY >= -1 && frame.maxY <= reading.height + 1]
    }
}

enum ChatUiColor {
    static func parse(_ text: String) -> NSColor? {
        var hex = text.trimmingCharacters(in: .whitespaces)
        guard hex.hasPrefix("#") else { return nil }
        hex.removeFirst()
        if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
        guard hex.count == 6 || hex.count == 8, let raw = UInt64(hex, radix: 16) else { return nil }
        let rgba = hex.count == 6 ? raw << 8 | 0xff : raw
        func channel(_ shift: UInt64) -> CGFloat { CGFloat((rgba >> shift) & 0xff) / 255 }
        return NSColor(srgbRed: channel(24), green: channel(16), blue: channel(8), alpha: channel(0))
    }
    static func hex(_ color: NSColor) -> String {
        guard let rgb = color.usingColorSpace(.sRGB) else { return "#000000" }
        func byte(_ value: CGFloat) -> Int { Int((min(1, max(0, value)) * 255).rounded()) }
        return String(format: "#%02x%02x%02x", byte(rgb.redComponent), byte(rgb.greenComponent), byte(rgb.blueComponent))
    }
}
