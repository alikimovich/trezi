import Foundation

/// LKM-208: an answer component (`chat_ui`) as a chat frame carries it. Bun validates with
/// the zod catalog (`bin/chat-ui-schema.mjs`); Swift decodes and checks the same limits
/// again, so a payload that got past it is shown as an error, never half-drawn.
struct ChatUiImage: Codable, Equatable { let src: String; let route: String? }
struct ChatUiOption: Codable, Equatable { let id: String; let title: String; let note: String; let tags: [String]? }
struct ChatUiChoice: Codable, Equatable { let value: String; let label: String }
struct ChatUiSuggestion: Codable, Equatable { let name: String; let value: String }

enum ChatUiValue: Codable, Equatable {
    case text(String), number(Double), flag(Bool), list([String])
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let v = try? c.decode(Bool.self) { self = .flag(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .text(v) }
        else { self = .list(try c.decode([String].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .text(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .flag(let v): try c.encode(v)
        case .list(let v): try c.encode(v)
        }
    }
    var json: Any { switch self { case .text(let v): v; case .number(let v): v; case .flag(let v): v; case .list(let v): v } }
}

struct ChatUiField: Decodable, Equatable {
    let id: String; let type: String; let label: String; let help: String?; let required: Bool?
    let options: [ChatUiChoice]?; let multiple: Bool?
    let placeholder: String?; let multiline: Bool?
    let min: Double?; let max: Double?; let step: Double?; let unit: String?
    let suggestions: [ChatUiSuggestion]?
    let `default`: ChatUiValue?
    var isRequired: Bool { required != false && type != "toggle" }
}

struct ChatUiComponent: Decodable, Equatable {
    let kind: String; let title: String; let prompt: String?
    let options: [ChatUiOption]?
    let fields: [ChatUiField]?; let submitLabel: String?
}

struct ChatUiAnswer: Decodable, Equatable {
    /// Options: the picked id; nil with `none` set is "none of these".
    let choice: String?; let none: Bool; let comment: String?
    let values: [String: ChatUiValue]?
    enum Keys: String, CodingKey { case choice, comment, values }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        choice = try c.decodeIfPresent(String.self, forKey: .choice)
        none = c.contains(.choice) && choice == nil
        comment = try c.decodeIfPresent(String.self, forKey: .comment)
        values = try c.decodeIfPresent([String: ChatUiValue].self, forKey: .values)
    }
}

struct ChatUiRecord: Decodable, Equatable {
    let id: String; let component: ChatUiComponent
    let images: [String: ChatUiImage]; let missing: [String: String]?
    let answer: ChatUiAnswer?; let answeredAt: Double?; let at: Double
}

/// A segment's `ui`: decoding never fails the frame; a bad record carries its problems.
struct ChatUiPayload: Decodable {
    let record: ChatUiRecord?; let problems: [String]
    init(from decoder: Decoder) throws {
        do {
            let record = try ChatUiRecord(from: decoder)
            let problems = ChatUiCatalog.problems(record.component)
            self.record = problems.isEmpty ? record : nil; self.problems = problems
        } catch { record = nil; problems = ["component: \(ChatUiCatalog.describe(error))"] }
    }
}

enum ChatUiCatalog {
    static let kinds = ["options", "form"]
    static let fieldTypes = ["choice", "text", "number", "slider", "color", "toggle"]
    static let limits = (options: 2...4, fields: 1...8, choices: 2...8, tags: 4, title: 80, prompt: 400, optionTitle: 60, note: 160, label: 60, help: 160, text: 2000)
    static let idPattern = try! NSRegularExpression(pattern: "^[a-z0-9][a-z0-9-]{0,31}$")

    static func decode(_ data: Data) -> ChatUiPayload? { try? JSONDecoder().decode(ChatUiPayload.self, from: data) }

    static func describe(_ error: Error) -> String {
        switch error as? DecodingError {
        case .keyNotFound(let key, let context)?: return "\(path(context.codingPath + [key])) is missing"
        case .typeMismatch(_, let context)?, .valueNotFound(_, let context)?: return "\(path(context.codingPath)) has the wrong type"
        case .dataCorrupted(let context)?: return "\(path(context.codingPath)) is not valid JSON"
        default: return error.localizedDescription
        }
    }
    private static func path(_ keys: [CodingKey]) -> String { keys.map { $0.intValue.map(String.init) ?? $0.stringValue }.joined(separator: ".") }

    /// Every problem as `path: message`, like Bun's zod issues; [] when it is valid.
    static func problems(_ component: ChatUiComponent) -> [String] {
        var out: [String] = []
        func check(_ ok: Bool, _ path: String, _ message: String) { if !ok { out.append("\(path): \(message)") } }
        func words(_ text: String?, _ max: Int, _ path: String, optional: Bool = false) {
            guard let text else { check(optional, path, "is missing"); return }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            check(!trimmed.isEmpty, path, "must not be empty"); check(trimmed.count <= max, path, "is longer than \(max) characters")
        }
        func id(_ value: String, _ path: String) {
            check(idPattern.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil, path, "use 1–32 lowercase letters, digits or dashes")
        }
        func unique(_ values: [String], _ path: String, _ key: String) {
            var seen = Set<String>()
            for (index, value) in values.enumerated() { check(seen.insert(value).inserted, "\(path).\(index).\(key)", "duplicate \(key) \"\(value)\"") }
        }
        guard kinds.contains(component.kind) else { return ["kind: unknown component \"\(component.kind)\""] }
        words(component.title, limits.title, "title"); words(component.prompt, limits.prompt, "prompt", optional: true)
        if component.kind == "options" {
            let options = component.options ?? []
            check(limits.options.contains(options.count), "options", "show \(limits.options.lowerBound)–\(limits.options.upperBound) options")
            check(component.fields == nil, "fields", "options take no fields")
            for (i, option) in options.enumerated() {
                id(option.id, "options.\(i).id"); words(option.title, limits.optionTitle, "options.\(i).title"); words(option.note, limits.note, "options.\(i).note")
                check((option.tags ?? []).count <= limits.tags, "options.\(i).tags", "at most \(limits.tags) tags")
            }
            unique(options.map(\.id), "options", "id")
            return out
        }
        let fields = component.fields ?? []
        check(limits.fields.contains(fields.count), "fields", "show \(limits.fields.lowerBound)–\(limits.fields.upperBound) fields")
        check(component.options == nil, "options", "a form takes fields")
        unique(fields.map(\.id), "fields", "id")
        for (i, f) in fields.enumerated() {
            let p = "fields.\(i)"
            id(f.id, "\(p).id"); words(f.label, limits.label, "\(p).label"); words(f.help, limits.help, "\(p).help", optional: true)
            guard fieldTypes.contains(f.type) else { out.append("\(p).type: unknown field type \"\(f.type)\""); continue }
            if f.type == "slider" { check(f.min != nil && f.max != nil, p, "a slider needs min and max") }
            if let min = f.min, let max = f.max {
                check(min < max, "\(p).min", "min must be below max")
                if case .number(let d)? = f.default { check(d >= min && d <= max, "\(p).default", "default is outside min…max") }
            }
            if f.type == "choice" {
                let choices = f.options ?? []
                check(limits.choices.contains(choices.count), "\(p).options", "offer \(limits.choices.lowerBound)–\(limits.choices.upperBound) choices")
                unique(choices.map(\.value), "\(p).options", "value")
                let known = Set(choices.map(\.value))
                switch f.default {
                case .text(let v)?: check(known.contains(v), "\(p).default", "default must be one of the option values")
                case .list(let v)?: check(f.multiple == true, "\(p).default", "a single choice takes one default value"); check(v.allSatisfy(known.contains), "\(p).default", "default must be one of the option values")
                case nil: break
                default: check(false, "\(p).default", "default must be one of the option values")
                }
            }
        }
        return out
    }
}

/// A form's values as the user edits them, and the one answer Submit sends.
struct ChatUiFormState: Equatable {
    var values: [String: ChatUiValue] = [:]
    init(_ component: ChatUiComponent) {
        for f in component.fields ?? [] {
            if let d = f.default { values[f.id] = d }
            else if f.type == "toggle" { values[f.id] = .flag(false) }
            else if f.type == "slider", let min = f.min { values[f.id] = .number(min) }
        }
    }
    static func filled(_ value: ChatUiValue?) -> Bool {
        switch value {
        case .text(let v)?: !v.trimmingCharacters(in: .whitespaces).isEmpty
        case .list(let v)?: !v.isEmpty
        case nil: false
        default: true
        }
    }
    /// What keeps Submit disabled; mirrors `chatUiAnswerProblems` in `src/shared/chat-ui.ts`.
    func problems(_ component: ChatUiComponent) -> [String] {
        var out: [String] = []
        for f in component.fields ?? [] {
            let value = values[f.id]
            guard Self.filled(value) else { if f.isRequired { out.append("\(f.label) is required.") }; continue }
            if case .number(let n)? = value {
                if let min = f.min, n < min { out.append("\(f.label): at least \(ChatUiFormat.number(min)).") }
                if let max = f.max, n > max { out.append("\(f.label): at most \(ChatUiFormat.number(max)).") }
            }
            if case .text(let t)? = value, t.count > ChatUiCatalog.limits.text { out.append("\(f.label): the text is too long.") }
        }
        return out
    }
    /// `{"values":{…}}` with empty optional fields left out.
    func answer(_ component: ChatUiComponent) -> String {
        var out: [String: Any] = [:]
        for f in component.fields ?? [] { if let v = values[f.id], Self.filled(v) { out[f.id] = v.json } }
        return ChatUiFormat.json(["values": out])
    }
}

enum ChatUiFormat {
    static func letter(_ index: Int) -> String { String(UnicodeScalar(UInt8(65 + index))) }
    static func number(_ value: Double) -> String { value == value.rounded() && abs(value) < 1e15 ? String(Int(value)) : String(value) }
    static func json(_ object: [String: Any]) -> String {
        (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }
    /// An options answer: a pick, or "none of these" (nil) with the user's comment.
    static func pick(_ choice: String?, comment: String) -> String {
        let note = comment.trimmingCharacters(in: .whitespacesAndNewlines)
        var out: [String: Any] = ["choice": choice as Any? ?? NSNull()]
        if !note.isEmpty { out["comment"] = note }
        return json(out)
    }
    static func value(_ value: ChatUiValue?, unit: String?) -> String {
        switch value {
        case .text(let v)?: v
        case .number(let v)?: unit.map { "\(number(v)) \($0)" } ?? number(v)
        case .flag(let v)?: v ? "On" : "Off"
        case .list(let v)?: v.joined(separator: ", ")
        case nil: "—"
        }
    }
    /// The JPEG bytes of an image data URI.
    static func imageData(_ src: String) -> Data? {
        guard src.hasPrefix("data:image/"), let comma = src.firstIndex(of: ",") else { return nil }
        return Data(base64Encoded: String(src[src.index(after: comma)...]))
    }
}
