import GreetKit
import SwiftUI

enum TreziPreviews {
    @MainActor static var all: [TreziPreview] {
        [
            .swiftUI("greeting-badge", "Greeting badge", size: CGSize(width: 260, height: 80)) {
                GreetingBadge(greeter: Greeter(), name: "Ada")
            }
        ]
    }
}
