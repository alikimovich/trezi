import AppKit

final class NativeActivity: NSObject, NSWindowDelegate {
    weak var parent: NSWindow?
    var window: NSWindow?
    let text = NSTextView()
    var count = 0
    /// Every line with its full paths, for Copy All.
    var fullText = ""
    func update(_ state: [String: Any]) {
        guard state["visible"] as? Bool == true else { let wasVisible = window?.isVisible == true; window?.orderOut(nil); if wasVisible { parent?.makeKeyAndOrderFront(nil) }; return }
        if window == nil {
            let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 420), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
            panel.title = "Activity"; panel.isReleasedWhenClosed = false; panel.delegate = self
            let content = NSView(); panel.contentView = content
            let clear = NSButton(title: "Clear", target: self, action: #selector(clearLog))
            let copy = NSButton(title: "Copy All", target: self, action: #selector(copyLog))
            // Lists the kept refs/trezi/recovery/* refs; deleting any is an explicit, confirmed choice there.
            let recovery = NSButton(title: "Recovery Refs…", target: self, action: #selector(showRecovery))
            let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
            text.isEditable = false; text.isSelectable = true; text.isRichText = false
            text.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
            text.textContainerInset = NSSize(width: 12, height: 12)
            text.isVerticallyResizable = true; text.isHorizontallyResizable = false
            text.autoresizingMask = [.width]; text.textContainer?.widthTracksTextView = true
            scroll.documentView = text
            for view in [clear, copy, recovery, scroll] { view.translatesAutoresizingMaskIntoConstraints = false; content.addSubview(view) }
            NSLayoutConstraint.activate([
                clear.topAnchor.constraint(equalTo: content.topAnchor, constant: 8), clear.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -12),
                copy.centerYAnchor.constraint(equalTo: clear.centerYAnchor), copy.trailingAnchor.constraint(equalTo: clear.leadingAnchor, constant: -8),
                recovery.centerYAnchor.constraint(equalTo: clear.centerYAnchor), recovery.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 12),
                scroll.topAnchor.constraint(equalTo: clear.bottomAnchor, constant: 8), scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor), scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor), scroll.bottomAnchor.constraint(equalTo: content.bottomAnchor)
            ])
            panel.center(); window = panel
        }
        let pinned = text.visibleRect.maxY >= text.bounds.maxY - 24
        let lines = state["lines"] as? [[String: Any]] ?? []; count = lines.count
        let output = NSMutableAttributedString()
        var full = ""
        for line in lines {
            let kind = line["kind"] as? String
            // Startup recovery notices are gray: nothing was lost (LKM-152).
            let color: NSColor = kind == "error" || kind == "needs-action" ? .systemRed : kind == "warning" ? .systemOrange : kind == "success" ? .systemGreen : kind == "notice" ? .secondaryLabelColor : .labelColor
            // Lines show collapsed paths (`display`); the tooltip and Copy All keep the full text.
            let time = line["time"] as? String ?? "", original = line["text"] as? String ?? ""
            let shown = line["display"] as? String ?? original
            var attributes: [NSAttributedString.Key: Any] = [.foregroundColor: color, .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)]
            if shown != original { attributes[.toolTip] = original }
            output.append(NSAttributedString(string: "\(time)  \(shown)\n", attributes: attributes))
            full += "\(time)  \(original)\n"
        }
        fullText = full
        text.textStorage?.setAttributedString(output)
        if pinned { text.scrollToEndOfDocument(nil) }
        // The user's Show takes the key window; an automatic open only orders it front,
        // so typing in the chat is not interrupted.
        if state["focus"] as? Bool == true { window?.makeKeyAndOrderFront(nil) }
        else if state["raise"] as? Bool == true || window?.isVisible != true { window?.orderFront(nil) }
    }
    @objc func clearLog() { emit(["event":"activity-action", "action":"clear"]) }
    @objc func showRecovery() { emit(["event":"activity-action", "action":"recovery"]) }
    @objc func copyLog() { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(fullText, forType: .string) }
    func windowWillClose(_ notification: Notification) { emit(["event":"activity-action", "action":"hide"]) }
}
