import Foundation

/// Text read from the package's own resource bundle through `Bundle.module`.
public enum Tagline {
    public static var text: String {
        guard let url = Bundle.module.url(forResource: "tagline", withExtension: "txt"),
              let text = try? String(contentsOf: url, encoding: .utf8)
        else { return "tagline.txt is missing from Bundle.module" }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
