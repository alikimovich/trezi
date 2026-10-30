import AppKit
import Foundation

// LKM-385: a badge hung from a real control through the conversions the host uses: a flipped
// canvas under a toolbar strip, in a window that is never shown.
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1320, height: 860), styleMask: [.borderless], backing: .buffered, defer: true)
final class Flipped: NSView { override var isFlipped: Bool { true } }
let root = NSView(frame: window.contentView!.bounds)
window.contentView = root
let toolbarHeight: CGFloat = 52
let canvas = Flipped(frame: NSRect(x: 300, y: 0, width: 1020, height: 860 - toolbarHeight))
let control = NSView(frame: NSRect(x: 1000, y: 860 - toolbarHeight + 8, width: 128, height: 36))
root.addSubview(canvas); root.addSubview(control)
let segment = NSRect(x: 96, y: 0, width: 32, height: 36)
let anchor = canvas.convert(control.convert(segment, to: nil), from: nil)
let page = NSRect(x: 140, y: 0, width: 880, height: 808)
let size = NSSize(width: 67.5, height: 22.5)
let frames = ["anchor":anchor, "under":PreviewSpeedPlacement.frame(size: size, anchor: anchor, page: page),
              // The full-screen toolbar window slid down over the canvas.
              "slidAnchor":anchor.offsetBy(dx: 0, dy: 40), "slid":PreviewSpeedPlacement.frame(size: size, anchor: anchor.offsetBy(dx: 0, dy: 40), page: page),
              "none":PreviewSpeedPlacement.frame(size: size, anchor: nil, page: page), "page":page]
let report = frames.mapValues(PreviewSpeedPlacement.box)
print(String(data: try! JSONSerialization.data(withJSONObject: report.merging(["gap":["value":Double(PreviewSpeedPlacement.gap)]]) { _, new in new }), encoding: .utf8)!)
