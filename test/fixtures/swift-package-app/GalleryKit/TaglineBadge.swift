import StudioDesign
import SwiftUI

/// A framework component built on the local package: its text comes from the package's
/// resource bundle. (A read-only field, because the host reads SwiftUI field values.)
public struct TaglineBadge: View {
    public init() {}

    public var body: some View {
        TextField("Tagline", text: .constant("Tagline: \(Tagline.text)"))
            .textFieldStyle(.plain)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Capsule().fill(Color.gray.opacity(0.15)))
    }
}
