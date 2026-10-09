import AppKit

/// LKM-187: the spinner beside the Publish label while a publish runs. The item stays a
/// standard NSMenuToolbarItem (no custom view, so AppKit keeps drawing its bezel and
/// chevron); the spinner is its image, a template frame swapped on a timer.
final class ToolbarPublishSpinner {
    static let frames = 8
    private static let images: [NSImage] = (0..<frames).map(frame)
    private var timer: Timer?
    private var phase = 0
    private weak var item: NSToolbarItem?

    var spinning: Bool { timer != nil }

    /// Eight spokes, the head (`phase`) opaque and the tail fading counter-clockwise.
    static func frame(_ phase: Int) -> NSImage {
        let image = NSImage(size: NSSize(width: 16, height: 16), flipped: false) { rect in
            for spoke in 0..<frames {
                let angle = CGFloat.pi / 2 - CGFloat(spoke) * 2 * .pi / CGFloat(frames)
                let age = (phase - spoke + frames) % frames
                NSColor.black.withAlphaComponent(1 - CGFloat(age) / CGFloat(frames) * 0.85).setStroke()
                let path = NSBezierPath(); path.lineWidth = 1.8; path.lineCapStyle = .round
                path.move(to: NSPoint(x: rect.midX + cos(angle) * 3.5, y: rect.midY + sin(angle) * 3.5))
                path.line(to: NSPoint(x: rect.midX + cos(angle) * 7, y: rect.midY + sin(angle) * 7))
                path.stroke()
            }
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "In progress"
        return image
    }

    /// Spins on `item`, or stops (clearing the image) when nil.
    func spin(_ item: NSToolbarItem?) {
        guard let item else {
            timer?.invalidate(); timer = nil
            self.item?.image = nil; self.item = nil
            return
        }
        self.item = item
        if item.image == nil { item.image = Self.images[phase] }
        guard timer == nil else { return }
        let timer = Timer(timeInterval: 1.0 / 12, repeats: true) { [weak self] _ in
            guard let self, let item = self.item else { return }
            self.phase = (self.phase + 1) % Self.frames
            item.image = Self.images[self.phase]
        }
        // Common modes: it keeps turning while the item's menu is open.
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }
}

extension NativeShell {
    /// Publish's label, menu and spinner from the shell state. While a publish runs the
    /// control only opens its menu (a click can't publish twice): the step, and Cancel
    /// while the step allows it.
    func updatePublish(_ item: NSMenuToolbarItem, state: [String: Any], ready: Bool) {
        let publishing = state["publishing"] as? Bool ?? false
        let cancellable = publishing && state["publishCancellable"] as? Bool == true
        item.title = state["publishLabel"] as? String ?? "Publish"; item.label = item.title; item.toolTip = item.title
        item.isEnabled = ready
        item.target = self; item.action = publishing ? nil : #selector(toolbarAction(_:))
        publishSpinner.spin(publishing ? item : nil)
        if item.title != publishTitle { republished(item.title) }
        let menu = NSMenu(); menu.autoenablesItems = false
        func add(_ title: String, _ action: String, _ value: String = "") -> NSMenuItem {
            let entry = NSMenuItem(title: title, action: #selector(previewMenuAction(_:)), keyEquivalent: ""); entry.target = self
            entry.representedObject = ["event":"shell-action", "action":action, "value":value]
            menu.addItem(entry); return entry
        }
        if publishing {
            let status = NSMenuItem(title: item.title, action: nil, keyEquivalent: ""); status.isEnabled = false
            menu.addItem(status)
            if cancellable { menu.addItem(.separator()); _ = add("Cancel Publish", "publish-cancel") }
        } else {
            for (title, value) in [("Create PR and merge to main", "merge"), ("Create PR", "pr")] {
                let entry = add(title, "publish-mode", value)
                entry.state = value == state["publishMode"] as? String ? .on : .off; entry.isEnabled = item.isEnabled
            }
        }
        item.menu = menu
    }

    /// Opens the publish menu's Cancel, as the user would (tests).
    func cancelPublish(_ item: NSMenuToolbarItem?) -> Bool {
        guard let item, item.isEnabled, let entry = item.menu.items.first(where: {
            ($0.representedObject as? [String: String])?["action"] == "publish-cancel"
        }), entry.isEnabled else { return false }
        previewMenuAction(entry); return true
    }

    /// LKM-213: Publish against the other laid-out toolbar items (window x): it must be the last
    /// one, its trailing edge on the toolbar's trailing inset.
    func publishTrailingInspect() -> [String: Any] {
        let frames = toolbarItemFrames(window)
        let order = frames.sorted { $0.value.minX < $1.value.minX }.map(\.key)
        var state: [String: Any] = ["publishMeasured":frames["publish"] != nil, "toolbarItemOrder":order,
            "publishVisible":toolbar.visibleItems?.contains { $0.itemIdentifier.rawValue == "publish" } ?? false]
        guard let publish = frames["publish"] else { return state }
        state["publishLeading"] = publish.minX; state["publishTrailing"] = publish.maxX
        state["publishTrailingInset"] = (window?.frame.width ?? 0) - publish.maxX
        state["beforePublishTrailing"] = frames.filter { $0.key != "publish" }.map(\.value.maxX).max() ?? 0
        return state
    }

    func publishInspect(_ item: NSMenuToolbarItem?, state: [String: Any]) -> [String: Any] {
        ["publishing":state["publishing"] as? Bool ?? false, "publishEnabled":item?.isEnabled ?? false, "publishSpinning":publishSpinner.spinning && item?.image != nil,
         "publishClickable":item?.action != nil, "publishMenu":item?.menu.items.filter { !$0.isSeparatorItem }.map(\.title) ?? []]
    }
}
