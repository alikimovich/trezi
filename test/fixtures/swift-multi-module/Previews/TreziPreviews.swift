import AppKit
@testable import Studio
import StudioKit
import SwiftUI

// Preview declarations for Trezi's native component preview host, compiled only into
// that host. The library's public components come from `import StudioKit`; the app's
// internal ones from `@testable import Studio` (each module is built with testing on).

enum TreziPreviews {
    @MainActor static var all: [TreziPreview] {
        [
            .swiftUI("status-badge", "Status badge (StudioKit)", size: CGSize(width: 260, height: 60)) {
                StatusBadge(title: "Reviews", count: 2)
            },
            .appKit("level-meter", "Level meter (StudioKit)", size: CGSize(width: 240, height: 72)) {
                let meter = LevelMeterView()
                meter.level = 3
                return meter
            },
            .swiftUI("project-header", "Project header (Studio)", size: CGSize(width: 300, height: 110)) {
                ProjectHeader(project: StudioProject(title: "Launch plan", open: 3))
            }
        ]
    }
}
