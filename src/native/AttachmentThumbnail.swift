import AppKit
import ImageIO

/// Shared by the composer strip and the sent bubble (LKM-166): compact square
/// cells, the image fitted inside with its aspect ratio, and a checkerboard behind
/// images with transparency (SVG, most PNGs) so dark artwork stays visible.
enum AttachmentThumbnail {
    /// Cell side in points, in both the composer and the sent bubble.
    static let side: CGFloat = 72
    /// Thumbnails decode at 2x the cell for Retina.
    static let pixels = Int(side * 2)

    /// Raster formats decode with ImageIO. Anything else NSImage reads (SVG on
    /// macOS 14+) is drawn at `maxPixels` on its longer side, so a vector with a
    /// tiny or huge intrinsic size still yields a bounded, sharp bitmap.
    static func image(_ data: Data?, maxPixels: Int) -> CGImage? {
        guard let data, !data.isEmpty else { return nil }
        if let source = CGImageSourceCreateWithData(data as CFData, nil),
           let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
               kCGImageSourceCreateThumbnailFromImageAlways: true,
               kCGImageSourceCreateThumbnailWithTransform: true,
               kCGImageSourceThumbnailMaxPixelSize: maxPixels
           ] as CFDictionary) { return image }
        guard let vector = NSImage(data: data), vector.size.width > 0, vector.size.height > 0 else { return nil }
        let scale = CGFloat(maxPixels) / max(vector.size.width, vector.size.height)
        let width = max(1, Int((vector.size.width * scale).rounded())), height = max(1, Int((vector.size.height * scale).rounded()))
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
        vector.draw(in: NSRect(x: 0, y: 0, width: width, height: height))
        NSGraphicsContext.restoreGraphicsState()
        return context.makeImage()
    }
    /// The payload of a `data:image/…;base64,` URL.
    static func data(url: String?) -> Data? {
        guard let url, url.hasPrefix("data:image/"), let comma = url.firstIndex(of: ",") else { return nil }
        return Data(base64Encoded: String(url[url.index(after: comma)...]))
    }
    static func hasAlpha(_ image: CGImage) -> Bool {
        ![.none, .noneSkipFirst, .noneSkipLast].contains(image.alphaInfo)
    }
    /// A checkerboard tile of 6 pt squares for the current appearance.
    static func checkerboard(dark: Bool) -> NSImage {
        let cell: CGFloat = 6
        return NSImage(size: NSSize(width: cell * 2, height: cell * 2), flipped: false) { rect in
            NSColor(white: dark ? 0.24 : 1, alpha: 1).setFill(); rect.fill()
            NSColor(white: dark ? 0.32 : 0.88, alpha: 1).setFill()
            NSRect(x: 0, y: 0, width: cell, height: cell).fill()
            NSRect(x: cell, y: cell, width: cell, height: cell).fill()
            return true
        }
    }
}

/// The AppKit checkerboard behind a transparent composer thumbnail.
final class CheckerboardView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        NSColor(patternImage: AttachmentThumbnail.checkerboard(dark: dark)).setFill()
        dirtyRect.fill()
    }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
}

/// What the composer hands the chat for one picked or pasted file (LKM-166). The bytes
/// are what the provider can take, never more: an oversized raster is downscaled, and
/// a format the provider cannot read (SVG, HEIC, TIFF…) is rasterized to a PNG
/// `preview` while the chat keeps the original on disk by path. Nothing here refuses
/// an attachment; a file that cannot be previewed is handed over as a plain file.
enum AttachmentPayload {
    /// The formats providers read as images (`IMAGE_TYPES` in provider-policy.ts).
    static let providerTypes: Set<String> = ["image/png", "image/jpeg", "image/gif", "image/webp"]
    /// Longer side of the PNG preview that stands in for an unreadable format.
    static let previewPixels = 512
    /// One inline image's raw size, so several still fit the turn's 20 MiB of base64.
    static let inlineBytes = 7 * 1024 * 1024
    /// Files larger than this are referenced by path instead of read into memory.
    static let readBytes = 64 * 1024 * 1024
    static let downscaleSteps = [2048, 1536, 1024, 768, 512]

    static func png(_ image: CGImage) -> Data? {
        NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
    }
    static func jpeg(_ image: CGImage) -> Data? {
        NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.85])
    }
    /// The raster re-encoded with a longer side of at most `maxPixels`, or nil.
    static func downscaled(_ data: Data, type: String, maxPixels: Int) -> (type: String, data: Data)? {
        guard let image = AttachmentThumbnail.image(data, maxPixels: maxPixels) else { return nil }
        if type == "image/jpeg", let encoded = jpeg(image) { return (type, encoded) }
        return png(image).map { ("image/png", $0) }
    }
    static func plainFile(path: String, name: String) -> [String: String] {
        ["path": path, "name": name, "type": "application/octet-stream", "data": ""]
    }
    /// The `files` action entry for an image's bytes. `path` is "" for a pasted image.
    static func file(path: String, name: String, type: String, data: Data) -> [String: String] {
        let mime = type.lowercased()
        if providerTypes.contains(mime) {
            if data.count <= inlineBytes { return ["path": path, "name": name, "type": mime, "data": data.base64EncodedString()] }
            for pixels in downscaleSteps {
                if let small = downscaled(data, type: mime, maxPixels: pixels), small.data.count <= inlineBytes {
                    return ["path": path, "name": name, "type": small.type, "data": small.data.base64EncodedString()]
                }
            }
            return plainFile(path: path, name: name)
        }
        guard let preview = image(preview: data) else { return plainFile(path: path, name: name) }
        return ["path": path, "name": name, "type": mime, "data": data.count <= inlineBytes ? data.base64EncodedString() : "",
                "preview": preview.base64EncodedString()]
    }
    static func image(preview data: Data) -> Data? {
        AttachmentThumbnail.image(data, maxPixels: previewPixels).flatMap(png)
    }
}
