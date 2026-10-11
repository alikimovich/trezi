import AppKit
import SwiftUI

struct ChatIncident: Decodable { let `class`: String; let line: String; let detail: String }

struct ChatIncidentRow: View {
    let message: ChatMessage
    let incident: ChatIncident
    @ObservedObject var model: ChatModel
    private var expanded: Bool { model.expandedComments.contains(message.id) }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.circle").foregroundStyle(.secondary)
                Text(incident.line).font(ChatTypography.body).frame(maxWidth: .infinity, alignment: .leading)
                Button(expanded ? "Hide details" : "Details") { model.toggleComment(message.id) }
                    .buttonStyle(.link).controlSize(.small)
            }
            if expanded {
                Text(incident.detail).font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                Button("Copy details") { copyChatText(incident.detail) }.controlSize(.small)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background { RoundedRectangle(cornerRadius: ChatCommentRow.cornerRadius).fill(.quaternary.opacity(0.5)) }
    }
}

/// Foreground smoke fixture: one incident row, with the same Details toggle as a click.
extension Host {
    @MainActor
    func verifyIncidentRow(_ c: [String: Any]) async throws -> [String: Any] {
        if c["restore"] as? Bool == true { chat.model.expandedComments = []; return [:] }
        let id = c["message"] as? String ?? ""
        if c["toggle"] as? Bool == true { chat.model.toggleComment(id) }
        chat.model.pressLatest()
        var last: CGRect = .zero
        for _ in 0..<60 {
            try await Task.sleep(nanoseconds: 50_000_000)
            let frame = chat.model.messageFrames[id] ?? .zero
            if frame == last && frame != .zero { break }
            last = frame
        }
        let reading = NSRect(x: 0, y: 0, width: chat.bounds.width, height: max(1, chat.bounds.height - chat.model.bottomInset))
        let captured = try await captureVisibleRegion(window: window, view: chat, region: reading, recognize: false)
        let frame = chat.model.messageFrames[id] ?? .zero
        return ["png": captured["png"] ?? "", "frame": NSStringFromRect(frame),
                "inView": frame.height > 0 && frame.maxY > 0 && frame.minY < reading.height,
                "expanded": chat.model.expandedComments.contains(id)]
    }
}
