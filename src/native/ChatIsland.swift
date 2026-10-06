import SwiftUI
import AppKit

// IslandValue and the live-write/typed-entry policy live in IslandEditing.swift.
struct IslandField: Decodable, Identifiable {
    let id: String; let label: String; let kind: String; let value: IslandValue?
    let min: Double?; let max: Double?; let step: Double?; let unit: String?; let options: [String]?
    /// Why the code no longer lets this field edit its binding (LKM-181), shown on hover.
    let disabled: String?
}
struct IslandBlock: Decodable, Identifiable { let id: String; let title: String; let kind: String; let params: [String] }
/// `status`: waiting, ready, partially-disabled, disabled (`disabledBy` code or user) or hidden.
struct IslandView: Decodable, Identifiable {
    let id: String; let revision: Int; let title: String; let blocks: [IslandBlock]; let fields: [IslandField]
    let sourceRevision: String; let status: String; let detail: String; let engine: String; let replay: Bool
    let notice: String?
    let name: String?; let reason: String?; let disabledBy: String?
    /// Controls write only while the code supports some of their bindings and the user has not disabled them.
    var live: Bool { status == "ready" || status == "partially-disabled" }
}
struct NativeChatIsland: View {
    let island: IslandView
    @ObservedObject var model: ChatModel
    @State private var drafts: [String: IslandValue] = [:]
    @State private var dragging = false
    @State private var writes = IslandLiveWrites()
    /// The one path every control writes through: live while editing, one Undo group per gesture.
    private func live(_ values: [String: IslandValue], ended: Bool = false) {
        model.controlInteraction += 1
        dragging = !ended
        drafts.merge(values) { _, next in next }
        guard let batch = writes.change(values, ended: ended) else { return }
        model.islandAction(island, action: "commit", values: batch.values.mapValues(\.object), gesture: batch.gesture, ended: batch.ended)
    }
    private func value(_ field: IslandField) -> IslandValue { drafts[field.id] ?? field.value ?? .text("") }
    private func action(_ name: String, values: [String: IslandValue] = [:]) {
        model.islandAction(island, action: name, values: values.mapValues(\.object))
    }
    /// A discrete change (typed value, toggle, picker, preset) is a gesture of one write.
    private func commit(_ field: IslandField, _ value: IslandValue) { live([field.id: value], ended: true) }
    private func range(_ field: IslandField) -> ClosedRange<Double>? {
        guard let lower = field.min, let upper = field.max, lower <= upper else { return nil }
        return lower...upper
    }
    private var shadowPanel: Bool { island.blocks.contains { $0.kind == "shadow" } }
    private func anchor(_ edge: String) -> some View {
        GeometryReader { geometry in
            Color.clear.preference(key: IslandPositions.self, value: [edge + "-" + island.id: geometry.frame(in: .named("chatScroll"))])
        }
    }
    var body: some View {
        if island.status == "hidden" { hiddenRow } else { panel }
    }
    /// LKM-181: a hidden island is one line until the user (or the agent's `show`) brings it back.
    private var hiddenRow: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "eye.slash").foregroundStyle(.secondary).accessibilityHidden(true)
                Text("Hidden island: \(island.title) —").foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                Button("Show") { action("show") }.buttonStyle(.link)
                Spacer(minLength: 0)
            }.font(.callout).padding(.vertical, 4)
                .id("island-start-" + island.id).background(anchor("start"))
            Color.clear.frame(height: 1).id("island-end-" + island.id).background(anchor("end"))
        }
    }
    private var header: some View {
        HStack(spacing: 8) {
            Text(island.title).font(.headline)
            if let name = island.name { Text(name).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled) }
            Spacer()
            if island.disabledBy == "user" { Text("Disabled").font(.caption).foregroundStyle(.secondary).help(island.reason ?? "") }
            else { Text(island.engine == "preparing" ? "Preparing…" : shadowPanel ? "chat island" : island.engine == "jev" ? "Jev" : "Agent").font(.caption).foregroundStyle(.secondary) }
            Menu {
                if island.disabledBy == "user" { Button("Enable") { action("enable") } }
                else { Button("Disable") { drafts = [:]; action("disable") } }
                Button("Hide") { action("hide") }
                Button("Show all hidden islands") { action("show-hidden") }
                Divider()
                Button("Copy reference") { copyReference() }.disabled(island.name == nil)
            } label: { Image(systemName: "ellipsis.circle") }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().accessibilityLabel("Island actions")
        }
    }
    /// The name on the pasteboard, and a reference chip in the composer.
    private func copyReference() {
        guard let name = island.name else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(name, forType: .string)
        action("reference")
    }
    private var panel: some View {
        VStack(alignment: .leading, spacing: 14) {
            header.id("island-start-" + island.id).background(anchor("start"))
            // Disabled by the user: collapsed to the title row.
            if island.disabledBy != "user" { content }
            Color.clear.frame(height: 1).id("island-end-" + island.id).background(anchor("end"))
        }.padding(shadowPanel ? 18 : 14).background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: shadowPanel ? 20 : 12))
            .overlay(RoundedRectangle(cornerRadius: shadowPanel ? 20 : 12).stroke(.separator, lineWidth: 0.5))
            .onChange(of: island.sourceRevision) { _ in if !dragging { drafts = [:] } }
            .onChange(of: island.revision) { _ in drafts = [:] }
            // A bound value changed outside the island: show the source, not the drag.
            .onChange(of: island.notice) { _ in drafts = [:] }
            .onChange(of: island.status) { _ in drafts = [:] }
    }
    @ViewBuilder private var content: some View {
        if island.status == "disabled", let reason = island.reason {
            VStack(alignment: .leading, spacing: 8) {
                Label(reason, systemImage: "exclamationmark.triangle").font(.callout).fixedSize(horizontal: false, vertical: true)
                HStack {
                    Button("Recreate with agent") { action("recreate") }
                    Button("Hide") { action("hide") }
                }.controlSize(.small)
            }
        }
        if !island.detail.isEmpty { Text(island.detail).font(.caption).fixedSize(horizontal: false, vertical: true) }
        if let notice = island.notice, !notice.isEmpty {
            Label(notice, systemImage: "arrow.triangle.2.circlepath").font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true).accessibilityLabel(notice)
        }
        ForEach(island.blocks) { block in
            let fields = block.params.compactMap { id in island.fields.first { $0.id == id } }
            // A compound block edits its bindings together: one that broke disables it.
            let broken = block.kind == "group" ? nil : fields.first { $0.disabled != nil }?.disabled
            VStack(alignment: .leading, spacing: 10) {
                if block.kind != "shadow" { Text(block.title).font(.subheadline.weight(.medium)) }
                if block.kind == "shadow", fields.count == 8 {
                    ShadowIsland(fields: fields, value: value, field: { field in AnyView(fieldView(field)) }, light: { x, y, ended in
                        live([fields[0].id: .number(x), fields[1].id: .number(y)], ended: ended)
                    }, input: { field in AnyView(IslandInput(label: field.id == fields[0].id ? "X" : "Y", value: value(field).text, kind: .number(range(field))) { commit(field, $0) }) })
                } else if block.kind == "point", fields.count == 2 {
                    IslandPoint(x: value(fields[0]).number, y: value(fields[1]).number,
                        xRange: (fields[0].min ?? -1)...(fields[0].max ?? 1), yRange: (fields[1].min ?? -1)...(fields[1].max ?? 1),
                        label: block.title, change: { x, y, ended in
                            live([fields[0].id:.number(x), fields[1].id:.number(y)], ended: ended)
                        })
                }
                ForEach(block.kind == "shadow" ? [] : fields) { field in
                    Group {
                        if block.kind == "point" {
                            IslandInput(label: field.label, value: value(field).text, kind: .number(range(field))) { commit(field, $0) }
                        } else { fieldView(field) }
                    }.disabled(field.disabled != nil).help(field.disabled ?? "")
                }
            }.disabled(!island.live || broken != nil).help(broken ?? "")
                .opacity(island.live ? 1 : 0.6)
        }
        HStack {
            Button("Reload") { drafts = [:]; action("reload") }
            Button("Reset") { drafts = [:]; action("reset") }.disabled(!island.live)
            Button("Undo") { drafts = [:]; action("undo") }.disabled(!island.live)
            if island.replay { Button("Replay") { action("replay") }.disabled(!island.live) }
        }.controlSize(.small)
    }
    @ViewBuilder private func fieldView(_ field: IslandField) -> some View {
        switch field.kind {
        case "toggle":
            Toggle(field.label, isOn: Binding(get: { value(field) == .toggle(true) }, set: { commit(field, .toggle($0)) })).toggleStyle(.switch).controlSize(.small)
        case "select":
            Picker(field.label, selection: Binding(get: { value(field).text }, set: { commit(field, .text($0)) })) {
                ForEach(field.options ?? [], id: \.self) { Text($0).tag($0) }
            }
        case "bezier":
            IslandBezier(label: field.label, value: value(field).text) { text, ended in
                live([field.id: .text(text)], ended: ended)
            }
        case "number":
            VStack(alignment: .leading, spacing: 4) {
                IslandInput(label: field.label + (field.unit.map { " (\($0))" } ?? ""), value: value(field).text, kind: .number(range(field))) { commit(field, $0) }
                if let lower = field.min, let upper = field.max, lower < upper {
                    SnappedSlider(value: Binding(get: { Swift.min(upper, Swift.max(lower, value(field).number)) }, set: { live([field.id: .number($0)]) }), bounds: lower...upper, step: field.step ?? (upper-lower)/1000, onEditingChanged: { editing in
                        if editing { dragging = true } else { live([field.id: value(field)], ended: true) }
                    }).accessibilityLabel(field.label)
                }
            }
        default:
            IslandInput(label: field.label, value: value(field).text, kind: .text) { commit(field, $0) }
        }
    }
}
/// A typed field: Return and blur both apply (see `IslandEntry`); an invalid draft shows red and is not written.
struct IslandInput: View {
    let label: String; let value: String; let commit: (IslandValue) -> Void
    @State private var entry: IslandEntry
    @State private var draft = ""
    @FocusState private var focused: Bool
    init(label: String, value: String, kind: IslandEntry.Kind, commit: @escaping (IslandValue) -> Void) {
        self.label = label; self.value = value; self.commit = commit
        _entry = State(initialValue: IslandEntry(kind))
    }
    private var wide: Bool { if case .number = entry.kind { return false }; return true }
    private func apply() { if let next = entry.commit(draft, current: value) { commit(next) } }
    var body: some View {
        HStack {
            Text(label).font(.callout); Spacer(minLength: 8)
            TextField(label, text: $draft).labelsHidden().textFieldStyle(.roundedBorder).frame(maxWidth: wide ? 200 : 90)
                .foregroundStyle(entry.parse(draft) == nil ? Color.red : Color.primary)
                .focused($focused).onSubmit(apply)
                .accessibilityLabel(label)
        }.onAppear { draft = value }.onChange(of: value) { next in entry.sourceChanged(); if !focused { draft = next } }
            .onChange(of: focused) { next in if !next { apply() } }
    }
}
struct IslandPoint: View {
    let x: Double; let y: Double; let xRange: ClosedRange<Double>; let yRange: ClosedRange<Double>
    let label: String; let change: (Double, Double, Bool) -> Void
    var body: some View {
        GeometryReader { geo in
            let width = max(1, geo.size.width - 20), height = max(1, geo.size.height - 20)
            ZStack {
                RoundedRectangle(cornerRadius: 8).fill(.background)
                Path { p in p.move(to: CGPoint(x: 10, y: geo.size.height/2)); p.addLine(to: CGPoint(x: geo.size.width-10, y: geo.size.height/2)); p.move(to: CGPoint(x: geo.size.width/2, y: 10)); p.addLine(to: CGPoint(x: geo.size.width/2, y: geo.size.height-10)) }.stroke(.secondary.opacity(0.4), style: StrokeStyle(lineWidth: 1, dash: [3]))
                Circle().fill(.tint).frame(width: 14, height: 14).position(x: 10 + CGFloat((x-xRange.lowerBound)/(xRange.upperBound-xRange.lowerBound))*width, y: 10 + CGFloat((y-yRange.lowerBound)/(yRange.upperBound-yRange.lowerBound))*height)
            }.contentShape(Rectangle()).gesture(DragGesture(minimumDistance: 0).onChanged { v in update(v.location, width, height, false) }.onEnded { v in update(v.location, width, height, true) })
        }.frame(height: 120).accessibilityLabel(label + ". Use the coordinate fields below for keyboard adjustment.")
    }
    private func update(_ p: CGPoint, _ width: CGFloat, _ height: CGFloat, _ end: Bool) {
        let x = min(1, max(0, (p.x-10)/width)), y = min(1, max(0, (p.y-10)/height))
        change(xRange.lowerBound + x*(xRange.upperBound-xRange.lowerBound), yRange.lowerBound + y*(yRange.upperBound-yRange.lowerBound), end)
    }
}
private struct IslandBezier: View {
    let label: String; let value: String; let commit: (String, Bool) -> Void
    @State private var points: [Double] = [0.25, 0.1, 0.25, 1]
    @State private var dragging = false
    private func load() {
        let regex = try! NSRegularExpression(pattern: "-?\\d*\\.?\\d+")
        let numbers = regex.matches(in: value, range: NSRange(value.startIndex..., in: value)).compactMap { Range($0.range, in: value).flatMap { Double(value[$0]) } }
        if numbers.count == 4 { points = numbers }
    }
    private func save(ended: Bool = true) { commit("cubic-bezier(\(points.map { String(format: "%.4g", $0) }.joined(separator: ", ")))", ended) }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).font(.callout)
            GeometryReader { geo in
                let w = max(1, geo.size.width-24), h = max(1, geo.size.height-24)
                let a = CGPoint(x: 12, y: h+12), b = CGPoint(x: w+12, y: 12)
                let c = CGPoint(x: 12+points[0]*w, y: 12+(1-points[1])*h), d = CGPoint(x: 12+points[2]*w, y: 12+(1-points[3])*h)
                ZStack {
                    RoundedRectangle(cornerRadius: 8).fill(.background)
                    Path { p in p.move(to: a); p.addLine(to: c); p.move(to: b); p.addLine(to: d) }.stroke(.secondary, lineWidth: 1)
                    Path { p in p.move(to: a); p.addCurve(to: b, control1: c, control2: d) }.stroke(.tint, lineWidth: 2)
                    ForEach(0..<2) { i in
                        Circle().fill(.tint).frame(width: 14, height: 14).position(i == 0 ? c : d)
                            .gesture(DragGesture(coordinateSpace: .named("curve-" + label)).onChanged { v in
                                dragging = true; points[i*2] = min(1, max(0, (v.location.x-12)/w)); points[i*2+1] = min(2, max(-1, 1-(v.location.y-12)/h)); save(ended: false)
                            }.onEnded { _ in dragging = false; save() })
                    }
                }.coordinateSpace(name: "curve-" + label)
            }.frame(height: 130)
            HStack {
                Button("Linear") { points = [0,0,1,1]; save() }
                Button("Ease") { points = [0.25,0.1,0.25,1]; save() }
                Button("Ease out") { points = [0,0,0.58,1]; save() }
            }.controlSize(.small)
            IslandInput(label: "Coordinates", value: value, kind: .bezier) { commit($0.text, true) }
        }.onAppear(perform: load).onChange(of: value) { _ in if !dragging { load() } }
    }
}
