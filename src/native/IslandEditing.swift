import Foundation

// How every island control applies its edits (LKM-133); no SwiftUI, so
// test/native-island-editing.mjs compiles it on its own.

// The native wire format is deliberately smaller than a general UI interpreter.
enum IslandValue: Decodable, Equatable {
    case number(Double), text(String), toggle(Bool)
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if let bool = try? value.decode(Bool.self) { self = .toggle(bool) }
        else if let number = try? value.decode(Double.self) { self = .number(number) }
        else { self = .text(try value.decode(String.self)) }
    }
    var object: Any { switch self { case .number(let n): return n; case .text(let s): return s; case .toggle(let b): return b } }
    var number: Double { if case .number(let n) = self { return n }; return 0 }
    var text: String { switch self { case .number(let n): return String(format: "%.4g", n); case .text(let s): return s; case .toggle(let b): return b ? "true" : "false" } }
}

/// One island's live writes. Every control (XY pad, slider, bezier handle, typed field,
/// toggle, picker, preset) reports changes here: frames while the user edits are sent at
/// most every `interval`, the gesture's last change is always sent, and all writes of one
/// gesture carry one gesture id, which the backend turns into one Undo group.
struct IslandLiveWrites {
    static let interval: TimeInterval = 0.08
    private(set) var gesture = UUID().uuidString
    private var pending: [String: IslandValue] = [:]
    private var last = Date.distantPast

    /// The values to write now with their gesture id, or nil while throttled. Values held
    /// back by the throttle are merged into the next batch, so none are lost. `ended` marks
    /// the gesture's last batch: a Shadow island writes its source then (LKM-140).
    mutating func change(_ values: [String: IslandValue], ended: Bool, at now: Date = Date()) -> (gesture: String, values: [String: IslandValue], ended: Bool)? {
        pending.merge(values) { _, next in next }
        guard ended || now.timeIntervalSince(last) >= Self.interval, !pending.isEmpty else { return nil }
        let batch = (gesture: gesture, values: pending, ended: ended)
        pending = [:]; last = now
        if ended { gesture = UUID().uuidString; last = .distantPast }
        return batch
    }
}

/// A typed island field. Return and blur both commit, with no separate apply step; an
/// invalid draft is never written, nor one that is already the source value or was just sent.
struct IslandEntry {
    enum Kind: Equatable { case number(ClosedRange<Double>?), text, bezier }
    let kind: Kind
    private var sent: String?
    init(_ kind: Kind) { self.kind = kind }

    func parse(_ draft: String) -> IslandValue? {
        let text = draft.trimmingCharacters(in: .whitespaces)
        switch kind {
        case .number(let range):
            guard let n = Double(text), n.isFinite, range?.contains(n) ?? true else { return nil }
            return .number(n)
        case .bezier:
            let regex = try! NSRegularExpression(pattern: "-?\\d*\\.?\\d+")
            let numbers = regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { Range($0.range, in: text).flatMap { Double(text[$0]) } }
            guard numbers.count == 4, numbers.allSatisfy(\.isFinite) else { return nil }
            return .text(text)
        case .text: return .text(draft)
        }
    }
    /// What Return or blur writes for `draft` while the source shows `current`.
    mutating func commit(_ draft: String, current: String) -> IslandValue? {
        guard draft != current, draft != sent, let value = parse(draft) else { return nil }
        sent = draft
        return value
    }
    /// The source value changed: the next commit compares against it alone.
    mutating func sourceChanged() { sent = nil }
}
