import StudioKit
import SwiftUI

/// App-internal model: the previews reach it through `@testable import Studio`.
struct StudioProject {
    let title: String
    let open: Int

    static let sample = StudioProject(title: "Launch plan", open: 3)
}

/// The cross-module component: an internal app view built from the library's badge.
struct ProjectHeader: View {
    let project: StudioProject

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Project", text: .constant(project.title))
                .font(.headline)
            StatusBadge(title: "Open tasks", count: project.open)
        }
        .padding(16)
    }
}
