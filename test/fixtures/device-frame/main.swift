import AppKit
import QuartzCore

// LKM-217: each offered bezel's measured opening, drawn by CALayer with a continuous corner,
// traces the asset's own inner edge; the layout scales it with the bezel. No window needed.
let directory = CommandLine.arguments[1]
var report: [[String: Any]] = []
for (name, file) in DeviceFrame.offered {
    guard let frame = DeviceFrame.load(name, path: directory + "/" + file), let cg = frame.image?.cgImage(forProposedRect: nil, context: nil, hints: nil) else { fatalError("\(name): asset not measured") }
    let w = cg.width, h = cg.height, cx = w / 2, cy = h / 2
    func alpha(_ draw: (CGContext) -> Void) -> [UInt8] {
        let context = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        draw(context)
        let data = context.data!.assumingMemoryBound(to: UInt8.self)
        return (0 ..< w * h).map { data[$0 * 4 + 3] }
    }
    // The bezel with the opening cut by a layer: opaque, then the layer's shape removed.
    func model(_ curve: CALayerCornerCurve) -> [UInt8] {
        alpha { context in
            context.setFillColor(.black); context.fill(CGRect(x: 0, y: 0, width: w, height: h))
            let hole = CALayer(); hole.frame = CGRect(origin: .zero, size: frame.screen.size)
            hole.backgroundColor = .black; hole.cornerRadius = frame.radius; hole.cornerCurve = curve
            context.setBlendMode(.destinationOut); context.translateBy(x: frame.screen.minX, y: CGFloat(h) - frame.screen.maxY)
            hole.render(in: context)
        }
    }
    func run(_ a: [UInt8], _ x: Int, _ y: Int, _ dx: Int, _ dy: Int) -> Double {
        var x = x, y = y, sum = 0.0
        while x >= 0, y >= 0, x < w, y < h, a[y * w + x] < 255 { sum += 1 - Double(a[y * w + x]) / 255; x += dx; y += dy }
        return sum
    }
    // Edge offsets near the four corners, column by column (top, bottom) and row by row (bottom sides).
    func offsets(_ m: [UInt8], _ asset: [UInt8]) -> (rms: Double, max: Double) {
        let reach = Int(frame.radius * 1.6) + 2, s = frame.screen
        var errors: [Double] = []
        for x in Array(Int(s.minX) ..< Int(s.minX) + reach) + Array(Int(s.maxX) - reach ..< Int(s.maxX)) {
            errors.append(run(asset, x, cy - 1, 0, -1) - run(m, x, cy - 1, 0, -1)); errors.append(run(asset, x, cy, 0, 1) - run(m, x, cy, 0, 1))
        }
        for y in Int(s.maxY) - reach ..< Int(s.maxY) {
            errors.append(run(asset, cx - 1, y, -1, 0) - run(m, cx - 1, y, -1, 0)); errors.append(run(asset, cx, y, 1, 0) - run(m, cx, y, 1, 0))
        }
        return ((errors.map { $0 * $0 }.reduce(0, +) / Double(errors.count)).squareRoot(), errors.map(abs).max() ?? 0)
    }
    let asset = alpha { $0.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h)) }
    let continuous = offsets(model(.continuous), asset), circular = offsets(model(.circular), asset)
    precondition(continuous.rms < 0.4 && continuous.max < 2, "\(name): continuous corner off the asset's edge: \(continuous)")
    precondition(circular.rms > continuous.rms * 2, "\(name): a circular corner should trace the asset worse: \(circular) vs \(continuous)")
    // Two bezel scales: the opening and its radius scale with the bezel.
    for area in [NSRect(x: 100, y: 40, width: 900, height: 1100), NSRect(x: 0, y: 0, width: 400, height: 700)] {
        let bezel = frame.bezel(in: area), scale = bezel.height / CGFloat(h), screen = frame.screen(in: bezel)
        precondition(abs(bezel.width / bezel.height - CGFloat(w) / CGFloat(h)) < 1e-9 && bezel.height <= 880 && bezel.minX >= area.minX && bezel.maxX <= area.maxX)
        precondition(abs(screen.rect.minX - (bezel.minX + frame.screen.minX * scale)) < 1e-9 && abs(screen.rect.maxY - (bezel.minY + frame.screen.maxY * scale)) < 1e-9)
        precondition(abs(screen.radius - frame.radius * scale) < 1e-9)
    }
    var item = frame.inspect(); item["rms"] = continuous.rms; item["max"] = continuous.max; item["circularRms"] = circular.rms
    report.append(item)
}
print(String(data: try! JSONSerialization.data(withJSONObject: report), encoding: .utf8)!)
