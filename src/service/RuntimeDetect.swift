import Foundation
import Darwin

/// Project runtime detection and launch commands (S06), identical to
/// `src/main/project-detect.ts`: framework and package manager from the project's
/// own manifest and lockfiles, so a project keeps the runtime it selected (Bun,
/// pnpm, Yarn or npm). The command string has exactly two origins: these literals
/// or the user's own custom command. It is never built from project file contents.
enum RuntimeDetect {
    struct Failure: Error { let message: String }

    static let setupOnlyEntries: Set<String> = [".git", ".gitignore", ".DS_Store", ".trezi", ".praxis"]
    static let managers = ["bun", "pnpm", "yarn", "npm"]

    /// `DetectedProject` as a JS object, in the TS key order.
    static func detect(root: String) throws -> JSValue {
        let manifest = root + "/package.json"
        guard exists(manifest) else {
            // No package.json: a vanilla site if there is an HTML entry to serve.
            if staticEntry(root) != nil { return staticProject(root: root, name: nil) }
            let entries: [String]
            do { entries = try FileManager.default.contentsOfDirectory(atPath: root) }
            catch { throw Failure(message: "Could not read the project folder: \(error.localizedDescription)") }
            if entries.allSatisfy({ setupOnlyEntries.contains($0) }) {
                var project = staticProject(root: root, name: nil)
                project = set(project, "framework", .string(JSText("unknown")))
                return set(project, "setupRequired", .bool(true))
            }
            throw Failure(message: "No package.json or index.html found in that folder. Enter a command to launch this project.")
        }
        guard let data = FileManager.default.contents(atPath: manifest) else {
            throw Failure(message: "Could not read package.json.")
        }
        let pkg: JSValue
        do { pkg = try JSValue.parse(data) } catch { throw Failure(message: "package.json is not valid JSON.") }
        if case .null = pkg { throw Failure(message: "package.json does not contain an object.") }
        let manager = packageManager(root: root)
        let framework = frameworkFor(pkg)
        let simulator = framework == "expo" || framework == "react-native"
        let scripts = pkg["scripts"]
        let scriptName = truthy(scripts?["dev"]) ? "dev" : truthy(scripts?["start"]) ? "start" : ""
        if scriptName.isEmpty && !simulator {
            // An unrecognized framework with an HTML entry is a bundler-less site; a
            // recognized one has a build-template index.html that will not serve raw.
            if framework == "unknown" && staticEntry(root) != nil { return staticProject(root: root, name: pkg["name"]) }
            throw Failure(message: "No \"dev\" or \"start\" script in package.json. Enter a command to launch this project.")
        }
        // RN/Expo: prefer the start script, else `expo start` so the simulator still launches.
        let devCommand = !scriptName.isEmpty ? "\(manager) run \(scriptName)" : "\(manager == "npm" ? "npx" : manager) expo start"
        return .object([
            (JSText("root"), .string(JSText(root))), (JSText("name"), name(pkg["name"], root: root)),
            (JSText("framework"), .string(JSText(framework))), (JSText("packageManager"), .string(JSText(manager))),
            (JSText("scriptName"), .string(JSText(scriptName))), (JSText("devCommand"), .string(JSText(devCommand))),
            (JSText("previewKind"), .string(JSText(simulator ? "simulator" : "web")))
        ])
    }

    /// An explicit `packageManager` wins even while an old lockfile remains; then lockfiles.
    static func packageManager(root: String) -> String {
        if let data = FileManager.default.contents(atPath: root + "/package.json"), let pkg = try? JSValue.parse(data),
           let declared = pkg["packageManager"]?.text?.string {
            let manager = declared.components(separatedBy: "@")[0]
            if managers.contains(manager) { return manager }
        }
        if exists(root + "/bun.lock") || exists(root + "/bun.lockb") { return "bun" }
        if exists(root + "/pnpm-lock.yaml") { return "pnpm" }
        if exists(root + "/yarn.lock") { return "yarn" }
        return "npm"
    }

    /// index.html, else index.htm, else the first `*.html?` in UTF-16 order.
    static func staticEntry(_ directory: String) -> String? {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory) else { return nil }
        if names.contains("index.html") { return "index.html" }
        if names.contains("index.htm") { return "index.htm" }
        return names.filter { name in
            let lower = name.lowercased()
            return lower.hasSuffix(".html") || lower.hasSuffix(".htm")
        }.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }.first
    }

    /// Port and host flags so the server binds where Trezi probes; CRA and custom
    /// commands read PORT/HOST from the environment instead.
    static func withPort(_ command: String, framework: String?, port: Int) -> String {
        switch framework {
        case "vite", "sveltekit": return "\(command) -- --port \(port) --host \(RuntimeNet.previewHost)"
        case "next":
            // npm consumes script flags unless separated; bun/pnpm forward them.
            let npm = matches("^npm[\(RuntimeNet.jsSpace)]+(?:run|run-script)(?![A-Za-z0-9_])", jsTrim(command))
            let separated = matches("[\(RuntimeNet.jsSpace)]--(?:[\(RuntimeNet.jsSpace)]|$)", command)
            return "\(command)\(npm && !separated ? " --" : "") --port \(port) -H \(RuntimeNet.previewHost)"
        default: return command
        }
    }

    static let conflictExpression = try! NSRegularExpression(
        pattern: "port [0-9]+ is in use|unable to acquire lock|another instance|EADDRINUSE|address already in use", options: [.caseInsensitive])

    /// `interpretFailure`: another instance of the project's server is the usual cause.
    static func interpretFailure(code: Int32?, tail: JSText) -> (conflict: Bool, message: String) {
        let text = tail.string
        if conflictExpression.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)) != nil {
            return (true, "A dev server is already running for this project. Trezi manages the dev server itself — " +
                "stop your other instance (e.g. the `dev` running in your terminal) and try again.")
        }
        return (false, "Dev server exited (code \(code.map(String.init) ?? "null")) before printing a URL.\n\(last(tail, 600).string)")
    }

    // MARK: JS semantics

    static func frameworkFor(_ pkg: JSValue) -> String {
        /// `{ ...dependencies, ...devDependencies }[name]`: only objects spread named keys.
        func dependency(_ name: String) -> Bool {
            if case .object(let fields)? = pkg["devDependencies"], fields.contains(where: { $0.0 == JSText(name) }) {
                return truthy(pkg["devDependencies"]?[name])
            }
            if case .object? = pkg["dependencies"] { return truthy(pkg["dependencies"]?[name]) }
            return false
        }
        // RN targets first: an Expo repo also lists react-native.
        for (name, framework) in [("expo", "expo"), ("react-native", "react-native"), ("next", "next"),
                                  ("@sveltejs/kit", "sveltekit"), ("react-scripts", "cra"), ("vite", "vite")] where dependency(name) {
            return framework
        }
        return "unknown"
    }

    static func staticProject(root: String, name: JSValue?) -> JSValue {
        .object([
            (JSText("root"), .string(JSText(root))), (JSText("name"), self.name(name, root: root)),
            (JSText("framework"), .string(JSText("static"))), (JSText("packageManager"), .string(JSText("npm"))),
            (JSText("scriptName"), .string(JSText(""))), (JSText("devCommand"), .string(JSText(""))),
            (JSText("previewKind"), .string(JSText("web")))
        ])
    }

    /// `pkg.name ?? basename(root)`.
    static func name(_ value: JSValue?, root: String) -> JSValue {
        if let value, value != .null { return value }
        var trimmed = Substring(root)
        while trimmed.count > 1 && trimmed.hasSuffix("/") { trimmed = trimmed.dropLast() }
        return .string(JSText(trimmed == "/" ? "" : String(trimmed.split(separator: "/", omittingEmptySubsequences: false).last ?? "")))
    }

    static func set(_ object: JSValue, _ key: String, _ value: JSValue) -> JSValue {
        guard case .object(var fields) = object else { return object }
        if let index = fields.firstIndex(where: { $0.0 == JSText(key) }) { fields[index].1 = value } else { fields.append((JSText(key), value)) }
        return .object(fields)
    }

    static func truthy(_ value: JSValue?) -> Bool {
        switch value {
        case .none, .null?: return false
        case .bool(let flag)?: return flag
        case .number(let number)?: return number != 0 && !number.isNaN
        case .string(let text)?: return !text.isEmpty
        case .array?, .object?: return true
        }
    }

    static func jsTrim(_ text: String) -> String {
        let space = Set(Array(" \t\n\u{0B}\u{0C}\r\u{A0}\u{1680}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}".utf16) + Array(0x2000...0x200A))
        let units = Array(text.utf16)
        guard let first = units.firstIndex(where: { !space.contains($0) }) else { return "" }
        let end = units.lastIndex(where: { !space.contains($0) })!
        return String(decoding: units[first...end], as: UTF16.self)
    }

    static func matches(_ pattern: String, _ text: String) -> Bool {
        (try? NSRegularExpression(pattern: pattern))?.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)) != nil
    }

    static func last(_ text: JSText, _ count: Int) -> JSText { text.count > count ? Array(text.suffix(count)) : text }

    static func exists(_ path: String) -> Bool { access(path, F_OK) == 0 }
}
