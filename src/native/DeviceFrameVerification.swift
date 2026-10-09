import AppKit

/// Test captures of the mobile page's four screen corners in the bezel (LKM-217).
extension Host {
    /// A square around each corner of the page, in canvas coordinates, reaching past the
    /// end of the corner's curve and a little into the bezel.
    func deviceCornerRegions() -> [(String, NSRect)] {
        let page = views["preview"]?.frame ?? .zero, pad: CGFloat = 10
        let side = min(page.width / 2, page.height / 2, nativeLayout.pageRadius * 1.6 + 8) + pad
        return [("top-left", NSRect(x: page.minX - pad, y: page.minY - pad, width: side, height: side)),
                ("top-right", NSRect(x: page.maxX + pad - side, y: page.minY - pad, width: side, height: side)),
                ("bottom-left", NSRect(x: page.minX - pad, y: page.maxY + pad - side, width: side, height: side)),
                ("bottom-right", NSRect(x: page.maxX + pad - side, y: page.maxY + pad - side, width: side, height: side))]
    }
    /// PNGs of the four corners: from the visible window, or offscreen (reduced coverage:
    /// an offscreen cache does not paint WebKit's page) when `foreground` is false.
    func captureDeviceCorners(foreground: Bool) async throws -> [String: Any] {
        var corners: [String: Any] = [:]
        for (name, region) in deviceCornerRegions() {
            if foreground {
                corners[name] = try await captureVisibleRegion(window: window, view: canvas, region: region, recognize: false)["png"]
            } else if let bitmap = canvas.bitmapImageRepForCachingDisplay(in: region) {
                canvas.cacheDisplay(in: region, to: bitmap)
                corners[name] = bitmap.representation(using: .png, properties: [:])?.base64EncodedString() ?? ""
            }
        }
        return ["corners": corners, "regions": deviceCornerRegions().map { ["name": $0.0, "frame": NSStringFromRect($0.1)] }]
    }
}
