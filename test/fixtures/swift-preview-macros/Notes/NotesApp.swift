import NotesKit
import SwiftUI

// The app entry point. A target-graph build leaves this file out (`@main`), so the
// `#Preview` below is listed as unsupported with that reason.
@main
struct NotesApp: App {
    @State private var store = NoteStore()

    var body: some Scene {
        WindowGroup {
            NoteList()
                .environment(store)
                .environmentObject(ListSettings())
        }
    }
}

#Preview("App window") {
    NoteList()
        .environment(NoteStore())
        .environmentObject(ListSettings())
}
