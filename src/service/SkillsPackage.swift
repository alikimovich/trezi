import Foundation
import CryptoKit
import Darwin

/// Bounds of the app-scoped Skills registry (LKM-284). The TS twin is
/// `SKILLS_LIMITS` in `src/shared/skills-registry.ts`; `test/skills-registry.mjs` pins both.
enum SkillsLimits {
    static let maxFiles = 64
    static let maxDirectoryEntries = 1024
    static let maxFileBytes = 256 * 1024
    static let maxPackageBytes = 1024 * 1024
    static let maxDepth = 6
    static let maxPath = 512
    static let maxComponent = 128
    static let maxName = 64
    static let maxDescription = 1024
    static let maxSkills = 512
    static let maxHistory = 64
    static let maxSnapshots = 4096
    static let maxSession = 200
    static let maxManifestBytes = 8 * 1024 * 1024
}

/// One file of a package as it is validated: a relative path and its bytes (UTF-8 text).
struct SkillFile: Equatable, Sendable { let path: String; let data: Data }

/// One file of a stored revision: its bytes live in `objects/<digest>`.
struct SkillEntry: Equatable, Sendable { let path: String; let digest: String; let size: Int }

/// An immutable package revision. Its ID is the SHA-256 of `encoded()`, so equal
/// content is one revision, and a revision file whose bytes do not hash to its name is damaged.
struct SkillRevision: Equatable, Sendable {
    static let format = "trezi-skill-revision-v1"
    let name: String
    let description: String
    /// Sorted by path; always holds `SKILL.md`.
    let files: [SkillEntry]

    var bytes: Int { files.reduce(0) { $0 + $1.size } }
    var entry: SkillEntry? { files.first { $0.path == SkillsPackage.entryFile } }

    func encoded() -> Data {
        JSValue.object([
            (JSText("format"), .string(JSText(Self.format))), (JSText("name"), .string(JSText(name))),
            (JSText("description"), .string(JSText(description))),
            (JSText("files"), .array(files.map { .object([(JSText("path"), .string(JSText($0.path))),
                (JSText("digest"), .string(JSText($0.digest))), (JSText("size"), .number(Double($0.size)))]) }))
        ]).utf8()
    }
    var id: String { SkillsPackage.digest(encoded()) }

    static func decode(_ data: Data) throws -> SkillRevision {
        let damaged = SkillsPackageError.damaged("revision")
        guard let root = try? JSValue.parse(data, maxDepth: 6), root["format"]?.text?.string == format,
              let name = root["name"]?.text?.string, let description = root["description"]?.text?.string,
              case .array(let items)? = root["files"] else { throw damaged }
        var files: [SkillEntry] = []
        for item in items {
            guard let path = item["path"]?.text?.string, let digest = item["digest"]?.text?.string, SkillsPackage.validDigest(digest),
                  case .number(let size)? = item["size"], size >= 0, size.rounded() == size, size <= Double(SkillsLimits.maxFileBytes) else { throw damaged }
            files.append(SkillEntry(path: path, digest: digest, size: Int(size)))
        }
        let revision = SkillRevision(name: name, description: description, files: files)
        guard revision.encoded() == data, (try? SkillsPackage.check(files.map { ($0.path, $0.size) })) != nil, revision.entry != nil else { throw damaged }
        return revision
    }
}

enum SkillsPackageError: Error, Equatable {
    /// The package breaks a rule (`invalidRequest`).
    case invalid(String)
    /// A path the registry never follows: a link, a special file, a hard link (`unauthorized`).
    case refused(String)
    /// Stored data does not match its digest or format (`recoveryRequired`).
    case damaged(String)
    case io(String)
}

/// Validation of package content. Nothing here runs, opens for writing or follows
/// anything: a package is inert text until a provider seam reads it.
enum SkillsPackage {
    static let entryFile = "SKILL.md"

    static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func validDigest(_ value: String) -> Bool { value.utf8.count == 64 && value.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) } }

    /// Agent Skills names: 1–64 of `a-z`, `0-9` and `-`, not starting or ending with `-`.
    static func validName(_ name: String) -> Bool {
        let units = Array(name.utf8)
        guard (1...SkillsLimits.maxName).contains(units.count), units.first != 0x2D, units.last != 0x2D else { return false }
        return units.allSatisfy { (0x61...0x7A).contains($0) || (0x30...0x39).contains($0) || $0 == 0x2D }
    }

    /// A relative path of 1–6 components of `A-Z a-z 0-9 . _ - space`; no component is
    /// empty, `.`/`..`, hidden (leading `.`) or ends in `.` or a space.
    static func validPath(_ path: String) -> Bool {
        guard !path.isEmpty, path.utf8.count <= SkillsLimits.maxPath else { return false }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count <= SkillsLimits.maxDepth else { return false }
        return parts.allSatisfy { validComponent(String($0)) }
    }

    static func validComponent(_ name: String) -> Bool {
        let units = Array(name.utf8)
        guard (1...SkillsLimits.maxComponent).contains(units.count), units[0] != 0x2E, units[0] != 0x20,
              units.last != 0x2E, units.last != 0x20 else { return false }
        return units.allSatisfy { (0x41...0x5A).contains($0) || (0x61...0x7A).contains($0) || (0x30...0x39).contains($0)
            || $0 == 0x2E || $0 == 0x5F || $0 == 0x2D || $0 == 0x20 }
    }

    /// The structural rules on `(path, size)` pairs: count, sizes, paths, case-folded
    /// uniqueness (the profile may be on a case-insensitive volume) and `SKILL.md`.
    static func check(_ files: [(String, Int)]) throws {
        guard !files.isEmpty, files.count <= SkillsLimits.maxFiles else { throw SkillsPackageError.invalid("A skill holds 1 to \(SkillsLimits.maxFiles) files.") }
        var seen = Set<String>(), total = 0
        for (path, size) in files {
            guard validPath(path) else { throw SkillsPackageError.invalid("“\(path.prefix(80))” is not an allowed file path in a skill.") }
            guard size <= SkillsLimits.maxFileBytes else { throw SkillsPackageError.invalid("\(path) is larger than \(SkillsLimits.maxFileBytes / 1024) KB.") }
            guard seen.insert(path.lowercased()).inserted else { throw SkillsPackageError.invalid("\(path) appears twice.") }
            total += size
        }
        guard total <= SkillsLimits.maxPackageBytes else { throw SkillsPackageError.invalid("A skill is limited to \(SkillsLimits.maxPackageBytes / 1024) KB.") }
        guard files.contains(where: { $0.0 == entryFile }) else { throw SkillsPackageError.invalid("A skill needs a SKILL.md at its top level.") }
    }

    /// UTF-8 text without NUL; scripts and binaries are not accepted as package content.
    static func text(_ file: SkillFile) throws -> String {
        guard !file.data.contains(0), let text = String(data: file.data, encoding: .utf8) else {
            throw SkillsPackageError.invalid("\(file.path) is not UTF-8 text.")
        }
        return text
    }

    /// Validates a whole package and returns its metadata from `SKILL.md`.
    static func validate(_ files: [SkillFile]) throws -> (name: String, description: String) {
        try check(files.map { ($0.path, $0.data.count) })
        for file in files { _ = try text(file) }
        return try metadata(of: files.first { $0.path == entryFile }!)
    }

    static func metadata(of entry: SkillFile) throws -> (name: String, description: String) {
        let meta = frontmatter(try text(entry))
        guard let name = meta.name, validName(name) else {
            throw SkillsPackageError.invalid("SKILL.md needs a `name` of lowercase letters, digits and hyphens (at most \(SkillsLimits.maxName)).")
        }
        guard let description = meta.description, description.utf16.count <= SkillsLimits.maxDescription else {
            throw SkillsPackageError.invalid("SKILL.md needs a `description` of at most \(SkillsLimits.maxDescription) characters.")
        }
        return (name, description)
    }

    /// `name`/`description` from YAML frontmatter, the rules of `parseSkillMeta` in
    /// `src/main/skills.ts` (plain, quoted and block scalars); anything else is ignored.
    static func frontmatter(_ content: String) -> (name: String?, description: String?) {
        var lines = content.components(separatedBy: "\n").map { $0.hasSuffix("\r") ? String($0.dropLast()) : $0 }
        guard lines.first == "---", let end = lines.dropFirst().firstIndex(of: "---") else { return (nil, nil) }
        lines = Array(lines[1..<end])
        var name: String?, description: String?
        var index = 0
        func blank(_ line: String) -> Bool { line.trimmingCharacters(in: .whitespaces).isEmpty }
        while index < lines.count {
            let line = lines[index]
            let key = line.hasPrefix("name:") ? "name" : line.hasPrefix("description:") ? "description" : nil
            guard let key else { index += 1; continue }
            var value = String(line.dropFirst(key.count + 1)).trimmingCharacters(in: .whitespaces)
            if ["", ">", "|", ">-", "|-"].contains(value) {
                var parts: [String] = []
                while index + 1 < lines.count, let first = lines[index + 1].first, (first == " " || first == "\t") || blank(lines[index + 1]) {
                    index += 1
                    let part = lines[index].trimmingCharacters(in: .whitespaces)
                    if !part.isEmpty { parts.append(part) }
                }
                value = parts.joined(separator: " ")
            } else if value.count >= 2, let first = value.first, first == "\"" || first == "'", value.last == first {
                value = String(value.dropFirst().dropLast())
            }
            if !value.isEmpty {
                if key == "name", name == nil { name = value }
                if key == "description", description == nil { description = value }
            }
            index += 1
        }
        return (name, description)
    }

    /// Reads a local folder chosen for import, bounded, without following anything:
    /// the folder itself and every entry are opened relative to their parent's
    /// descriptor with `O_NOFOLLOW`, so a link swapped in mid-walk is refused, not
    /// followed. A symbolic link, special file or hard-linked file anywhere refuses the
    /// whole import; hidden entries (`.git`, `.DS_Store`, …) are skipped unopened and named.
    static func readDirectory(_ path: String) throws -> (files: [SkillFile], skipped: [String]) {
        guard path.hasPrefix("/"), path.utf8.count <= 4096, !path.split(separator: "/").contains(where: { $0 == ".." || $0 == "." }) else {
            throw SkillsPackageError.invalid("Choose an absolute folder to import.")
        }
        let root = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard root >= 0 else {
            if errno == ELOOP || errno == ENOTDIR { throw SkillsPackageError.refused("The chosen folder is a link or not a folder.") }
            throw SkillsPackageError.io("The folder could not be opened (errno \(errno)).")
        }
        var files: [SkillFile] = [], skipped: [String] = [], total = 0, visited = 0
        func walk(_ directory: Int32, _ prefix: String, _ depth: Int) throws {
            guard let stream = fdopendir(dup(directory)) else { throw SkillsPackageError.io("The folder could not be listed.") }
            var names: [String] = []
            while let entry = readdir(stream) {
                let name = withUnsafePointer(to: entry.pointee.d_name) { $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) } }
                if name != "." && name != ".." {
                    visited += 1
                    guard visited <= SkillsLimits.maxDirectoryEntries else {
                        closedir(stream)
                        throw SkillsPackageError.invalid("A skill folder contains too many entries, including folders and hidden files.")
                    }
                    names.append(name)
                }
            }
            closedir(stream)
            for name in names.sorted() {
                let relative = prefix.isEmpty ? name : prefix + "/" + name
                if name.hasPrefix(".") { skipped.append(relative); continue }
                guard validComponent(name), relative.utf8.count <= SkillsLimits.maxPath else {
                    throw SkillsPackageError.invalid("“\(relative.prefix(80))” is not an allowed file name in a skill.")
                }
                var status = stat()
                guard fstatat(directory, name, &status, AT_SYMLINK_NOFOLLOW) == 0 else { throw SkillsPackageError.io("\(relative) could not be read.") }
                switch status.st_mode & S_IFMT {
                case S_IFLNK: throw SkillsPackageError.refused("\(relative) is a symbolic link; skills are imported without links.")
                case S_IFDIR:
                    guard depth + 1 < SkillsLimits.maxDepth else { throw SkillsPackageError.invalid("\(relative) is nested too deeply.") }
                    let child = openat(directory, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                    guard child >= 0 else { throw SkillsPackageError.refused("\(relative) changed while it was read.") }
                    defer { close(child) }
                    try walk(child, relative, depth + 1)
                case S_IFREG:
                    guard status.st_nlink == 1 else { throw SkillsPackageError.refused("\(relative) is a hard link; copy the file instead.") }
                    guard files.count < SkillsLimits.maxFiles else { throw SkillsPackageError.invalid("A skill holds at most \(SkillsLimits.maxFiles) files.") }
                    guard status.st_size <= off_t(SkillsLimits.maxFileBytes), total + Int(status.st_size) <= SkillsLimits.maxPackageBytes else {
                        throw SkillsPackageError.invalid("\(relative) makes the skill larger than allowed.")
                    }
                    let data = try readFile(directory, name, relative, expected: status)
                    total += data.count
                    files.append(SkillFile(path: relative, data: data))
                default: throw SkillsPackageError.refused("\(relative) is not a regular file.")
                }
            }
        }
        defer { close(root) }
        try walk(root, "", 0)
        return (files, skipped)
    }

    /// Opens one entry without following it and checks it is the file `fstatat` saw.
    private static func readFile(_ directory: Int32, _ name: String, _ relative: String, expected: stat) throws -> Data {
        let fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw SkillsPackageError.refused("\(relative) changed while it was read.") }
        defer { close(fd) }
        var status = stat()
        guard fstat(fd, &status) == 0, status.st_mode & S_IFMT == S_IFREG, status.st_ino == expected.st_ino, status.st_dev == expected.st_dev, status.st_nlink == 1 else {
            throw SkillsPackageError.refused("\(relative) changed while it was read.")
        }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = read(fd, &buffer, buffer.count)
            if count == 0 { return data }
            if count < 0 { if errno == EINTR { continue }; throw SkillsPackageError.io("\(relative) could not be read.") }
            data.append(contentsOf: buffer[..<count])
            guard data.count <= SkillsLimits.maxFileBytes else { throw SkillsPackageError.invalid("\(relative) is larger than \(SkillsLimits.maxFileBytes / 1024) KB.") }
        }
    }
}
