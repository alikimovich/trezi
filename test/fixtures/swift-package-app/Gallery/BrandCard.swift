import AppKit
import GalleryKit
import SwiftUI

/// What the build settings turned on, as text: `DEBUG` and `GALLERY_FIXTURE` come from
/// SWIFT_ACTIVE_COMPILATION_CONDITIONS, `GALLERY_FLAG` from OTHER_SWIFT_FLAGS.
enum BuildFlags {
    static var summary: String {
        var on: [String] = []
        #if DEBUG
        on.append("DEBUG")
        #endif
        #if GALLERY_FIXTURE
        on.append("GALLERY_FIXTURE")
        #endif
        #if GALLERY_FLAG
        on.append("GALLERY_FLAG")
        #endif
        return "Flags: \(on.joined(separator: " "))"
    }
}

private final class GalleryBundleMarker {}

/// The app's asset catalog color, read by name from `Bundle.main` and from the
/// module's own bundle (`Bundle(for:)`, the one the generated `Color(.brand)` uses).
enum BrandColor {
    static var summary: String {
        let module = Bundle(for: GalleryBundleMarker.self)
        guard NSColor(named: "Brand", bundle: module) != nil else {
            let car = module.url(forResource: "Assets", withExtension: "car")
            return "Brand: missing from the module bundle \(module.bundlePath) (Assets.car: \(car?.path ?? "none"))"
        }
        guard let color = NSColor(named: "Brand")?.usingColorSpace(.sRGB) else {
            return "Brand: missing from the asset catalog"
        }
        let parts = [color.redComponent, color.greenComponent, color.blueComponent]
        return "Brand: " + parts.map { String(format: "%.2f", $0) }.joined(separator: " ")
    }
}

/// An app view using the generated asset symbol (`Color(.brand)`), the framework's
/// package-backed badge and the settings-dependent text.
struct BrandCard: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            RoundedRectangle(cornerRadius: 8)
                .fill(Color(.brand))
                .frame(height: 24)
            TextField("Brand", text: .constant(BrandColor.summary))
                .textFieldStyle(.plain)
            TextField("Flags", text: .constant(BuildFlags.summary))
                .textFieldStyle(.plain)
            TaglineBadge()
        }
        .padding(16)
    }
}
