import SwiftUI

// Availability and conditional compilation around previews and components.

@available(macOS 15.0, *)
struct NewBadge: View {
    var body: some View {
        Text("New")
            .padding(6)
            .background(.blue.gradient, in: .capsule)
    }
}

@available(macOS 15.0, *)
#Preview("New badge (macOS 15)") {
    NewBadge()
}

#if DEBUG
struct DebugPanel: View {
    var body: some View {
        Text("Debug build")
            .padding()
    }
}

#Preview("Debug panel") {
    DebugPanel()
}
#endif

#if os(iOS)
#Preview("iOS only") {
    Text("Never compiled on macOS")
}
#endif
