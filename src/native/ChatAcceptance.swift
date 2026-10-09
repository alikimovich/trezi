import AppKit

/// Last thumb-drag diagnostics, reported with every acceptance inspection.
enum AcceptanceDiagnostics {
    static var lastDrag: [String: Any] = [:]
    static var lastLatest: [String: Any] = [:]
}

// Only dispatched by the ephemeral-profile Host command. Scroller style and
// accessibility modes are switched through the in-process ChatSystemEnvironment
// override: verification never reads-modifies-writes macOS settings.
extension Host {
    @MainActor
    func chatAcceptance(_ command: [String: Any]) async throws -> [String: Any] {
        func fail(_ reason: String) -> NSError {
            NSError(domain: "ChatAcceptance", code: 1, userInfo: [NSLocalizedDescriptionKey: reason])
        }
        func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
        if command["prepare"] as? Bool == true {
            NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil)
            window.acceptsMouseMovedEvents = true
            // Activation completes on a later run-loop turn, and the system may defer it
            // while another app (the previous host exiting, a shared desktop) holds focus:
            // ask again every half second. Still fail if it is denied for 5 s.
            for attempt in 0..<100 where !(window.isKeyWindow && NSApp.isActive) {
                if attempt > 0, attempt % 10 == 0 {
                    NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil)
                }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
        }
        guard window.isKeyWindow, NSApp.isActive, !chat.isHidden else { throw fail("Chat must be foreground") }
        if let width = command["width"] as? Double { nativeLayout.resized(max(320, min(520, width))) }
        if let height = command["height"] as? Double {
            window.setContentSize(NSSize(width: window.contentView!.bounds.width, height: max(550, min(850, height))))
            nativeLayout.layout()
        }
        let environment = ChatSystemEnvironment.shared
        if let change = command["environment"] as? [String: Any] {
            if change["clear"] as? Bool == true { environment.clearOverrides() } else {
                var style = environment.scrollerStyleOverride
                if let scrollers = change["scrollers"] as? String {
                    switch scrollers {
                    case "Always": style = .legacy
                    case "WhenScrolling": style = .overlay
                    default: throw fail("Unknown scroller override \(scrollers)")
                    }
                }
                var accessibility = environment.accessibilityOverride
                if let values = change["accessibility"] as? [String: Bool] {
                    accessibility = ChatAccessibility(increaseContrast: values["increaseContrast"] ?? false,
                        reduceTransparency: values["reduceTransparency"] ?? false, reduceMotion: values["reduceMotion"] ?? false)
                }
                environment.override(accessibility: accessibility, scrollerStyle: style)
            }
        }
        // A message id treated as hovered ("" = none; null = the real pointer again).
        if let hover = command["hoverMessage"] { chat.model.hoverOverride = hover as? String }
        window.contentView?.layoutSubtreeIfNeeded()
        guard let probe = descendants(chat).compactMap({ $0 as? ChatScrollStyleProbe }).first,
              let scroll = probe.enclosingScrollView, let scroller = scroll.verticalScroller else {
            throw fail("SwiftUI conversation scroller/probe is missing")
        }
        // Window-targeted events enter the app's own event queue, so the probe's
        // local monitor, NSApplication.sendEvent, NSWindow hit-testing and AppKit
        // tracking loops handle them as input. A pid-posted CGEvent arrived with
        // no window and was dropped before reaching the scroll view.
        func windowPoint(_ point: NSPoint, in view: NSView) -> NSPoint { view.convert(point, to: nil) }
        func windowEvent(_ type: NSEvent.EventType, _ point: NSPoint) throws -> NSEvent {
            let pressed = type == .leftMouseDown || type == .leftMouseDragged
            guard let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                    timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                    context: nil, eventNumber: 0, clickCount: type == .mouseMoved ? 0 : 1, pressure: pressed ? 1 : 0) else {
                throw fail("Cannot create \(type) event for the chat window")
            }
            return event
        }
        func mouse(_ type: NSEvent.EventType, _ point: NSPoint) throws {
            NSApp.postEvent(try windowEvent(type, point), atStart: false)
        }
        // AppKit has no window-targeted wheel constructor. A window event's
        // CGEvent carries its window number and window-local location; retype
        // it as a precise pixel wheel event (positive: toward history).
        func wheel(_ delta: Int, at point: NSPoint) throws {
            guard let cg = try windowEvent(.mouseMoved, point).cgEvent else { throw fail("Cannot create wheel event") }
            cg.type = .scrollWheel
            cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
            cg.setIntegerValueField(.scrollWheelEventDeltaAxis1, value: Int64(delta.signum()))
            cg.setIntegerValueField(.scrollWheelEventPointDeltaAxis1, value: Int64(delta))
            guard let event = NSEvent(cgEvent: cg), event.type == .scrollWheel, event.scrollingDeltaY != 0 else {
                throw fail("Wheel event conversion failed")
            }
            guard event.window === window else {
                throw fail("Wheel event is not targeted at the chat window (number \(event.windowNumber), chat \(window.windowNumber))")
            }
            NSApp.postEvent(event, atStart: false)
        }
        let readingPoint = windowPoint(NSPoint(x: chat.bounds.midX, y: chat.isFlipped ? 80 : chat.bounds.height - 80), in: chat)
        let knob = scroller.rect(for: .knob)
        let knobPoint = windowPoint(NSPoint(x: knob.midX, y: knob.midY), in: scroller)
        // The thumb drag goes up (+96 window points, toward history).
        if let action = command["input"] as? String {
            switch action {
            case "away": try mouse(.mouseMoved, windowPoint(NSPoint(x: 40, y: 40), in: chat))
            case "hover": try mouse(.mouseMoved, knobPoint)
            case "wheel": try wheel(command["delta"] as? Int ?? 600, at: readingPoint)
            case "drag":
                guard knob.height > 0 else { throw fail("Native thumb is not draggable") }
                try mouse(.mouseMoved, knobPoint)
                try await Task.sleep(nanoseconds: 50_000_000)
                // A faded overlay knob falls through to the clip view. Reveal it
                // (flashScrollers, as scrolling does) and wait, bounded, until the
                // knob hit-tests to the scroller; never change style/autohide.
                let before = ScrollerDrag.knobHit(scroller: scroller, window: window)
                let revealed = await ScrollerDrag.revealKnob(scroller: scroller, scroll: scroll, window: window) {
                    try? await Task.sleep(nanoseconds: 25_000_000)
                }
                var report: [String: Any] = ["hitBeforeReveal": before.dictionary, "hitAfterReveal": revealed.hit.dictionary,
                                             "revealWait": revealed.elapsed]
                guard revealed.hit.isScroller else {
                    AcceptanceDiagnostics.lastDrag = report
                    throw fail("Scroller knob never hit-tested to NSScroller before mouseDown: hit \(revealed.hit.target), knob \(NSStringFromRect(revealed.hit.knob)), waited \(String(format: "%.2f", revealed.elapsed))s")
                }
                // Queue the drag, then let the window hit-test the mouseDown to the
                // scroller, whose own tracking loop consumes it (see ScrollerDrag).
                let scrolls = probe.userScrollCount
                let drag = ScrollerDrag.perform(scroller: scroller, scroll: scroll, window: window, dy: 96) { window.sendEvent($0) }
                report.merge(drag.dictionary) { _, new in new }
                report["liveScrollInputs"] = probe.userScrollCount - scrolls
                AcceptanceDiagnostics.lastDrag = report
                if drag.refused { throw fail("Thumb drag refused: knob hit \(drag.hitTarget) at mouseDown, knob \(NSStringFromRect(drag.knob))") }
            case "latest":
                let frame = chat.model.latestButtonFrame
                guard frame.width > 0, frame.height > 0 else {
                    throw fail(chat.model.showsLatest ? "Scroll-to-latest button is shown but its rendered frame was not reported"
                                                      : "Scroll-to-latest button is missing")
                }
                let point = windowPoint(NSPoint(x: frame.midX, y: chat.isFlipped ? frame.midY : chat.bounds.height - frame.midY), in: chat)
                let hitTarget: String
                // hitTest takes the receiver's superview coordinates.
                if let content = window.contentView,
                   let hit = content.hitTest(content.superview?.convert(point, from: nil) ?? point) {
                    hitTarget = String(describing: type(of: hit))
                } else { hitTarget = "nil" }
                let attachBefore = probe.attachCount
                let distanceBefore = ChatScrollStyleProbe.distanceFromEnd(scroll)
                let clicksBefore = chat.model.latestButtonClickCount
                let ignoredBefore = probe.ignoredLiveScrollEndCount
                try mouse(.leftMouseDown, point); try mouse(.leftMouseUp, point)
                // The click is only queued here; "after" values are read once it
                // and the resulting pin have run (below, after the settle sleep).
                AcceptanceDiagnostics.lastLatest = [
                    "hitTarget": hitTarget, "clickPoint": NSStringFromPoint(point),
                    "clicksBefore": clicksBefore, "attachBefore": attachBefore,
                    "distanceBefore": distanceBefore, "pinnedBefore": probe.isPinned,
                    "liveScrollingBefore": probe.isLiveScrolling, "ignoredLiveScrollEndsBefore": ignoredBefore,
                ]
            default: throw fail("Unknown chat input")
            }
        }
        // Event delivery and SwiftUI layout happen on subsequent run-loop turns.
        try await Task.sleep(nanoseconds: 100_000_000)
        if command["input"] as? String == "latest" {
            let clicksBefore = AcceptanceDiagnostics.lastLatest["clicksBefore"] as? Int ?? 0
            AcceptanceDiagnostics.lastLatest.merge([
                "buttonClickCount": chat.model.latestButtonClickCount - clicksBefore,
                "attachAfter": probe.attachCount, "distanceAfter": ChatScrollStyleProbe.distanceFromEnd(scroll),
                "pinnedAfter": probe.isPinned, "liveScrollingAfter": probe.isLiveScrolling,
                "ignoredLiveScrollEndsAfter": probe.ignoredLiveScrollEndCount,
            ]) { _, new in new }
        }
        let composerFrame = composer.convert(composer.bounds, to: chat)
        let latest = chat.model.snapshot?.messages.last?.id ?? ""
        let latestFrame = chat.model.messageFrames[latest] ?? .zero
        let readingHeight = chat.bounds.height - chat.model.bottomInset
        // What a click at the button's center reaches: the button itself, never the text under it.
        let buttonFrame = chat.model.latestButtonFrame
        let composerTop = chat.isFlipped ? composerFrame.minY : chat.bounds.height - composerFrame.maxY
        var latestHit = ""
        if buttonFrame.width > 0, let content = window.contentView {
            let point = chat.convert(NSPoint(x: buttonFrame.midX, y: chat.isFlipped ? buttonFrame.midY : chat.bounds.height - buttonFrame.midY), to: nil)
            latestHit = content.hitTest(content.superview?.convert(point, from: nil) ?? point).map { String(describing: type(of: $0)) } ?? "nil"
        }
        var result: [String: Any] = [
            "probeAttached": probe.configuredScroll === scroll, "configurationCount": probe.configurationCount, "pinCount": probe.pinCount,
            "attachCount": probe.attachCount, "ignoredLiveScrollEnds": probe.ignoredLiveScrollEndCount,
            "liveScrolling": probe.isLiveScrolling, "latestButtonClickCount": chat.model.latestButtonClickCount,
            "pinned": probe.isPinned, "userScrollCount": probe.userScrollCount,
            "monitorCallbacks": probe.monitorCallbackCount, "scrollWheelEvents": probe.scrollWheelEventCount,
            "lastInputRejection": probe.lastInputRejection,
            "probeShowsLatest": probe.showsLatestButton, "modelShowsLatest": chat.model.showsLatest, "chatWindowNumber": window.windowNumber,
            "preferredStyle": environment.scrollerStyle == .overlay ? "overlay" : "legacy",
            "systemPreferredStyle": NSScroller.preferredScrollerStyle == .overlay ? "overlay" : "legacy",
            "environmentOverridden": environment.isOverridden,
            "style": scroll.scrollerStyle == .overlay ? "overlay" : "legacy",
            "small": scroller.controlSize == .small, "autohides": scroll.autohidesScrollers,
            "scrollerHidden": scroller.isHidden, "knobHeight": scroller.rect(for: .knob).height,
            "scrollY": scroll.contentView.bounds.minY, "viewportWidth": scroll.contentSize.width,
            "documentHeight": scroll.documentView?.bounds.height ?? 0, "viewportHeight": scroll.contentSize.height,
            "windowContentHeight": window.contentView!.bounds.height,
            "chatWidth": chat.bounds.width, "chatHeight": chat.bounds.height,
            "leftGap": composerFrame.minX, "rightGap": chat.bounds.width - composerFrame.maxX,
            "bottomGap": chat.bounds.height - composerFrame.maxY,
            "latestID": latest, "latestTop": latestFrame.minY, "latestBottom": latestFrame.maxY,
            "latestVisible": latestFrame.height > 0 && latestFrame.minY >= 0 && latestFrame.maxY <= readingHeight + 1,
            "readingHeight": readingHeight, "bottomPosition": chat.model.bottomPosition, "settleAttempts": chat.model.latestSettleAttempts, "latestButton": chat.model.latestButtonFrame.width > 0,
            "latestButtonFrame": NSStringFromRect(chat.model.latestButtonFrame),
            "latestButtonGap": ChatLatestButton.gap, "latestButtonHit": latestHit,
            "latestButtonBackdrop": String(describing: type(of: chat.latestButton.backdrop)),
            "latestButtonBackdropFills": !chat.latestButton.backdrop.isHidden && chat.latestButton.backdrop.frame == chat.latestButton.bounds,
            "messageFrames": chat.model.messageFrames.mapValues { NSStringFromRect($0) },
            "footerFrames": chat.model.footerFrames.mapValues { NSStringFromRect($0) }, "revealedActions": chat.model.revealedActions,
            "hoverOverride": chat.model.hoverOverride ?? NSNull(), "latestButtonLabel": chat.latestButton.accessibilityLabel() ?? "",
            "composerTop": composerTop,
            "lastDrag": AcceptanceDiagnostics.lastDrag,
            "lastLatest": AcceptanceDiagnostics.lastLatest,
            "layout": composer.verificationLayout(), "composer": composer.inspect(),
            "appearance": window.effectiveAppearance.name.rawValue,
            // Read-only: the real macOS values, never written by verification.
            "system": environment.systemAccessibility().dictionary,
            "accessibility": environment.accessibility.dictionary,
            "rendered": chat.model.renderedAccessibility.dictionary,
            "scrollAppearance": scroll.appearance?.name.rawValue ?? "",
            "scrollEffectiveAppearance": scroll.effectiveAppearance.name.rawValue,
            "scrollerEffectiveAppearance": scroller.effectiveAppearance.name.rawValue
        ]
        if command["capture"] as? Bool == true {
            let image = try await captureVisibleRegion(window: window, view: chat, region: chat.bounds)
            result["image"] = image
            if buttonFrame.width > 0, let png = (image["png"] as? String).flatMap({ Data(base64Encoded: $0) }) {
                result["latestBandInk"] = Self.inkPixels(png: png, chatWidth: chat.bounds.width, button: buttonFrame,
                                                         top: buttonFrame.minY - ChatLatestButton.gap, bottom: composerTop)
            }
        }
        return result
    }
    /// Text pixels beside the shown latest button, from `gap` above it down to the
    /// composer: the band LKM-141's mask left empty. Counts captured pixels whose
    /// luminance is far from the band's most common (background) value.
    static func inkPixels(png: Data, chatWidth: CGFloat, button: CGRect, top: CGFloat, bottom: CGFloat) -> Int {
        guard let image = NSBitmapImageRep(data: png)?.cgImage, chatWidth > 0,
              let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue),
              let pixels = context.data?.assumingMemoryBound(to: UInt8.self) else { return 0 }
        // Row 0 of the buffer is the image's top row.
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        let scale = CGFloat(image.width) / chatWidth
        func luminance(_ x: Int, _ y: Int) -> CGFloat {
            let i = (y * image.width + x) * 4
            return (0.2126 * CGFloat(pixels[i]) + 0.7152 * CGFloat(pixels[i + 1]) + 0.0722 * CGFloat(pixels[i + 2])) / 255
        }
        // Skip the column margins, the scroller and the button with a 4 pt halo.
        let halo = Int((button.minX - 4) * scale)..<Int((button.maxX + 4) * scale)
        let columns = stride(from: Int(18 * scale), to: min(image.width, Int((chatWidth - 24) * scale)), by: 1).filter { !halo.contains($0) }
        let rows = stride(from: max(0, Int(top * scale)), to: min(image.height, Int(bottom * scale)), by: 1)
        guard !columns.isEmpty else { return 0 }
        var values: [CGFloat] = []
        for y in rows { for x in columns { values.append(luminance(x, y)) } }
        var bins = [Int](repeating: 0, count: 33)
        for value in values { bins[min(32, max(0, Int(value * 32)))] += 1 }
        let background = CGFloat(bins.indices.max { bins[$0] < bins[$1] } ?? 0) / 32
        return values.filter { abs($0 - background) > 0.3 }.count
    }
}
