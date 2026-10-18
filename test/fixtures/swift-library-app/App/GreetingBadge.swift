import GreetKit
import SwiftUI

/// An app-module view that only compiles because it imports the library module.
/// (A read-only field, because the host reads SwiftUI field values, not static text.)
struct GreetingBadge: View {
    let greeter: Greeter
    let name: String

    var body: some View {
        TextField("Greeting", text: .constant(greeter.greeting(for: name)))
            .font(.title2)
            .padding(16)
    }
}
