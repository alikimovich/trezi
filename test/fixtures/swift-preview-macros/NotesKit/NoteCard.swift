import SwiftUI

// A framework view with two plain `#Preview` blocks: one unnamed, one named with a
// fixed-size layout trait. Trezi lists both without changing this file.

public struct Note: Identifiable, Hashable {
    public let id: Int
    public var title: String
    public var pinned: Bool

    public init(id: Int, title: String, pinned: Bool = false) {
        self.id = id
        self.title = title
        self.pinned = pinned
    }
}

public struct NoteCard: View {
    let note: Note

    public init(note: Note) {
        self.note = note
    }

    public var body: some View {
        HStack(spacing: 8) {
            Text(note.title)
                .font(.headline)
            if note.pinned {
                Text("Pinned")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(12)
    }
}

#Preview {
    NoteCard(note: Note(id: 1, title: "Groceries"))
}

#Preview("Pinned card", traits: .fixedLayout(width: 280, height: 80)) {
    NoteCard(note: Note(id: 2, title: "Launch plan", pinned: true))
}
