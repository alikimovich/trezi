import Foundation
import Darwin

@main struct ServiceMain {
    static func main() {
        signal(SIGPIPE, SIG_IGN)
        do {
            if CommandLine.arguments.count > 1, ["--guard", "--guard-backend"].contains(CommandLine.arguments[1]) {
                runProcessGuardian(arguments: Array(CommandLine.arguments.dropFirst(2)), backend: CommandLine.arguments[1] == "--guard-backend")
            }
            if CommandLine.arguments.count > 1, CommandLine.arguments[1] == "--watch-group" {
                runGroupWatchdog(arguments: Array(CommandLine.arguments.dropFirst(2)))
            }
            if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--resolve-profile" {
                // The launcher's default profile, with the legacy-profile alias made first.
                do { print(try ProfilePaths.profile(support: CommandLine.arguments[2])); exit(0) } catch {
                    fputs("\(error)\n", stderr); exit(1)
                }
            }
            // The only launch is the XPC service under Trezi.app (LKM-111 removed the in-process rollback launch).
            let bundle = Bundle.main.bundleURL
            let host = bundle.deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("MacOS/TreziHost").path
            let owner = try ServiceRuntime(hostExecutable: host)
            let listener = NSXPCListener.service()
            listener.delegate = owner
            withExtendedLifetime(owner) { listener.resume() }
        } catch {
            fputs("Trezi service startup failed: \(error)\n", stderr)
            exit(1)
        }
    }
}
