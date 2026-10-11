import AppKit
import WebKit

/// LKM-227: the host's half of exploded-view capture. The isolated preview packs its inert
/// surfaces (`src/preview/three-d-paint.ts`) into atlas pages inside its modal dialog. For each
/// page the host asks for it on black, then on white, and snapshots the used rect at the
/// backing scale; the pair yields every surface with its own alpha (difference matting).
/// Nothing but the action and the bounded layer set crosses the bridge: pixels stay in WebKit
/// and AppKit.
enum ThreeDCapture {
    struct Job {
        let session: String
        let revision: Int
        let pages: Int
        let scale: Double
        let layers: [ThreeDLayer]
    }

    /// `done` receives one image per layer (nil where a crop was empty), or nil when the preview
    /// refused a page, a snapshot failed or the capture took longer than 8 s.
    static func run(_ job: Job, view: WKWebView, world: WKContentWorld, done: @escaping ([CGImage?]?) -> Void) {
        var images = [CGImage?](repeating: nil, count: job.layers.count)
        var finished = false
        func finish(_ value: [CGImage?]?) {
            guard !finished else { return }
            finished = true
            paint(-1, job: job, view: view, world: world) { _ in }
            done(value)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { finish(nil) }
        func step(_ page: Int) {
            guard !finished else { return }
            guard page < job.pages else { finish(images); return }
            let onPage = job.layers.filter { $0.page == page }
            let css = CGRect(x: 0, y: 0,
                             width: (onPage.map { $0.ax + $0.width * job.scale }.max() ?? 1) + 2,
                             height: (onPage.map { $0.ay + $0.height * job.scale }.max() ?? 1) + 2)
            shot(page * 2, css: css, job: job, view: view, world: world) { black in
                guard let black else { finish(nil); return }
                shot(page * 2 + 1, css: css, job: job, view: view, world: world) { white in
                    guard let white, let matted = matte(black.image, white.image) else { finish(nil); return }
                    for layer in onPage {
                        let k = black.pixelsPerCSS
                        let crop = CGRect(x: layer.ax * k, y: layer.ay * k,
                                          width: layer.width * job.scale * k, height: layer.height * job.scale * k)
                            .integral.intersection(CGRect(x: 0, y: 0, width: matted.width, height: matted.height))
                        if !crop.isEmpty { images[layer.id] = matted.cropping(to: crop) }
                    }
                    step(page + 1)
                }
            }
        }
        step(0)
    }

    private static func paint(_ value: Int, job: Job, view: WKWebView, world: WKContentWorld, completion: @escaping (Bool) -> Void) {
        let action: [String: Any] = ["session": job.session, "revision": job.revision, "action": "paint", "value": value]
        guard let data = try? JSONSerialization.data(withJSONObject: action), let json = String(data: data, encoding: .utf8) else { completion(false); return }
        view.evaluateJavaScript("globalThis.__treziThreeDAction?.(\(json)) === true", in: nil, in: world) { result in
            if case .success(let value) = result { completion(value as? Bool == true) } else { completion(false) }
        }
    }

    private static func shot(_ value: Int, css: CGRect, job: Job, view: WKWebView, world: WKContentWorld,
                             completion: @escaping ((image: CGImage, pixelsPerCSS: Double)?) -> Void) {
        paint(value, job: job, view: view, world: world) { painted in
            let zoom = max(Double(view.pageZoom * view.magnification), 0.01)
            let height = css.height * zoom
            let rect = NSRect(x: 0, y: view.isFlipped ? 0 : view.bounds.height - height, width: css.width * zoom, height: height)
                .intersection(view.bounds)
            guard painted, !rect.isEmpty else { completion(nil); return }
            let config = WKSnapshotConfiguration()
            config.rect = rect
            config.afterScreenUpdates = true
            view.takeSnapshot(with: config) { image, _ in
                guard let image, let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil), cg.width > 0 else { completion(nil); return }
                completion((cg, Double(cg.width) / (Double(rect.width) / zoom)))
            }
        }
    }

    /// On black a pixel is its premultiplied color; white minus black is 1 − alpha.
    static func matte(_ black: CGImage, _ white: CGImage) -> CGImage? {
        let width = black.width, height = black.height
        guard width > 0, height > 0, white.width == width, white.height == height else { return nil }
        let space = black.colorSpace?.model == .rgb ? black.colorSpace! : CGColorSpace(name: CGColorSpace.sRGB)!
        let info = CGImageAlphaInfo.premultipliedLast.rawValue
        guard let dark = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space, bitmapInfo: info),
              let light = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space, bitmapInfo: info) else { return nil }
        let bounds = CGRect(x: 0, y: 0, width: width, height: height)
        dark.draw(black, in: bounds); light.draw(white, in: bounds)
        guard let b = dark.data?.assumingMemoryBound(to: UInt8.self), let w = light.data?.assumingMemoryBound(to: UInt8.self) else { return nil }
        for i in stride(from: 0, to: width * height * 4, by: 4) {
            let diff = (Int(w[i]) - Int(b[i]) + Int(w[i + 1]) - Int(b[i + 1]) + Int(w[i + 2]) - Int(b[i + 2])) / 3
            let alpha = UInt8(clamping: 255 - max(0, diff))
            b[i] = min(b[i], alpha); b[i + 1] = min(b[i + 1], alpha); b[i + 2] = min(b[i + 2], alpha); b[i + 3] = alpha
        }
        return dark.makeImage()
    }
}
