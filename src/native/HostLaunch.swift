import AppKit
import Darwin

/// How this TreziHost was started, and the service launch it asks for.
///
/// Trezi's start path is `open -a Trezi` (Finder, the Dock, Spotlight, the `trezi`
/// command): LaunchServices starts the host with no arguments, as a child of launchd.
/// The host then derives what the development launcher (`scripts/start-native.mjs`)
/// passes on its command line: the build directory is the bundle's parent, the Bun is
/// the one copied into `Contents/Helpers`, the backend is the `index.cjs` bundled into
/// `Contents/Resources/backend`, and the profile is the one `TreziService --resolve-profile` names. Apps
/// started by LaunchServices get launchd's minimal environment, so the user's login
/// shell environment (PATH for git, gh and the provider CLIs) is read once here.
///
/// Anything else (a direct exec with the wrong arguments) is refused with status 64.
enum HostLaunch {
    /// Started by LaunchServices (not by the launcher or a test).
    static let launchServices: Bool = {
        let rest = CommandLine.arguments.dropFirst().filter { !$0.hasPrefix("-psn_") }
        return rest.isEmpty && getppid() == 1
    }()
    /// The bundle as installed (a `/Applications/Trezi.app` link resolves to the build).
    static let bundle = Bundle.main.bundleURL.resolvingSymlinksInPath()
    private static var resolved: (arguments: [String], environment: [String: String])?

    /// The launch arguments: the command line, or the derived ones under LaunchServices.
    static var arguments: [String] { resolve().arguments }
    /// The environment the service passes to Bun and the helpers.
    static var environment: [String: String] { resolve().environment }

    private static func resolve() -> (arguments: [String], environment: [String: String]) {
        if let resolved { return resolved }
        let base = ProcessInfo.processInfo.environment
        guard launchServices else {
            resolved = (CommandLine.arguments, base)
            return resolved!
        }
        var environment = loginEnvironment(base: base)
        let out = bundle.deletingLastPathComponent().path
        let bun = bundle.appendingPathComponent("Contents/Helpers/bun").path
        let backend = bundle.appendingPathComponent("Contents/Resources/backend/index.cjs").path
        guard access(bun, X_OK) == 0, access(backend, R_OK) == 0 else {
            fail("Trezi is not built completely (\(access(bun, X_OK) == 0 ? backend : bun) is missing). Run trezi --update, or bun run build in \(bundle.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path).")
        }
        let profile: String
        if let data = environment["TREZI_USER_DATA"], data.hasPrefix("/") { profile = data } else {
            let support = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support").path
            let service = bundle.appendingPathComponent("Contents/XPCServices/dev.trezi.service.xpc/Contents/MacOS/TreziService").path
            let result = run(service, ["--resolve-profile", support], environment: environment, timeout: 10)
            guard let result, result.status == 0, let path = result.output.split(separator: "\n").first.map(String.init), path.hasPrefix("/") else {
                fail("Trezi could not find its profile folder. \(result?.error ?? "")")
            }
            profile = path
        }
        environment["TREZI_USER_DATA"] = profile
        let arguments = [CommandLine.arguments[0], out, "persistent", "--service", "--bun", bun, "--backend", backend,
                         "--profile", profile, "--"]
        resolved = (arguments, environment)
        return resolved!
    }

    /// The login shell's environment (`$SHELL -ilc`), bounded; launchd's with the usual
    /// tool folders added when the shell cannot answer.
    static func loginEnvironment(base: [String: String]) -> [String: String] {
        let shell = base["SHELL"].flatMap { access($0, X_OK) == 0 ? $0 : nil } ?? "/bin/zsh"
        let marker = "__TREZI_ENVIRONMENT_\(UUID().uuidString)__"
        if let result = run(shell, ["-ilc", "printf '%s' '\(marker)'; exec /usr/bin/env -0"], environment: base, timeout: 5),
           result.status == 0, let range = result.output.range(of: marker, options: .backwards) {
            var environment: [String: String] = [:]
            for entry in result.output[range.upperBound...].split(separator: "\0") {
                guard let equals = entry.firstIndex(of: "=") else { continue }
                environment[String(entry[..<equals])] = String(entry[entry.index(after: equals)...])
            }
            for key in ["SHLVL", "_", "PWD", "OLDPWD"] { environment.removeValue(forKey: key) }
            if environment["PATH"] != nil { return environment }
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var environment = base
        let extra = ["/opt/homebrew/bin", "/usr/local/bin", home + "/.bun/bin", home + "/.local/bin"]
        environment["PATH"] = (extra + (base["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init)).joined(separator: ":")
        return environment
    }

    /// Runs a short command with a deadline; nil when it could not start or overran.
    static func run(_ executable: String, _ arguments: [String], environment: [String: String], timeout: TimeInterval) -> (status: Int32, output: String, error: String)? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.environment = environment
        // Not the home folder (LKM-137): a login shell's startup files or a tool run from
        // `$HOME` can walk it into ~/Pictures and trigger macOS privacy prompts.
        process.currentDirectoryURL = FileManager.default.temporaryDirectory
        let output = Pipe(), error = Pipe()
        process.standardOutput = output; process.standardError = error
        process.standardInput = FileHandle.nullDevice
        let finished = DispatchSemaphore(value: 0)
        var stdout = Data(), stderr = Data()
        do { try process.run() } catch { return nil }
        DispatchQueue.global().async { stdout = output.fileHandleForReading.readDataToEndOfFile(); finished.signal() }
        DispatchQueue.global().async { stderr = error.fileHandleForReading.readDataToEndOfFile(); finished.signal() }
        let deadline = DispatchTime.now() + timeout
        guard finished.wait(timeout: deadline) == .success, finished.wait(timeout: deadline) == .success else {
            process.terminate()
            return nil
        }
        process.waitUntilExit()
        return (process.terminationStatus, String(decoding: stdout, as: UTF8.self), String(decoding: stderr, as: UTF8.self))
    }

    /// A launch that cannot start: an alert under LaunchServices (there is no terminal).
    static func fail(_ message: String) -> Never {
        fputs("\(message)\n", stderr)
        if launchServices {
            let application = NSApplication.shared
            application.setActivationPolicy(.regular)
            application.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            alert.messageText = "Trezi could not start"
            alert.informativeText = message
            alert.runModal()
        }
        exit(1)
    }

    /// Restart after an update: the same way Trezi was started, with the active project.
    static func relaunch(directory: String, project: String?) {
        let process = Process()
        if launchServices {
            // A new instance: this one is still quitting.
            process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            process.arguments = ["-n", "-a", bundle.path] + (project.map { [$0] } ?? [])
        } else {
            let args = arguments
            guard let index = args.firstIndex(of: "--bun"), index + 1 < args.count else { return }
            process.executableURL = URL(fileURLWithPath: args[index + 1])
            process.arguments = [URL(fileURLWithPath: directory).deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("scripts/start-native.mjs").path] + (project.map { ["--project", $0] } ?? [])
        }
        process.environment = environment
        try? process.run()
    }
}
