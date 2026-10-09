import AppKit

/// The device bezel around the mobile preview (LKM-217). The screen opening and its
/// corner radius are measured from the asset's alpha, never fixed numbers, so the page
/// sits exactly in the opening and is clipped with the same continuous corner at any scale.
struct DeviceFrame {
    /// Every frame the mobile viewport offers: a name and its asset next to the host binary.
    static let offered = [("iphone-16-pro", "device.png")]
    /// A continuous (squircle) corner of radius r cuts `cut · r²` from a square corner;
    /// measured from CALayer's `.continuous` curve (a circular arc cuts 1 − π/4 ≈ 0.2146).
    static let cut: CGFloat = 0.2254
    let name: String
    let image: NSImage?
    /// The asset's pixel size, its screen opening in asset pixels from the top-left, and the
    /// opening's continuous corner radius in asset pixels.
    let size: NSSize, screen: NSRect, radius: CGFloat

    static func load(_ name: String, path: String) -> DeviceFrame? {
        guard let image = NSImage(contentsOfFile: path), let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
              let measured = measure(cg) else { return nil }
        return DeviceFrame(name: name, image: image, size: NSSize(width: cg.width, height: cg.height), screen: measured.screen, radius: measured.radius)
    }

    /// Walks out from the centre summing each pixel's transparency until the bezel is opaque,
    /// so anti-aliased edges count by coverage. Each corner's radius follows from the area
    /// its curve cuts from the opening's bounding rectangle.
    static func measure(_ image: CGImage) -> (screen: NSRect, radius: CGFloat)? {
        let w = image.width, h = image.height
        guard w > 16, h > 16, let context = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let data = context.data?.assumingMemoryBound(to: UInt8.self) else { return nil }
        // Bitmap row 0 is the top of the image.
        func alpha(_ x: Int, _ y: Int) -> UInt8 { data[(y * w + x) * 4 + 3] }
        func clear(_ x: Int, _ y: Int) -> CGFloat { 1 - CGFloat(alpha(x, y)) / 255 }
        func run(_ x: Int, _ y: Int, _ dx: Int, _ dy: Int) -> CGFloat {
            var x = x, y = y, sum: CGFloat = 0
            while x >= 0, y >= 0, x < w, y < h, alpha(x, y) < 255 { sum += clear(x, y); x += dx; y += dy }
            return sum
        }
        let cx = w / 2, cy = h / 2
        guard alpha(cx, cy) < 255 else { return nil }
        // The straight edges over the middle half; the longest run passes a camera cutout
        // (the Dynamic Island) that ends some columns early.
        let rows = h / 4 ..< h * 3 / 4, columns = w / 4 ..< w * 3 / 4
        let left = CGFloat(cx) - (rows.map { run(cx - 1, $0, -1, 0) }.max() ?? 0)
        let right = CGFloat(cx) + (rows.map { run(cx, $0, 1, 0) }.max() ?? 0)
        let top = CGFloat(cy) - (columns.map { run($0, cy - 1, 0, -1) }.max() ?? 0)
        let bottom = CGFloat(cy) + (columns.map { run($0, cy, 0, 1) }.max() ?? 0)
        guard right - left > 8, bottom - top > 8 else { return nil }
        // Column by column from a side inwards: the straight height minus the transparent run.
        func corner(leading: Bool, upper: Bool) -> CGFloat {
            let straight = upper ? CGFloat(cy) - top : bottom - CGFloat(cy)
            var x = leading ? Int(left) : Int(right.rounded(.up)) - 1, area: CGFloat = 0, flat = 0
            while flat < 3, leading ? x < cx : x >= cx {
                // A side column on an anti-aliased edge is only partly inside the opening.
                let share = clear(x, cy), cut = straight * share - run(x, upper ? cy - 1 : cy, 0, upper ? -1 : 1)
                area += max(0, cut); flat = share > 0.99 && cut < 0.01 ? flat + 1 : 0
                x += leading ? 1 : -1
            }
            return area
        }
        let area = [corner(leading: true, upper: true), corner(leading: false, upper: true), corner(leading: true, upper: false), corner(leading: false, upper: false)].reduce(0, +) / 4
        return (NSRect(x: left, y: top, width: right - left, height: bottom - top), (area / cut).squareRoot())
    }

    /// The bezel centred in `area`: at most 880 pt tall, 16 pt from each side.
    func bezel(in area: NSRect) -> NSRect {
        let aspect = size.width / size.height
        let height = min(880, max(120, area.height - 32), max(120, area.width - 32) / aspect)
        return NSRect(x: area.midX - height * aspect / 2, y: area.midY - height / 2, width: height * aspect, height: height)
    }
    /// The screen opening and its corner radius for a bezel drawn at `bezel` (y down).
    func screen(in bezel: NSRect) -> (rect: NSRect, radius: CGFloat) {
        let scale = bezel.height / size.height
        return (NSRect(x: bezel.minX + screen.minX * scale, y: bezel.minY + screen.minY * scale, width: screen.width * scale, height: screen.height * scale), radius * scale)
    }
    func inspect() -> [String: Any] {
        ["name": name, "width": Double(size.width), "height": Double(size.height), "radius": Double(radius),
         "screen": ["x": Double(screen.minX), "y": Double(screen.minY), "width": Double(screen.width), "height": Double(screen.height)]]
    }
}
