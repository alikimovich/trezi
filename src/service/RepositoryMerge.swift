import Foundation
import Darwin

/// The three-way merge `applyToWorkingTree` falls back to (LKM-130) when `git apply
/// --3way` refuses a patch for a reason that is really a conflict: a file the change
/// adds that the checkout already has (add/add), a file one side changed and the
/// other deleted (modify/delete, delete/modify), or a rename whose source is gone.
/// It merges file by file from the commits the patch came from (`base` → `tip`) onto
/// `directory`, whose state is the snapshot commit `live`, with `git merge-file`.
/// Every conflict ends as Git-style markers in the file; a deleted side is an empty
/// side labelled "(deleted)". A binary file or symbolic link changed on both sides
/// follows `binary`. All results are computed before the first file is written.
extension RepositoryEffects {
    enum BinaryPolicy { case chat, live }
    struct Merged { var conflicted: [String] = []; var kept: [String] = [] }

    private struct Blob: Equatable { let mode: String; let data: Data }
    private struct Change { let status: Character; let from: String; let to: String; let old: String?; let new: String? }
    private struct Placement { let path: String; let current: Blob?; let result: Blob? }

    func mergeChange(_ directory: String, base: String, tip: String, live: String, binary: BinaryPolicy) throws -> Merged {
        guard let top = RepositoryPaths.realpath(directory) else { throw RepositoryRefusal(.ioFailure, "\(directory): not found") }
        let chat = try changes(directory, base, tip)
        let liveRenames = Dictionary(try changes(directory, base, live).filter { $0.status == "R" }.map { ($0.from, $0.to) },
                                     uniquingKeysWith: { first, _ in first })
        var merged = Merged(), placements: [Placement] = []
        func settle(_ path: String, current: Blob?, ours: Blob?, base: Blob?, theirs: Blob?, conflict: Bool = false) throws {
            placements.append(Placement(path: path, current: current, result: try resolve(path, ours: ours, base: base, theirs: theirs,
                                                                                         binary: binary, conflict: conflict, into: &merged)))
        }
        for change in chat {
            let old = try change.old.map { try blob(directory, $0) }, new = try change.new.map { try blob(directory, $0) }
            // The same file on the live side: where it is now, following a live rename.
            var source = change.from, ours = try entry(directory, live, source)
            if ours == nil, let moved = liveRenames[source] { source = moved; ours = try entry(directory, live, moved) }
            switch change.status {
            case "R":
                let atTarget = try entry(directory, live, change.to)
                if ours == nil {
                    // Live deleted the source: rename/delete, or rename/add when live has the target.
                    try settle(change.to, current: atTarget, ours: atTarget, base: atTarget == nil ? old : nil, theirs: new, conflict: atTarget == nil)
                } else if atTarget != nil && source != change.to {
                    // Live has another file at the chat's new name: add/add there; the source is a deletion.
                    try settle(change.to, current: atTarget, ours: atTarget, base: nil, theirs: new)
                    try settle(source, current: ours, ours: ours, base: old, theirs: nil)
                } else {
                    // The chat's name wins; live's edits to the file are merged into it.
                    try settle(change.to, current: atTarget, ours: ours, base: old, theirs: new)
                    if source != change.to { placements.append(Placement(path: source, current: ours, result: nil)) }
                }
            case "A":
                let atTarget = try entry(directory, live, change.to)
                try settle(change.to, current: atTarget, ours: atTarget, base: nil, theirs: new)
            default:
                try settle(source, current: ours, ours: ours, base: old, theirs: change.status == "D" ? nil : new)
            }
        }
        for placement in placements { try check(top, placement) }
        for placement in placements where placement.current != placement.result { try place(top, placement) }
        return merged
    }

    /// What `path` should hold (nil: absent). `conflict` skips the one-sided shortcuts
    /// (a rename whose source live deleted is a conflict even when the chat only moved it).
    private func resolve(_ path: String, ours: Blob?, base: Blob?, theirs: Blob?, binary: BinaryPolicy,
                         conflict: Bool = false, into merged: inout Merged) throws -> Blob? {
        if ours == theirs { return ours }
        if !conflict && theirs == base { return ours }
        if !conflict && ours == base { return theirs }
        let opaque = [ours, base, theirs].contains { $0.map { $0.mode == "120000" || $0.data.prefix(8000).contains(0) } ?? false }
        if opaque {
            if binary == .chat { return theirs }
            merged.kept.append(path)
            return ours
        }
        guard let ours, let theirs else {
            // One side deleted the file: an explicit conflict with that side empty.
            merged.conflicted.append(path)
            var text = Data("<<<<<<< live\(ours == nil ? " (deleted)" : "")\n".utf8)
            text.append(Self.line(ours?.data)); text.append(Data("=======\n".utf8))
            text.append(Self.line(theirs?.data)); text.append(Data(">>>>>>> chat\(theirs == nil ? " (deleted)" : "")\n".utf8))
            return Blob(mode: (ours ?? theirs)?.mode ?? "100644", data: text)
        }
        let (text, clean) = try mergeFile(ours.data, base?.data ?? Data(), theirs.data)
        if !clean { merged.conflicted.append(path) }
        return Blob(mode: theirs.mode != base?.mode ? theirs.mode : ours.mode, data: text)
    }

    private static func line(_ data: Data?) -> Data {
        guard var data, !data.isEmpty else { return Data() }
        if data.last != 10 { data.append(10) }
        return data
    }

    private func mergeFile(_ ours: Data, _ base: Data, _ theirs: Data) throws -> (Data, Bool) {
        let stem = scratch + "/merge-\(UUID().uuidString)"
        let files = ["live", "base", "chat"].map { stem + "-" + $0 }
        defer { files.forEach { unlink($0) } }
        for (file, data) in zip(files, [ours, base, theirs]) where !Self.write(data, to: file) {
            throw RepositoryRefusal(.ioFailure, "Could not write a merge input (\(String(cString: strerror(errno))), \(file)).")
        }
        let result = try git.run(scratch, ["merge-file", "-p", "-L", "live", "-L", "base", "-L", "chat"] + files)
        guard (0...127).contains(result.status) else {
            throw GitFailure(arguments: ["merge-file"], status: result.status, stdout: "", stderr: String(decoding: result.stderr, as: UTF8.self))
        }
        return (result.stdout, result.status == 0)
    }

    /// `diff-tree -M` between two commits: plumbing, so no user diff configuration applies.
    private func changes(_ directory: String, _ from: String, _ to: String) throws -> [Change] {
        let fields = try git.paths(directory, ["diff-tree", "-r", "-z", "-M", "--no-abbrev", from, to])
        var result: [Change] = [], index = 0
        while index < fields.count {
            let header = fields[index].split(separator: " ").map(String.init)
            index += 1
            guard header.count == 5, header[0].hasPrefix(":"), let status = header[4].first, index < fields.count else { continue }
            let from = fields[index], to = "RC".contains(status) && index + 1 < fields.count ? fields[index + 1] : from
            index += "RC".contains(status) ? 2 : 1
            guard Self.relative(from), Self.relative(to), !RepositoryPaths.excluded(from), !RepositoryPaths.excluded(to) else { continue }
            for (mode, path) in [(header[0].dropFirst(), from), (Substring(header[1]), to)] where mode == "160000" {
                throw RepositoryRefusal(.conflict, "\(path): a submodule change can't be merged here")
            }
            let absent = String(repeating: "0", count: header[2].count)
            result.append(Change(status: status == "C" ? "A" : status, from: from, to: to,
                                 old: header[2] == absent ? nil : "\(header[0].dropFirst()) \(header[2])",
                                 new: header[3] == absent ? nil : "\(header[1]) \(header[3])"))
        }
        return result
    }

    /// "<mode> <sha>" → its content.
    private func blob(_ directory: String, _ spec: String) throws -> Blob {
        let parts = spec.split(separator: " ").map(String.init)
        return Blob(mode: parts[0], data: try git.data(directory, ["cat-file", "blob", parts[1]]))
    }

    private func entry(_ directory: String, _ commit: String, _ path: String) throws -> Blob? {
        let listing = try git.text(directory, ["ls-tree", "-z", "--full-tree", commit, "--", path], env: ["GIT_LITERAL_PATHSPECS": "1"])
        guard let record = listing.split(separator: "\0").first(where: { $0.hasSuffix("\t" + path) }) else { return nil }
        let parts = record.split(separator: "\t")[0].split(separator: " ").map(String.init)
        guard parts.count == 3, parts[1] == "blob" else { throw RepositoryRefusal(.conflict, "\(path): a folder or submodule is in the way") }
        return try blob(directory, parts[0] + " " + parts[2])
    }

    /// Refused before anything is written: a path whose folder resolves outside the
    /// checkout (a symbolic link) or that a folder occupies.
    private func check(_ top: String, _ placement: Placement) throws {
        let path = top + "/" + placement.path
        var parent = (path as NSString).deletingLastPathComponent
        while !FileManager.default.fileExists(atPath: parent) && parent.count > top.count { parent = (parent as NSString).deletingLastPathComponent }
        guard let resolved = RepositoryPaths.realpath(parent), RepositoryPaths.contains(top, resolved) else {
            throw RepositoryRefusal(.conflict, "\(placement.path): is beyond a symbolic link")
        }
        var isDirectory: ObjCBool = false
        if placement.result != nil, FileManager.default.fileExists(atPath: parent, isDirectory: &isDirectory), !isDirectory.boolValue {
            throw RepositoryRefusal(.conflict, "\(placement.path): a file is in the way of its folder")
        }
        if FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue {
            throw RepositoryRefusal(.conflict, "\(placement.path): a folder is in the way")
        }
    }

    private func place(_ top: String, _ placement: Placement) throws {
        let path = top + "/" + placement.path
        if unlink(path) != 0 && errno != ENOENT {
            throw RepositoryRefusal(.ioFailure, "\(placement.path): \(String(cString: strerror(errno)))")
        }
        guard let result = placement.result else {
            // Like Git, drop folders the deletion emptied.
            var parent = (path as NSString).deletingLastPathComponent
            while parent.count > top.count && rmdir(parent) == 0 { parent = (parent as NSString).deletingLastPathComponent }
            return
        }
        try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        let written = result.mode == "120000" ? symlink(String(decoding: result.data, as: UTF8.self), path) == 0 : Self.write(result.data, to: path)
        guard written else { throw RepositoryRefusal(.ioFailure, "\(placement.path): \(String(cString: strerror(errno)))") }
        if result.mode == "100755" { chmod(path, 0o755) }
    }
}
