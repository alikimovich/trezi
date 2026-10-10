import AppKit
import SwiftUI
import WebKit

/// Visible preview only. The page owns identity, selection and capture; the host owns the
/// controls and renders the scene (`ThreeDScene.swift`). Geometry is CSS px (`ThreeDState`).
struct ThreeDLayer: Identifiable {
    let id: Int
    let label: String
    let depth: Int
    let x, y, width, height: Double
    let page: Int
    let ax, ay: Double
}

/// "1 layer", "3 layers".
func threeDLayerCount(_ count: Int) -> String { "\(count) \(count == 1 ? "layer" : "layers")" }

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
    /// Camera and spacing never leave the host.
    var local: ((String, Int?) -> Void)?
    func action(_ name: String, value: Int? = nil) {
        if ["front", "reset", "separation"].contains(name) { local?(name, value); return }
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
        // The scene validates the action; only its published state moves the picker.
        Binding(get: { model.selected }, set: { value in
            model.action("layer", value: value)
        })
    }
    private var picker: some View {
        Picker(threeDLayerCount(model.layers.count), selection: layer) {
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
            Text(model.compact ? "Drag: orbit · Shift: pan · Pinch: zoom" : "Drag to orbit · Shift-drag or two fingers to pan · Pinch or scroll to zoom")
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
    let scene = ThreeDSceneView(frame: .zero)
    let backdrop = ThreeDBackdrop(frame: .zero)
    var document = ""
    var active = false
    weak var preview: WKWebView?
    var world: WKContentWorld?
    var insets = ThreeDInsets()
    /// Smoke only: the next capture fails, to exercise the fallback message.
    var failNextCapture = false
    private(set) var captures = 0
    private var closedSession = ""
    private var closedDocument = ""
    private var extent = (width: 1.0, height: 1.0, scale: 1.0, pages: 0)
    private var invalid = false
    private var capturing = false
    private var recaptureQueued = false
    private var capturedRevision = -1
    private var focusOnShow = false
    init() {
        header = ThreeDBar(rootView: ThreeDHeader(model: model))
        footer = ThreeDBar(rootView: ThreeDFooter(model: model))
        header.isHidden = true; footer.isHidden = true; scene.isHidden = true; backdrop.isHidden = true
        scene.onSelect = { [weak self] index in self?.model.action("layer", value: index) }
        model.local = { [weak self] name, value in
            guard let self else { return }
            switch name {
            case "front": scene.front()
            case "reset": scene.reset()
            default: scene.setSeparation(Double(value ?? 36))
            }
            if model.separation != scene.separation { model.separation = scene.separation }
        }
    }
    func receive(_ state: [String: Any]?, document nextDocument: String) {
        guard let state else { clear(); return }
        // Bounds mirror THREE_D_LIMITS in src/shared/three-d-contract.ts.
        func finite(_ value: Any?, _ range: ClosedRange<Double>) -> Double? {
            guard let number = value as? Double, number.isFinite, range.contains(number) else { return nil }
            return number
        }
        guard let session = state["session"] as? String, session.count <= 80, !session.isEmpty,
              let revision = state["revision"] as? Int, revision >= 0,
              let title = state["title"] as? String, title.count <= 160,
              let rows = state["layers"] as? [[String: Any]], rows.count <= 160,
              let width = finite(state["width"], 0...100000), let height = finite(state["height"], 0...100000),
              let scale = finite(state["scale"], 0.01...1),
              let pages = state["pages"] as? Int, (0...6).contains(pages),
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
                  let depth = row["depth"] as? Int, (0...18).contains(depth),
                  let x = finite(row["x"], -100000...100000), let y = finite(row["y"], -100000...100000),
                  let w = finite(row["width"], 0...100000), let h = finite(row["height"], 0...100000),
                  let page = row["page"] as? Int, (0..<pages).contains(page),
                  let ax = finite(row["ax"], 0...100000), let ay = finite(row["ay"], 0...100000) else { return }
            layers.append(ThreeDLayer(id: id, label: label, depth: depth, x: x, y: y, width: w, height: h, page: page, ax: ax, ay: ay))
        }
        let selected = state["selected"] as? Int ?? -1
        guard selected == -1 || layers.indices.contains(selected) else { return }
        let opening = !active || model.session != session || document != nextDocument
        document = nextDocument
        active = true
        if opening {
            capturedRevision = -1
            focusOnShow = true
            scene.reset(animated: false)
            scene.clearPlanes(message: "Capturing layers…")
            model.separation = scene.separation
        }
        model.session = session; model.revision = revision
        model.title = title; model.layers = layers; model.selected = selected
        model.hasSource = hasSource
        extent = (width, height, scale, pages)
        self.invalid = invalid
        model.status = invalid
            ? "This component was removed or replaced ambiguously. Return to the page and select it again."
            : threeDLayerCount(layers.count) + " · Depth shows nesting" + (limited ? " · Capture limited" : "") + (simplified ? " · Some content simplified" : "")
        if capturedRevision == revision { scene.select(selected) }
        capture()
    }
    /// One capture at a time; a newer revision recaptures when the running one ends.
    private func capture() {
        guard active, !capturing, capturedRevision != model.revision else { return }
        if invalid || model.layers.isEmpty {
            capturedRevision = model.revision
            scene.clearPlanes(message: invalid
                ? "This component was removed or replaced. Return to the page and select it again."
                : "This component has no visible layers to show in 3D.")
            return
        }
        let job = ThreeDCapture.Job(session: model.session, revision: model.revision, pages: extent.pages, scale: extent.scale, layers: model.layers)
        let size = (width: extent.width, height: extent.height)
        let finish: ([CGImage?]?) -> Void = { [weak self] images in
            guard let self else { return }
            capturing = false
            guard active, model.session == job.session else { return }
            if model.revision != job.revision || recaptureQueued { recaptureQueued = false; capture(); return }
            capturedRevision = job.revision
            captures += 1
            if let images, images.contains(where: { $0 != nil }) {
                scene.show(job.layers, images: images, width: size.width, height: size.height)
                scene.select(model.selected)
            } else {
                scene.clearPlanes(message: "Trezi couldn't capture this component's layers. Return to the page and try again, or reload the preview.")
                ProductLog.info("preview", "Exploded view capture failed")
            }
        }
        capturing = true
        if failNextCapture { failNextCapture = false; DispatchQueue.main.async { finish(nil) }; return }
        guard let preview, let world else { DispatchQueue.main.async { finish(nil) }; return }
        ThreeDCapture.run(job, view: preview, world: world, done: finish)
    }
    /// Smoke only: capture the current revision again (optionally failing it).
    func recapture(fail: Bool) {
        failNextCapture = fail; capturedRevision = -1; recaptureQueued = capturing; capture()
    }
    func clear() {
        if active { closedSession = model.session; closedDocument = document }
        if let window = header.window, ownsFocus(window.firstResponder), let preview { window.makeFirstResponder(preview) }
        active = false; document = ""; model.session = ""; model.revision = 0
        insets = ThreeDInsets(); invalid = false; capturedRevision = -1; recaptureQueued = false; failNextCapture = false
        scene.clearPlanes(message: "")
        header.isHidden = true; footer.isHidden = true; scene.isHidden = true; backdrop.isHidden = true
    }
    func dismiss() { if active { model.action("close"); clear() } }
    func ownsFocus(_ responder: NSResponder?) -> Bool {
        guard let view = responder as? NSView else { return false }
        return ([header, footer, scene] as [NSView]).contains { view === $0 || view.isDescendant(of: $0) }
    }
    @discardableResult func place(in page: NSRect, visible: Bool, occluders: [NSRect]) -> Bool {
        let show = active && visible && page.width >= 190 && page.height >= 280
        header.isHidden = !show; footer.isHidden = !show; scene.isHidden = !show; backdrop.isHidden = !show
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
        // The native scene replaces the page between the bars; islands float above it.
        scene.frame = stage; backdrop.frame = page
        scene.sideInsets = (next.left, next.right)
        if focusOnShow, let window = scene.window {
            focusOnShow = false
            let responder = window.firstResponder
            if responder == nil || responder === window || responder === preview { window.makeFirstResponder(scene) }
        }
        return true
    }
    /// Scene state for `threeDInspect` (smoke): what Core Animation actually holds.
    func inspectScene() -> [String: Any] {
        let points = scene.layers.indices.map { index -> [String: Double] in
            guard let p = scene.screenPoint(index) else { return [:] }
            return ["x": Double(p.x), "y": Double(p.y)]
        }
        return ["rendered": scene.planes.filter { $0.contents != nil && $0.superlayer != nil }.count,
                "planes": scene.planes.count, "capturedRevision": capturedRevision, "captures": captures,
                "pitch": scene.pitch, "yaw": scene.yaw, "zoom": scene.zoom, "sceneSeparation": scene.separation,
                "spacing": scene.spacing, "sceneSelected": scene.selected, "hovered": scene.hovered,
                "hoverLabel": scene.hoverText, "message": scene.message, "sceneHidden": scene.isHidden,
                "sceneRect": ["x": Double(scene.frame.minX), "y": Double(scene.frame.minY), "width": Double(scene.frame.width), "height": Double(scene.frame.height)],
                "background": scene.backgroundHex, "points": points, "countLabel": threeDLayerCount(model.layers.count),
                "atlasScale": extent.scale, "backing": Double(scene.window?.backingScaleFactor ?? 0),
                "layerWidths": scene.layers.map(\.width), "depths": scene.layers.map(\.depth),
                "imageSizes": scene.planes.map { plane -> [Int] in
                    guard let contents = plane.contents else { return [0, 0] }
                    let image = contents as! CGImage
                    return [image.width, image.height]
                }]
    }
}
