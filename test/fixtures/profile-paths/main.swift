import Foundation

// `profile-paths <profile|sessions> <path>`: one ProfilePaths call, the answer on stdout
// or the refusal on stderr (exit 1): the service's migration in test/rename-compat.mjs.
let arguments = CommandLine.arguments
guard arguments.count == 3 else { fputs("usage: profile-paths <profile|sessions> <path>\n", stderr); exit(2) }
do {
    print(arguments[1] == "profile" ? try ProfilePaths.profile(support: arguments[2]) : try ProfilePaths.sessions(profile: arguments[2]))
} catch {
    fputs("\(error)\n", stderr)
    exit(1)
}
