import AppKit
import SwiftUI

// LKM-139: the conversation's follow-latest path (ChatConversation) in a real
// offscreen NSHostingView: a LazyVStack whose row heights the stack must
// estimate, the AppKit probe pinning it, and ChatLatestSettle. Transcripts of
// long answers with a short tail (and a send inserting short rows) make the
// estimates far off, so the AppKit pin's long jump leaves the viewport with no
// realized rows. `--no-settle` runs the same view without the settle (the
// pre-fix behaviour) as the negative control. Prints one JSON summary.
let settles = !CommandLine.arguments.contains("--no-settle")
struct Row: Identifiable, Equatable { let id: String; var height: CGFloat }
final class Model: ObservableObject {
    @Published var rows: [Row] = []
    @Published var followRevision = 0
    @Published var inset: CGFloat = 120
    @Published var chat = ""
    var frames: [String: CGRect] = [:]
    var bottom: CGFloat = 0
    var settleAttempts = 0
}
struct Frames: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) { value.merge(nextValue()) { _, new in new } }
}
struct Bottom: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
struct Conversation: View {
    @ObservedObject var model: Model
    @State private var follows = true
    @State private var pinRequest = 0
    @State private var attachRequest = 0
    @State private var latestGeneration = 0
    @State private var settlingLatest = false
    @State private var realizingLatest = false
    @State private var latestNudge = false
    @State private var viewportHeight: CGFloat = 0
    private func settleLatest(_ proxy: ScrollViewProxy) {
        guard settles else { return }
        latestGeneration += 1
        guard !settlingLatest else { return }
        settlingLatest = true
        Task { @MainActor in
            let readingHeight = { max(1, viewportHeight - model.inset) }
            var stuck = 0, unresolved = 0
            model.settleAttempts = await ChatLatestSettle.follow(request: { latestGeneration }, current: { follows }, step: {
                ChatLatestSettle.step(latest: model.rows.last?.id, frames: model.frames, bottom: model.bottom,
                                      readingHeight: readingHeight(), viewportHeight: viewportHeight)
            }) { step in
                unresolved = step == .bottom ? unresolved + 1 : 0
                let action = ChatLatestSettle.escalated(step, unresolved: unresolved)
                if case .realize(let id) = action {
                    realizingLatest = true; latestNudge.toggle(); stuck += 1
                    let target = ChatLatestSettle.realizeTarget(latest: id, first: model.rows.first?.id, stuck: stuck)
                    proxy.scrollTo(target.id, anchor: target.anchor)
                } else {
                    stuck = 0; realizingLatest = false
                    if action == .relayout { latestNudge.toggle() }
                    pinRequest += 1
                }
            }
            settlingLatest = false; realizingLatest = false
            if latestNudge { latestNudge = false }
            if follows { pinRequest += 1 }
        }
    }
    var body: some View {
        GeometryReader { viewport in
            ScrollViewReader { proxy in
                let anchor = UnitPoint(x: 0.5, y: max(1, viewport.size.height - model.inset) / max(1, viewport.size.height))
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 20) {
                        ForEach(model.rows) { row in
                            Text(row.id).frame(maxWidth: .infinity, minHeight: row.height, maxHeight: row.height, alignment: .topLeading).id(row.id)
                                .background(GeometryReader { geometry in Color.clear.preference(key: Frames.self, value: [row.id: geometry.frame(in: .named("scroll"))]) })
                        }
                        Color.clear.frame(height: latestNudge ? 2 : 1).id("bottom")
                            .background(GeometryReader { geometry in Color.clear.preference(key: Bottom.self, value: geometry.frame(in: .named("scroll")).maxY) })
                    }.padding(.horizontal, 18).padding(.top, 18).padding(.bottom, model.inset - (latestNudge ? 1 : 0))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(ChatScrollStyle(follows: { follows }, pinRequest: pinRequest, attachRequest: attachRequest,
                                                    onPinnedChange: { follows = $0 }, onMovedToEnd: { if follows { settleLatest(proxy) } },
                                                    holdsPin: { realizingLatest }))
                }
                .coordinateSpace(name: "scroll")
                .onPreferenceChange(Frames.self) { model.frames = $0 }
                .onPreferenceChange(Bottom.self) { model.bottom = $0 }
                .onAppear { viewportHeight = viewport.size.height }
                .onChange(of: viewport.size) { size in viewportHeight = size.height; if follows { pinRequest += 1 } }
                .onChange(of: model.inset) { _ in if follows { pinRequest += 1 } }
                .onChange(of: model.followRevision) { _ in if follows { proxy.scrollTo("bottom", anchor: anchor); pinRequest += 1; settleLatest(proxy) } }
                .onChange(of: model.chat) { _ in follows = true; proxy.scrollTo("bottom", anchor: anchor); attachRequest += 1; settleLatest(proxy) }
            }
        }
    }
}

// LKM-149: `--cases` prints the settle decision and footer heights for fixed
// inputs (no window), so the test pins the conditions themselves.
if CommandLine.arguments.contains("--cases") {
    let rows = ["old": CGRect(x: 0, y: 100, width: 400, height: 154), "latest": CGRect(x: 0, y: 274, width: 400, height: 74)]
    func step(_ frames: [String: CGRect], bottom: CGFloat) -> String {
        switch ChatLatestSettle.step(latest: "latest", frames: frames, bottom: bottom, readingHeight: 570, viewportHeight: 776) {
        case .settled: return "settled"
        case .bottom: return "bottom"
        case .relayout: return "relayout"
        case .realize(let id): return "realize:\(id)"
        }
    }
    var below = rows; below["latest"] = CGRect(x: 0, y: 1144, width: 400, height: 74)
    var unrealized = rows; unrealized["latest"] = nil
    let escalations = (0...6).map { unresolved -> String in
        ChatLatestSettle.escalated(.bottom, unresolved: unresolved) == .bottom ? "bottom" : "relayout"
    }
    let cases: [String: Any] = [
        "atEdge": step(rows, bottom: 369), "markerBelow": step(rows, bottom: 900),
        // The failure on candidate: the marker read at the edge, the latest row 650 pt below it.
        "latestBelowEdge": step(below, bottom: 560), "latestUnrealized": step(unrealized, bottom: 560),
        "noRowInView": step(["old": CGRect(x: 0, y: 900, width: 400, height: 154)], bottom: 0),
        "escalations": escalations,
        "settledEscalates": ChatLatestSettle.escalated(.settled, unresolved: 3) == .settled,
        "footer": ["history": ChatLayout.footerHeight(running: false, latest: false), "latestDone": ChatLayout.footerHeight(running: false, latest: true),
                   "running": ChatLayout.footerHeight(running: true, latest: true), "runningNotLast": ChatLayout.footerHeight(running: true, latest: false)]
    ]
    print(String(data: try! JSONSerialization.data(withJSONObject: cases, options: [.sortedKeys]), encoding: .utf8)!)
    exit(0)
}

_ = NSApplication.shared
NSApp.setActivationPolicy(.accessory)
let model = Model()
let window = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: 440, height: 776), styleMask: [.titled], backing: .buffered, defer: false)
let host = NSHostingView(rootView: Conversation(model: model))
window.contentView = host
window.orderFront(nil)
func spin(_ seconds: Double) {
    let end = Date(timeIntervalSinceNow: seconds)
    while Date() < end { RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.016)) }
}
func scrollView() -> NSScrollView? {
    func find(_ view: NSView) -> NSScrollView? { (view as? NSScrollView) ?? view.subviews.lazy.compactMap(find).first }
    return find(host)
}
var samples: [[String: Any]] = []
var scenario = ""
func sample(_ phase: String) {
    spin(0.6)
    guard let scroll = scrollView() else { samples.append(["scenario": scenario, "phase": phase, "visibleRows": 0]); return }
    // Leaf layers in the viewport: what is drawn, independent of preferences.
    var drawnLayers = 0
    if let layer = scroll.documentView?.layer, let clip = scroll.contentView.layer {
        func walk(_ layer: CALayer) {
            if layer.sublayers == nil || layer.contents != nil {
                let rect = layer.convert(layer.bounds, to: clip)
                if rect.width > 0, rect.height > 0, rect.intersects(clip.bounds) { drawnLayers += 1 }
            }
            layer.sublayers?.forEach(walk)
        }
        walk(layer)
    }
    let metrics = ChatScrollStyleProbe.metrics(scroll)
    let reading = host.bounds.height - model.inset
    let visible = model.frames.filter { $0.value.maxY > 0 && $0.value.minY < reading }.map(\.key)
    samples.append(["scenario": scenario, "phase": phase, "visibleRows": visible.count, "drawnLayers": drawnLayers, "settleAttempts": model.settleAttempts,
                    "latestVisible": model.rows.last.map { visible.contains($0.id) } ?? false,
                    // LKM-149: settled means the latest row ends at the reading edge, not below it.
                    "latestAboveEdge": model.rows.last.flatMap { model.frames[$0.id] }.map { $0.maxY <= reading + 1 } ?? false,
                    "offset": metrics["offset"] ?? 0, "maxOffset": metrics["maxOffset"] ?? 0])
}
var chats = 0
func load(_ name: String, _ heights: [CGFloat]) {
    scenario = name; chats += 1
    model.rows = heights.enumerated().map { Row(id: "\(name)-\($0.offset)", height: $0.element) }
    model.chat = "chat-\(chats)"; model.followRevision += 1
    sample("load")
}
/// ChatController.run: the prompt and an empty reply in one update, then chunks.
func send(insetTo inset: CGFloat? = nil) {
    model.rows += [Row(id: "\(scenario)-prompt", height: 40), Row(id: "\(scenario)-reply", height: 15)]
    if let inset { model.inset = inset }
    model.followRevision += 1
    sample("sent")
    for chunk in 1...10 {
        model.rows[model.rows.count - 1].height = CGFloat(15 + chunk * 30); model.followRevision += 1; spin(0.03)
        if chunk == 5 { sample("mid-stream") }
    }
    sample("streamed")
}
let tail = Array(repeating: CGFloat(20), count: 10)
load("long-answers", Array(repeating: 2000, count: 40) + tail); send()
load("longer-answers", Array(repeating: 3000, count: 60) + tail); send()
let mixed: [CGFloat] = [40, 300, 1200, 60, 2500, 20]
load("mixed-grown-composer", (0..<80).map { mixed[$0 % mixed.count] }); model.inset = 420; model.followRevision += 1; sample("grown"); send(insetTo: 120)
model.inset = 120
let blanks = samples.filter { ($0["visibleRows"] as? Int ?? 0) == 0 }.count
let overs = samples.filter { ($0["offset"] as? CGFloat ?? 0) > ($0["maxOffset"] as? CGFloat ?? 0) + 1 }.count
let summary: [String: Any] = ["settles": settles, "blanks": blanks, "overs": overs, "samples": samples]
print(String(data: try! JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys]), encoding: .utf8)!)
