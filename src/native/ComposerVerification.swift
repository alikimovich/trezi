import AppKit

// Called only by the ephemeral-profile Host verification command.
extension NativeComposer {
    func verifyInteraction(_ command: [String: Any]) -> [String: Any] {
        guard let window else { return ["error": "No composer window"] }
        if command["prepare"] as? Bool == true {
            NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil)
            window.makeFirstResponder(text)
        }
        guard window.isKeyWindow || window.attachedSheet?.isKeyWindow == true, NSApp.isActive, !isHidden else { return ["error": "Composer is not foreground"] }
        window.contentView?.layoutSubtreeIfNeeded()
        if command["attachDialog"] as? Bool == true, let menu = plus.menu {
            menu.performActionForItem(at: 1)
        }
        let attachmentDialog = window.attachedSheet is NSOpenPanel
        if command["cancelDialog"] as? Bool == true, let panel = window.attachedSheet as? NSOpenPanel { panel.cancel(nil) }
        if let label = command["label"] as? String, let value = command["value"] as? String,
           let picker = pickers[label], picker.isEnabled,
           let item = picker.itemArray.first(where: { $0.representedObject as? String == value }) {
            picker.select(item)
            if let action = picker.action { NSApp.sendAction(action, to: picker.target, from: picker) }
        }
        if let typing = command["typing"] as? String {
            window.makeFirstResponder(text)
            text.insertText(typing, replacementRange: text.selectedRange())
        }
        if command["submit"] as? Bool == true { sendButton.performClick(nil) }
        // Deliver Return through the window's key path, as a physical press would.
        if command["keySubmit"] as? Bool == true {
            window.makeFirstResponder(text)
            for type in [NSEvent.EventType.keyDown, .keyUp] {
                if let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36) { window.sendEvent(event) }
            }
        }
        var result = verificationLayout()
        result["foreground"] = true
        result["attachmentDialog"] = attachmentDialog
        result["send"] = ["enabled": sendButton.isEnabled, "label": sendButton.accessibilityLabel() ?? ""]
        result["pickersEnabled"] = pickers.mapValues { $0.isEnabled }
        result["composerHeight"] = frame.height
        result["textFits"] = text.frame.height <= scroll.contentSize.height + 1
        return result
    }

    // AppKit lays out popup buttons by alignment rect, not their overlapping
    // decoration frames. Keep this measurement usable without a window.
    func verificationLayout() -> [String: Any] {
        func rect(_ view: NSView) -> NSRect { view.convert(view.bounds, to: self) }
        let bubble = rect(content)
        let row = rect(controls)
        let targets = [plus, sendButton] + ["Provider", "Model", "Permission mode"].compactMap { pickers[$0] }
        let hitTargets = targets.allSatisfy { view in
            let box = rect(view)
            let point = convert(NSPoint(x: box.midX, y: box.midY), to: superview)
            guard let hit = hitTest(point) else { return false }
            return hit === view || hit.isDescendant(of: view)
        }
        let ordered: [NSView] = [plus] + ["Provider", "Model", "Permission mode"].compactMap { pickers[$0] } + [sendButton]
        let aligned = ordered.map { view in
            view.superview!.convert(view.alignmentRect(forFrame: view.frame), to: self)
        }
        let gaps = zip(aligned, aligned.dropFirst()).map { $1.minX - $0.maxX }
        let geometry = zip(["attachment", "provider", "model", "permission", "send"], ordered).map { name, view in
            ["control": name, "frame": NSStringFromRect(rect(view)),
             "alignmentRect": NSStringFromRect(view.superview!.convert(view.alignmentRect(forFrame: view.frame), to: self))]
        }
        return ["contained": controls.superview === content && bubble.contains(row) && bubble.contains(rect(scroll)) && aligned.allSatisfy { bubble.contains($0) } && rect(scroll).minY >= row.maxY,
                "bottomInset": row.minY - bubble.minY, "hitTargets": hitTargets,
                "alignment": aligned.count == 5 && aligned.allSatisfy { $0.width > 0 && $0.height > 0 } && gaps.allSatisfy { $0 >= controls.spacing - 0.01 } && aligned.allSatisfy { abs($0.midY - row.midY) < 0.01 },
                "controlGeometry": geometry, "alignmentGaps": gaps,
                "labels": ["Provider", "Model", "Permission mode"].compactMap { pickers[$0]?.titleOfSelectedItem }]
    }
}
