import AppKit
import SwiftUI

/// A problem Trezi's check of the preview found after a turn landed (LKM-195, LKM-210,
/// `NativeChatMessage.landingCheck`). A passing check has no row.
struct ChatLandingCheck: Decodable { let problem: String; let line: String; let errors: [String] }

/// One compact warning row: the reason, the first console errors or the dev server's
/// message (page text, shown as data), and Ask agent to fix / Show preview.
struct ChatLandingCheckRow: View {
    let message: ChatMessage
    let check: ChatLandingCheck
    @ObservedObject var model: ChatModel
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle").font(.system(size: 12, weight: .semibold)).foregroundStyle(.orange)
                .frame(height: 17).accessibilityLabel("Warning")
            VStack(alignment: .leading, spacing: 4) {
                Text(check.line).font(ChatTypography.body).lineLimit(1).truncationMode(.tail).help(check.line)
                ForEach(Array(check.errors.enumerated()), id: \.offset) { _, error in
                    Text(error).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
                        .lineLimit(2).truncationMode(.tail).textSelection(.enabled)
                }
                HStack(spacing: 8) {
                    Button("Ask agent to fix") { model.action("landing-fix", id: message.id) }
                    Button("Show preview") { model.action("landing-preview", id: message.id) }
                }.controlSize(.small).padding(.top, 2)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background { RoundedRectangle(cornerRadius: ChatCommentRow.cornerRadius).fill(.quaternary.opacity(0.5)) }
        .accessibilityElement(children: .contain)
        .help(messageTime(message.at))
    }
}

/// LKM-195 verification (test profile): the chat scrolled to its end in a forced light or
/// dark window appearance (the window's own, never the system's), captured in the foreground.
extension Host {
    @MainActor
    func verifyLandingChecks(_ c: [String: Any]) async throws -> [String: Any] {
        if c["restore"] as? Bool == true { window.appearance = nil; return [:] }
        if let dark = c["dark"] as? Bool { window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua) }
        let ids = c["messages"] as? [String] ?? []
        chat.model.pressLatest()
        // Settled: every row is laid out and holds its frame across two samples.
        var last: [CGRect] = []
        for _ in 0..<60 {
            try await Task.sleep(nanoseconds: 50_000_000)
            let frames = ids.map { chat.model.messageFrames[$0] ?? .zero }
            if frames == last && !frames.contains(.zero) { break }
            last = frames
        }
        let reading = NSRect(x: 0, y: 0, width: chat.bounds.width, height: max(1, chat.bounds.height - chat.model.bottomInset))
        let captured = try await captureVisibleRegion(window: window, view: chat, region: reading, recognize: false)
        let rows: [[String: Any]] = ids.map { id in
            let frame = chat.model.messageFrames[id] ?? .zero
            return ["id": id, "frame": NSStringFromRect(frame), "inView": frame.height > 0 && frame.maxY > 0 && frame.minY < reading.height]
        }
        return ["png": captured["png"] ?? "", "appearance": window.effectiveAppearance.name.rawValue,
                "readingHeight": Double(reading.height), "rows": rows]
    }
}
