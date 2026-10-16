import AppKit
import SwiftUI

struct InspectorToken: Decodable, Identifiable { let id: String; let label: String }
struct InspectorField: Decodable, Identifiable {
    let id: String, label: String, group: String, kind: String, value: String
    let disabled: Bool?, detail: String?, options: [String]?, min: Double?, max: Double?, step: Double?, unit: String?, tokens: [InspectorToken]?, reset: Bool?
    let layout: String?, axis: String?, mixed: Bool?, expanded: Bool?
}
struct InspectorAction: Decodable, Identifiable { let id: String; let label: String }
struct InspectorNotice: Decodable { let title: String; let reason: String; let editable: Bool }
struct InspectorState: Decodable { let root: String; let generation: Int; let visible: Bool; let title: String; let tab: String; let fields: [InspectorField]; let actions: [InspectorAction]; let error: String; let busy: Bool; let notice: InspectorNotice?; let updated: Int?; let edits: Int? }
final class InspectorModel: ObservableObject {
    @Published var state: InspectorState?
    /// LKM-216: a re-read after a source/CSS change altered the same selection's values;
    /// the island plays a brief "Updated" pulse instead of rebuilding its fields.
    @Published var pulse = false
    private(set) var pulses = 0
    private var pulseEnd: DispatchWorkItem?
    func show(_ next: InspectorState) {
        let previous = state; state = next
        guard let previous, previous.root == next.root, previous.generation == next.generation, (next.updated ?? 0) > (previous.updated ?? 0) else { return }
        pulses += 1; pulseEnd?.cancel()
        withAnimation(.easeOut(duration: 0.15)) { pulse = true }
        let end = DispatchWorkItem { [weak self] in withAnimation(.easeIn(duration: 0.35)) { self?.pulse = false } }
        pulseEnd = end; DispatchQueue.main.asyncAfter(deadline: .now() + 0.9, execute: end)
    }
    func send(_ action: String, field: String? = nil, value: String? = nil) {
        guard let state else { return }
        var message: [String: Any] = ["event":"inspector-action", "root":state.root, "generation":state.generation, "action":action]
        if let field { message["field"] = field }; if let value { message["value"] = value }; emit(message)
    }
}
struct InspectorFieldView: View {
    let field: InspectorField
    @ObservedObject var model: InspectorModel
    @State var value: String = ""
    @FocusState var focused: Bool
    func apply() { model.send("apply", field: field.id, value: value) }
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(field.label).font(.system(size: 11, weight: .medium))
                Spacer()
                if let unit = field.unit, !unit.isEmpty { Text(unit).foregroundStyle(.secondary).font(.caption) }
                if let tokens = field.tokens, !tokens.isEmpty {
                    Menu { ForEach(tokens) { token in Button(token.label) { model.send("token", field: field.id, value: token.id) } } } label: { Image(systemName: "swatchpalette") }.menuStyle(.borderlessButton).fixedSize().help("Choose design token")
                }
                if field.reset == true { Button { model.send("reset", field: field.id) } label: { Image(systemName: "arrow.counterclockwise") }.buttonStyle(.plain).help("Reset to default") }
            }
            if field.kind == "action" { Button(field.label) { model.send(field.value) } }
            else if field.kind == "multiline" { TextEditor(text: $value).font(.system(size: 12)).frame(minHeight: 80).focused($focused).accessibilityLabel(field.label) }
            else if field.kind == "readonly" { Text(field.value).textSelection(.enabled).font(.system(size: 11)).foregroundStyle(.secondary) }
            else if field.kind == "toggle" {
                Toggle(field.label, isOn: Binding(get: { value == "true" }, set: { value = String($0); apply() })).labelsHidden().toggleStyle(.checkbox)
            } else if field.kind == "select" {
                Picker(field.label, selection: Binding(get: { value }, set: { value = $0; apply() })) {
                    if !(field.options ?? []).contains(value) { Text(value.isEmpty ? "Default" : value).tag(value) }
                    ForEach(field.options ?? [], id: \.self) { Text($0).tag($0) }
                }.labelsHidden()
            } else {
                HStack {
                    TextField(field.label, text: $value).textFieldStyle(.roundedBorder).focused($focused).onSubmit { apply() }
                    if field.kind == "color" {
                        ColorPicker("Color", selection: Binding(get: { Color(nsColor: editorColor(value)) }, set: { color in let c = NSColor(color).usingColorSpace(.deviceRGB) ?? .black; value = String(format: "rgba(%d, %d, %d, %.3f)", Int(c.redComponent * 255), Int(c.greenComponent * 255), Int(c.blueComponent * 255), c.alphaComponent); model.send("preview", field: field.id, value: value) })).labelsHidden()
                    }
                    Button { apply() } label: { Image(systemName: "checkmark") }.buttonStyle(.borderless).accessibilityLabel("Apply " + field.label).help("Apply value")
                }
                if field.kind == "number", let minimum = field.min, let maximum = field.max, maximum > minimum, let number = Double(value) {
                    SnappedSlider(value: Binding(get: { Swift.min(maximum, Swift.max(minimum, Double(value) ?? number)) }, set: { value = String($0); model.send("preview", field: field.id, value: value) }), bounds: minimum...maximum, step: field.step ?? 1, onEditingChanged: { editing in if !editing { apply() } }).accessibilityLabel(field.label)
                }
                if field.kind == "bezier" { NativeBezier(value: $value, preview: { model.send("preview", field: field.id, value: value) }, commit: apply).frame(height: 110) }
            }
            if let detail = field.detail, !detail.isEmpty { Text(detail).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
        }.disabled(field.disabled == true || model.state?.busy == true)
            .onAppear { value = field.value }
            .onChange(of: field.value) { next in if !focused { value = next } }
    }
}
private func editorColor(_ value: String) -> NSColor {
    if value.hasPrefix("#") { var raw = String(value.dropFirst()); if raw.count == 3 { raw = raw.map { "\($0)\($0)" }.joined() }; if let n = UInt64(raw, radix: 16), raw.count == 6 { return NSColor(red: Double((n >> 16) & 255) / 255, green: Double((n >> 8) & 255) / 255, blue: Double(n & 255) / 255, alpha: 1) } }
    if let regex = try? NSRegularExpression(pattern: "[0-9]+(?:\\.[0-9]+)?") { let text = value as NSString; let numbers = regex.matches(in: value, range: NSRange(location: 0, length: text.length)).compactMap { Double(text.substring(with: $0.range)) }; if numbers.count >= 3 { return NSColor(red: numbers[0] / 255, green: numbers[1] / 255, blue: numbers[2] / 255, alpha: numbers.count > 3 ? numbers[3] : 1) } }
    return .black
}
struct NativeBezier: View {
    @Binding var value: String
    let preview: () -> Void, commit: () -> Void
    var points: [Double] {
        let presets: [String: [Double]] = ["linear":[0,0,1,1], "ease":[0.25,0.1,0.25,1], "ease-in":[0.42,0,1,1], "ease-out":[0,0,0.58,1], "ease-in-out":[0.42,0,0.58,1]]
        if let preset = presets[value] { return preset }
        let stripped = value.replacingOccurrences(of: "cubic-bezier(", with: "").replacingOccurrences(of: ")", with: "")
        let values = stripped.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }; return values.count == 4 ? values : [0.25,0.1,0.25,1]
    }
    var body: some View {
        GeometryReader { geometry in
            let size = geometry.size, p = points
            let start = CGPoint(x: 12, y: size.height - 12), end = CGPoint(x: size.width - 12, y: 12)
            let one = CGPoint(x: 12 + p[0] * (size.width - 24), y: size.height - 12 - p[1] * (size.height - 24)), two = CGPoint(x: 12 + p[2] * (size.width - 24), y: size.height - 12 - p[3] * (size.height - 24))
            ZStack {
                RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.04))
                Path { path in path.move(to: start); path.addLine(to: one); path.move(to: end); path.addLine(to: two) }.stroke(Color.secondary.opacity(0.4), lineWidth: 1)
                Path { path in path.move(to: start); path.addCurve(to: end, control1: one, control2: two) }.stroke(Color.accentColor, lineWidth: 2)
                ForEach(0..<2) { index in
                    Circle().fill(Color.accentColor).frame(width: 12, height: 12).position(index == 0 ? one : two)
                        .gesture(DragGesture(coordinateSpace: .named("curve")).onChanged { drag in var next = points; next[index * 2] = min(1, max(0, (drag.location.x - 12) / (size.width - 24))); next[index * 2 + 1] = min(2, max(-1, (size.height - 12 - drag.location.y) / (size.height - 24))); value = "cubic-bezier(" + next.map { String(format: "%.3f", $0) }.joined(separator: ", ") + ")"; preview() }.onEnded { _ in commit() })
                        .accessibilityLabel("Control point \(index + 1); edit coordinates in the field above")
                }
            }.coordinateSpace(name: "curve")
        }
    }
}
/// The tiny "values changed" mark (LKM-216): an accent dot and a caption, never a reload flash.
struct UpdatedPulse: View {
    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(Color.accentColor).frame(width: 6, height: 6)
            Text("Updated").font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
        }.padding(.horizontal, 6).padding(.vertical, 2).background(Capsule().fill(Color.accentColor.opacity(0.12)))
            .padding(.trailing, 12).allowsHitTesting(false).accessibilityLabel("Values updated")
    }
}
private struct CompactLayoutValue: View {
    let field: InspectorField
    @ObservedObject var model: InspectorModel
    @State private var draft = ""
    @State private var submitted = ""
    @State private var cancelling = false
    @FocusState private var focused: Bool
    private var title: String {
        switch field.axis {
        case "horizontal": return "Horizontal"
        case "vertical": return "Vertical"
        case "top": return "Top"
        case "right": return "Right"
        case "bottom": return "Bottom"
        case "left": return "Left"
        default: return field.id == "style:border-radius" ? "Radius" : field.label.capitalized
        }
    }
    private var symbol: String {
        switch field.axis {
        case "horizontal": return "arrow.left.and.right"
        case "vertical": return "arrow.up.and.down"
        case "top": return "arrow.up"
        case "right": return "arrow.right"
        case "bottom": return "arrow.down"
        case "left": return "arrow.left"
        default: return field.id == "style:width" ? "arrow.left.and.right" : field.id == "style:height" ? "arrow.up.and.down" : "circle.dashed"
        }
    }
    private func commit() {
        if draft.isEmpty {
            model.send("cancel-preview", field: field.id)
            return
        }
        guard draft != field.value, draft != submitted else { return }
        submitted = draft
        model.send("apply", field: field.id, value: draft)
    }
    private var bareNumber: Bool {
        draft.range(of: "^-?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)$", options: .regularExpression) != nil
    }
    private func cancel() {
        cancelling = true
        draft = field.value
        submitted = field.value
        focused = false
        model.send("cancel-preview", field: field.id)
    }
    private func increment(_ direction: Double) {
        guard let current = Double(draft), let step = field.step else { return }
        let next = min(field.max ?? .infinity, max(field.min ?? -.infinity, current + direction * step))
        draft = String(format: "%g", next)
        model.send("preview", field: field.id, value: draft)
    }
    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: symbol).font(.system(size: 10)).foregroundStyle(.secondary).frame(width: 13)
                .accessibilityHidden(true)
            TextField(title, text: $draft, prompt: Text(field.mixed == true ? "Mixed" : title))
                .textFieldStyle(.roundedBorder).controlSize(.small).font(.system(size: 11))
                .focused($focused).onSubmit(commit)
                .onChange(of: focused) { next in if !next && !cancelling { commit() }; if next { cancelling = false } }
                .onChange(of: draft) { next in
                    if focused && !cancelling && bareNumber && next != field.value {
                        model.send("preview", field: field.id, value: next)
                    }
                }
                .onMoveCommand { direction in
                    if direction == .up { increment(1) }
                    if direction == .down { increment(-1) }
                }
                .onExitCommand(perform: cancel)
                .accessibilityLabel(title + " " + (field.layout ?? ""))
                .help(field.detail ?? title)
            if let unit = field.unit, !unit.isEmpty, bareNumber {
                Text(unit).font(.system(size: 10)).foregroundStyle(.secondary).fixedSize()
            }
            if let tokens = field.tokens, !tokens.isEmpty {
                Menu { ForEach(tokens) { token in Button(token.label) { model.send("token", field: field.id, value: token.id) } } }
                    label: { Image(systemName: "swatchpalette") }.menuStyle(.borderlessButton).fixedSize()
                    .help("Choose design token for " + title)
            }
        }
        .overlay(alignment: .bottomLeading) {
            if let detail = field.detail, (detail.contains("var(") || detail.contains("calc(")) {
                Text(detail).font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(1)
                    .truncationMode(.middle).help(detail).offset(y: 12)
            }
        }
        .disabled(field.disabled == true || model.state?.busy == true)
        .onAppear { draft = field.value; submitted = field.value }
        .onChange(of: field.value) { next in if !focused { draft = next; submitted = next } }
    }
}

private struct CompactSpacingRow: View {
    let group: String
    let fields: [InspectorField]
    @ObservedObject var model: InspectorModel
    private var expanded: Bool { fields.first?.expanded == true }
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(group.capitalized).font(.system(size: 11, weight: .medium))
                Spacer()
                Button {
                    NSApp.keyWindow?.makeFirstResponder(nil)
                    DispatchQueue.main.async { model.send("spacing:" + group) }
                } label: {
                    FourEdgeInsetIcon().frame(width: 14, height: 14)
                        .frame(width: 24, height: 24)
                        .background(expanded ? Color.accentColor.opacity(0.18) : Color.clear, in: RoundedRectangle(cornerRadius: 5))
                }
                .buttonStyle(.plain).accessibilityLabel(group == "padding" ? "Individual padding" : "Individual margins")
                .accessibilityAddTraits(expanded ? .isSelected : [])
                .help(group == "padding" ? "Edit each padding side" : "Edit each margin side")
            }
            if expanded {
                HStack(alignment: .top, spacing: 6) {
                    VStack(spacing: 5) {
                        ForEach(fields.filter { $0.axis == "right" || $0.axis == "left" }) { field in
                            CompactLayoutValue(field: field, model: model)
                        }
                    }.frame(maxWidth: .infinity)
                    VStack(spacing: 5) {
                        ForEach(fields.filter { $0.axis == "top" || $0.axis == "bottom" }) { field in
                            CompactLayoutValue(field: field, model: model)
                        }
                    }.frame(maxWidth: .infinity)
                }
            } else {
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 6), GridItem(.flexible(), spacing: 6)], spacing: 5) {
                    ForEach(fields) { field in CompactLayoutValue(field: field, model: model) }
                }
            }
        }
    }
}

private struct FourEdgeInsetIcon: View {
    var body: some View {
        SwiftUI.Canvas { context, size in
            let bounds = CGRect(x: 1, y: 1, width: size.width - 2, height: size.height - 2)
            context.stroke(Path(roundedRect: bounds, cornerRadius: 1.5), with: .color(.secondary), lineWidth: 1)
            let center = CGRect(x: 4.5, y: 4.5, width: size.width - 9, height: size.height - 9)
            context.stroke(Path(roundedRect: center, cornerRadius: 0.8), with: .color(.primary), lineWidth: 1)
        }.accessibilityHidden(true)
    }
}

private struct CompactLayoutFields: View {
    let fields: [InspectorField]
    @ObservedObject var model: InspectorModel
    private func row(_ name: String) -> [InspectorField] { fields.filter { $0.layout == name } }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Layout").font(.headline).padding(.top, 5)
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 6), GridItem(.flexible(), spacing: 6)], spacing: 5) {
                ForEach(row("size")) { field in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(field.id == "style:width" ? "Width" : "Height").font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
                        CompactLayoutValue(field: field, model: model)
                    }
                }
            }
            CompactSpacingRow(group: "padding", fields: row("padding"), model: model)
            CompactSpacingRow(group: "margin", fields: row("margin"), model: model)
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 6), GridItem(.flexible(), spacing: 6)], spacing: 5) {
                ForEach(row("finish")) { field in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(field.id == "style:border-radius" ? "Radius" : "Opacity").font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
                        CompactLayoutValue(field: field, model: model)
                    }
                }
            }
        }
    }
}
struct EditingInspectorContent: View {
    @ObservedObject var model: InspectorModel
    var body: some View {
        if let state = model.state {
            // The title row is the island's AppKit header (LKM-180), which also moves it.
            VStack(alignment: .leading, spacing: 10) {
                if let notice = state.notice {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(notice.title).font(.system(size: 12, weight: .semibold))
                        Text(notice.reason).font(.caption).foregroundStyle(.secondary)
                        if notice.editable { Text("A unique CSS class rule can still be edited.").font(.caption).foregroundStyle(.secondary) }
                        HStack {
                            Button("Connect project to Trezi") { model.send("setup") }
                            Button("Ask the agent") { model.send("ask-agent") }
                        }.font(.caption)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                Picker("Inspector section", selection: Binding(get: { state.tab }, set: { model.send("tab", value: $0) })) { Text("Props").tag("props"); Text("Styles").tag("styles"); Text("Custom").tag("custom") }.pickerStyle(.segmented).labelsHidden()
                if state.busy { ProgressView().controlSize(.small) }
                if !state.error.isEmpty { Text(state.error).foregroundStyle(.red).font(.caption).textSelection(.enabled) }
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        if state.tab == "styles" {
                            let layout = state.fields.filter { $0.layout != nil }
                            if !layout.isEmpty { CompactLayoutFields(fields: layout, model: model) }
                        }
                        ForEach(Array(state.fields.filter { state.tab != "styles" || $0.layout == nil }.enumerated()), id: \.element.id) { index, field in
                            if index == 0 || field.group != state.fields.filter({ state.tab != "styles" || $0.layout == nil })[index - 1].group {
                                if !field.group.isEmpty && !(state.tab == "styles" && field.group == "layout") {
                                    Text(field.group == "appearance" ? "Color & Effects" : field.group.capitalized).font(.headline).padding(.top, 5)
                                }
                            }
                            InspectorFieldView(field: field, model: model)
                        }
                    // Trailing room keeps units and apply buttons clear of the overlay scroller.
                    }.id("\(state.root):\(state.generation)").padding(2).padding(.trailing, 10)
                }.overlay(alignment: .topTrailing) { if model.pulse { UpdatedPulse().transition(.opacity) } }
            }.padding(.horizontal, FloatingIsland.padding).padding(.top, 4).padding(.bottom, FloatingIsland.padding).frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
/// Floats over the preview like the composer island, so opening it never narrows the
/// preview: by default along its right edge at full height, or wherever its header was
/// dragged (LKM-180). The face under the controls is opaque (LKM-162): over an arbitrary
/// page, clear glass let text, hover boxes and selection outlines ghost the fields.
final class NativeEditingInspector: FloatingIsland {
    let model: InspectorModel
    let content: NSHostingView<EditingInspectorContent>
    let more = NSButton(image: NSImage(systemSymbolName: "ellipsis", accessibilityDescription: "More")!, target: nil, action: nil)
    let close = NSButton(image: NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close")!, target: nil, action: nil)
    init() {
        let model = InspectorModel(); self.model = model
        content = NSHostingView(rootView: EditingInspectorContent(model: model))
        super.init(title: "")
        content.sizingOptions = []
        more.target = self; more.action = #selector(showMenu(_:)); more.toolTip = "More"
        close.target = self; close.action = #selector(closeIsland); close.toolTip = "Close"
        for button in [more, close] { button.isBordered = false; button.translatesAutoresizingMaskIntoConstraints = false; header.addSubview(button) }
        content.translatesAutoresizingMaskIntoConstraints = false; face.addSubview(content)
        let pad = Self.padding
        NSLayoutConstraint.activate([
            title.trailingAnchor.constraint(lessThanOrEqualTo: more.leadingAnchor, constant: -8),
            close.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -pad), close.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            more.trailingAnchor.constraint(equalTo: close.leadingAnchor, constant: -10), more.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            content.leadingAnchor.constraint(equalTo: face.leadingAnchor), content.trailingAnchor.constraint(equalTo: face.trailingAnchor),
            content.topAnchor.constraint(equalTo: header.bottomAnchor), content.bottomAnchor.constraint(equalTo: face.bottomAnchor)
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
    func update(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value), let state = try? JSONDecoder().decode(InspectorState.self, from: data) else { return }
        model.show(state); isHidden = !state.visible
        title.stringValue = state.title; title.toolTip = state.title
    }
    @objc func closeIsland() { model.send("close") }
    /// The element's actions, then Reset Position, which puts the island back on the right.
    func actionMenu() -> NSMenu {
        let menu = NSMenu()
        for action in model.state?.actions ?? [] {
            let item = NSMenuItem(title: action.label, action: #selector(menuAction(_:)), keyEquivalent: ""); item.target = self; item.representedObject = action.id; menu.addItem(item)
        }
        if !menu.items.isEmpty { menu.addItem(.separator()) }
        let item = NSMenuItem(title: "Reset Position", action: #selector(resetPosition), keyEquivalent: ""); item.target = self; menu.addItem(item)
        return menu
    }
    @objc func showMenu(_ sender: NSButton) { actionMenu().popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.maxY + 4), in: sender) }
    @objc func menuAction(_ item: NSMenuItem) { if let id = item.representedObject as? String { model.send(id) } }
    @objc func resetPosition() { reset?() }
    /// The island's frame over `area` (the preview's full, unchanged frame), or zero when closed:
    /// at `spot` when it was moved and still fits, else along the right edge.
    static func frame(in area: NSRect, width preferred: CGFloat, visible: Bool, spot: IslandSpot? = nil) -> NSRect {
        guard visible else { return .zero }
        if let spot, let moved = moved(in: area, width: preferred, spot: spot) { return moved }
        let width = max(0, min(preferred, area.width - 2 * inset))
        return NSRect(x: area.maxX - inset - width, y: area.minY + inset, width: width, height: max(0, area.height - 2 * inset))
    }
    /// The frame at `spot`, always full height (only its side and distance from that edge
    /// move), or nil when it no longer fits the preview.
    static func moved(in area: NSRect, width preferred: CGFloat, spot: IslandSpot) -> NSRect? {
        let width = max(0, min(preferred, area.width - 2 * inset))
        var moved = spot.frame(NSSize(width: width, height: max(0, area.height - 2 * inset)), in: area); moved.origin.y = area.minY + inset
        return area.insetBy(dx: inset - 0.5, dy: inset - 0.5).contains(moved) ? moved : nil
    }
}
