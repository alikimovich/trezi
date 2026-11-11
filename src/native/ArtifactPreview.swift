import AppKit
import Quartz

/// LKM-657: a chat link's project image, PDF or movie in a Quick Look panel inside Trezi,
/// (`HostFileLinks.swift` adds Reveal in Finder). Quick Look renders these natively (no page scripts, no network);
/// nothing is opened in another app, executed or written.
final class ArtifactPreview: NSObject, NSWindowDelegate {
    static let shared = ArtifactPreview()
    private var panel: NSPanel?
    private var preview: QLPreviewView?
    private(set) var path: String?
    private(set) var shown = 0

    func show(_ path: String, over parent: NSWindow?, order: Bool = true) {
        let panel = self.panel ?? {
            let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 720, height: 540), styleMask: [.titled, .closable, .resizable, .utilityWindow], backing: .buffered, defer: true)
            panel.isReleasedWhenClosed = false; panel.hidesOnDeactivate = false; panel.delegate = self
            panel.minSize = NSSize(width: 320, height: 240)
            let view = QLPreviewView(frame: panel.contentLayoutRect, style: .normal)!
            view.autoresizingMask = [.width, .height]; view.autostarts = true
            panel.contentView = view
            self.panel = panel; self.preview = view
            if let parent { let frame = parent.frame; panel.setFrameOrigin(NSPoint(x: frame.midX - 360, y: frame.midY - 270)) }
            return panel
        }()
        preview?.previewItem = URL(fileURLWithPath: path) as NSURL
        panel.title = (path as NSString).lastPathComponent
        panel.representedURL = URL(fileURLWithPath: path)
        self.path = path; shown += 1
        if order { panel.makeKeyAndOrderFront(nil) }
    }
    func close() { panel?.close() }
    func windowWillClose(_ notification: Notification) { preview?.previewItem = nil; path = nil }
    var inspect: [String: Any] { ["visible": panel?.isVisible ?? false, "path": path ?? NSNull(), "shown": shown, "title": panel?.title ?? "",
                                  "item": (preview?.previewItem as? NSURL)?.path ?? NSNull()] }
}

