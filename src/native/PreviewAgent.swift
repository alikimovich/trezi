import AppKit
import WebKit

/// Agent preview inspection (LKM-138). `preview_evaluate` runs in its own content
/// world with no message handler, so agent code can never post Trezi IPC; a page-world
/// forwarder feeds `preview_console`; snapshots can be cropped to an element; and the
/// page can be laid out at a temporary CSS width for responsive checks.
enum PreviewAgent {
    static let world = WKContentWorld.world(name: "TreziAgent")

    /// Page-world, document-start: forwards console calls and page errors as one string
    /// `trezi:console` event each. It exposes nothing; the TreziPreview world buffers them.
    /// WebKit's `Error.stack` has frames only, so errors are sent as `String(error)` plus the stack.
    static let consoleForwarder = #"""
    (() => {
      const d = document, S = String, E = CustomEvent, max = 2000;
      const text = (v) => { try { return typeof v === 'string' ? v : v instanceof Error ? S(v) + (v.stack ? '\n' + v.stack : '') : (JSON.stringify(v) ?? S(v)); } catch { return S(v); } };
      const send = (level, args) => { try { d.dispatchEvent(new E('trezi:console', { detail: level + '\u0000' + Array.prototype.map.call(args, (v) => text(v).slice(0, max)).join(' ').slice(0, max) })); } catch {} };
      for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
        const original = console[level];
        if (typeof original === 'function') console[level] = function (...args) { send(level, args); return original.apply(this, args); };
      }
      addEventListener('error', (e) => {
        const t = e.target;
        send('pageerror', [e instanceof ErrorEvent ? (e.error ? text(e.error) : e.message) + (e.filename ? ' (' + e.filename + ':' + e.lineno + ':' + e.colno + ')' : '') : 'Failed to load ' + ((t && (t.src || t.href)) || 'a resource')]);
      }, true);
      addEventListener('unhandledrejection', (e) => send('pageerror', ['Unhandled rejection: ' + text(e.reason)]));
    })();
    """#

    /// LKM-230, agent pages only: one `trezi:net` event (+1 / -1) per fetch or XHR, so
    /// `preview_interact` can wait for network idle. It reports counts and exposes nothing.
    static let networkCounter = #"""
    (() => {
      const d = document, E = CustomEvent;
      const send = (step) => { try { d.dispatchEvent(new E('trezi:net', { detail: step })); } catch {} };
      const original = globalThis.fetch;
      if (typeof original === 'function') globalThis.fetch = function (...args) {
        send(1);
        let request;
        try { request = original.apply(this, args); } catch (error) { send(-1); throw error; }
        Promise.resolve(request).then(() => send(-1), () => send(-1));
        return request;
      };
      const xhr = globalThis.XMLHttpRequest && XMLHttpRequest.prototype, send0 = xhr && xhr.send;
      if (send0) xhr.send = function (...args) { send(1); this.addEventListener('loadend', () => send(-1), { once: true }); return send0.apply(this, args); };
    })();
    """#

    static func install(_ controller: WKUserContentController, agent: Bool = false) {
        controller.addUserScript(WKUserScript(source: consoleForwarder, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        if agent { controller.addUserScript(WKUserScript(source: networkCounter, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page)) }
    }

    /// The world an `evaluate` command runs in: the agent world, the isolated preview world, or the page.
    static func world(for command: [String: Any], preview: WKContentWorld) -> WKContentWorld {
        if command["world"] as? String == "agent" { return world }
        return command["isolated"] as? Bool == true ? preview : .page
    }

    /// A snapshot limited to `rect` (CSS px scaled by the page zoom), clipped to the view.
    static func snapshot(for command: [String: Any], view: WKWebView?) -> WKSnapshotConfiguration? {
        guard let view, let rect = command["rect"] as? [String: Double] else { return nil }
        let zoom = view.pageZoom
        let values = [rect["x"] ?? 0, rect["y"] ?? 0, rect["width"] ?? 0, rect["height"] ?? 0]
        guard values.allSatisfy({ $0.isFinite && abs($0) < 100000 }) else { return nil }
        let height = values[3] * zoom, top = values[1] * zoom
        let requested = NSRect(x: values[0] * zoom, y: view.isFlipped ? top : view.bounds.height - top - height, width: values[2] * zoom, height: height)
        let clipped = requested.intersection(view.bounds)
        guard !clipped.isEmpty else { return nil }
        let config = WKSnapshotConfiguration()
        config.rect = clipped
        return config
    }

    /// LKM-200: the agent's frame. WebKit renders it at the size it is sent at (the longest
    /// side at most `maxPixels` unless `full`) and it is encoded once as JPEG: no
    /// full-resolution PNG and no second scaling pass. The reply carries the host's timings.
    static func capture(_ options: [String: Any], view: WKWebView, reply: @escaping ([String: Any]?, String?) -> Void) {
        let started = Date()
        let full = options["full"] as? Bool == true
        let maxPixels = CGFloat(options["maxPixels"] as? Double ?? 1280)
        let quality = options["quality"] as? Double ?? 0.8
        let scale = view.window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        let size = view.bounds.size, longest = max(size.width, size.height) * scale
        let config = WKSnapshotConfiguration()
        if !full, longest > maxPixels, size.width > 0 { config.snapshotWidth = NSNumber(value: Double(size.width * maxPixels / longest)) }
        view.takeSnapshot(with: config) { image, error in
            let snapshotMs = Date().timeIntervalSince(started) * 1000, encoding = Date()
            guard var frame = image?.cgImage(forProposedRect: nil, context: nil, hints: nil) else { reply(nil, error?.localizedDescription ?? "Snapshot unavailable"); return }
            if !full, let fitted = fit(frame, maxPixels: maxPixels) { frame = fitted }
            guard let jpeg = NSBitmapImageRep(cgImage: frame).representation(using: .jpeg, properties: [.compressionFactor: quality]) else { reply(nil, "Snapshot encoding failed"); return }
            reply(["jpeg": jpeg.base64EncodedString(), "width": frame.width, "height": frame.height, "snapshotMs": snapshotMs, "encodeMs": Date().timeIntervalSince(encoding) * 1000], nil)
        }
    }

    /// `image` scaled so its longest side is `maxPixels`; nil when it already fits.
    static func fit(_ image: CGImage, maxPixels: CGFloat) -> CGImage? {
        let longest = CGFloat(max(image.width, image.height))
        guard longest > maxPixels, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let width = max(1, Int((CGFloat(image.width) * maxPixels / longest).rounded()))
        let height = max(1, Int((CGFloat(image.height) * maxPixels / longest).rounded()))
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()
    }

    /// `previewViewport {width}`: lay the page out at `width` CSS px (nil restores).
    static func setViewport(_ command: [String: Any], layout: WorkspaceLayout, view: WKWebView?) -> [String: Any] {
        if let width = command["width"] as? Double, width.isFinite { layout.viewportWidth = CGFloat(min(3840, max(240, width))) }
        else { layout.viewportWidth = nil }
        layout.layout()
        var result: [String: Any] = ["zoom": Double(view?.pageZoom ?? 1), "width": NSNull()]
        if let width = layout.viewportWidth { result["width"] = Double(width) }
        return result
    }

    /// The page frame for a requested CSS width: centered, never wider than the area,
    /// zoomed out so the page's `innerWidth` is exactly `width`.
    static func frame(width: CGFloat, in area: NSRect) -> (page: NSRect, zoom: CGFloat) {
        let shown = min(width, area.width)
        let page = NSRect(x: area.midX - shown / 2, y: area.minY, width: shown, height: area.height)
        return (page, width > 0 ? shown / width : 1)
    }
}
