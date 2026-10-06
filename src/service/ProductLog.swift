import Foundation
import Darwin

/// LKM-168: the host's and the service's writer for Trezi's product log, in the format
/// and folder of `src/main/product-log.ts`: `~/Library/Logs/Trezi/` (`TREZI_LOG_DIR`
/// overrides it), one `trezi-YYYY-MM-DD.log` per UTC day, 7 days kept, 20 MB per day.
/// A line is `<ISO time> <level> <process> <area> [chat=<id>] [turn=<id>] <message>`,
/// redacted and with the home folder shortened to `~`. Until `configure` every call is
/// a no-op, so owner tests write nothing. Writes run on a private queue (never the main
/// thread) with O_APPEND, so the processes' lines never tear; logging never fails.
enum ProductLog {
    static let keepDays = 7
    static let dayBytes: Int64 = 20 * 1024 * 1024
    static let messageLimit = 1000

    private static let queue = DispatchQueue(label: "dev.trezi.product-log", qos: .utility)
    private static var tag = ""
    private static var folder = ""
    private static var home = ""
    private static var limit = dayBytes
    private static var descriptor: Int32 = -1
    private static var day = ""

    static func directory(environment: [String: String], home: String) -> String {
        if let override = environment["TREZI_LOG_DIR"], override.hasPrefix("/") { return override }
        return home + "/Library/Logs/Trezi"
    }

    /// The account's home, whatever `HOME` says.
    static var accountHome: String {
        if let account = getpwuid(getuid()) { return String(cString: account.pointee.pw_dir) }
        return NSHomeDirectory()
    }

    /// Starts writing as `process` ("app", "service") to the launch environment's folder.
    static func configure(process: String, environment: [String: String], maxBytes: Int64 = dayBytes) {
        let home = accountHome
        let folder = directory(environment: environment, home: home)
        queue.sync {
            closeFile()
            self.tag = process; self.folder = folder; self.home = home; self.limit = maxBytes
        }
    }

    /// The folder this process writes to; the default one before `configure`.
    static var configuredDirectory: String {
        let folder = queue.sync { self.folder }
        return folder.isEmpty ? directory(environment: ProcessInfo.processInfo.environment, home: accountHome) : folder
    }

    static func debug(_ area: String, _ message: String, chat: String? = nil, turn: String? = nil) { write("debug", area, message, chat: chat, turn: turn) }
    static func info(_ area: String, _ message: String, chat: String? = nil, turn: String? = nil) { write("info", area, message, chat: chat, turn: turn) }
    static func warn(_ area: String, _ message: String, chat: String? = nil, turn: String? = nil) { write("warn", area, message, chat: chat, turn: turn) }
    static func error(_ area: String, _ message: String, chat: String? = nil, turn: String? = nil) { write("error", area, message, chat: chat, turn: turn) }

    static func write(_ level: String, _ area: String, _ message: String, chat: String? = nil, turn: String? = nil) {
        let at = Date()
        queue.async { append(level, area, message, chat: chat, turn: turn, at: at) }
    }

    /// Waits for queued lines (before the process exits).
    static func flush() { queue.sync {} }

    private static func append(_ level: String, _ area: String, _ message: String, chat: String?, turn: String?, at: Date) {
        guard !tag.isEmpty else { return }
        let stamp = timestamp(at), name = "trezi-\(stamp.prefix(10)).log"
        if name != day {
            closeFile(); day = name
            try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            descriptor = open(folder + "/" + name, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0o600)
            prune(directory: folder, now: at)
        }
        guard descriptor >= 0 else { return }
        var info = stat()
        guard fstat(descriptor, &info) == 0, Int64(info.st_size) < limit else { return }
        let text = line(level: level, process: tag, area: area, message: message, chat: chat, turn: turn, at: at, home: home) + "\n"
        put(text)
        if Int64(info.st_size) + Int64(text.utf8.count) >= limit {
            put(line(level: "warn", process: tag, area: "log", message: "Daily log limit reached (\(limit) bytes); later lines today are dropped.",
                     chat: nil, turn: nil, at: at, home: home) + "\n")
        }
    }

    private static func put(_ text: String) {
        var bytes = Array(text.utf8)
        _ = bytes.withUnsafeMutableBytes { Darwin.write(descriptor, $0.baseAddress, $0.count) }
    }

    private static func closeFile() {
        if descriptor >= 0 { close(descriptor) }
        descriptor = -1; day = ""
    }

    private static let stampFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter
    }()
    private static let stampLock = NSLock()
    static func timestamp(_ at: Date) -> String {
        stampLock.lock(); defer { stampLock.unlock() }
        return stampFormatter.string(from: at)
    }

    /// One redacted line without its newline (the TS `formatLogLine`).
    static func line(level: String, process: String, area: String, message: String, chat: String?, turn: String?, at: Date, home: String) -> String {
        var head = [timestamp(at), level, token(process), token(area)]
        if let chat, !chat.isEmpty { head.append("chat=\(value(chat))") }
        if let turn, !turn.isEmpty { head.append("turn=\(value(turn))") }
        var text = redact(oneLine(message), home: home)
        if text.count > messageLimit { text = String(text.prefix(messageLimit)) + "…" }
        return redact(head.joined(separator: " ") + " " + text, home: home)
    }

    private static func token(_ text: String) -> String {
        let out = String(text.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) && $0.isASCII || "_.:-".unicodeScalars.contains($0) ? Character($0) : "-" })
        return out.isEmpty ? "-" : out
    }
    private static func value(_ text: String) -> String {
        if !text.isEmpty, !text.contains(where: { $0.isWhitespace || $0 == "\"" || $0 == "=" }) { return text }
        let data = (try? JSONSerialization.data(withJSONObject: [text], options: [.withoutEscapingSlashes])) ?? Data("[\"\"]".utf8)
        return String(String(decoding: data, as: UTF8.self).dropFirst().dropLast())
    }
    private static func oneLine(_ text: String) -> String {
        text.replacingOccurrences(of: "\r\n", with: " ⏎ ").replacingOccurrences(of: "\n", with: " ⏎ ")
            .unicodeScalars.map { $0.value < 0x20 || $0.value == 0x7f ? " " : String($0) }.joined()
    }

    private static let secrets: [(NSRegularExpression, String)] = ([
        (#"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"#, "[redacted key]", false),
        (#"\bsk-[A-Za-z0-9_-]{16,}"#, "[redacted]", false),
        (#"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"#, "[redacted]", false),
        (#"\bxox[abposr]-[A-Za-z0-9-]{10,}"#, "[redacted]", false),
        (#"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"#, "[redacted]", false),
        (#"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"#, "[redacted]", false),
        (#"(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}"#, "$1[redacted]", true),
        (#"(//[^/\s:@]+:)[^@\s/]+@"#, "$1[redacted]@", false),
        (#"((?:api[_-]?key|access[_-]?key|secret|token|password|passwd|authorization|credential|cookie)[A-Za-z_-]*["']?\s*[:=]\s*["']?(?:(?:bearer|basic)\s+)?)[^\s"',;&]+"#, "$1[redacted]", true),
    ] as [(String, String, Bool)]).map { pattern, template, caseless in
        (try! NSRegularExpression(pattern: pattern, options: caseless ? [.caseInsensitive] : []), template)
    }

    /// Removes secrets and shortens the home folder to `~` (the TS `redact`).
    static func redact(_ text: String, home: String) -> String {
        var out = text
        for (pattern, template) in secrets {
            out = pattern.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out), withTemplate: template)
        }
        if !home.isEmpty && home != "/" { out = out.replacingOccurrences(of: home, with: "~") }
        return out
    }

    /// Removes day files older than `keepDays` (today counts as one); returns their names.
    @discardableResult
    static func prune(directory: String, now: Date, keepDays: Int = keepDays) -> [String] {
        let oldest = String(timestamp(now.addingTimeInterval(-Double(keepDays - 1) * 86_400)).prefix(10))
        var removed: [String] = []
        for name in (try? FileManager.default.contentsOfDirectory(atPath: directory)) ?? [] {
            guard name.hasPrefix("trezi-"), name.hasSuffix(".log"), name.count == 20 else { continue }
            let day = String(name.dropFirst(6).prefix(10))
            if day < oldest, unlink(directory + "/" + name) == 0 { removed.append(name) }
        }
        return removed
    }
}
