import AppKit

// LKM-372: project favicons in the native sidebar. Decoding (`SidebarFavicon`) and the shared
// row layout (`SourceListCell`), without a window or the app.

func png(width: Int, height: Int, red: UInt8, green: UInt8, blue: UInt8) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: width * 4, bitsPerPixel: 32)!
    for index in 0..<(width * height) { for (offset, value) in [red, green, blue, 255].enumerated() { rep.bitmapData![index * 4 + offset] = value } }
    return rep.representation(using: .png, properties: [:])!
}

/// A 16×16 32-bit BMP icon in an ICO container, every pixel the given BGRA colour.
func ico(blue: UInt8, green: UInt8, red: UInt8) -> Data {
    var data = Data()
    func le16(_ v: Int) { data.append(contentsOf: [UInt8(v & 0xff), UInt8(v >> 8 & 0xff)]) }
    func le32(_ v: Int) { le16(v & 0xffff); le16(v >> 16 & 0xffff) }
    let pixels = 16 * 16 * 4, mask = 16 * 4, image = 40 + pixels + mask
    le16(0); le16(1); le16(1)                                   // reserved, type icon, one image
    data.append(contentsOf: [16, 16, 0, 0]); le16(1); le16(32)  // 16×16, no palette, planes, bpp
    le32(image); le32(6 + 16)                                   // size, offset
    le32(40); le32(16); le32(32); le16(1); le16(32); le32(0); le32(pixels); le32(0); le32(0); le32(0); le32(0)
    for _ in 0..<(16 * 16) { data.append(contentsOf: [blue, green, red, 255]) }
    data.append(Data(count: mask))
    return data
}

func dataURL(_ type: String, _ bytes: Data) -> String { "data:\(type);base64,\(bytes.base64EncodedString())" }

func check(_ condition: Bool, _ message: @autoclosure () -> String) {
    if !condition { FileHandle.standardError.write(("SIDEBAR FAVICON FAIL — " + message() + "\n").data(using: .utf8)!); exit(1) }
}

let redPNG = png(width: 32, height: 16, red: 255, green: 0, blue: 0)
let svg = ##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect width="24" height="24" fill="#0000ff"/></svg>"##
let onePixel = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=")!

// Valid favicons: decoded, never template, fitted into the 16-point slot with the aspect ratio kept.
let valid: [(String, String, CGFloat)] = [
    ("png 32×16", dataURL("image/png", redPNG), 2),
    ("png 1×1", dataURL("image/png", onePixel), 1),
    ("svg base64", dataURL("image/svg+xml", svg.data(using: .utf8)!), 1),
    ("svg percent-encoded", "data:image/svg+xml," + svg.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!, 1),
    ("ico", dataURL("image/x-icon", ico(blue: 0, green: 200, red: 0)), 1)
]
for (name, uri, aspect) in valid {
    guard let image = SidebarFavicon.image(dataURL: uri) else { check(false, "\(name) did not decode"); continue }
    check(!image.isTemplate, "\(name) must keep its own colours (not a template)")
    check(max(image.size.width, image.size.height) == SidebarIconLayout.size, "\(name) fitted size \(image.size)")
    check(abs(image.size.width / image.size.height - aspect) < 0.01, "\(name) aspect \(image.size)")
    check(SidebarFavicon.image(dataURL: uri) === image, "\(name) repeated snapshots reuse the decoded image")
}

// Missing, non-image, corrupt and undecodable data: nil, so the row keeps its folder.
let invalid: [(String, String?)] = [
    ("missing", nil),
    ("empty", "data:image/png;base64,"),
    ("remote URL", "https://example.com/favicon.png"),
    ("non-image type", dataURL("text/html", "<html></html>".data(using: .utf8)!)),
    ("bad base64", "data:image/png;base64,!!!not-base64!!!"),
    ("text named favicon.png", dataURL("image/png", "this is not an image".data(using: .utf8)!)),
    ("png signature, garbage body", dataURL("image/png", Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) + "garbage".data(using: .utf8)!)),
    ("truncated png", dataURL("image/png", redPNG.prefix(24))),
    ("ico header only", dataURL("image/x-icon", ico(blue: 0, green: 0, red: 0).prefix(22))),
    ("svg without markup", dataURL("image/svg+xml", "not svg".data(using: .utf8)!))
]
for (name, uri) in invalid { check(SidebarFavicon.image(dataURL: uri) == nil, "\(name) must fall back to the folder") }

// Rows as NativeShell builds them: favicon and folder rows share the frame, the label column
// and the vertical centre, selected or not.
final class Rows: NSObject, NSOutlineViewDataSource, NSOutlineViewDelegate {
    let images: [(String, NSImage)]
    init(_ images: [(String, NSImage)]) { self.images = images }
    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int { item == nil ? images.count : 0 }
    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any { images[index].0 }
    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool { false }
    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        let cell = SourceListCell()
        let text = cell.install(title: item as! String, image: images.first { $0.0 == item as! String }!.1)
        text.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -4).isActive = true
        return cell
    }
}

let folder = NSImage(systemSymbolName: "folder", accessibilityDescription: nil)!
let wide = SidebarFavicon.image(dataURL: valid[0].1)!, square = SidebarFavicon.image(dataURL: valid[4].1)!
let rows = Rows([("lkmv.ch", wide), ("radial-portfolio", folder), ("icon project", square)])
let outline = NSOutlineView(frame: NSRect(x: 0, y: 0, width: 240, height: 200))
SourceList.configure(outline, label: "Projects")
outline.dataSource = rows; outline.delegate = rows
let scroll = SourceList.scrollView(outline)
scroll.frame = NSRect(x: 0, y: 0, width: 240, height: 200)
outline.reloadData()
var reference: NSRect?
for emphasized in [false, true] {
    for index in 0..<outline.numberOfRows {
        let cell = outline.view(atColumn: 0, row: index, makeIfNecessary: true) as! SourceListCell
        cell.backgroundStyle = emphasized ? .emphasized : .normal
        cell.layoutSubtreeIfNeeded()
        let icon = cell.imageView!, text = cell.textField!
        let name = "\(rows.images[index].0) \(emphasized ? "selected" : "unselected")"
        let rect = icon.convert(icon.bounds, to: outline)
        let label = outline.convert(text.alignmentRect(forFrame: text.frame), from: cell)
        check(icon.bounds.size == NSSize(width: 16, height: 16), "\(name): slot \(icon.bounds.size)")
        check(rect.origin.x == rect.origin.x.rounded() && rect.origin.y == rect.origin.y.rounded(), "\(name): fractional origin \(rect.origin)")
        check(label.minX - rect.maxX == SidebarIconLayout.gap, "\(name): label gap")
        check(abs(label.midY - rect.midY) <= 1, "\(name): icon centre \(rect.midY) vs label \(label.midY)")
        // The slot's offset within its row, against the first row's.
        let slot = NSRect(origin: NSPoint(x: rect.minX, y: rect.minY - outline.rect(ofRow: index).minY), size: rect.size)
        if let reference { check(slot == reference, "\(name): layout shift \(slot) against the first row's \(reference)") }
        else { reference = slot }
        let favicon = icon.image !== folder
        let tint: NSColor? = favicon ? nil : emphasized ? .alternateSelectedControlTextColor : .labelColor
        check(icon.contentTintColor == tint, "\(name): tint \(String(describing: icon.contentTintColor))")
        let ink = SidebarFaviconInk.measure(icon)
        check(ink.fraction > 0, "\(name): blank icon slot")
        if index == 0 {
            // 32×16 fitted to 16×8: half the slot, solid red, centred.
            check(abs(ink.fraction - 0.5) < 0.1, "\(name): wide favicon covers \(ink.fraction) of the slot")
            check(ink.center == "#FF0000", "\(name): centre \(ink.center)")
        }
        if index == 2 { check(ink.fraction > 0.95 && ink.center == "#00C800", "\(name): ico \(ink.fraction) \(ink.center)") }
    }
}
print("SIDEBAR FAVICON PASS — PNG/SVG/ICO favicons decode into the 16-point slot with aspect kept; missing/invalid/corrupt data falls back; favicon and folder rows align selected and unselected")
