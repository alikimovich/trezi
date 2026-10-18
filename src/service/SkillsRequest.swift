import Foundation

/// The `skills` pipe methods (LKM-284), parsed strictly: exact body fields, the mode
/// each method needs, and `expectedRevision` exactly on the ledger-backed mutations.
/// The TS twin is `SkillsMethod` in `src/shared/skills-registry.ts`.
enum SkillsRequest: Sendable {
    // Reads.
    case list
    case read(skill: String, revision: String?, session: String?)
    case reference(skill: String, revision: String, path: String)
    case pins(session: String)
    // Ledger-backed manifest mutations.
    case create(files: [SkillFile])
    case importFolder(path: String)
    case edit(skill: String, base: String, changes: [SkillChange])
    case enable(skill: String, enabled: Bool)
    case providers(skill: String, providers: SkillProviders)
    case remove(skill: String), restore(skill: String), purge(skill: String)
    /// Service-internal only: the GitHub import's commit, never parsed from Bun.
    case install(files: [SkillFile], source: SkillSource, replacing: String?)
    // Session pins: idempotent per session key, outside the ledger.
    case snapshot(session: String), release(session: String)
    /// LKM-287: the session's pins (created once) laid out read-only for one provider.
    case project(session: String, provider: String)
    // GitHub import (LKM-285): a bounded fetch that ends in one `install`, and its
    // cancellation by the import's operation ID. Neither carries `expectedRevision`:
    // the fetch commits at whatever revision is current when it finishes.
    case github(url: String, ref: String?, subpath: String?, replacing: String?)
    case cancel(operation: String)

    static let reads: Set<String> = ["list", "read", "reference", "pins"]
    static let ledger: Set<String> = ["create", "import", "edit", "enable", "providers", "remove", "restore", "purge"]
    static let sessions: Set<String> = ["snapshot", "release", "project"]
    static let fetches: Set<String> = ["github", "cancel"]

    var mutatesManifest: Bool {
        switch self {
        case .create, .importFolder, .edit, .enable, .providers, .remove, .restore, .purge, .install, .github: return true
        default: return false
        }
    }

    init(method: String, mode: String, expectsRevision: Bool, body: [(JSText, JSValue)]) throws {
        let invalid = ServiceContractFailure.invalidRequest
        let fields = JSValue.object(body), names = body.map { $0.0.string }
        guard Set(names).count == names.count else { throw invalid }
        func exactly(_ required: Set<String>, optional: Set<String> = []) throws {
            guard Set(names).isSuperset(of: required), Set(names).isSubset(of: required.union(optional)) else { throw invalid }
        }
        func text(_ key: String) throws -> String {
            guard let value = fields[key]?.text, Self.wellFormed(value) else { throw invalid }
            return value.string
        }
        func skill() throws -> String {
            let id = try text("skill")
            guard UUID(uuidString: id) != nil, id == id.lowercased() else { throw invalid }
            return id
        }
        func digest(_ key: String) throws -> String {
            let value = try text(key)
            guard SkillsPackage.validDigest(value) else { throw invalid }
            return value
        }
        func session() throws -> String {
            let value = try text("session")
            guard SkillSnapshot.validSession(value) else { throw invalid }
            return value
        }
        func uuid(_ key: String) throws -> String {
            let id = try text(key)
            guard UUID(uuidString: id) != nil, id == id.lowercased() else { throw invalid }
            return id
        }
        func optional(_ key: String, limit: Int) throws -> String? {
            guard names.contains(key) else { return nil }
            let value = try text(key)
            guard !value.isEmpty, value.utf8.count <= limit else { throw invalid }
            return value
        }
        let read = Self.reads.contains(method), ledger = Self.ledger.contains(method)
        let sessions = Self.sessions.contains(method), fetch = Self.fetches.contains(method)
        guard read || ledger || sessions || fetch, mode == (read ? "read" : "mutation"), expectsRevision == ledger else { throw invalid }
        switch method {
        case "list": try exactly([]); self = .list
        case "read":
            try exactly(["skill"], optional: ["revision", "session"])
            guard !(names.contains("revision") && names.contains("session")) else { throw invalid }
            self = .read(skill: try skill(), revision: names.contains("revision") ? try digest("revision") : nil,
                         session: names.contains("session") ? try session() : nil)
        case "reference":
            try exactly(["skill", "revision", "path"])
            let path = try text("path")
            guard SkillsPackage.validPath(path) else { throw invalid }
            self = .reference(skill: try skill(), revision: try digest("revision"), path: path)
        case "pins": try exactly(["session"]); self = .pins(session: try session())
        case "create":
            try exactly(["files"])
            guard case .array(let items)? = fields["files"], (1...SkillsLimits.maxFiles).contains(items.count) else { throw invalid }
            self = .create(files: try items.map { item in
                guard case .object(let parts) = item, parts.count == 2, let path = item["path"]?.text, let content = item["text"]?.text,
                      Self.wellFormed(path), Self.wellFormed(content), content.count <= SkillsLimits.maxFileBytes else { throw invalid }
                return SkillFile(path: path.string, data: Data(content.string.utf8))
            })
        case "import":
            try exactly(["folder"])
            self = .importFolder(path: try text("folder"))
        case "edit":
            try exactly(["skill", "base", "changes"])
            guard case .array(let items)? = fields["changes"], (1...SkillsLimits.maxFiles).contains(items.count) else { throw invalid }
            self = .edit(skill: try skill(), base: try digest("base"), changes: try items.map { item in
                guard case .object(let parts) = item, parts.count == 2, let path = item["path"]?.text, Self.wellFormed(path) else { throw invalid }
                switch item["text"] {
                case .null?: return SkillChange(path: path.string, data: nil)
                case .string(let content)? where Self.wellFormed(content) && content.count <= SkillsLimits.maxFileBytes:
                    return SkillChange(path: path.string, data: Data(content.string.utf8))
                default: throw invalid
                }
            })
        case "enable":
            try exactly(["skill", "enabled"])
            guard case .bool(let enabled)? = fields["enabled"] else { throw invalid }
            self = .enable(skill: try skill(), enabled: enabled)
        case "providers":
            try exactly(["skill", "providers"])
            guard let providers = SkillProviders(fields["providers"]) else { throw invalid }
            self = .providers(skill: try skill(), providers: providers)
        case "remove": try exactly(["skill"]); self = .remove(skill: try skill())
        case "restore": try exactly(["skill"]); self = .restore(skill: try skill())
        case "purge": try exactly(["skill"]); self = .purge(skill: try skill())
        case "snapshot": try exactly(["session"]); self = .snapshot(session: try session())
        case "release": try exactly(["session"]); self = .release(session: try session())
        case "project":
            try exactly(["session", "provider"])
            let provider = try text("provider")
            guard SkillProviders.names.contains(provider) else { throw invalid }
            self = .project(session: try session(), provider: provider)
        case "github":
            try exactly(["url"], optional: ["ref", "subpath", "replacing"])
            guard let url = try optional("url", limit: SkillsGitHubAddress.maxURL) else { throw invalid }
            self = .github(url: url, ref: try optional("ref", limit: 255), subpath: try optional("subpath", limit: SkillsLimits.maxPath),
                           replacing: names.contains("replacing") ? try uuid("replacing") : nil)
        case "cancel": try exactly(["operation"]); self = .cancel(operation: try uuid("operation"))
        default: throw invalid
        }
    }

    /// No lone surrogate: every string is stored and compared as UTF-8.
    static func wellFormed(_ text: JSText) -> Bool {
        var index = 0
        while index < text.count {
            let unit = text[index]
            if (0xD800...0xDBFF).contains(unit) {
                guard index + 1 < text.count, (0xDC00...0xDFFF).contains(text[index + 1]) else { return false }
                index += 2; continue
            }
            if (0xDC00...0xDFFF).contains(unit) { return false }
            index += 1
        }
        return true
    }
}

/// One file of an edit: new text, or `nil` to delete it (never `SKILL.md`).
struct SkillChange: Equatable, Sendable { let path: String; let data: Data? }
