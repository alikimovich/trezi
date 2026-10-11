import AppKit

/// Integration-only checks for the centered start composer (LKM-232). Window appearance
/// and Reduce Motion are overridden on Trezi's own window and layout only, never in
/// system settings, and restored by the caller.
extension Host {
    func startPerform(_ c: [String: Any]) async throws -> [String: Any] {
        if c.keys.contains("reduceMotion") { nativeLayout.start.reduceMotion = c["reduceMotion"] as? Bool }
        if let width = c["width"] as? Double {
            let height = c["height"] as? Double ?? Double(window.frame.height)
            window.setFrame(NSRect(x: window.frame.minX, y: window.frame.maxY - height, width: width, height: height), display: true)
            canvas.layoutSubtreeIfNeeded(); nativeLayout.layout()
        }
        if c.keys.contains("appearance") {
            let name = c["appearance"] as? String
            window.appearance = name == "dark" ? NSAppearance(named: .darkAqua) : name == "light" ? NSAppearance(named: .aqua) : nil
        }
        // A start surface or composer project menu item, through its own action.
        if let action = c["action"] as? String {
            if let item = composer.project.itemArray.first(where: { ($0.representedObject as? [String: Any])?["action"] as? String == action && ($0.representedObject as? [String: Any])?["value"] as? String == c["value"] as? String }) {
                composer.project.select(item); composer.chooseProject(composer.project)
            } else { startSurface.run(action, c["value"] as? String) }
        }
        if let capture = c["capture"] as? String, let content = window.contentView?.superview {
            content.layoutSubtreeIfNeeded(); content.displayIfNeeded()
            try? await Task.sleep(nanoseconds: 350_000_000)
            var value: [String: Any]
            if capture == "foreground" { value = try await captureVisibleRegion(window: window, view: content, region: content.bounds, recognize: false) }
            else {
                guard let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) else { throw NSError(domain: "StartVerification", code: 1, userInfo: [NSLocalizedDescriptionKey: "Capture unavailable"]) }
                content.cacheDisplay(in: content.bounds, to: bitmap)
                value = ["png":bitmap.representation(using: .png, properties: [:])?.base64EncodedString() ?? ""]
            }
            value["dark"] = window.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            value["start"] = nativeLayout.startInspect()
            return value
        }
        var report = nativeLayout.startInspect()
        report["window"] = ["width":Double(window.frame.width), "height":Double(window.frame.height)]
        report["composer"] = ["frame":NSStringFromRect(composer.frame), "visible":!composer.isHidden, "projectVisible":!composer.project.isHidden, "projectTitle":composer.project.title,
                              "projectItems":composer.project.itemArray.dropFirst().map(\.title), "firstResponder":window.firstResponder === composer.text,
                              "superview":composer.superview === chatColumn, "column":NSStringFromRect(chatColumn.frame)]
        return report
    }
}

extension NativeStart {
    func run(_ action: String, _ value: String?) { StartContent(model: model).run(action, value) }
}
