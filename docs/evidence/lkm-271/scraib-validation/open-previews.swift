import SwiftUI

enum TreziPreviews {
    @MainActor static var all: [TreziPreview] {
        [
            .swiftUI("theme-card", "Theme preview card", size: CGSize(width: 190, height: 140)) {
                ThemePreviewCard(theme: SystemTheme(), isSelected: true, onSelect: {}).padding(20)
            }
        ]
    }
}
