@testable import Gallery
import GalleryKit
import SwiftUI

// Preview declarations for Trezi's native component preview host (LKM-275): the
// framework's package-backed badge and the app's card using the asset catalog and
// the settings-dependent flags.

enum TreziPreviews {
    @MainActor static var all: [TreziPreview] {
        [
            .swiftUI("tagline-badge", "Tagline badge (GalleryKit + StudioDesign)", size: CGSize(width: 340, height: 60)) {
                TaglineBadge()
            },
            .swiftUI("brand-card", "Brand card (Gallery)", size: CGSize(width: 360, height: 170)) {
                BrandCard()
            }
        ]
    }
}
