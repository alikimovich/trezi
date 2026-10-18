import NotesKit
import Observation
import SwiftUI

// Environment injection: the list reads an `@Observable` store and an
// `ObservableObject` from the environment, and its `#Preview` provides both.

@Observable
final class NoteStore {
    var notes: [Note] = [
        Note(id: 1, title: "Groceries"),
        Note(id: 2, title: "Launch plan", pinned: true)
    ]
}

final class ListSettings: ObservableObject {
    @Published var compact = false
}

struct NoteList: View {
    @Environment(NoteStore.self) private var store
    @EnvironmentObject var settings: ListSettings

    var body: some View {
        VStack(alignment: .leading, spacing: settings.compact ? 2 : 8) {
            ForEach(store.notes) { note in
                NoteCard(note: note)
            }
        }
        .padding()
    }
}

#Preview("List with store") {
    NoteList()
        .environment(NoteStore())
        .environmentObject(ListSettings())
}
