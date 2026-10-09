import Foundation

/// The provider owner's policy (S10), pure: the exact mirror of `src/main/provider-policy.ts`.
/// `test/provider-owner.mjs` pins every answer to a golden recorded from the Bun policy.
/// A session's capabilities come from what the owner was told when it opened (provider,
/// background or not, its roots), never from what the adapter or helper asks for later.
enum ProviderPolicy {
    static let grace: TimeInterval = 3

    enum Limits {
        static let helperLine = 24 * 1024 * 1024
        static let sendText = 2 * 1024 * 1024
        static let images = 16
        static let imageBase64 = 14 * 1024 * 1024
        static let imagesTotal = 20 * 1024 * 1024
        static let permissionTarget = 4 * 1024 * 1024
        static let toolArgs = 256 * 1024
        static let eventText = 1024 * 1024
        static let pendingTools = 8
        static let pendingApprovals = 32
    }

    static let imageTypes: Set<String> = ["image/png", "image/jpeg", "image/gif", "image/webp"]

    static let treziTools = [
        "project_ui_catalog", "compose_project_ui", "preview_location", "preview_screenshot", "preview_inspect",
        "preview_evaluate", "preview_console", "preview_viewport", "preview_speed", "open_preview", "reload_preview", "restart_dev_server", "open_code", "chat_island", "spring_to_css", "check_contrast", "fluid_clamp", "color_scale", "layered_shadow",
        "line_height", "list_recommended_skills", "install_skills", "workspace_state", "prepare_conflict_resolution",
        "git_sync_base", "git_merge_continue", "git_merge_abort", "pr_status", "publish_update", "publish_merge", "land_now", "ask_user", "chat_ui",
    ]
    static let foregroundOnly = [
        "open_code": "Background edits cannot navigate the user editor.",
        "chat_island": "Background edits cannot create chat islands.",
        "restart_dev_server": "Background edits cannot restart the dev server.",
        "ask_user": "Background agents cannot ask with ask_user. Make the reasonable default choice and name it in your final message.",
        "chat_ui": "Background agents cannot show answer components. Make the reasonable default choice and name it in your final message.",
    ]
    static let autoTrezi = Set(treziTools).subtracting(["install_skills", "workspace_state", "prepare_conflict_resolution"])
    static let autoAllow: Set<String> = ["Read", "Glob", "Grep", "LS", "NotebookRead"]
    static let edit: Set<String> = ["Edit", "Write", "MultiEdit", "NotebookEdit"]
    static let mcpPrefix = "mcp__trezi__"
    static let sidecar = try! NSRegularExpression(pattern: #"(^|[\s/\\"'])\.(trezi|praxis|dsgn)([/\\]|$)"#)

    enum Message {
        static let inactive = "Session no longer active."
        static let sidecar = "The .trezi/ sidecar is managed by trezi, not the agent."
        static let profile = "Trezi's own data is managed by Trezi, not the agent."
        static let closed = "This provider session is no longer active."
        static func ungranted(_ tool: String) -> String { "The \(tool) tool is not granted to this session." }
        static let tooLarge = "The tool arguments are too large."
    }

    static func granted(background: Bool) -> [String] { treziTools.filter { !(background && foregroundOnly[$0] != nil) } }

    struct Scope {
        var live: Bool
        var background: Bool
        var root: String
        var liveRoot: String
        var profile: String
    }

    enum Verdict: Equatable { case allow, ask, question, deny(String) }

    /// Node's `path.normalize` for an absolute path: `.` and `..` resolved, repeated
    /// slashes collapsed, a trailing slash kept.
    static func lexical(_ path: String) -> String {
        var parts: [Substring] = []
        for part in path.split(separator: "/", omittingEmptySubsequences: true) {
            if part == "." { continue }
            if part == ".." { if !parts.isEmpty { parts.removeLast() }; continue }
            parts.append(part)
        }
        let out = "/" + parts.joined(separator: "/")
        return path.hasSuffix("/") && out != "/" ? out + "/" : out
    }

    /// `path.resolve(root, target)` then `normalize`: a relative target loses its trailing slash.
    static func absolute(_ target: String, root: String) -> String {
        if target.hasPrefix("/") { return lexical(target) }
        var resolved = lexical(root + "/" + target)
        while resolved.count > 1 && resolved.hasSuffix("/") { resolved.removeLast() }
        return resolved
    }

    static func within(_ path: String, _ dir: String) -> Bool {
        var d = lexical(dir)
        while d.hasSuffix("/") { d.removeLast() }
        return path == d || path.hasPrefix(d + "/")
    }

    static func touchesSidecar(_ text: String) -> Bool {
        sidecar.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    static func touchesProfile(tool: String, target: String?, scope: Scope) -> Bool {
        guard edit.contains(tool), let target, !scope.profile.isEmpty else { return false }
        let path = absolute(target, root: scope.root)
        return within(path, scope.profile) && !within(path, scope.root) && !within(path, scope.liveRoot)
    }

    /// `decidePermission`: questions, Trezi tools, the sidecar, Trezi's own data,
    /// read-only tools, then a closed session, else ask.
    static func decide(tool: String, target: String?, scope: Scope) -> Verdict {
        if tool == "AskUserQuestion" { return scope.live ? .question : .deny(Message.inactive) }
        if tool.hasPrefix(mcpPrefix) {
            let name = String(tool.dropFirst(mcpPrefix.count))
            if autoTrezi.contains(name) {
                if scope.background, let message = foregroundOnly[name] { return .deny(message) }
                return .allow
            }
        }
        if let target, edit.contains(tool) || tool == "Bash", touchesSidecar(target) { return .deny(Message.sidecar) }
        if touchesProfile(tool: tool, target: target, scope: scope) { return .deny(Message.profile) }
        if autoAllow.contains(tool) { return .allow }
        if !scope.live { return .deny(Message.inactive) }
        return .ask
    }

    /// `authorizeTool`: nil when the session may run the tool with arguments of `bytes` bytes.
    static func authorize(tool: String, bytes: Int, live: Bool, background: Bool) -> ServiceFailure? {
        if !live { return PreferencesOwner.fail(.unauthorized, Message.closed) }
        if !treziTools.contains(tool) { return PreferencesOwner.fail(.unauthorized, Message.ungranted(tool)) }
        if background, let message = foregroundOnly[tool] { return PreferencesOwner.fail(.unauthorized, message) }
        if bytes > Limits.toolArgs { return PreferencesOwner.fail(.invalidRequest, Message.tooLarge) }
        return nil
    }

    static func validImage(mediaType: String?, data: JSText?) -> Bool {
        guard let mediaType, imageTypes.contains(mediaType), let data, !data.isEmpty, data.count <= Limits.imageBase64,
              data.count % 4 == 0 else { return false }
        var padding = 0
        for unit in data {
            let alphanumeric = (unit >= 0x41 && unit <= 0x5A) || (unit >= 0x61 && unit <= 0x7A) || (unit >= 0x30 && unit <= 0x39)
            if unit == 0x3D { padding += 1; continue }
            guard padding == 0, alphanumeric || unit == 0x2B || unit == 0x2F else { return false }
        }
        return padding <= 2
    }

    static func validSessionID(_ id: String) -> Bool {
        !id.isEmpty && id.utf8.count <= 128 && id.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A) || $0 == 0x5F || $0 == 0x2D }
    }

    static func validProviderID(_ id: String) -> Bool {
        guard let first = id.utf8.first, first >= 0x61 && first <= 0x7A, id.utf8.count <= 32 else { return false }
        return id.utf8.allSatisfy { ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2D }
    }
}
