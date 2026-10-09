import Foundation

/// Git's stderr, read without depending on its version (LKM-150). Git rewords its
/// messages between releases: 2.50 says "corrupt patch at line 7", 2.55 names the
/// patch file ("corrupt patch at /…/apply-<uuid>.patch:7"). Every decision the
/// service takes on Git's text goes through here, and `test/git-messages.mjs` pins
/// it against output recorded from several Git versions. Foundation only, so the
/// test compiles this file alone.
enum GitMessages {
    /// One `error:` line of `git apply`, as fields.
    struct ApplyProblem: Equatable {
        enum Reason: String {
            case corruptPatch = "corrupt patch"
            /// Any other patch Git cannot parse (no header, garbage, no valid patches).
            case unreadable
            /// A hunk did not match; `line` is the target file's line.
            case patchFailed = "patch failed"
            case doesNotApply = "does not apply"
            case alreadyExists = "already exists"
            case missing = "does not exist"
            case doesNotMatchIndex = "does not match index"
            /// No three-way base; Git falls back to a direct apply and reports that.
            case missingBlob = "missing blob"
            case other
        }
        var reason: Reason
        /// The repository file. A reason Git gives by patch line gets the file whose
        /// part of the patch that line is.
        var file: String?
        /// The patch line for `corruptPatch`/`unreadable`, the file's line for `patchFailed`.
        var line: Int?
        /// Git's text with every patch location as "line N" and no scratch path.
        var text: String

        /// Patches Git could not read: no per-file merge can lay them.
        var unreadable: Bool { reason == .corruptPatch || reason == .unreadable }

        /// What the user sees, e.g. "a.txt: corrupt patch at line 7".
        var message: String {
            // Reworded in Git 2.32 ("…to fall back on 3-way merge.").
            if reason == .missingBlob { return "repository lacks the necessary blob to perform 3-way merge." }
            guard let file, !text.contains(file) else { return text }
            return "\(file): \(text)"
        }
    }

    /// Each `error:` line of a failed `git apply` of `patch` (written to `patchFile`).
    static func applyProblems(_ stderr: String, patchFile: String?, patch: Data) -> [ApplyProblem] {
        scrub(stderr, patchFile: patchFile).split(separator: "\n").compactMap { line in
            line.hasPrefix("error: ") ? applyProblem(String(line.dropFirst(7)), patch: patch) : nil
        }
    }

    static func applyProblem(_ text: String, patch: Data) -> ApplyProblem {
        func match(_ pattern: String) -> [String]? { captures(text, pattern) }
        // The scratch patch itself is gone: "can't open patch 'the patch': No such file or directory".
        if text.hasPrefix("can't open patch ") { return ApplyProblem(reason: .other, text: text) }
        if let m = match(#"^corrupt patch at line (\d+)$"#) {
            let line = Int(m[0])
            return ApplyProblem(reason: .corruptPatch, file: line.flatMap { patchPath(patch, line: $0) }, line: line, text: text)
        }
        if let m = match(#"^patch failed: (.+):(\d+)$"#) { return ApplyProblem(reason: .patchFailed, file: m[0], line: Int(m[1]), text: text) }
        if let m = match(#"^(.+): patch does not apply$"#) { return ApplyProblem(reason: .doesNotApply, file: m[0], text: text) }
        if let m = match(#"^(.+): already exists in (?:working directory|index)$"#) {
            return ApplyProblem(reason: .alreadyExists, file: m[0], text: text)
        }
        if let m = match(#"^(.+): (?:does not exist in (?:index|working tree)|No such file or directory)$"#) {
            return ApplyProblem(reason: .missing, file: m[0], text: text)
        }
        if let m = match(#"^(.+): does not match index$"#) { return ApplyProblem(reason: .doesNotMatchIndex, file: m[0], text: text) }
        if text.range(of: "lacks the necessary blob", options: .caseInsensitive) != nil {
            return ApplyProblem(reason: .missingBlob, text: text)
        }
        if text.range(of: #"corrupt patch|unrecognized input|unrecognized binary patch|No valid patches|without header|malformed|garbage|lacks filename|bad git-diff"#,
                      options: [.regularExpression, .caseInsensitive]) != nil {
            let line = (match(#"\b(?:at|on) line (\d+)"#) ?? match(#"\(line (\d+)\)"#)).flatMap { Int($0[0]) }
            return ApplyProblem(reason: .unreadable, file: line.flatMap { patchPath(patch, line: $0) }, line: line, text: text)
        }
        return ApplyProblem(reason: .other, text: text)
    }

    /// The user-facing reason: each problem once, naming its file. The missing-blob
    /// notice only stands when nothing else explains the failure (Git then applied
    /// directly, and that attempt's errors are the reason).
    static func applyReason(_ problems: [ApplyProblem], stderr: String, patchFile: String?) -> String {
        let shown = problems.contains { $0.reason != .missingBlob } ? problems.filter { $0.reason != .missingBlob } : problems
        var seen = Set<String>()
        let reasons = shown.map(\.message).filter { seen.insert($0).inserted }
        if !reasons.isEmpty { return reasons.joined(separator: "; ") }
        return scrub(stderr, patchFile: patchFile).split(separator: "\n").last.map(String.init) ?? "git apply failed"
    }

    /// Git's text with the scratch patch gone: a patch location ("<patch>:7", any
    /// Git version's spelling) becomes "line 7", any other mention "the patch".
    static func scrub(_ text: String, patchFile: String?) -> String {
        var out = text
        if let patchFile, !patchFile.isEmpty {
            out = out.replacingOccurrences(of: NSRegularExpression.escapedPattern(for: patchFile) + #":(\d+)"#, with: "line $1",
                                           options: .regularExpression)
            out = out.replacingOccurrences(of: patchFile, with: "the patch")
        }
        // Another spelling of a scratch patch's path (a resolved symlink, another scratch).
        let scratch = #"apply-[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\.patch"#
        out = out.replacingOccurrences(of: #"(\bat |\bon |\()[^\n]*?"# + scratch + #":(\d+)"#, with: "$1line $2", options: .regularExpression)
        return out.replacingOccurrences(of: #"[^\s'"]*"# + scratch, with: "the patch", options: .regularExpression)
    }

    /// The file a patch line belongs to (its `diff --git a/… b/…` header's new name).
    static func patchPath(_ patch: Data, line number: Int) -> String? {
        var path: String?
        for (index, line) in String(decoding: patch, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
            if index >= number { break }
            if line.hasPrefix("diff --git "), let range = line.range(of: " b/", options: .backwards) { path = String(line[range.upperBound...]) }
        }
        return path
    }

    /// A push the remote refused because the branch moved meanwhile, or a ref update
    /// it rejected (bounded retry after a fetch). Keys on the per-ref status Git
    /// prints untranslated in every version (` ! [rejected]  main -> main (fetch
    /// first)`), not on the summary or the hints, which are translated and reworded.
    static func pushRejected(_ output: String) -> Bool {
        output.range(of: #"(?m)^\s*!\s+\[(?:remote )?rejected\]|\((?:fetch first|non-fast-forward)\)"#, options: .regularExpression) != nil
    }

    /// The capture groups of `pattern`'s first match in `text`.
    static func captures(_ text: String, _ pattern: String) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let found = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
        return (1..<max(found.numberOfRanges, 1)).map { index in
            Range(found.range(at: index), in: text).map { String(text[$0]) } ?? ""
        }
    }
}
