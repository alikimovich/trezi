import Foundation
import Darwin

/// `<profile>/workspace.json` in its unchanged legacy format:
/// `{"projects":[entry…],"activeKey":key|null,"recents":[…]}`. The operations are
/// the retired Bun writer's (recorded in `test/workspace-owner.mjs`) and produce the
/// same bytes. Nothing is dropped: unknown fields, invalid entries and invalid
/// recents stay where they are. A project is a valid entry: an object whose
/// `root` is absolute and whose `key` is `projectKey(root)`; the first per key.
struct WorkspaceDocument: Equatable {
    static let maxProjects = 1000
    static let maxPatches = 256
    static let maxRecents = 10
    static let maxRoot = 4096
    static let maxText = 8192
    static let maxName = 1024
    static let maxSessions = 1000

    private(set) var fields: [(JSText, JSValue)]

    static func == (lhs: WorkspaceDocument, rhs: WorkspaceDocument) -> Bool { JSValue.object(lhs.fields) == JSValue.object(rhs.fields) }

    static var empty: WorkspaceDocument {
        WorkspaceDocument(fields: [(JSText("projects"), .array([])), (JSText("activeKey"), .null), (JSText("recents"), .array([]))])
    }

    /// Refuses what the pre-S04 reader refused: anything but an object with an array `projects`.
    static func decode(_ data: Data) throws -> WorkspaceDocument {
        guard case .object(let fields) = try JSValue.parse(data), case .array? = JSValue.object(fields)["projects"] else {
            throw WorkspaceError.invalidFile
        }
        return WorkspaceDocument(fields: fields)
    }

    func encoded() -> Data { JSValue.object(fields).utf8() }

    subscript(_ key: String) -> JSValue? { JSValue.object(fields)[key] }
    mutating func set(_ key: String, _ value: JSValue) { JSValue.set(&fields, JSText(key), value) }

    var items: [JSValue] { if case .array(let items)? = self["projects"] { return items }; return [] }

    // MARK: Identity

    /// `projectKey` (src/shared/projectKey.ts): JS `trim()`, `\` → `/`, no trailing slashes.
    static func projectKey(_ root: JSText) -> JSText {
        func space(_ unit: UInt16) -> Bool {
            switch unit {
            case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
            default: return false
            }
        }
        var units = Array(root.drop(while: space))
        while let last = units.last, space(last) { units.removeLast() }
        units = units.map { $0 == 0x5C ? 0x2F : $0 }
        while units.last == 0x2F { units.removeLast() }
        return units.isEmpty ? [0x2F] : units
    }

    static func validEntry(_ item: JSValue) -> JSText? {
        guard case .object = item, let root = item["root"]?.text, root.hasPrefix("/"),
              let key = item["key"]?.text, key == projectKey(root) else { return nil }
        return key
    }

    static func validRecent(_ item: JSValue) -> Bool {
        guard case .object = item, item["root"]?.text != nil, item["name"]?.text != nil else { return false }
        return true
    }

    /// Valid entries in file order, the first per key, with their index in `projects`.
    func entries() -> [(index: Int, key: JSText, entry: JSValue)] {
        var seen = Set<JSText>(), out: [(Int, JSText, JSValue)] = []
        for (index, item) in items.enumerated() {
            if let key = Self.validEntry(item), seen.insert(key).inserted { out.append((index, key, item)) }
        }
        return out
    }

    /// Null unless it names a project.
    var activeKey: JSText? {
        guard let key = self["activeKey"]?.text, entries().contains(where: { $0.key == key }) else { return nil }
        return key
    }

    var recents: [JSValue] { if case .array(let items)? = self["recents"] { return items.filter(Self.validRecent) }; return [] }

    static func name(_ root: JSText) -> JSText { root.split(separator: 0x2F).last.map(Array.init) ?? root }

    // MARK: Operations (validated by WorkspaceOperation.init)

    struct Applied { var changed: Bool; var key: JSText? = nil; var created: Bool? = nil }

    mutating func apply(_ op: WorkspaceOperation, now: Double, resolve: (JSText) -> String?) throws -> Applied {
        let entries = entries()
        func find(_ key: JSText) -> (index: Int, key: JSText, entry: JSValue)? { entries.first { $0.key == key } }
        let missing = WorkspaceError.notFound
        switch op {
        case .open(let root, let chatSettings):
            let key = Self.projectKey(root)
            if find(key) != nil { return Applied(changed: false, key: key, created: false) }
            // The same folder reached through another path is the same project.
            if let real = resolve(root), let alias = entries.first(where: { resolve($0.entry["root"]!.text!) == real }) {
                return Applied(changed: false, key: alias.key, created: false)
            }
            guard entries.count < Self.maxProjects else { throw WorkspaceError.tooMany }
            var entry: [(JSText, JSValue)] = [
                (JSText("root"), .string(root)), (JSText("key"), .string(key)), (JSText("name"), .string(Self.name(root))),
                (JSText("url"), .null), (JSText("previewKind"), .string(JSText("web"))), (JSText("branch"), .null),
                (JSText("launchSpec"), .null), (JSText("touchedAt"), .number(now)), (JSText("sessionKeys"), .array([.string(key)])),
                (JSText("activeSessionKey"), .string(key))]
            if let chatSettings { entry.append((JSText("chatSettings"), .object([(key, chatSettings)]))) }
            set("projects", .array(items + [.object(entry)]))
            return Applied(changed: true, key: key, created: true)
        case .select(let key):
            guard let found = find(key), case .object(var entry) = found.entry else { throw missing }
            JSValue.set(&entry, JSText("touchedAt"), .number(now))
            var next = items; next[found.index] = .object(entry)
            set("projects", .array(next))
            set("activeKey", .string(key))
            return Applied(changed: true, key: key)
        case .close(let key):
            guard find(key) != nil else { throw missing }
            // Every copy of the identity goes; invalid entries are left alone.
            set("projects", .array(items.filter { Self.validEntry($0) != key }))
            if self["activeKey"]?.text == key { set("activeKey", .null) }
            return Applied(changed: true, key: key)
        case .reorder(let key, let before):
            guard let from = find(key) else { throw missing }
            if before == key { return Applied(changed: false) }
            var target: (index: Int, key: JSText, entry: JSValue)?
            if let before { guard let found = find(before) else { throw missing }; target = found }
            var next = items
            next.remove(at: from.index)
            let to = target.map { $0.index > from.index ? $0.index - 1 : $0.index } ?? next.count
            next.insert(from.entry, at: to)
            if to == from.index { return Applied(changed: false) }
            set("projects", .array(next))
            return Applied(changed: true)
        case .update(let patches):
            var next = items, changed = false
            for (key, patch) in patches {
                // A project closed meanwhile: the close won.
                guard let found = find(key), case .object(var entry) = next[found.index] else { continue }
                for (name, value) in patch where JSValue.object(entry)[name.string]?.serialized() != value.serialized() {
                    JSValue.set(&entry, name, value); changed = true
                }
                next[found.index] = .object(entry)
            }
            if changed { set("projects", .array(next)) }
            return Applied(changed: changed)
        case .recent(let root, let name):
            var prior: [JSValue] = []
            if case .array(let items)? = self["recents"] { prior = items }
            let kept = prior.filter { item in
                guard case .object = item, item["root"]?.text == root else { return true }
                return false
            }
            let recent = JSValue.object([(JSText("root"), .string(root)), (JSText("name"), .string(name)), (JSText("at"), .number(now))])
            set("recents", .array(Array(([recent] + kept).prefix(Self.maxRecents))))
            return Applied(changed: true)
        }
    }
}

extension JSValue {
    /// Assignment with JavaScript semantics: an existing key keeps its position.
    static func set(_ fields: inout [(JSText, JSValue)], _ key: JSText, _ value: JSValue) {
        if let index = fields.firstIndex(where: { $0.0 == key }) { fields[index].1 = value } else { fields.append((key, value)) }
    }
}

enum WorkspaceError: Error, Equatable { case invalidFile, notFound, tooMany }

/// One validated workspace mutation (`src/native/workspace-model.ts` `validateOperation`).
enum WorkspaceOperation {
    case open(root: JSText, chatSettings: JSValue?)
    case select(key: JSText)
    case close(key: JSText)
    case reorder(key: JSText, before: JSText?)
    case update([(JSText, [(JSText, JSValue)])])
    case recent(root: JSText, name: JSText)

    static let methods: Set<String> = ["open", "select", "close", "reorder", "update", "recent"]

    /// The legacy-owned metadata slice written through `update`, and each field's rule.
    static func validField(_ name: String, _ value: JSValue) -> Bool {
        typealias D = WorkspaceDocument
        func text(_ max: Int) -> Bool { if case .string(let text) = value { return text.count <= max }; return false }
        func object() -> Bool { if case .object = value { return true }; return false }
        func bool() -> Bool { if case .bool = value { return true }; return false }
        switch name {
        case "name": return text(D.maxName)
        case "url": return value == .null || text(D.maxText)
        case "previewKind": return value == .string(JSText("web")) || value == .string(JSText("simulator"))
        case "branch": return value == .null || text(D.maxName)
        case "launchSpec": return value == .null || object()
        case "viewport": return value == .string(JSText("desktop")) || value == .string(JSText("mobile"))
        case "chatsCollapsed", "dependenciesPending": return bool()
        case "environmentRevision":
            guard case .number(let number) = value else { return false }
            return number >= 0 && number <= 9_007_199_254_740_991 && number.rounded() == number
        case "sessionKeys":
            guard case .array(let keys) = value, (1...D.maxSessions).contains(keys.count) else { return false }
            return keys.allSatisfy { if case .string(let key) = $0 { return key.count <= D.maxText }; return false }
        case "activeSessionKey": return text(D.maxText)
        case "chatSettings": return object()
        case "sourceSetup":
            // Connect to Trezi outcome (LKM-153, `unstamped` LKM-157): `{state, at, reason?}`, nothing else.
            guard case .object(let fields) = value, Set(fields.map { $0.0.string }).count == fields.count else { return false }
            var state = false, at = false
            for (key, field) in fields {
                switch (key.string, field) {
                case ("state", .string(let text)): state = ["done", "declined", "failed", "unstamped"].contains(text.string)
                case ("at", .number(let number)): at = number >= 0 && number <= 9_007_199_254_740_991 && number.rounded() == number
                case ("reason", .string(let text)): if text.count > D.maxText { return false }
                default: return false
                }
            }
            return state && at
        default: return false
        }
    }

    private static func path(_ value: JSValue?) -> JSText? {
        guard let text = value?.text, text.count <= WorkspaceDocument.maxRoot, text.hasPrefix("/"), !hasLoneSurrogate(text) else { return nil }
        return text
    }
    private static func hasLoneSurrogate(_ text: JSText) -> Bool {
        var index = 0
        while index < text.count {
            let unit = text[index]
            if (0xD800...0xDBFF).contains(unit) {
                guard index + 1 < text.count, (0xDC00...0xDFFF).contains(text[index + 1]) else { return true }
                index += 2; continue
            }
            if (0xDC00...0xDFFF).contains(unit) { return true }
            index += 1
        }
        return false
    }
    private static func key(_ value: JSValue?) -> JSText? {
        guard let text = value?.text, text.count <= WorkspaceDocument.maxRoot else { return nil }
        return text
    }

    /// Strict: exactly the body fields each method takes; anything else is refused.
    init(method: String, body: [(JSText, JSValue)]) throws {
        let invalid = ServiceContractFailure.invalidRequest
        let value = JSValue.object(body)
        let names = body.map { $0.0.string }
        func exactly(_ allowed: Set<String>, optional: Set<String> = []) throws {
            let present = Set(names)
            guard present.count == names.count, present.isSubset(of: allowed.union(optional)), present.isSuperset(of: allowed) else { throw invalid }
        }
        switch method {
        case "open":
            try exactly(["root"], optional: ["chatSettings"])
            guard let root = Self.path(value["root"]) else { throw invalid }
            var settings: JSValue?
            if let given = value["chatSettings"] { guard case .object = given else { throw invalid }; settings = given }
            self = .open(root: root, chatSettings: settings)
        case "select", "close":
            try exactly(["key"])
            guard let key = Self.key(value["key"]) else { throw invalid }
            self = method == "select" ? .select(key: key) : .close(key: key)
        case "reorder":
            try exactly(["key", "before"])
            guard let key = Self.key(value["key"]), let before = value["before"] else { throw invalid }
            if before == .null { self = .reorder(key: key, before: nil); return }
            guard let target = Self.key(before) else { throw invalid }
            self = .reorder(key: key, before: target)
        case "update":
            try exactly(["projects"])
            guard case .array(let items)? = value["projects"], (1...WorkspaceDocument.maxPatches).contains(items.count) else { throw invalid }
            var patches: [(JSText, [(JSText, JSValue)])] = []
            for item in items {
                guard case .object(let parts) = item, parts.count == 2, let key = Self.key(item["key"]),
                      case .object(let fields)? = item["fields"], !fields.isEmpty else { throw invalid }
                for (name, field) in fields where !Self.validField(name.string, field) { throw invalid }
                patches.append((key, fields))
            }
            self = .update(patches)
        case "recent":
            try exactly(["root", "name"])
            guard let root = Self.path(value["root"]), let name = value["name"]?.text, name.count <= WorkspaceDocument.maxName else { throw invalid }
            self = .recent(root: root, name: name)
        default: throw invalid
        }
    }
}

/// `realpath(3)`, like Bun's `realpathSync.native`; nil when it cannot be resolved.
func resolveWorkspaceRoot(_ root: JSText) -> String? {
    guard let resolved = realpath(root.string, nil) else { return nil }
    defer { free(resolved) }
    return String(cString: resolved)
}
