import SwiftUI

/// A public SwiftUI component of the library module.
/// (A read-only field, because the host reads SwiftUI field values, not static text.)
public struct StatusBadge: View {
    let title: String
    let count: Int

    public init(title: String, count: Int) {
        self.title = title
        self.count = count
    }

    public var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(count > 0 ? Color.orange : Color.green)
                .frame(width: 10, height: 10)
            TextField(title, text: .constant("\(title): \(StudioFormat.count(count, "item"))"))
                .textFieldStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Capsule().fill(Color.gray.opacity(0.15)))
    }
}
