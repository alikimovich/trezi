import SwiftUI

// A view driven by a binding; its `#Preview` owns the state with `@Previewable`.

public struct TagCounter: View {
    @Binding var count: Int
    let label: String

    public init(count: Binding<Int>, label: String) {
        _count = count
        self.label = label
    }

    public var body: some View {
        HStack {
            Text("\(label): \(count)")
            Button("Add tag") { count += 1 }
        }
        .padding()
    }
}

#Preview("Counter with state", traits: .sizeThatFitsLayout) {
    @Previewable @State var count = 3
    TagCounter(count: $count, label: "Tags")
}
