import AppKit
import SwiftUI

// Preview declarations for Trezi's native component preview host. This file is compiled
// only into that host (it uses `TreziPreview`), never into the DemoComponents library.

/// Sample dependency: following adds one follower.
struct SampleProfileService: ProfileService {
    func followers(for id: String, following: Bool, base: Int) -> Int { following ? base + 1 : base - 1 }
}

/// Sample dependency: a fixed component catalog.
struct SampleSearchIndex: SearchIndex {
    let names = ["Button", "Card", "Sidebar", "Slider", "Toolbar"]
    func search(_ query: String) -> [String] { names.filter { $0.localizedCaseInsensitiveContains(query) } }
}

extension Profile {
    static let sample = Profile(id: "ada", name: "Ada Lovelace", role: "Analytical engine programmer", followers: 1_842)
}

enum TreziPreviews {
    @MainActor static var all: [TreziPreview] {
        [
            .swiftUI("profile-card", "Profile card", size: CGSize(width: 320, height: 330)) {
                ProfileCard(model: ProfileModel(profile: .sample, service: SampleProfileService()))
            },
            .appKit("rating-control", "Rating control", size: CGSize(width: 240, height: 90)) {
                let control = RatingControl()
                control.rating = 3
                return control
            },
            .viewController("search-panel", "Search panel", size: CGSize(width: 340, height: 170)) {
                SearchPanelController(index: SampleSearchIndex())
            }
        ]
    }
}
