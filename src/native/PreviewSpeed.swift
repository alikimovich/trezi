import AppKit
import SwiftUI
import WebKit

/// Preview slow motion (LKM-206). `slow-motion.js` runs in the page's own world at document
/// start and scales its clock and animations (`src/preview/slow-motion.ts`). The session's
/// speed is baked into the registered script, so a reload or navigation starts at that
/// speed; the open document follows a change through the isolated world (`speed-control.ts`),
/// never through a host evaluation that could land mid-navigation.
extension Host {
    func installPreviewScripts(_ controller: WKUserContentController, speed: Double) {
        controller.removeAllUserScripts()
        PreviewAgent.install(controller)
        let preview = (try? String(contentsOfFile: directory + "/preview.js", encoding: .utf8)) ?? ""
        // Selection must intercept input before the project's capture listeners.
        controller.addUserScript(WKUserScript(source: preview, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: world))
        let slow = (try? String(contentsOfFile: directory + "/slow-motion.js", encoding: .utf8)) ?? ""
        controller.addUserScript(WKUserScript(source: "{const __treziSpeed = \(speed);\n\(slow)\n}", injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        let canvas = (try? String(contentsOfFile: directory + "/states-canvas.js", encoding: .utf8)) ?? ""
        controller.addUserScript(WKUserScript(source: canvas, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
    }
    func setPreviewSpeed(_ c: [String: Any]) {
        let speed = c["speed"] as? Double ?? 1
        guard speed.isFinite, speed >= 0, speed <= 1, speed != speedBadge.speed else { return }
        speedBadge.speed = speed
        if let controller = views["preview"]?.configuration.userContentController { installPreviewScripts(controller, speed: speed) }
        shell.updateSpeed(speed)
        nativeLayout.layout()
    }
}

/// "1×", "0.25×" or "Paused", as the toolbar menu and the badge show it.
func previewSpeedLabel(_ speed: Double) -> String {
    speed == 0 ? "Paused" : (speed == speed.rounded() ? String(Int(speed)) : String(speed)) + "×"
}

struct PreviewSpeedContent: View {
    let label: String
    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "tortoise.fill").accessibilityHidden(true)
            Text(label).font(.system(size: 11, weight: .semibold)).monospacedDigit()
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 9).padding(.vertical, 4)
        .background(Color.accentColor, in: Capsule())
        .shadow(color: .black.opacity(0.18), radius: 4, y: 1)
        .fixedSize()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Preview slow motion \(label)")
    }
}

/// The badge on the page's bottom-left corner while the preview is slowed or paused. It
/// takes no input, so it needs no page shield (`PreviewCover.swift`).
final class NativePreviewSpeed: NSHostingView<PreviewSpeedContent> {
    var speed: Double = 1 { didSet { rootView = PreviewSpeedContent(label: previewSpeedLabel(speed)) } }
    init() { super.init(rootView: PreviewSpeedContent(label: "1×")); sizingOptions = []; isHidden = true }
    required init(rootView: PreviewSpeedContent) { fatalError("init(rootView:) has not been implemented") }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func place(in page: NSRect, visible: Bool) {
        isHidden = speed == 1 || !visible || page.width < 120
        guard !isHidden else { return }
        let size = fittingSize
        frame = NSRect(x: page.minX + 10, y: page.maxY - size.height - 10, width: size.width, height: size.height)
    }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    func inspect() -> [String: Any] { ["visible":!isHidden, "speed":speed, "label":previewSpeedLabel(speed), "frame":NSStringFromRect(frame)] }
}
