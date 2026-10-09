import AppKit
import SwiftUI

/// Visible preview only. The page owns scene identity and capture; this view owns controls.
struct ThreeDLayer: Identifiable {
    let id: Int
    let label: String
    let depth: Int
}

final class ThreeDChromeModel: ObservableObject {
    @Published var title = "3D component"
    @Published var layers: [ThreeDLayer] = []
    @Published var selected = -1
    @Published var hasSource = false
    @Published var separation = 36.0
    @Published var status = ""
    var session = ""
    var revision = 0
    func action(_ name: String, value: Int? = nil) {
        var body: [String: Any] = ["event":"three-d-action", "session":session, "revision":revision, "action":name]
        if let value { body["value"] = value }
        emit(body)
    }
}

struct ThreeDHeader: View {
    @ObservedObject var model: ThreeDChromeModel
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                Button("Back to page") { model.action("close") }.accessibilityLabel("Back to page")
                Text(model.title).font(.headline).lineLimit(1).help(model.title)
                Spacer(minLength: 4)
                if model.hasSource { Button("Code") { model.action("code") }.help("View selected layer source") }
                Button("Front") { model.action("front") }
                Button("Reset view") { model.action("reset") }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Color(nsColor: .windowBackgroundColor))
        .overlay(alignment: .bottom) { Rectangle().fill(Color(nsColor: .separatorColor)).frame(height: 1) }
    }
}

struct ThreeDFooter: View {
    @ObservedObject var model: ThreeDChromeModel
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    Text("Separation").font(.caption)
                    Slider(value: Binding(get: { model.separation }, set: { value in
                        model.separation = value
                        model.action("separation", value: Int(value.rounded()))
                    }), in: 0...100).frame(width: 100).accessibilityLabel("Layer separation")
                    Picker("Component layer", selection: Binding(get: { model.selected }, set: { value in
                        model.selected = value
                        model.action("layer", value: value)
                    })) {
                        ForEach(model.layers) { layer in
                            Text(String(repeating: "· ", count: min(layer.depth, 18)) + layer.label).tag(layer.id)
                        }
                    }
                    .frame(width: 230).disabled(model.layers.isEmpty)
                }
            }
            Text("Drag to orbit · Shift-drag to pan · Scroll to zoom")
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                .minimumScaleFactor(0.75)
            Text(model.status).font(.caption).foregroundStyle(.secondary).lineLimit(1).help(model.status)
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(Color(nsColor: .windowBackgroundColor))
        .overlay(alignment: .top) { Rectangle().fill(Color(nsColor: .separatorColor)).frame(height: 1) }
    }
}

final class ThreeDBar<Content: View>: NSHostingView<Content> {
    var appearanceChanged: (() -> Void)?
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); appearanceChanged?() }
    override func scrollWheel(with event: NSEvent) {}
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class ThreeDChrome {
    let model = ThreeDChromeModel()
    let header: ThreeDBar<ThreeDHeader>
    let footer: ThreeDBar<ThreeDFooter>
    var document = ""
    var active = false
    private var closedSession = ""
    private var closedDocument = ""
    init() {
        header = ThreeDBar(rootView: ThreeDHeader(model: model))
        footer = ThreeDBar(rootView: ThreeDFooter(model: model))
        header.isHidden = true; footer.isHidden = true
    }
    func receive(_ state: [String: Any]?, document nextDocument: String) {
        guard let state else { clear(); return }
        guard let session = state["session"] as? String, session.count <= 80, !session.isEmpty,
              let revision = state["revision"] as? Int, revision >= 0,
              let title = state["title"] as? String, title.count <= 160,
              let rows = state["layers"] as? [[String: Any]], rows.count <= 160,
              let separation = state["separation"] as? Int, (0...100).contains(separation),
              let hasSource = state["hasSource"] as? Bool,
              let limited = state["limited"] as? Bool,
              let simplified = state["simplified"] as? Bool,
              let invalid = state["invalid"] as? Bool else { return }
        if nextDocument == closedDocument && session == closedSession { return }
        if active && document == nextDocument && model.session == session && revision < model.revision { return }
        var layers: [ThreeDLayer] = []
        for (index, row) in rows.enumerated() {
            guard let id = row["id"] as? Int, id == index,
                  let label = row["label"] as? String, label.count <= 120,
                  let depth = row["depth"] as? Int, (0...18).contains(depth) else { return }
            layers.append(ThreeDLayer(id: id, label: label, depth: depth))
        }
        let selected = state["selected"] as? Int ?? -1
        guard selected == -1 || layers.indices.contains(selected) else { return }
        document = nextDocument
        active = true
        model.session = session; model.revision = revision
        model.title = title; model.layers = layers; model.selected = selected
        model.hasSource = hasSource; model.separation = Double(separation)
        model.status = invalid
            ? "This component was removed or replaced ambiguously. Return to the page and select it again."
            : "\(layers.count) layers · Depth shows nesting" + (limited ? " · Capture limited" : "") + (simplified ? " · Some content simplified" : "")
    }
    func clear() {
        if active { closedSession = model.session; closedDocument = document }
        active = false; document = ""; model.session = ""; model.revision = 0
        header.isHidden = true; footer.isHidden = true
    }
    func place(in page: NSRect, visible: Bool) -> (Double, Double) {
        let show = active && visible && page.width >= 200 && page.height >= 180
        header.isHidden = !show; footer.isHidden = !show
        guard show else { return (0, 0) }
        let top: CGFloat = 48, bottom: CGFloat = 76
        header.frame = NSRect(x: page.minX, y: page.minY, width: page.width, height: top)
        footer.frame = NSRect(x: page.minX, y: page.maxY - bottom, width: page.width, height: bottom)
        return (Double(top), Double(bottom))
    }
    func palette(_ appearance: NSAppearance) -> [String: String] {
        var colors: [String: String] = [:]
        appearance.performAsCurrentDrawingAppearance {
            let background = NSColor.windowBackgroundColor.usingColorSpace(.sRGB) ?? .windowBackgroundColor
            func blended(_ color: NSColor) -> String {
                let foreground = color.usingColorSpace(.sRGB) ?? color
                let alpha = min(1, max(0, foreground.alphaComponent))
                return NSColor(srgbRed: foreground.redComponent * alpha + background.redComponent * (1 - alpha),
                               green: foreground.greenComponent * alpha + background.greenComponent * (1 - alpha),
                               blue: foreground.blueComponent * alpha + background.blueComponent * (1 - alpha), alpha: 1).hexString
            }
            colors = ["background": NSColor.windowBackgroundColor.hexString,
                      "grid": blended(.quaternaryLabelColor),
                      "outline": blended(.tertiaryLabelColor),
                      "accent": NSColor.controlAccentColor.hexString,
                      "focus": NSColor.keyboardFocusIndicatorColor.hexString]
        }
        return colors
    }
}
