import AppKit
import SwiftUI
import WebKit

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
    @Published var compact = false
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
        Group {
          if model.compact {
            HStack(spacing: 6) {
                Button { model.action("close") } label: { Image(systemName: "chevron.left") }
                    .accessibilityLabel("Back to page").help("Back to page")
                Text(model.title).font(.headline).lineLimit(1).truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading).help(model.title)
                if model.hasSource {
                    Button { model.action("code") } label: { Image(systemName: "chevron.left.forwardslash.chevron.right") }
                        .accessibilityLabel("Code").help("View selected layer source")
                }
                Button("Front") { model.action("front") }.accessibilityLabel("Front view")
                Button { model.action("reset") } label: { Image(systemName: "arrow.counterclockwise") }
                    .accessibilityLabel("Reset view").help("Reset view")
            }
          } else {
            HStack(spacing: 8) {
                Button("Back to page") { model.action("close") }.accessibilityLabel("Back to page")
                Text(model.title).font(.headline).lineLimit(1).truncationMode(.tail).help(model.title)
                    .layoutPriority(-1)
                Spacer(minLength: 4)
                if model.hasSource { Button("Code") { model.action("code") }.help("View selected layer source") }
                Button("Front") { model.action("front") }
                Button("Reset view") { model.action("reset") }
            }
          }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Color(nsColor: .windowBackgroundColor))
        .overlay(alignment: .bottom) { Rectangle().fill(Color(nsColor: .separatorColor)).frame(height: 1) }
    }
}

struct ThreeDFooter: View {
    @ObservedObject var model: ThreeDChromeModel
    private var separation: Binding<Double> {
        Binding(get: { model.separation }, set: { value in
            model.separation = value
            model.action("separation", value: Int(value.rounded()))
        })
    }
    private var layer: Binding<Int> {
        Binding(get: { model.selected }, set: { value in
            model.selected = value
            model.action("layer", value: value)
        })
    }
    private var picker: some View {
        Picker("Component layer", selection: layer) {
            ForEach(model.layers) { item in
                Text(String(repeating: "· ", count: min(item.depth, 18)) + item.label).tag(item.id)
            }
        }.disabled(model.layers.isEmpty)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if model.compact {
                HStack(spacing: 8) {
                    Text("Separation").font(.caption)
                    Slider(value: separation, in: 0...100).accessibilityLabel("Layer separation")
                }
                picker.labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
                    .help(model.layers.first(where: { $0.id == model.selected })?.label ?? "Component layer")
            } else {
                HStack(spacing: 8) {
                    Text("Separation").font(.caption)
                    Slider(value: separation, in: 0...100).frame(width: 100).accessibilityLabel("Layer separation")
                    picker.frame(width: 230)
                    Spacer(minLength: 0)
                }
            }
            Text(model.compact ? "Drag: orbit · Shift: pan · Scroll: zoom" : "Drag to orbit · Shift-drag to pan · Scroll to zoom")
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
    override var acceptsFirstResponder: Bool { true }
    override func scrollWheel(with event: NSEvent) {}
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

struct ThreeDInsets {
    var top = 0.0, bottom = 0.0, left = 0.0, right = 0.0
}

final class ThreeDChrome {
    let model = ThreeDChromeModel()
    let header: ThreeDBar<ThreeDHeader>
    let footer: ThreeDBar<ThreeDFooter>
    var document = ""
    var active = false
    weak var preview: WKWebView?
    var insets = ThreeDInsets()
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
        if let window = header.window, let focused = window.firstResponder as? NSView,
           focused === header || focused.isDescendant(of: header) || focused === footer || focused.isDescendant(of: footer),
           let preview { window.makeFirstResponder(preview) }
        active = false; document = ""; model.session = ""; model.revision = 0
        insets = ThreeDInsets()
        header.isHidden = true; footer.isHidden = true
    }
    func dismiss() { if active { model.action("close"); clear() } }
    func ownsFocus(_ responder: NSResponder?) -> Bool {
        guard let view = responder as? NSView else { return false }
        return view === header || view.isDescendant(of: header) || view === footer || view.isDescendant(of: footer)
    }
    @discardableResult func place(in page: NSRect, visible: Bool, occluders: [NSRect]) -> Bool {
        let show = active && visible && page.width >= 190 && page.height >= 280
        header.isHidden = !show; footer.isHidden = !show
        guard show else { insets = ThreeDInsets(); return false }
        let compact = page.width < 520
        if model.compact != compact { model.compact = compact }
        let top: CGFloat = 48, bottom: CGFloat = compact ? 100 : 76
        header.frame = NSRect(x: page.minX, y: page.minY, width: page.width, height: top)
        footer.frame = NSRect(x: page.minX, y: page.maxY - bottom, width: page.width, height: bottom)
        var next = ThreeDInsets(top: Double(top), bottom: Double(bottom))
        let stage = NSRect(x: page.minX, y: page.minY + top, width: page.width, height: page.height - top - bottom)
        for panel in occluders {
            let overlap = panel.intersection(stage)
            if overlap.isNull || overlap.width <= 0 || overlap.height <= 0 { continue }
            if overlap.midX >= page.midX { next.right = max(next.right, Double(page.maxX - overlap.minX)) }
            else { next.left = max(next.left, Double(overlap.maxX - page.minX)) }
        }
        insets = next
        return true
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
