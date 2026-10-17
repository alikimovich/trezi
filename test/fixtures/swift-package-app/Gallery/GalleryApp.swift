import GalleryKit
import SwiftUI

// The app entry point. A target-graph build leaves it out (`@main`): the preview
// host has its own entry point.
@main
struct GalleryApp: App {
    var body: some Scene {
        WindowGroup { BrandCard() }
    }
}
