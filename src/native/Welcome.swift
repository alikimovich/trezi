import AppKit
import SwiftUI

struct WelcomeRecent: Identifiable { let root: String; let name: String; var id: String { root } }
final class WelcomeModel: ObservableObject {
    @Published var busy = true
    @Published var label = "Opening Trezi…"
    @Published var recents: [WelcomeRecent] = []
    let cat = CatAnimator()
    init() { cat.update(running: true, questioning: false) }
}
struct WelcomeContent: View {
    @ObservedObject var model: WelcomeModel
    var body: some View {
        ZStack(alignment: .bottomLeading) {
            Color.clear
            VStack(spacing: 20) {
                if model.busy {
                    NativeCat(animator: model.cat).scaleEffect(1.5).padding(12)
                    Text(model.label).foregroundStyle(.secondary).multilineTextAlignment(.center)
                } else {
                    if !model.label.isEmpty { Text(model.label).foregroundStyle(.secondary).multilineTextAlignment(.center) }
                    if !model.recents.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Recent projects").font(.headline)
                            ForEach(model.recents.prefix(8)) { recent in
                                Button { emit(["event":"recent", "root":recent.root]) } label: {
                                    VStack(alignment: .leading) { Text(recent.name); Text(recent.root).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle) }
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }.buttonStyle(.plain).padding(.vertical, 4)
                            }
                        }.frame(maxWidth: 380)
                    }
                    HStack(spacing: 12) {
                        Button("Open project") { emit(["event":"menu", "action":"open-project"]) }.keyboardShortcut("o", modifiers: .command)
                        Button("New project") { emit(["event":"menu", "action":"new-project"]) }
                    }.controlSize(.large)
                }
            }.padding(32).frame(maxWidth: .infinity, maxHeight: .infinity)
            if !model.busy { NativeCat(animator: model.cat).padding(20) }
        }
    }
}
final class NativeWelcome: NSHostingView<WelcomeContent> {
    let model = WelcomeModel()
    init() { super.init(rootView: WelcomeContent(model: model)); sizingOptions = []; autoresizingMask = [.width, .height] }
    required init(rootView: WelcomeContent) { fatalError("init(rootView:) has not been implemented") }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func update(_ state: [String: Any]) {
        isHidden = !(state["visible"] as? Bool ?? false) || (state["blocked"] as? Bool ?? false)
        model.busy = state["busy"] as? Bool ?? false
        model.label = state["label"] as? String ?? ""
        model.recents = (state["recents"] as? [[String: String]] ?? []).compactMap { item in
            guard let root = item["root"], let name = item["name"] else { return nil }
            return WelcomeRecent(root: root, name: name)
        }
        model.cat.update(running: model.busy, questioning: false)
        model.cat.show(!isHidden)
    }
    func inspect() -> [String: Any] { ["visible":!isHidden, "busy":model.busy, "label":model.label, "native":true, "catFrames":CatArtwork.frames.values.reduce(0) { $0 + $1.count }] }
}
