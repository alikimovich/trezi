import AppKit
import SwiftUI

// LKM-447: the Dreamer acceptance's footer measure (src/native/DreamerAcceptance.swift) on the
// real sheet sources, in a window that is never shown. Reads `[{name, width, state}]` from the
// file in argv[1] and prints one JSON line per case; test/dreamer-acceptance.mjs judges them.
func emit(_ event: [String: Any]) {}
let app = NSApplication.shared
let cases = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [[String: Any]]
for item in cases {
    let size = SectionedSheetContent.defaultSize
    let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentMinSize = SectionedSheetContent.minimumSize
    let sheets = NativeSheets(parent: window)
    sheets.model.update(try JSONDecoder().decode(SheetState.self, from: JSONSerialization.data(withJSONObject: item["state"]!)))
    // Match production: the split view with the source-list sidebar, installed the way NativeSheets does.
    sheets.panel = window
    sheets.install(in: window)
    window.setContentSize(NSSize(width: item["width"] as! Double, height: size.height))
    for _ in 0..<8 {
        window.contentView?.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.02))
    }
    precondition(!window.isVisible, "the fixture never shows a window")
    var result = try sheets.dreamerAcceptance(["op": "measure"])
    result["case"] = item["name"]
    print(String(data: try JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
    // Optional offscreen PNGs for layout review (no Liquid Glass; never shown on screen).
    if let dir = ProcessInfo.processInfo.environment["DREAMER_ACCEPTANCE_PNG"], let view = window.contentView,
       let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
        view.cacheDisplay(in: view.bounds, to: bitmap)
        try bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(item["name"]!).png"))
    }
    window.close()
}
