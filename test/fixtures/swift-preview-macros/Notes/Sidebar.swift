import SwiftUI

// Private same-file declarations: the `#Preview` uses a private view and private
// sample data, so Trezi builds an isolated copy of this file with its preview
// appended (the original is never edited).

private let sampleFolders = ["Inbox", "Work", "Ideas"]

private struct FolderRow: View {
    let name: String

    var body: some View {
        Label(name, systemImage: "folder")
            .padding(.vertical, 2)
    }
}

struct Sidebar: View {
    var folders: [String]

    var body: some View {
        VStack(alignment: .leading) {
            ForEach(folders, id: \.self) { FolderRow(name: $0) }
        }
        .padding()
    }
}

#Preview("Sidebar folders") {
    VStack(alignment: .leading) {
        ForEach(sampleFolders, id: \.self) { FolderRow(name: $0) }
    }
    .padding()
}
