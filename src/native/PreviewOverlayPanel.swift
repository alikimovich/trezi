import AppKit
import SwiftUI

/// The toolbar popover for rulers, guides and layout grids. Every edit goes through
/// `PreviewOverlay.update`, which clamps it, redraws and has main save it for the
/// project and viewport.
struct PreviewOverlayPanel: View {
    @ObservedObject var overlay: PreviewOverlay

    private func flag(_ path: WritableKeyPath<OverlayState, Bool>) -> Binding<Bool> {
        Binding(get: { overlay.state[keyPath: path] }, set: { value in overlay.update { $0[keyPath: path] = value } })
    }
    private func grid<T>(_ index: Int, _ path: WritableKeyPath<OverlayGrid, T>, _ fallback: T) -> Binding<T> {
        Binding(get: { overlay.state.grids.indices.contains(index) ? overlay.state.grids[index][keyPath: path] : fallback },
                set: { value in overlay.update { if $0.grids.indices.contains(index) { $0.grids[index][keyPath: path] = value } } })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle("Show Rulers and Guides", isOn: flag(\.rulers))
            Toggle("Show Layout Grid", isOn: Binding(get: { overlay.state.gridVisible }, set: { _ in overlay.toggleGrid(nil) }))
            HStack {
                Toggle("Lock Guides", isOn: flag(\.locked))
                Toggle("Fixed to Viewport", isOn: flag(\.fixed))
            }
            ForEach(Array(overlay.state.grids.indices), id: \.self) { index in
                Divider()
                gridEditor(index)
            }
            Divider()
            HStack {
                Menu("Add Grid") {
                    ForEach(OverlayMath.presets.indices, id: \.self) { index in
                        Button(OverlayMath.presets[index].name) { overlay.addGrid(OverlayMath.presets[index].grid) }
                    }
                }
                .fixedSize()
                .disabled(overlay.state.grids.count >= OverlayState.maxGrids)
                Spacer()
                Button("Clear Guides") { overlay.clearGuides(nil) }
                    .disabled(overlay.state.guides.isEmpty || overlay.state.locked)
            }
            Text(overlay.viewport == "mobile" ? "Saved for this project's mobile viewport." : "Saved for this project's desktop viewport.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .toggleStyle(.checkbox)
        .padding(14)
        .frame(width: 320)
    }

    @ViewBuilder private func gridEditor(_ index: Int) -> some View {
        let kind = overlay.state.grids.indices.contains(index) ? overlay.state.grids[index].kind : "columns"
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Toggle("", isOn: grid(index, \.visible, true)).labelsHidden()
                Picker("", selection: grid(index, \.kind, "columns")) {
                    Text("Columns").tag("columns"); Text("Rows").tag("rows"); Text("Square").tag("square")
                }
                .labelsHidden().fixedSize()
                Spacer()
                ColorPicker("", selection: Binding(
                    get: { Color(nsColor: NSColor(hex: overlay.state.grids.indices.contains(index) ? overlay.state.grids[index].color : "#ff3b30")) },
                    set: { value in overlay.update { if $0.grids.indices.contains(index) { $0.grids[index].color = NSColor(value).hexString } } }
                ), supportsOpacity: false).labelsHidden()
                Button { overlay.update { if $0.grids.indices.contains(index) { $0.grids.remove(at: index) } } } label: { Image(systemName: "minus.circle") }
                    .buttonStyle(.borderless).help("Remove Grid")
            }
            switch kind {
            case "columns":
                HStack {
                    field("Count", Binding(get: { Double(grid(index, \.count, 12).wrappedValue) }, set: { grid(index, \.count, 12).wrappedValue = Int($0) }))
                    field("Gutter", grid(index, \.gutter, 24))
                    field("Margin", grid(index, \.margin, 0))
                }
                HStack {
                    Picker("Align", selection: grid(index, \.align, "stretch")) {
                        Text("Stretch").tag("stretch"); Text("Left").tag("left"); Text("Center").tag("center")
                    }
                    .fixedSize()
                    Spacer()
                    Text("Width").font(.caption).foregroundStyle(.secondary)
                    TextField("Auto", value: grid(index, \.width, nil), format: .number)
                        .frame(width: 54).disabled(grid(index, \.align, "stretch").wrappedValue == "stretch")
                }
            case "rows":
                HStack { field("Step", grid(index, \.step, 8)); field("Offset", grid(index, \.offset, 0)) }
            default:
                HStack { field("Size", grid(index, \.size, 8)) }
            }
            HStack {
                Text("Opacity").font(.caption).foregroundStyle(.secondary)
                Slider(value: grid(index, \.opacity, 0.12), in: 0.02...1)
            }
        }
    }

    private func field(_ title: String, _ value: Binding<Double>) -> some View {
        HStack(spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            TextField(title, value: value, format: .number).labelsHidden().frame(width: 48)
        }
    }
}

extension NSColor {
    convenience init(hex: String) {
        let (r, g, b) = OverlayMath.rgb(hex) ?? (1, 0.23, 0.19)
        self.init(srgbRed: r, green: g, blue: b, alpha: 1)
    }
    var hexString: String {
        let c = usingColorSpace(.sRGB) ?? self
        let v = [c.redComponent, c.greenComponent, c.blueComponent].map { Int((min(max($0, 0), 1) * 255).rounded()) }
        return String(format: "#%02x%02x%02x", v[0], v[1], v[2])
    }
}
