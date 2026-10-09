import Foundation
import Darwin

/// The profile and session-store rename migrations (LKM-102), formerly Bun's
/// `native/profile-path.ts`, which now only resolves and refuses an unmigrated store
/// (LKM-111 removed its creating twin). Both keep the physical directory in place and add
/// one atomic alias, so Git administrative paths and saved absolute worktree paths stay
/// valid and there is no partial-copy state:
/// - `profile(support:)`: `Trezi Native` → `Praxis Native` (relative link), for the
///   launcher before the profile lock exists (`TreziService --resolve-profile`);
/// - `sessions(profile:)`: `<profile>/trezi` → the real `praxis` or `dsgn` store, run by
///   the service under the profile lock before Bun starts.
/// Neither ever moves, copies or deletes data; a state they cannot reconcile is refused
/// with the same message as before and changes nothing.
enum ProfilePaths {
    struct Refusal: Error, CustomStringConvertible { let description: String }

    private static func present(_ path: String) throws -> Bool {
        var info = stat()
        if lstat(path, &info) == 0 { return true }
        if errno == ENOENT { return false }
        throw Refusal(description: "\(String(cString: strerror(errno))), lstat '\(path)'")
    }
    private static func exists(_ path: String) -> Bool { var info = stat(); return stat(path, &info) == 0 }
    private static func real(_ path: String) -> String? {
        guard let resolved = realpath(path, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }
    private static func realDirectory(_ path: String) -> Bool {
        var info = stat()
        return lstat(path, &info) == 0 && info.st_mode & S_IFMT == S_IFDIR
    }
    /// `symlinkSync(target, path)`; an alias that already resolves to `expected` is fine.
    private static func alias(_ target: String, at path: String, expected: String) throws {
        guard symlink(target, path) != 0 else { return }
        let code = errno
        guard code == EEXIST, let current = real(path), current == real(expected) else {
            throw Refusal(description: "\(String(cString: strerror(code))), symlink '\(target)' -> '\(path)'")
        }
    }

    static func profile(support: String) throws -> String {
        let current = support + "/Trezi Native", legacy = support + "/Praxis Native"
        if try present(current) {
            guard exists(current) else { throw Refusal(description: "Trezi profile alias is broken; restore its original target before starting.") }
            if try present(legacy), real(current) != real(legacy) {
                throw Refusal(description: "Separate Trezi Native and Praxis Native profiles exist. Select one explicitly with TREZI_USER_DATA; neither profile was changed.")
            }
            return current
        }
        if try present(legacy) {
            guard realDirectory(legacy) else { throw Refusal(description: "Legacy native profile must be a real directory.") }
            try FileManager.default.createDirectory(atPath: support, withIntermediateDirectories: true)
            try alias("Praxis Native", at: current, expected: legacy)
        }
        return current
    }

    /// Under the profile lock, before Bun: the session alias. A store it cannot reconcile
    /// is reported and left as is; Bun refuses chats with the same message.
    static func migrateSessions(profile: String, report: (String) -> Void) {
        do { _ = try sessions(profile: profile) } catch { report("Trezi service: \(error)\n") }
    }

    static func sessions(profile: String) throws -> String {
        let current = profile + "/trezi"
        let candidates = ["praxis", "dsgn"].map { profile + "/" + $0 }.filter(exists)
        if exists(current) {
            if candidates.contains(where: { real($0) != real(current) }) {
                throw Refusal(description: "Separate Trezi and legacy session stores exist; reconcile them before opening chats. No data was changed.")
            }
            return current
        }
        if candidates.count > 1, real(candidates[0]) != real(candidates[1]) {
            throw Refusal(description: "Both Praxis and dsgn session stores exist; reconcile them before opening chats. No data was changed.")
        }
        if let legacy = candidates.first {
            guard realDirectory(legacy) else { throw Refusal(description: "Legacy session store must be a real directory.") }
            guard let target = real(legacy) else { throw Refusal(description: "Legacy session store must be a real directory.") }
            try alias(target, at: current, expected: legacy)
        }
        return current
    }
}
