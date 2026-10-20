import Foundation
import Darwin

/// LOCAL-WEBKIT-4: Settings → Browser Checks' quick installs of the two external tools the
/// managed Chromium checks need (built-in WebKit needs neither). They run only when the
/// user presses Install, one at a time, each a fixed executable and argv (never shell text
/// from a page or an agent), into Trezi's own folder (`~/Library/Caches/Trezi/browser-tools`):
/// - `cli`: `npm install --prefix <tools>/agent-browser --ignore-scripts … agent-browser@0.26.0`,
///   then the package's native binary for this Mac is made executable (the skipped install
///   script only does that and links a global command);
/// - `shell`: `npx --yes --package=playwright@1.64.1 playwright install chromium-headless-shell
///   --no-remove` with `PLAYWRIGHT_BROWSERS_PATH=<tools>/ms-playwright`, so other tools'
///   Playwright caches are never touched.
/// No sudo, no Keychain, no copied credentials (npm reads the user's own ~/.npmrc in place).
/// Progress lines are clipped and redacted; Cancel stops the whole process group. Success
/// means only that the files exist: the backend's launch check decides Ready.
final class BrowserToolsInstaller: @unchecked Sendable {
    static let cliVersion = "0.26.0"
    static let playwrightVersion = "1.64.1"
    static let nodeMajor = 20
    static let steps = ["cli": "agent-browser CLI", "shell": "Chromium headless shell"]

    struct Tools {
        var home: String
        /// Folders npm, npx and node are looked up in, in order (absolute only).
        var search: [String]
        /// Passed through to npm when set: locale, user, proxies, extra CA certificates.
        var environment: [String: String]
        var timeout: TimeInterval = 15 * 60
        var arch: String = Tools.machine
        var directory: String { home + "/Library/Caches/Trezi/browser-tools" }

        static var machine: String {
            #if arch(arm64)
            return "arm64"
            #else
            return "x64"
            #endif
        }

        /// The launch environment's PATH, then the Homebrew folders a GUI launch may lack.
        static func standard(environment: [String: String], profile: String) -> Tools {
            if let fixture = fixture(environment: environment, profile: profile) { return fixture }
            let home = environment["HOME"].flatMap { $0.hasPrefix("/") ? $0 : nil } ?? NSHomeDirectory()
            let path = (environment["PATH"] ?? "").split(separator: ":").map(String.init)
            return Tools(home: home, search: path + ["/opt/homebrew/bin", "/usr/local/bin"], environment: environment)
        }

        /// A disposable native test profile installs only with the smoke's scripted npm and
        /// npx (`<test dir>/browser-tools-fixture/bin`) under `<test dir>/browser-tools-home`.
        static func fixture(environment: [String: String], profile: String) -> Tools? {
            #if TREZI_TEST_PROFILE
            guard let directory = environment["TREZI_NATIVE_TEST_DIR"], !directory.isEmpty,
                  URL(fileURLWithPath: profile).standardizedFileURL.path.hasPrefix(URL(fileURLWithPath: directory).standardizedFileURL.path + "/")
            else { return nil }
            return Tools(home: directory + "/browser-tools-home", search: [directory + "/browser-tools-fixture/bin"], environment: environment)
            #else
            return nil
            #endif
        }
    }

    let tools: Tools
    private let progress: @Sendable (String, String) -> Void
    private let lock = NSLock()
    private var active: (step: String, scope: ToolScope)?
    private var closed = false

    init(tools: Tools, progress: @escaping @Sendable (String, String) -> Void) {
        self.tools = tools; self.progress = progress
    }

    /// Stops a running install (its whole process group); false when none was running.
    func cancel() -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let active else { return false }
        active.scope.cancel()
        return true
    }

    func close() {
        lock.lock(); closed = true; active?.scope.cancel(); lock.unlock()
    }

    func install(_ step: String) throws -> JSValue {
        guard let name = Self.steps[step] else { throw PlatformRefusal(.invalidRequest, "Unknown browser tool.") }
        let scope = ToolScope()
        lock.lock()
        if closed { lock.unlock(); throw PlatformOwner.stopping }
        if let active {
            lock.unlock()
            throw PlatformRefusal(.busy, "The \(Self.steps[active.step] ?? "browser tool") install is still running. Wait for it or cancel it first.")
        }
        active = (step, scope)
        lock.unlock()
        defer { lock.lock(); active = nil; lock.unlock() }

        let tool = step == "cli" ? "npm" : "npx"
        guard let executable = locate(tool) else {
            throw PlatformRefusal(.unavailable, "\(tool) was not found, so Trezi cannot install the \(name). Install Node.js (it includes npm and npx) from https://nodejs.org/en/download, then try again.")
        }
        let bin = (executable as NSString).deletingLastPathComponent
        guard let node = locate("node", first: bin) else {
            throw PlatformRefusal(.unavailable, "Node.js was not found next to \(tool). Install Node.js from https://nodejs.org/en/download, then try again.")
        }
        let nodeDir = (node as NSString).deletingLastPathComponent
        let environment = childEnvironment(path: [bin, nodeDir], shell: step == "shell")
        let version = try PlatformTool.run(node, ["--version"], environment: environment, timeout: 10, scope: scope)
        if version.cancelled { throw Self.cancelled }
        let major = Int(version.output.trimmingCharacters(in: .whitespacesAndNewlines).dropFirst().split(separator: ".").first ?? "") ?? 0
        guard version.ok, major > 0 else { throw PlatformRefusal(.unavailable, "Node.js at \(node) did not report its version.") }
        if step == "shell" && major < Self.nodeMajor {
            throw PlatformRefusal(.unavailable, "Playwright \(Self.playwrightVersion) needs Node.js \(Self.nodeMajor) or later; this Mac has Node.js \(major). Update Node.js from https://nodejs.org/en/download, then try again.")
        }
        try prepare(step: step)
        if step == "shell" { clearInstallMarkers() }
        let arguments = step == "cli"
            ? ["install", "--prefix", tools.directory + "/agent-browser", "--ignore-scripts", "--no-save", "--no-package-lock",
               "--no-fund", "--no-audit", "--omit=dev", "--loglevel=http", "agent-browser@\(Self.cliVersion)"]
            : ["--yes", "--package=playwright@\(Self.playwrightVersion)", "playwright", "install", "chromium-headless-shell", "--no-remove"]
        let sink = LineSink(home: tools.home) { [progress] line in progress(step, line) }
        progress(step, Self.redact("$ \(tool) \(arguments.joined(separator: " "))", home: tools.home))
        let result = try PlatformTool.run(executable, arguments, environment: environment, directory: tools.directory,
                                          timeout: tools.timeout, scope: scope, output: { sink.feed($0, $1) })
        sink.flush()
        if result.cancelled || scope.isCancelled { throw Self.cancelled }
        if result.timedOut { throw PlatformRefusal(.deadlineExceeded, "The \(name) install did not finish in \(Int(tools.timeout / 60)) minutes and was stopped. Try again.") }
        guard result.status == 0 else {
            let tail = sink.tail.suffix(6).joined(separator: "\n")
            throw PlatformRefusal(.ioFailure, "\(tool) exited with status \(result.status.map(String.init) ?? "unknown"); the \(name) was not installed.\(tail.isEmpty ? "" : "\n" + tail)")
        }
        return step == "cli" ? try installedCli() : try installedShell()
    }

    static let cancelled = PlatformRefusal(.cancelled, "The install was cancelled. Nothing was marked ready.")

    /// An executable regular file named `name` in `first`, then the search folders.
    func locate(_ name: String, first: String? = nil) -> String? {
        for dir in [first].compactMap({ $0 }) + tools.search where dir.hasPrefix("/") {
            let path = dir + "/" + name
            var info = stat()
            if stat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, access(path, X_OK) == 0 { return path }
        }
        return nil
    }

    private func childEnvironment(path: [String], shell: Bool) -> [String: String] {
        var environment: [String: String] = [:]
        for key in ["LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
                    "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS"] {
            if let value = tools.environment[key] { environment[key] = value }
        }
        var seen = Set<String>()
        environment["PATH"] = (path + ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]).filter { seen.insert($0).inserted }.joined(separator: ":")
        environment["HOME"] = tools.home
        environment["TMPDIR"] = tools.directory + "/tmp"
        environment["npm_config_cache"] = tools.directory + "/npm-cache"
        environment["npm_config_update_notifier"] = "false"
        environment["npm_config_fund"] = "false"
        environment["npm_config_audit"] = "false"
        environment["NO_COLOR"] = "1"
        if shell { environment["PLAYWRIGHT_BROWSERS_PATH"] = tools.directory + "/ms-playwright" }
        return environment
    }

    /// Trezi's tools folders, checked BEFORE the installer starts: every folder from the home's
    /// `Library` down to the one the step writes into must be this user's own real folder (a link
    /// or another owner is refused, never followed), and so must what already sits in that
    /// folder, so a planted link cannot send npm or Playwright writes outside Trezi's folder.
    private func prepare(step: String) throws {
        let relative = tools.directory.dropFirst(tools.home.count + 1).split(separator: "/").map(String.init)
        var path = tools.home
        var home = stat()
        // The home itself may be reached through a link (/var); only a test profile's home is missing.
        if stat(path, &home) != 0 { try? FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true) }
        for (index, name) in relative.enumerated() {
            path += "/" + name
            try ownedFolder(path, mode: index == relative.count - 1 ? 0o700 : 0o755)
        }
        let destination = tools.directory + (step == "cli" ? "/agent-browser" : "/ms-playwright")
        for dir in [tools.directory + "/tmp", tools.directory + "/npm-cache", destination] { try ownedFolder(dir, mode: 0o700) }
        // npm writes <prefix>/node_modules/*; Playwright writes <cache>/chromium_headless_shell-*.
        try sweep(destination, levels: step == "cli" ? 2 : 1)
    }

    /// Pressing Install Headless Shell (or Repair) means "install it again", but Playwright skips
    /// a revision whose `INSTALLATION_COMPLETE` marker exists, so the markers in Trezi's own
    /// cache go first (`unlink` never follows a link; nothing else there is touched).
    private func clearInstallMarkers() {
        let cache = tools.directory + "/ms-playwright"
        for name in (try? FileManager.default.contentsOfDirectory(atPath: cache)) ?? [] where name.hasPrefix("chromium_headless_shell-") {
            unlink(cache + "/" + name + "/INSTALLATION_COMPLETE")
        }
    }

    private func refuse(_ path: String, _ what: String) -> PlatformRefusal {
        PlatformRefusal(.ioFailure, "Trezi's browser tools folder is not private: \(Self.redact(path, home: tools.home)) \(what). Remove it, then try again.")
    }

    /// A real folder owned by this user, created (never through a link) when it is missing.
    private func ownedFolder(_ path: String, mode: mode_t) throws {
        var info = stat()
        if lstat(path, &info) != 0 {
            guard errno == ENOENT, mkdir(path, mode) == 0 || errno == EEXIST else {
                throw PlatformRefusal(.ioFailure, "Could not create Trezi's browser tools folder (\(Self.redact(path, home: tools.home))).")
            }
            guard lstat(path, &info) == 0 else { throw refuse(path, "cannot be read") }
        }
        guard (info.st_mode & S_IFMT) == S_IFDIR else { throw refuse(path, "is a link or not a folder") }
        guard info.st_uid == getuid() else { throw refuse(path, "belongs to another user") }
    }

    /// No link and no foreign owner among what is already in `path`, `levels` folders deep.
    private func sweep(_ path: String, levels: Int) throws {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: path)) ?? []
        for name in names {
            let child = path + "/" + name
            var info = stat()
            guard lstat(child, &info) == 0 else { continue }
            let type = info.st_mode & S_IFMT
            guard type != S_IFLNK else { throw refuse(child, "is a link") }
            guard info.st_uid == getuid() else { throw refuse(child, "belongs to another user") }
            if type == S_IFDIR && levels > 1 { try sweep(child, levels: levels - 1) }
        }
    }

    private func inside(_ path: String) -> String? {
        guard let real = realpath(path, nil), let base = realpath(tools.directory, nil) else { return nil }
        defer { free(real); free(base) }
        let resolved = String(cString: real)
        return resolved.hasPrefix(String(cString: base) + "/") ? resolved : nil
    }

    private func installedCli() throws -> JSValue {
        let package = tools.directory + "/agent-browser/node_modules/agent-browser"
        guard let data = FileManager.default.contents(atPath: package + "/package.json"),
              let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              manifest["name"] as? String == "agent-browser", manifest["version"] as? String == Self.cliVersion else {
            throw PlatformRefusal(.ioFailure, "npm finished, but agent-browser \(Self.cliVersion) is not in Trezi's tools folder.")
        }
        let binary = package + "/bin/agent-browser-darwin-" + tools.arch
        var info = stat()
        guard lstat(binary, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(), let path = inside(binary) else {
            throw PlatformRefusal(.unsupportedCapability, "agent-browser \(Self.cliVersion) has no binary for this Mac (\(tools.arch)).")
        }
        guard chmod(path, 0o755) == 0 else { throw PlatformRefusal(.ioFailure, "Could not make \(path) executable.") }
        return .object([(JSText("step"), .string(JSText("cli"))), (JSText("path"), .string(JSText(path))),
                        (JSText("version"), .string(JSText(Self.cliVersion)))])
    }

    private func installedShell() throws -> JSValue {
        let cache = tools.directory + "/ms-playwright"
        let revisions = ((try? FileManager.default.contentsOfDirectory(atPath: cache)) ?? [])
            .compactMap { name -> Int? in name.hasPrefix("chromium_headless_shell-") ? Int(name.dropFirst(24)) : nil }
            .sorted(by: >)
        for revision in revisions {
            let binary = "\(cache)/chromium_headless_shell-\(revision)/chrome-headless-shell-mac-\(tools.arch)/chrome-headless-shell"
            var info = stat()
            if stat(binary, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, access(binary, X_OK) == 0, let path = inside(binary) {
                return .object([(JSText("step"), .string(JSText("shell"))), (JSText("path"), .string(JSText(path))),
                                (JSText("revision"), .number(Double(revision)))])
            }
        }
        throw PlatformRefusal(.ioFailure, "Playwright finished, but no Chromium headless shell for this Mac is in Trezi's tools folder.")
    }

    /// Credentials in URLs, tokens and auth headers become `***`; the home folder becomes `~`.
    static func redact(_ text: String, home: String) -> String {
        var out = text
        let rules: [(String, String)] = [
            ("(://)[^/\\s@]+@", "$1***@"),
            ("(?i)(_authToken|_auth|token|password|passwd|secret|authorization)([\"']?\\s*[=:]\\s*[\"']?)[^\\s\"',]+", "$1$2***"),
            ("(?i)\\b(bearer|basic)\\s+[A-Za-z0-9._~+/=-]+", "$1 ***"),
            ("\\b(npm_|gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}", "$1***")
        ]
        for (pattern, template) in rules {
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            out = regex.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out), withTemplate: template)
        }
        if home.count > 1 { out = out.replacingOccurrences(of: home, with: "~") }
        return out
    }

    /// Output split into lines (`\n` or a progress bar's `\r`), clipped to 300 characters
    /// and redacted; at most 2000 lines are sent, and the last few are kept for an error.
    final class LineSink: @unchecked Sendable {
        private var pending = [Data(), Data()]
        private var sent = 0
        private(set) var tail: [String] = []
        private let home: String
        private let emit: (String) -> Void
        init(home: String, emit: @escaping (String) -> Void) { self.home = home; self.emit = emit }

        func feed(_ index: Int, _ data: Data) {
            guard index == 0 || index == 1 else { return }
            pending[index].append(data)
            while let end = pending[index].firstIndex(where: { $0 == 10 || $0 == 13 }) {
                deliver(Data(pending[index][pending[index].startIndex..<end]))
                pending[index] = Data(pending[index][(end + 1)...])
            }
            if pending[index].count > 4096 { deliver(pending[index]); pending[index] = Data() }
        }

        func flush() { for index in 0..<2 { deliver(pending[index]); pending[index] = Data() } }

        private func deliver(_ data: Data) {
            let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return }
            let line = BrowserToolsInstaller.redact(text.count > 300 ? String(text.prefix(300)) + "…" : text, home: home)
            tail.append(line)
            if tail.count > 20 { tail.removeFirst() }
            sent += 1
            if sent <= 2000 { emit(line) }
        }
    }
}
