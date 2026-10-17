import StudioKit
import SwiftUI

// The app entry point. A target-graph build leaves it out (`@main`): the preview
// host has its own entry point.
@main
struct StudioApp: App {
    var body: some Scene {
        WindowGroup { ProjectHeader(project: .sample) }
    }
}
