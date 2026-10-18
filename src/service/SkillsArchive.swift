import Foundation
import zlib

/// Bounds of one GitHub archive (LKM-285). The TS twin is `SKILLS_GITHUB_LIMITS` in
/// `src/shared/skills-registry.ts`; `test/skills-github.mjs` pins both.
struct SkillsArchiveLimits: Sendable {
    static let compressedBytes = 64 * 1024 * 1024
    static let expandedBytes = 256 * 1024 * 1024
    static let entries = 20_000
    static let headerBytes = 64 * 1024
    var compressed = compressedBytes, expanded = expandedBytes, entries = entries, header = headerBytes
}

/// What a repository archive holds for one folder, as inert bytes: nothing is
/// written to disk, extracted, followed or run.
struct SkillsArchiveContents: Sendable {
    /// From the archive's pax global header (`git archive` writes the commit there).
    var commit: String?
    /// Regular files inside the folder, relative to it.
    var files: [SkillFile] = []
    /// Hidden entries inside the folder that were not read (`.github`, `.DS_Store`, …).
    var skipped: [String] = []
    /// The repository's top-level license files, read only when the folder is not the root.
    var rootLicenses: [SkillFile] = []
    /// The folder exists in the archive.
    var found = false
}

/// A streaming reader for GitHub's `tar.gz` archives. The one gzip member is inflated by
/// the system zlib in 64 KB chunks, CRC-32 and length checked; the tar stream is read record by
/// record and never materialised. The whole archive is refused for a malformed or
/// unsafe entry anywhere (absolute or `..` paths, entries outside the archive's one top
/// folder, non-UTF-8 names, unknown entry types, base-256 sizes, data after the end
/// marker, overrides without an entry) and for links, special files or executables
/// inside the chosen folder. Only that folder's regular files are kept.
enum SkillsArchive {
    enum Failure: Error { case refused(String), invalid(String), tooLarge(String) }

    static func read(_ gzip: Data, subpath: String, limits: SkillsArchiveLimits, cancelled: () -> Bool) throws -> SkillsArchiveContents {
        guard gzip.count <= limits.compressed else { throw Failure.tooLarge("The archive is larger than \(limits.compressed / 1024 / 1024) MB.") }
        var reader = TarReader(subpath: subpath, limits: limits)
        try gunzip(gzip, limit: limits.expanded, cancelled: cancelled) { try reader.feed($0) }
        return try reader.finish()
    }

    /// Exactly one gzip member (zlib checks its header, CRC-32 and length), nothing after it.
    static func gunzip(_ gzip: Data, limit: Int, cancelled: () -> Bool, sink: (UnsafeBufferPointer<UInt8>) throws -> Void) throws {
        let damaged = Failure.refused("The archive is damaged or truncated.")
        guard gzip.count >= 18, gzip.prefix(3) == Data([0x1F, 0x8B, 8]) else { throw Failure.refused("The download is not a gzip archive.") }
        var stream = z_stream()
        guard inflateInit2_(&stream, 16 + MAX_WBITS, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK else { throw damaged }
        defer { inflateEnd(&stream) }
        let size = 64 * 1024
        var buffer = [UInt8](repeating: 0, count: size)
        var total = 0
        try gzip.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            stream.next_in = UnsafeMutablePointer(mutating: raw.bindMemory(to: Bytef.self).baseAddress)
            stream.avail_in = uInt(raw.count)
            while true {
                let status: Int32 = try buffer.withUnsafeMutableBufferPointer { out in
                    stream.next_out = out.baseAddress
                    stream.avail_out = uInt(size)
                    let status = zlib.inflate(&stream, Z_NO_FLUSH)
                    let produced = size - Int(stream.avail_out)
                    if produced > 0 {
                        total += produced
                        guard total <= limit else { throw Failure.tooLarge("The archive expands to more than \(limit / 1024 / 1024) MB.") }
                        try sink(UnsafeBufferPointer(start: out.baseAddress, count: produced))
                    }
                    return status
                }
                if cancelled() { throw CancellationError() }
                if status == Z_STREAM_END { break }
                // Z_BUF_ERROR: the input ended inside the member.
                guard status == Z_OK else { throw damaged }
            }
            guard stream.avail_in == 0 else { throw damaged }
        }
    }
}

/// The tar half of `SkillsArchive`: ustar headers with pax (`x`, `g`) and GNU long-name
/// (`L`, `K`) records, read from a stream of chunks.
struct TarReader {
    private enum Action { case skip, file(String), license(String), pax(global: Bool), longName, longLink }
    typealias Failure = SkillsArchive.Failure

    let subpath: String
    let limits: SkillsArchiveLimits
    private(set) var contents = SkillsArchiveContents()
    private var header: [UInt8] = []
    private var body: [UInt8] = []
    private var remaining = 0, padding = 0
    private var action: Action?
    private var zeros = 0, entries = 0, total = 0
    private var root: String?
    private var nextPath: String?, nextSize: Int?
    private var globals = 0
    private var seen = Set<String>()

    init(subpath: String, limits: SkillsArchiveLimits) { self.subpath = subpath; self.limits = limits }

    mutating func feed(_ chunk: UnsafeBufferPointer<UInt8>) throws {
        var index = 0
        while index < chunk.count {
            if zeros == 2 {
                // After the end marker only zero padding may follow.
                guard chunk[index...].allSatisfy({ $0 == 0 }) else { throw Failure.refused("The archive has data after its end.") }
                return
            }
            if let current = action {
                let count = min(remaining, chunk.count - index)
                if case .skip = current {} else { body.append(contentsOf: chunk[index..<index + count]) }
                remaining -= count; index += count
                if remaining == 0 { action = nil; try complete(current) }
                continue
            }
            if padding > 0 {
                let count = min(padding, chunk.count - index)
                padding -= count; index += count
                continue
            }
            let count = min(512 - header.count, chunk.count - index)
            header.append(contentsOf: chunk[index..<index + count]); index += count
            if header.count == 512 { let record = header; header.removeAll(keepingCapacity: true); try begin(record) }
        }
    }

    func finish() throws -> SkillsArchiveContents {
        guard zeros == 2, action == nil, nextPath == nil, nextSize == nil else { throw Failure.refused("The archive is truncated.") }
        return contents
    }

    private mutating func begin(_ record: [UInt8]) throws {
        if record.allSatisfy({ $0 == 0 }) { zeros += 1; return }
        guard zeros == 0 else { throw Failure.refused("The archive has an entry after an empty block.") }
        entries += 1
        guard entries <= limits.entries else { throw Failure.tooLarge("The archive has more than \(limits.entries) entries.") }
        let stored = try Self.octal(record[148..<156])
        let sum = record.enumerated().reduce(0) { $0 + ((148..<156).contains($1.offset) ? 0x20 : Int($1.element)) }
        guard stored == sum else { throw Failure.refused("The archive has a damaged header.") }
        let posix = Array(record[257..<263]) == Array("ustar\0".utf8), gnu = Array(record[257..<265]) == Array("ustar  \0".utf8)
        guard posix || gnu else { throw Failure.refused("The archive is not a ustar archive.") }
        var size = try Self.octal(record[124..<136])
        let type = record[156]
        if let override = nextSize { size = override }
        guard size <= limits.expanded else { throw Failure.tooLarge("An archive entry is too large.") }
        let next: Action
        switch type {
        case UInt8(ascii: "g"), UInt8(ascii: "x"), UInt8(ascii: "L"), UInt8(ascii: "K"):
            guard size <= limits.header, nextPath == nil || type == UInt8(ascii: "K"), nextSize == nil else { throw Failure.refused("The archive has a malformed extended header.") }
            next = type == UInt8(ascii: "g") ? .pax(global: true) : type == UInt8(ascii: "x") ? .pax(global: false) : type == UInt8(ascii: "L") ? .longName : .longLink
        default:
            var path: String
            if let override = nextPath { path = override } else {
                path = try Self.string(record[0..<100])
                let prefix = posix ? try Self.string(record[345..<500]) : ""
                if !prefix.isEmpty { path = prefix + "/" + path }
            }
            nextPath = nil; nextSize = nil
            next = try entry(type: type, path: path, mode: try Self.octal(record[100..<108]), size: size)
        }
        remaining = size; padding = (512 - size % 512) % 512; body = []
        if size == 0 { try complete(next) } else { action = next }
    }

    private mutating func entry(type: UInt8, path raw: String, mode: Int, size: Int) throws -> Action {
        let directory = type == UInt8(ascii: "5")
        let known: Set<UInt8> = [0, UInt8(ascii: "0"), UInt8(ascii: "1"), UInt8(ascii: "2"), UInt8(ascii: "3"), UInt8(ascii: "4"),
                                 UInt8(ascii: "5"), UInt8(ascii: "6"), UInt8(ascii: "7")]
        guard known.contains(type) else { throw Failure.refused("The archive has an entry of an unsupported type.") }
        let regular = type == 0 || type == UInt8(ascii: "0")
        let link = type == UInt8(ascii: "1") || type == UInt8(ascii: "2")
        var path = raw
        if directory, path.hasSuffix("/") { path.removeLast() }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard !path.isEmpty, !path.hasPrefix("/"), !path.contains("\\"),
              parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            throw Failure.refused("The archive has an unsafe path (“\(raw.prefix(80))”).")
        }
        if let root { guard parts[0] == root else { throw Failure.refused("The archive has an entry outside its folder.") } } else { root = parts[0] }
        let relative = parts.dropFirst().joined(separator: "/")
        if relative.isEmpty { guard directory else { throw Failure.refused("The archive's top entry is not a folder.") }; return .skip }
        let inside: String?
        if subpath.isEmpty { inside = relative }
        else if relative == subpath { inside = "" }
        else if relative.hasPrefix(subpath + "/") { inside = String(relative.dropFirst(subpath.count + 1)) }
        else { inside = nil }
        guard let inside else {
            if (subpath + "/").hasPrefix(relative + "/"), !directory {
                throw link ? Failure.refused("\(relative) is a link; skills are imported without links.") : Failure.invalid("\(relative) is not a folder.")
            }
            if !subpath.isEmpty, regular, parts.count == 2, SkillsLicense.isLicenseFile(relative), size <= SkillsLimits.maxFileBytes { return .license(relative) }
            return .skip
        }
        contents.found = true
        if inside.isEmpty {
            guard directory else { throw link ? Failure.refused("\(subpath) is a link; skills are imported without links.") : Failure.invalid("\(subpath) is not a folder.") }
            return .skip
        }
        let components = inside.split(separator: "/").map(String.init)
        if let hidden = components.firstIndex(where: { $0.hasPrefix(".") }) {
            let name = components[...hidden].joined(separator: "/")
            if !contents.skipped.contains(name), contents.skipped.count < 64 { contents.skipped.append(name) }
            return .skip
        }
        if directory {
            guard components.count < SkillsLimits.maxDepth else { throw Failure.invalid("\(inside) is nested too deeply.") }
            return .skip
        }
        switch type {
        case UInt8(ascii: "1"): throw Failure.refused("\(inside) is a hard link; skills are imported without links.")
        case UInt8(ascii: "2"): throw Failure.refused("\(inside) is a symbolic link; skills are imported without links.")
        case _ where !regular: throw Failure.refused("\(inside) is not a regular file.")
        default: break
        }
        guard SkillsPackage.validPath(inside) else { throw Failure.invalid("“\(inside.prefix(80))” is not an allowed file path in a skill.") }
        guard mode & 0o111 == 0 else { throw Failure.refused("\(inside) is an executable file; imported skills hold plain text only.") }
        guard seen.insert(inside.lowercased()).inserted else { throw Failure.refused("\(inside) appears twice in the archive.") }
        guard contents.files.count < SkillsLimits.maxFiles else { throw Failure.invalid("A skill holds at most \(SkillsLimits.maxFiles) files.") }
        guard size <= SkillsLimits.maxFileBytes, total + size <= SkillsLimits.maxPackageBytes else { throw Failure.invalid("\(inside) makes the skill larger than allowed.") }
        total += size
        return .file(inside)
    }

    private mutating func complete(_ done: Action) throws {
        switch done {
        case .skip, .longLink: break
        case .file(let path): contents.files.append(SkillFile(path: path, data: Data(body)))
        case .license(let path): contents.rootLicenses.append(SkillFile(path: path, data: Data(body)))
        case .longName: nextPath = try Self.string(body[...])
        case .pax(let global):
            let records = try Self.pax(body)
            if global {
                globals += 1
                guard globals == 1, entries == 1, records.allSatisfy({ $0.0 == "comment" }) else { throw Failure.refused("The archive has an unexpected global header.") }
                contents.commit = records.first { $0.0 == "comment" }?.1
            } else {
                // `path` and `size` apply to the next entry; other keys (mtime, linkpath, …) are ignored.
                for (key, value) in records {
                    if key == "path" { nextPath = value }
                    if key == "size" { guard let size = Int(value), size >= 0 else { throw Failure.refused("The archive has a malformed extended header.") }; nextSize = size }
                }
            }
        }
        body = []
    }

    /// `"<length> <key>=<value>\n"` records, strictly.
    static func pax(_ bytes: [UInt8]) throws -> [(String, String)] {
        let malformed = Failure.refused("The archive has a malformed extended header.")
        var records: [(String, String)] = [], index = 0
        while index < bytes.count {
            var cursor = index, length = 0
            while cursor < bytes.count, (0x30...0x39).contains(bytes[cursor]), cursor - index < 8 { length = length * 10 + Int(bytes[cursor] - 0x30); cursor += 1 }
            guard cursor < bytes.count, bytes[cursor] == 0x20, length > cursor - index + 2, index + length <= bytes.count, bytes[index + length - 1] == 0x0A,
                  let line = String(bytes: bytes[(cursor + 1)..<(index + length - 1)], encoding: .utf8), let equals = line.firstIndex(of: "=") else { throw malformed }
            let key = String(line[..<equals]), value = String(line[line.index(after: equals)...])
            guard !key.isEmpty, !value.contains("\0") else { throw malformed }
            records.append((key, value))
            index += length
        }
        return records
    }

    /// An octal header field; base-256 (GNU large) values are refused.
    static func octal(_ field: ArraySlice<UInt8>) throws -> Int {
        var value = 0, digits = 0, done = false
        for byte in field {
            if byte == 0 || byte == 0x20 { if digits > 0 { done = true }; continue }
            guard !done, (0x30...0x37).contains(byte), digits < 12 else { throw Failure.refused("The archive has a malformed header field.") }
            value = value * 8 + Int(byte - 0x30); digits += 1
        }
        guard digits > 0 else { throw Failure.refused("The archive has a malformed header field.") }
        return value
    }

    /// A NUL-terminated UTF-8 field.
    static func string(_ field: ArraySlice<UInt8>) throws -> String {
        let bytes = field.prefix { $0 != 0 }
        guard let text = String(bytes: bytes, encoding: .utf8) else { throw Failure.refused("The archive has a name that is not UTF-8.") }
        return text
    }
}
