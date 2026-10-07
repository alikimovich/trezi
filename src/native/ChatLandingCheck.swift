import AppKit
import SwiftUI

/// Trezi's check of the preview after a turn landed (LKM-195, `NativeChatMessage.landingCheck`).
struct ChatLandingCheck: Decodable { let status: String; let line: String; let errors: [String]; let thumbnail: String? }

/// One compact row: a status symbol, "Checked after landing: …", the first console errors
/// (page text, shown as data) and a thumbnail of the preview, in the comment rows' bubble.
struct ChatLandingCheckRow: View {
    let message: ChatMessage
    let check: ChatLandingCheck
    static let thumbnailSize = CGSize(width: 64, height: 40)
    private static let cache = NSCache<NSString, CGImage>()
    private var thumbnail: CGImage? {
        guard check.thumbnail != nil else { return nil }
        if let image = Self.cache.object(forKey: message.id as NSString) { return image }
        guard let image = AttachmentThumbnail.image(AttachmentThumbnail.data(url: check.thumbnail), maxPixels: Int(Self.thumbnailSize.width * 2)) else { return nil }
        Self.cache.setObject(image, forKey: message.id as NSString)
        return image
    }
    private var symbol: (name: String, color: Color) {
        switch check.status {
        case "clean": return ("checkmark.circle", .green)
        case "errors": return ("exclamationmark.triangle", .orange)
        default: return ("eye.slash", .secondary)
        }
    }
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: symbol.name).font(.system(size: 12, weight: .semibold)).foregroundStyle(symbol.color)
                .frame(height: 17)
            VStack(alignment: .leading, spacing: 4) {
                Text(check.line).font(ChatTypography.body).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                ForEach(Array(check.errors.enumerated()), id: \.offset) { _, error in
                    Text(error).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
                        .lineLimit(2).truncationMode(.tail).textSelection(.enabled)
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
            if let thumbnail {
                Image(decorative: thumbnail, scale: 1).resizable().interpolation(.high).scaledToFill()
                    .frame(width: Self.thumbnailSize.width, height: Self.thumbnailSize.height).clipped()
                    .clipShape(RoundedRectangle(cornerRadius: 5))
                    .overlay { RoundedRectangle(cornerRadius: 5).strokeBorder(.quaternary) }
                    .help("The preview after landing")
                    .accessibilityLabel("Preview after landing")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background { RoundedRectangle(cornerRadius: ChatCommentRow.cornerRadius).fill(.quaternary.opacity(0.5)) }
        .accessibilityElement(children: .combine)
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
