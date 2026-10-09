import Foundation
import Security

/// LKM-125: the security session a process runs in and whether it reaches the user's
/// keychains. The host answers `securitySession` in-process; `TreziHost --session`
/// answers the same for a process started under the XPC service (Bun, the Keychain
/// helper, provider helpers). The two must match. Read-only, no secret: the session
/// id, its graphic-access bit, and the exit codes of `security list-keychains` and
/// `security default-keychain` (their output is discarded).
enum SecuritySessionProbe {
    static func report() -> [String: Any] {
        var id = SecuritySessionId(0)
        var attributes = SessionAttributeBits(rawValue: 0)
        let status = SessionGetInfo(SecuritySessionId(bitPattern: -1), &id, &attributes)
        return ["session": status == errSecSuccess ? Int(id) : -1,
                "graphic": attributes.contains(.sessionHasGraphicAccess),
                "listKeychains": security(["list-keychains"]),
                "defaultKeychain": security(["default-keychain"])]
    }

    /// `/usr/bin/security` exit code; -1 when it cannot start.
    static func security(_ arguments: [String]) -> Int {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = arguments
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return -1 }
        process.waitUntilExit()
        return Int(process.terminationStatus)
    }
}
