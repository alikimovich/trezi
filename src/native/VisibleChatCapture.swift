import AppKit
import Vision
import ScreenCaptureKit

/// Capture only this process's window through WindowServer. An external
/// screencapture process does not own this window and requires broader TCC access.
@MainActor
func captureVisibleChat(window: NSWindow, chat: NativeChat) async throws -> [String: Any] {
    let reading = NSRect(x: 0, y: 0, width: chat.bounds.width, height: max(1, chat.bounds.height - chat.model.bottomInset))
    return try await captureVisibleRegion(window: window, view: chat, region: reading)
}

/// LKM-334: the window's own rendering of `region`, first row at its top, for colour
/// samples at view frames. The capture below can't serve: on macOS 27 it drew the window
/// 2–6 % smaller than its frame (varying per capture), so frames read the wrong pixels.
@MainActor
func renderRegion(window: NSWindow, view: NSView, region: NSRect) throws -> NSBitmapImageRep {
    guard let root = window.contentView?.superview ?? window.contentView else {
        throw NSError(domain: "VisibleChatCapture", code: 5, userInfo: [NSLocalizedDescriptionKey: "Window has no content to render"])
    }
    let area = view.convert(region, to: root)
    guard let bitmap = root.bitmapImageRepForCachingDisplay(in: area) else {
        throw NSError(domain: "VisibleChatCapture", code: 5, userInfo: [NSLocalizedDescriptionKey: "Window rendering unavailable"])
    }
    root.cacheDisplay(in: area, to: bitmap)
    return bitmap
}

@MainActor
func captureVisibleRegion(window: NSWindow, view: NSView, region: NSRect, recognize: Bool = true, corrected: Bool = false) async throws -> [String: Any] {
    guard window.isVisible, window.isKeyWindow, NSApp.isActive, !view.isHidden else {
        throw NSError(domain: "VisibleChatCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "Chat window is not in the foreground"])
    }
    guard #available(macOS 14.4, *) else {
        throw NSError(domain: "VisibleChatCapture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Native visible capture verification requires macOS 14.4 or later"])
    }
    let content = try await SCShareableContent.currentProcess
    guard let ownWindow = content.windows.first(where: { $0.windowID == CGWindowID(window.windowNumber) }) else {
        throw NSError(domain: "VisibleChatCapture", code: 3, userInfo: [NSLocalizedDescriptionKey: "Trezi window is missing from current-process capture content"])
    }
    let filter = SCContentFilter(desktopIndependentWindow: ownWindow)
    let configuration = SCStreamConfiguration()
    configuration.width = Int((filter.contentRect.width * CGFloat(filter.pointPixelScale)).rounded())
    configuration.height = Int((filter.contentRect.height * CGFloat(filter.pointPixelScale)).rounded())
    configuration.ignoreShadowsSingleWindow = true
    configuration.showsCursor = false
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    // Capture is asynchronous: refuse pixels if the window changed while awaiting it.
    guard window.isVisible, window.isKeyWindow, NSApp.isActive, !view.isHidden else {
        throw NSError(domain: "VisibleChatCapture", code: 4, userInfo: [NSLocalizedDescriptionKey: "Chat lost foreground during capture"])
    }
    // Restrict OCR to chat pixels: the project preview must not supply labels.
    let rect = view.convert(region, to: nil)
    let scale = CGFloat(image.width) / window.frame.width
    let crop = CGRect(x: rect.minX * scale, y: (window.frame.height - rect.maxY) * scale,
                      width: rect.width * scale, height: rect.height * scale).integral
    guard let pixels = image.cropping(to: crop), let png = NSBitmapImageRep(cgImage: pixels).representation(using: .png, properties: [:]) else {
        throw NSError(domain: "VisibleChatCapture", code: 3, userInfo: [NSLocalizedDescriptionKey: "Chat screenshot crop failed"])
    }
    // LKM-334: how the capture maps onto the window, for checks that compare it with frames.
    let geometry: [String: Any] = ["image": "\(image.width)x\(image.height)", "contentRect": NSStringFromRect(filter.contentRect),
                                   "pointPixelScale": Double(filter.pointPixelScale), "scWindow": NSStringFromRect(ownWindow.frame),
                                   "window": NSStringFromRect(window.frame), "crop": NSStringFromRect(crop)]
    // Whole-window state evidence needs pixels only.
    guard recognize else { return ["png": png.base64EncodedString(), "text": [String](), "width": pixels.width, "height": pixels.height, "geometry": geometry] }
    func read(correcting: Bool) throws -> [String] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = correcting
        try VNImageRequestHandler(cgImage: pixels).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    }
    var result: [String: Any] = ["png": png.base64EncodedString(), "text": try read(correcting: false), "width": pixels.width, "height": pixels.height, "geometry": geometry]
    // LKM-331: a second reading of the same pixels with language correction. Uncorrected Vision
    // read a dark Settings capture's whole "UI layout method" as "Ul layout methoda".
    if corrected { result["corrected"] = try read(correcting: true) }
    return result
}
