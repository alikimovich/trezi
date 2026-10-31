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
                "image":["width":canvas.image.width, "height":canvas.image.height], "frozen":MarkupDigest.hex(canvas.image),
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

    /// Layout and opening seams for the disposable-profile smoke. Input uses
    /// `previewMarkupEvent` below so it traverses the foreground AppKit event queue.
    func previewMarkupTest(_ c: [String: Any]) -> [String: Any] {
        switch c["action"] as? String {
        case "open":
            emit(["event":"shell-action", "action":"markup"])
            return ["ok":true]
        case "cancel": markup?.overlay?.cancel(); return ["ok":true] // cleanup seam only
        case "resize":
            guard let width = c["width"] as? Double, let height = c["height"] as? Double, let frame = markup?.overlay?.frame else { return ["error":"No overlay"] }
            markup?.place(area: NSRect(x: frame.minX, y: frame.minY, width: width, height: height))
            markup?.overlay?.layoutSubtreeIfNeeded()
            return ["ok":true]
        default: return ["error":"Unknown Mark up test action"]
        }
    }

    /// Foreground smoke input. Each event is posted, then the main actor yields so
    /// AppKit can dispatch it through local monitors, the window and the hit-tested view.
    @MainActor func previewMarkupEvent(_ c: [String: Any]) async -> [String: Any] {
        func settle() async { try? await Task.sleep(nanoseconds: 90_000_000) }
        NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil)
        await settle()
        guard window.isKeyWindow, NSApp.isActive, window.attachedSheet == nil else { return ["error":"Markup window is not foreground"] }
        let action = c["action"] as? String ?? ""
        if action != "typeInstruction", markup?.overlay?.ownsFocus != true { return ["error":"Overlay does not own focus"] }
        func post(_ event: NSEvent?) -> Bool {
            guard let event else { return false }
            NSApp.postEvent(event, atStart: false)
            return true
        }
        func mouse(_ type: NSEvent.EventType, _ point: NSPoint) -> Bool {
            post(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                    windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
                                    pressure: type == .leftMouseDown ? 1 : 0))
        }
        func key(_ type: NSEvent.EventType, _ chars: String, _ code: UInt16, _ flags: NSEvent.ModifierFlags) -> Bool {
            post(NSEvent.keyEvent(with: type, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                                  windowNumber: window.windowNumber, context: nil, characters: chars,
                                  charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code))
        }
        switch action {
        case "key":
            let chars = c["key"] as? String ?? "", code = UInt16(c["code"] as? Int ?? 0)
            let flags: NSEvent.ModifierFlags = c["command"] as? Bool == true ?
                ([123, 124].contains(code) ? [.command, .numericPad, .function] : .command) : []
            guard key(.keyDown, chars, code, flags), key(.keyUp, chars, code, flags) else { return ["error":"Cannot post key"] }
            await settle()
            return ["route":"real event route", "focused":markup?.overlay?.ownsFocus ?? false]
        case "button":
            guard let overlay = markup?.overlay, let label = c["label"] as? String,
                  let button = overlay.controls.first(where: { $0.cell?.accessibilityLabel() == label }), button.isEnabled else { return ["error":"Button unavailable"] }
            let point = button.convert(NSPoint(x: button.bounds.midX, y: button.bounds.midY), to: nil)
            guard let hit = window.contentView?.superview?.hitTest(point), hit === button || hit.isDescendant(of: button),
                  mouse(.leftMouseDown, point), mouse(.leftMouseUp, point) else { return ["error":"Button is not hit-testable"] }
            await settle()
            return ["route":"real event route", "hit":"\(type(of: hit))", "label":label]
        case "pointer":
            guard let overlay = markup?.overlay, let points = c["points"] as? [[Double]], points.count >= 2,
                  points.allSatisfy({ $0.count == 2 }) else { return ["error":"No pointer path"] }
            let canvas = overlay.canvas, mapping = canvas.mapping
            let locations = points.map { canvas.convert(mapping.toView(CGPoint(x: $0[0], y: $0[1])), to: nil) }
            guard let hit = window.contentView?.superview?.hitTest(locations[0]), hit === canvas || hit.isDescendant(of: canvas),
                  mouse(.leftMouseDown, locations[0]) else { return ["error":"Canvas is not hit-testable"] }
            for point in locations.dropFirst() { guard mouse(.leftMouseDragged, point) else { return ["error":"Cannot post drag"] } }
            guard mouse(.leftMouseUp, locations.last!) else { return ["error":"Cannot post pointer up"] }
            await settle()
            return ["route":"real event route", "hit":"\(type(of: hit))", "marks":canvas.document.marks.count]
        case "typeInstruction":
            guard markup?.overlay == nil, window.firstResponder === composer.text,
                  let instruction = c["text"] as? String, !instruction.isEmpty else { return ["error":"Composer does not own text focus"] }
            for character in instruction {
                let chars = String(character)
                let code = chars == " " ? UInt16(49) : KeyShortcut.ansi.first(where: { $0.value.0 == chars.lowercased() })?.key
                guard let code else { return ["error":"Unsupported smoke text character"] }
                let flags: NSEvent.ModifierFlags = chars != chars.lowercased() ? .shift : []
                guard key(.keyDown, chars, code, flags), key(.keyUp, chars, code, flags) else { return ["error":"Cannot post text"] }
                await settle()
            }
            return ["route":"real event route", "text":composer.text.string]
        default: return ["error":"Unknown Mark up event"]
        }
    }
}
