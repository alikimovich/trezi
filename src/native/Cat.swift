import AppKit
import SwiftUI

struct CatFrame: Decodable { let duration: Double; let pixels: [[Double]] }
enum CatArtwork {
    static let frames: [String: [CatFrame]] = {
        guard let url = Bundle.main.url(forResource: "cat", withExtension: "json"),
              let data = try? Data(contentsOf: url), let result = try? JSONDecoder().decode([String: [CatFrame]].self, from: data) else { return [:] }
        return result
    }()
}
final class CatAnimator: ObservableObject {
    @Published var pose = "rest"
    @Published var frame = 0
    private var timer: Timer?
    private var mode = "rest"
    private var visible = false
    var pixels: [[Double]] { CatArtwork.frames[pose]?[safe: frame]?.pixels ?? [] }
    var label: String { mode == "think" ? "Waiting for your answer" : mode == "run" ? "Working…" : pose == "jump" ? "Task complete" : "Idle" }
    func update(running: Bool, questioning: Bool, completed: Bool = false) {
        let next = questioning ? "think" : running ? "run" : "rest"
        guard next != mode || completed else { return }
        mode = next; play(completed && next == "rest" ? "jump" : next)
    }
    func show(_ value: Bool) {
        guard visible != value else { return }
        visible = value
        if value { play(mode) } else { timer?.invalidate(); timer = nil }
    }
    private func play(_ next: String, index: Int = 0) {
        timer?.invalidate(); timer = nil
        pose = next; frame = index
        guard visible, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
        if next == "rest" {
            timer = Timer.scheduledTimer(withTimeInterval: 20, repeats: false) { [weak self] _ in self?.play("idle") }
            return
        }
        guard let frames = CatArtwork.frames[next], !frames.isEmpty else { return }
        timer = Timer.scheduledTimer(withTimeInterval: max(0.04, frames[index].duration / 1000), repeats: false) { [weak self] _ in
            guard let self else { return }
            if index + 1 < frames.count { self.play(next, index: index + 1) }
            else { self.play(next == "run" || next == "think" ? next : self.mode) }
        }
    }
    deinit { timer?.invalidate() }
}
private extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
struct NativeCat: View {
    @ObservedObject var animator: CatAnimator
    var size: CGFloat = 32
    var body: some View {
        SwiftUI.Canvas { context, size in
            var path = Path()
            for pixel in animator.pixels where pixel.count == 4 {
                path.addRect(CGRect(x: pixel[0] * size.width / 32, y: pixel[1] * size.height / 32, width: pixel[2] * size.width / 32, height: pixel[3] * size.height / 32))
            }
            context.fill(path, with: .color(.secondary))
        }.frame(width: size, height: size).accessibilityLabel(animator.label)
            .onAppear { animator.show(true) }.onDisappear { animator.show(false) }
    }
}
