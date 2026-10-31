import AppKit
import WebKit

/// LKM-391: Mark up in the host: the capture of the live preview and the seams the native
/// smoke drives. Wiring only; the session is `PreviewMarkup`.
extension Host {
    func installMarkup() {
        markup = PreviewMarkup(parent: canvas, emit: { emit($0) }, refusal: { [weak self] in self?.markupRefusal },
                               capture: { [weak self] done in self?.captureForMarkup(done) },
                               restoreFocus: { [weak self] responder in if let responder { self?.window.makeFirstResponder(responder) } },
                               changed: { [weak self] in self?.sendPreviewCover() })
    }
    /// Keys are the overlay's only while this window is really taking them.
    var markupTakesKeys: Bool { NSApp.keyWindow === window && window.attachedSheet == nil && !menuTracking }
    /// Why there is nothing to capture, in the words the user reads.
    var markupRefusal: String? {
        guard let view = views["preview"], !view.isHidden, view.superview === canvas, view.url != nil, previewStatus.isHidden else { return "Open the preview to mark it up." }
        return threeD.active ? "Close the 3D view to mark up the preview." : nil
    }
    /// The visible viewport without Trezi's own in-page chrome. If that chrome cannot be hidden
    /// nothing is captured: a pin or selection must not end up in the image.
    private func captureForMarkup(_ done: @escaping (Result<PreviewMarkup.Captured, PreviewMarkup.Failure>) -> Void) {
        guard let view = views["preview"] else { done(.failure(.init(message: "Open the preview to mark it up."))); return }
        let world = world
        // Off any WebKit callback: evaluating into the page from inside one trips its executor check.
        Task { @MainActor in
            let hidden = try? await view.callAsyncJavaScript(PreviewMarkupScript.hide, arguments: [:], in: nil, contentWorld: world) as? String
            guard let hidden, let metrics = (try? JSONSerialization.jsonObject(with: Data(hidden.utf8))) as? [String: Any] else {
                _ = try? await view.callAsyncJavaScript(PreviewMarkupScript.restore, arguments: [:], in: nil, contentWorld: world)
                done(.failure(.init(message: "The preview was not ready, so nothing was captured. Try Mark up again.")))
                return
            }
            let (image, failure) = await withCheckedContinuation { (finished: CheckedContinuation<(CGImage?, String?), Never>) in
                PreviewAgent.snapshot(WKSnapshotConfiguration(), view: view) { finished.resume(returning: ($0, $1)) }
            }
            _ = try? await view.callAsyncJavaScript(PreviewMarkupScript.restore, arguments: [:], in: nil, contentWorld: world)
            guard let image else { done(.failure(.init(message: failure ?? "Snapshot unavailable"))); return }
            var context = metrics
            context["viewportWidth"] = metrics["width"]; context["viewportHeight"] = metrics["height"]
            context["width"] = nil; context["height"] = nil
            context["url"] = view.url?.absoluteString ?? ""
            context["zoom"] = Double(view.pageZoom * view.magnification)
            done(.success(PreviewMarkup.Captured(image: image, context: context)))
        }
    }

    func previewMarkupInspect() -> [String: Any] {
        guard let overlay = markup?.overlay else { return ["open":false, "session":markup?.session ?? NSNull(), "cover":previewCoverRects().count] }
        let canvas = overlay.canvas, mapping = canvas.mapping
        let bitmap = NSBitmapImageRep(cgImage: canvas.image)
        func rect(_ value: NSRect) -> [String: Double] { ["x":value.minX, "y":value.minY, "width":value.width, "height":value.height] }
        let marks: [[String: Any]] = canvas.document.marks.map { mark in
            ["tool":mark.tool.rawValue, "points":mark.points.map { [$0.x, $0.y] }, "view":mark.points.map { point -> [CGFloat] in let p = mapping.toView(point); return [p.x, p.y] }]
        }
        return ["open":true, "session":markup?.session ?? NSNull(), "frame":rect(overlay.frame), "canvas":rect(canvas.frame), "bar":rect(overlay.barFrame), "shown":rect(mapping.frame),
                "image":["width":canvas.image.width, "height":canvas.image.height], "frozen":(bitmap.tiffRepresentation ?? Data()).hashValue,
                "backing":window.backingScaleFactor, "tool":overlay.tool.rawValue, "marks":marks, "addEnabled":overlay.addEnabled, "undoEnabled":overlay.undoEnabled,
                "adding":overlay.adding, "status":overlay.statusText, "error":overlay.errorShown, "animates":overlay.animates, "focused":overlay.ownsFocus,
                "topmost":canvasTopmost(overlay), "cover":previewCoverRects().count, "context":markup?.context ?? [:], "magenta":magentaPixels(bitmap),
                "controls":overlay.controls.map { ["label":$0.cell?.accessibilityLabel() ?? "", "enabled":$0.isEnabled, "frame":rect($0.frame)] as [String: Any] }]
    }
    private func canvasTopmost(_ view: NSView) -> Bool { canvas.subviews.last === view }
    /// The smoke's marker colour for Trezi's in-page chrome, sampled every few pixels.
    private func magentaPixels(_ bitmap: NSBitmapImageRep) -> Int {
        var count = 0
        for y in stride(from: 0, to: bitmap.pixelsHigh, by: 4) {
            for x in stride(from: 0, to: bitmap.pixelsWide, by: 4) {
                guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                if color.redComponent > 0.9, color.greenComponent < 0.15, color.blueComponent > 0.9 { count += 1 }
            }
        }
        return count
    }

    /// Everything goes through what a pointer, a key or a button reaches. `points` are in
    /// captured pixels, turned into view points first, as a pointer would give them.
    func previewMarkupTest(_ c: [String: Any]) -> [String: Any] {
        switch c["action"] as? String {
        case "open":
            emit(["event":"shell-action", "action":"markup"])
            return ["ok":true]
        case "stroke":
            guard let overlay = markup?.overlay, let tool = MarkupTool(rawValue: c["tool"] as? String ?? ""),
                  let points = c["points"] as? [[Double]], let first = points.first, first.count == 2 else { return ["error":"Nothing to draw on"] }
            let canvas = overlay.canvas, mapping = canvas.mapping
            func view(_ point: [Double]) -> NSPoint { mapping.toView(CGPoint(x: point[0], y: point[1])) }
            overlay.select(tool)
            canvas.pointerDown(view(first), tool: overlay.tool)
            for point in points.dropFirst() where point.count == 2 { canvas.pointerDragged(view(point)) }
            canvas.pointerUp()
            return ["marks":canvas.document.marks.count]
        case "key":
            // The ⌘Z and Escape routes of a real press, through the overlay's own handlers.
            guard let overlay = markup?.overlay, let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: c["command"] as? Bool == true ? .command : [], timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: c["key"] as? String ?? "", charactersIgnoringModifiers: c["key"] as? String ?? "", isARepeat: false, keyCode: UInt16(c["code"] as? Int ?? 0)) else { return ["error":"No overlay"] }
            if c["command"] as? Bool == true { return ["taken":overlay.performKeyEquivalent(with: event)] }
            overlay.keyDown(with: event)
            return ["ok":true]
        case "clear": markup?.overlay?.clear(); return ["ok":true]
        case "cancel": markup?.overlay?.cancel(); return ["ok":true]
        case "add": markup?.overlay?.add(); return ["ok":true]
        case "resize":
            guard let width = c["width"] as? Double, let height = c["height"] as? Double, let frame = markup?.overlay?.frame else { return ["error":"No overlay"] }
            markup?.place(area: NSRect(x: frame.minX, y: frame.minY, width: width, height: height))
            markup?.overlay?.layoutSubtreeIfNeeded()
            return ["ok":true]
        default: return ["error":"Unknown Mark up test action"]
        }
    }
}
