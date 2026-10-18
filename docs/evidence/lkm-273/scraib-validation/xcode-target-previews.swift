@testable import scraib
import SwiftUI

struct ShortcutDemo: View {
    @State var keyCode = 0
    @State var modifiers = 0
    var body: some View { ShortcutRecorderView(title: "Dictation shortcut", keyCode: $keyCode, modifiers: $modifiers).padding() }
}

struct KeyDemo: View {
    @State var key = ""
    var body: some View { ProviderAPIKeyField(provider: .claude, apiKey: $key, validationMessage: nil, onChange: {}).padding() }
}

enum TreziPreviews {
    @MainActor static var all: [TreziPreview] {
        [
            .swiftUI("shortcut-recorder", "Shortcut recorder", size: CGSize(width: 360, height: 80)) { ShortcutDemo() },
            .swiftUI("provider-key", "Provider API key", size: CGSize(width: 360, height: 140)) { KeyDemo() }
        ]
    }
}
