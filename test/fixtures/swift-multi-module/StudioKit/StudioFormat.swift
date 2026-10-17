import Foundation

/// Library-module formatting the badge and the meter share.
public enum StudioFormat {
    public static func count(_ value: Int, _ noun: String) -> String {
        value == 1 ? "1 \(noun)" : "\(value) \(noun)s"
    }

    public static func level(_ value: Int, of total: Int) -> String {
        "Level \(min(max(value, 0), total)) of \(total)"
    }
}
