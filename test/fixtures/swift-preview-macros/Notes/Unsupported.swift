import AppKit
import SwiftUI

// What Trezi lists as unsupported, each with its reason: a preview modifier trait
// (an async shared context), a generic view, and a view controller whose view comes
// from a nib.

@available(macOS 15.0, *)
struct SampleStore: PreviewModifier {
    static func makeSharedContext() async throws -> NoteStore { NoteStore() }

    func body(content: Content, context: NoteStore) -> some View {
        content.environment(context)
    }
}

@available(macOS 15.0, *)
#Preview("Shared store", traits: .modifier(SampleStore())) {
    NoteList()
        .environmentObject(ListSettings())
}

struct Tagged<Content: View>: View {
    let content: Content

    var body: some View {
        content.padding(4)
    }
}

final class NibController: NSViewController {}

final class SummaryViewController: NSViewController {
    var summary = "3 notes"

    override func loadView() {
        view = NSTextField(labelWithString: summary)
    }
}
