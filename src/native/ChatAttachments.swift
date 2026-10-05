import AppKit
import SwiftUI

/// A sent message's attachments (LKM-166): compact thumbnails and file chips in a
/// row that wraps, above the message text. Hover names the file; a click opens a
/// larger preview in a popover.
struct SentAttachments: View {
    let attachments: [ChatAttachment]
    @ObservedObject var model: ChatModel
    var body: some View {
        AttachmentFlow(spacing: 6) {
            ForEach(attachments) { attachment in
                Group {
                    if let thumbnail = SentThumbnails.shared.thumbnail(attachment) {
                        SentAttachmentThumbnail(attachment: attachment, thumbnail: thumbnail, model: model)
                    } else {
                        Label(attachment.name ?? "Attachment", systemImage: "doc").font(.caption).lineLimit(1).truncationMode(.middle)
                            .padding(.horizontal, 8).padding(.vertical, 6).frame(maxWidth: 200, alignment: .leading)
                            .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                            .help(attachment.path.flatMap { $0.isEmpty ? nil : $0 } ?? attachment.name ?? "Attachment")
                    }
                }.background(GeometryReader { geometry in
                    Color.clear.preference(key: AttachmentFrames.self, value: [attachment.id:geometry.frame(in: .named("chatScroll"))])
                })
            }
        }
    }
}
/// Rows left to right, wrapping at the proposed width. It reports the widest row,
/// so a single small attachment leaves the bubble narrow.
struct AttachmentFlow: Layout {
    var spacing: CGFloat
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(subviews, width: proposal.width ?? .infinity).reduce(.zero) { CGSize(width: max($0.width, $1.maxX), height: max($0.height, $1.maxY)) }
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (subview, frame) in zip(subviews, arrange(subviews, width: bounds.width)) {
            subview.place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY), proposal: ProposedViewSize(frame.size))
        }
    }
    private func arrange(_ subviews: Subviews, width: CGFloat) -> [CGRect] {
        var frames: [CGRect] = []
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0
        for subview in subviews {
            var size = subview.sizeThatFits(.unspecified)
            size.width = min(size.width, width)
            if x > 0, x + size.width > width { x = 0; y += row + spacing; row = 0 }
            frames.append(CGRect(origin: CGPoint(x: x, y: y), size: size))
            x += size.width + spacing; row = max(row, size.height)
        }
        return frames
    }
}
struct AttachmentFrames: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) { value.merge(nextValue()) { _, new in new } }
}
/// Decoded once per attachment: the bubble re-renders on every streamed update,
/// and an image URL carries megabytes of base64.
final class SentThumbnails {
    static let shared = SentThumbnails()
    final class Entry { let image: CGImage; let alpha: Bool; init(_ image: CGImage) { self.image = image; alpha = AttachmentThumbnail.hasAlpha(image) } }
    private let cache = NSCache<NSString, Entry>()
    func thumbnail(_ attachment: ChatAttachment) -> Entry? {
        if let entry = cache.object(forKey: attachment.id as NSString) { return entry }
        guard let image = AttachmentThumbnail.image(AttachmentThumbnail.data(url: attachment.url), maxPixels: AttachmentThumbnail.pixels) else { return nil }
        let entry = Entry(image); cache.setObject(entry, forKey: attachment.id as NSString)
        return entry
    }
}
/// Transparent images sit on a checkerboard, opaque ones on a neutral fill.
private struct ThumbnailBackground: View {
    let alpha: Bool
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        if alpha { Image(nsImage: AttachmentThumbnail.checkerboard(dark: scheme == .dark)).resizable(resizingMode: .tile) }
        else { Color(nsColor: .controlBackgroundColor) }
    }
}
private struct SentAttachmentThumbnail: View {
    let attachment: ChatAttachment
    let thumbnail: SentThumbnails.Entry
    @ObservedObject var model: ChatModel
    private var name: String { attachment.name ?? "Image" }
    private var presented: Binding<Bool> {
        Binding(get: { model.attachmentPreview == attachment.id },
                set: { if !$0 && model.attachmentPreview == attachment.id { model.attachmentPreview = nil } })
    }
    var body: some View {
        let side = AttachmentThumbnail.side
        Button { model.attachmentPreview = attachment.id } label: {
            Image(decorative: thumbnail.image, scale: 2).resizable().interpolation(.high).scaledToFit()
                .frame(width: side, height: side)
                .background(ThumbnailBackground(alpha: thumbnail.alpha))
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color(nsColor: .separatorColor)))
                .contentShape(RoundedRectangle(cornerRadius: 10))
        }.buttonStyle(.plain)
            .help(name).accessibilityLabel("Preview " + name)
            .popover(isPresented: presented, arrowEdge: .bottom) { SentAttachmentPreview(name: name, url: attachment.url) }
    }
}
private struct SentAttachmentPreview: View {
    let name: String
    let image: CGImage?
    init(name: String, url: String?) {
        self.name = name
        image = AttachmentThumbnail.image(AttachmentThumbnail.data(url: url), maxPixels: 1600)
    }
    var body: some View {
        VStack(spacing: 8) {
            if let image {
                let scale = min(1, 480 / CGFloat(image.width), 360 / CGFloat(image.height))
                Image(decorative: image, scale: 1).resizable().interpolation(.high).scaledToFit()
                    .frame(width: max(80, CGFloat(image.width) * scale), height: max(80, CGFloat(image.height) * scale))
                    .background(ThumbnailBackground(alpha: AttachmentThumbnail.hasAlpha(image)))
            }
            Text(name).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
        }.padding(12).frame(maxWidth: 520)
    }
}
