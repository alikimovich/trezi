import Foundation
import CryptoKit
import Darwin

/// Text exactly as JavaScript holds it: UTF-16 code units. Lone surrogates and JS
/// `.length` limits survive a round trip that Swift `String` would normalize away.
typealias JSText = [UInt16]

extension JSText {
    init(_ string: String) { self = Array(string.utf16) }
    var string: String { String(decoding: self, as: UTF16.self) }
    func hasPrefix(_ prefix: String) -> Bool { starts(with: prefix.utf16) }
}

/// JSON with insertion-ordered objects, parsed and written with `JSON.parse` /
/// `JSON.stringify` semantics so the v1 file stays byte-compatible with Bun.
indirect enum JSValue: Equatable, Sendable {
    case null, bool(Bool), number(Double), string(JSText)
    case array([JSValue]), object([(JSText, JSValue)])

    static func == (lhs: JSValue, rhs: JSValue) -> Bool {
        switch (lhs, rhs) {
        case (.null, .null): return true
        case let (.bool(a), .bool(b)): return a == b
        case let (.number(a), .number(b)): return a == b
        case let (.string(a), .string(b)): return a == b
        case let (.array(a), .array(b)): return a == b
        case let (.object(a), .object(b)): return a.count == b.count && zip(a, b).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 }
        default: return false
        }
    }

    subscript(_ key: String) -> JSValue? {
        guard case .object(let fields) = self else { return nil }
        let wanted = JSText(key)
        return fields.last(where: { $0.0 == wanted })?.1
    }
    var text: JSText? { if case .string(let value) = self { return value }; return nil }

    /// `JSON.parse` over the text JavaScript would see: UTF-8 decoded with
    /// replacement (like `readFileSync(path, 'utf8')`), a BOM is not whitespace,
    /// a repeated key keeps its first position and takes the last value.
    static func parse(_ data: Data, maxDepth: Int = 512) throws -> JSValue {
        var parser = JSParser(units: Array(String(decoding: data, as: UTF8.self).utf16), maxDepth: maxDepth)
        return try parser.document()
    }

    /// `JSON.stringify` output (well-formed variant: lone surrogates escaped).
    func serialized() -> JSText {
        var out: JSText = []
        write(to: &out)
        return out
    }

    func utf8() -> Data { Data(serialized().string.utf8) }

    /// `JSON.stringify(value, null, 2)`.
    static func pretty(_ value: JSValue, indent: String = "") -> String {
        let inner = indent + "  "
        switch value {
        case .array(let items):
            if items.isEmpty { return "[]" }
            return "[\n" + items.map { inner + pretty($0, indent: inner) }.joined(separator: ",\n") + "\n" + indent + "]"
        case .object(let fields):
            if fields.isEmpty { return "{}" }
            var seen: [JSText] = [], unique: [(JSText, JSValue)] = []
            for (key, item) in fields {
                if let index = seen.firstIndex(of: key) { unique[index].1 = item } else { seen.append(key); unique.append((key, item)) }
            }
            return "{\n" + JSValue.enumerationOrder(unique).map { key, item -> String in
                var quoted: JSText = []
                JSValue.quote(key, into: &quoted)
                return inner + quoted.string + ": " + pretty(item, indent: inner)
            }.joined(separator: ",\n") + "\n" + indent + "}"
        default: return value.serialized().string
        }
    }

    private func write(to out: inout JSText) {
        switch self {
        case .null: out += JSText("null")
        case .bool(let value): out += JSText(value ? "true" : "false")
        case .number(let value): out += JSText(JSValue.number(value))
        case .string(let value): JSValue.quote(value, into: &out)
        case .array(let values):
            out.append(0x5B)
            for (index, value) in values.enumerated() { if index > 0 { out.append(0x2C) }; value.write(to: &out) }
            out.append(0x5D)
        case .object(let fields):
            out.append(0x7B)
            for (index, (key, value)) in JSValue.enumerationOrder(fields).enumerated() {
                if index > 0 { out.append(0x2C) }
                JSValue.quote(key, into: &out); out.append(0x3A); value.write(to: &out)
            }
            out.append(0x7D)
        }
    }

    /// JavaScript's own-property order: array-index keys ("0"…"4294967294", no
    /// leading zeros) ascending, then every other key in insertion order.
    static func enumerationOrder(_ fields: [(JSText, JSValue)]) -> [(JSText, JSValue)] {
        func index(_ key: JSText) -> UInt64? {
            guard !key.isEmpty, key.count <= 10, key.allSatisfy({ (0x30...0x39).contains($0) }), key == [0x30] || key[0] != 0x30,
                  let value = UInt64(key.string), value < 4_294_967_295 else { return nil }
            return value
        }
        let indexed = fields.compactMap { field in index(field.0).map { ($0, field) } }
        guard !indexed.isEmpty else { return fields }
        return indexed.sorted { $0.0 < $1.0 }.map(\.1) + fields.filter { index($0.0) == nil }
    }

    /// `Number.prototype.toString()` for a finite double (non-finite is `null`, -0 is "0").
    static func number(_ value: Double) -> String {
        guard value.isFinite else { return "null" }
        if value == 0 { return "0" }
        // Swift's description is the shortest round-tripping digit string, as in JS;
        // only its layout differs. Reduce it to digits and a decimal exponent.
        let description = abs(value).description
        let parts = description.split(separator: "e", maxSplits: 1)
        let mantissa = String(parts[0])
        let exponent = parts.count > 1 ? Int(parts[1])! : 0
        let point = mantissa.firstIndex(of: ".").map { mantissa.distance(from: mantissa.startIndex, to: $0) } ?? mantissa.count
        var digits = [Character](mantissa.replacingOccurrences(of: ".", with: ""))
        var n = point + exponent
        while digits.first == "0" { digits.removeFirst(); n -= 1 }
        while digits.last == "0" { digits.removeLast() }
        let k = digits.count, sign = value < 0 ? "-" : ""
        let all = String(digits)
        if k <= n && n <= 21 { return sign + all + String(repeating: "0", count: n - k) }
        if 0 < n && n <= 21 { return sign + String(digits[..<n]) + "." + String(digits[n...]) }
        if -6 < n && n <= 0 { return sign + "0." + String(repeating: "0", count: -n) + all }
        let e = n - 1
        let power = (e < 0 ? "-" : "+") + String(abs(e))
        return sign + (k == 1 ? all : String(digits[0]) + "." + String(digits[1...])) + "e" + power
    }

    static func quote(_ text: JSText, into out: inout JSText) {
        let hex = Array("0123456789abcdef".utf16)
        func escape(_ unit: UInt16) {
            out += [0x5C, 0x75]
            for shift in [12, 8, 4, 0] { out.append(hex[Int((unit >> UInt16(shift)) & 0xF)]) }
        }
        out.append(0x22)
        var index = 0
        while index < text.count {
            let unit = text[index]
            switch unit {
            case 0x22: out += [0x5C, 0x22]
            case 0x5C: out += [0x5C, 0x5C]
            case 0x08: out += [0x5C, 0x62]
            case 0x0C: out += [0x5C, 0x66]
            case 0x0A: out += [0x5C, 0x6E]
            case 0x0D: out += [0x5C, 0x72]
            case 0x09: out += [0x5C, 0x74]
            case ..<0x20: escape(unit)
            case 0xD800...0xDBFF:
                if index + 1 < text.count, (0xDC00...0xDFFF).contains(text[index + 1]) {
                    out += [unit, text[index + 1]]; index += 1
                } else { escape(unit) }
            case 0xDC00...0xDFFF: escape(unit)
            default: out.append(unit)
            }
            index += 1
        }
        out.append(0x22)
    }
}

enum JSParseError: Error { case syntax, depth }

private struct JSParser {
    let units: [UInt16]
    let maxDepth: Int
    var index = 0

    mutating func document() throws -> JSValue {
        let value = try parse(depth: 0)
        skip()
        guard index == units.count else { throw JSParseError.syntax }
        return value
    }

    mutating func skip() { while index < units.count, [0x20, 0x09, 0x0A, 0x0D].contains(units[index]) { index += 1 } }

    mutating func literal(_ word: String, _ value: JSValue) throws -> JSValue {
        let expected = Array(word.utf16)
        guard index + expected.count <= units.count, Array(units[index..<index + expected.count]) == expected else { throw JSParseError.syntax }
        index += expected.count
        return value
    }

    mutating func parse(depth: Int) throws -> JSValue {
        // Deeper than any preference file needs: refused instead of overflowing the stack.
        guard depth <= maxDepth else { throw JSParseError.depth }
        skip()
        guard index < units.count else { throw JSParseError.syntax }
        switch units[index] {
        case 0x7B:
            index += 1
            var fields: [(JSText, JSValue)] = []
            var positions: [JSText: Int] = [:]
            skip()
            if index < units.count, units[index] == 0x7D { index += 1; return .object(fields) }
            while true {
                skip()
                guard index < units.count, units[index] == 0x22 else { throw JSParseError.syntax }
                let key = try string()
                skip()
                guard index < units.count, units[index] == 0x3A else { throw JSParseError.syntax }
                index += 1
                let value = try parse(depth: depth + 1)
                if let position = positions[key] { fields[position].1 = value }
                else { positions[key] = fields.count; fields.append((key, value)) }
                skip()
                guard index < units.count else { throw JSParseError.syntax }
                if units[index] == 0x2C { index += 1; continue }
                guard units[index] == 0x7D else { throw JSParseError.syntax }
                index += 1
                return .object(fields)
            }
        case 0x5B:
            index += 1
            var values: [JSValue] = []
            skip()
            if index < units.count, units[index] == 0x5D { index += 1; return .array(values) }
            while true {
                values.append(try parse(depth: depth + 1))
                skip()
                guard index < units.count else { throw JSParseError.syntax }
                if units[index] == 0x2C { index += 1; continue }
                guard units[index] == 0x5D else { throw JSParseError.syntax }
                index += 1
                return .array(values)
            }
        case 0x22: return .string(try string())
        case 0x74: return try literal("true", .bool(true))
        case 0x66: return try literal("false", .bool(false))
        case 0x6E: return try literal("null", .null)
        default: return .number(try number())
        }
    }

    mutating func digits() -> Int {
        let start = index
        while index < units.count, (0x30...0x39).contains(units[index]) { index += 1 }
        return index - start
    }

    mutating func number() throws -> Double {
        let start = index
        if index < units.count, units[index] == 0x2D { index += 1 }
        guard index < units.count else { throw JSParseError.syntax }
        if units[index] == 0x30 { index += 1 } else { guard digits() > 0 else { throw JSParseError.syntax } }
        if index < units.count, units[index] == 0x2E { index += 1; guard digits() > 0 else { throw JSParseError.syntax } }
        if index < units.count, units[index] == 0x65 || units[index] == 0x45 {
            index += 1
            if index < units.count, units[index] == 0x2B || units[index] == 0x2D { index += 1 }
            guard digits() > 0 else { throw JSParseError.syntax }
        }
        guard let value = Double(String(decoding: units[start..<index], as: UTF16.self)) else { throw JSParseError.syntax }
        return value
    }

    mutating func string() throws -> JSText {
        index += 1
        var out: JSText = []
        while true {
            guard index < units.count else { throw JSParseError.syntax }
            let unit = units[index]; index += 1
            if unit == 0x22 { return out }
            guard unit >= 0x20 else { throw JSParseError.syntax }
            guard unit == 0x5C else { out.append(unit); continue }
            guard index < units.count else { throw JSParseError.syntax }
            let escape = units[index]; index += 1
            switch escape {
            case 0x22, 0x5C, 0x2F: out.append(escape)
            case 0x62: out.append(0x08)
            case 0x66: out.append(0x0C)
            case 0x6E: out.append(0x0A)
            case 0x72: out.append(0x0D)
            case 0x74: out.append(0x09)
            case 0x75:
                guard index + 4 <= units.count,
                      let code = UInt16(String(decoding: units[index..<index + 4], as: UTF16.self), radix: 16),
                      units[index..<index + 4].allSatisfy({ (0x30...0x39).contains($0) || (0x41...0x46).contains($0) || (0x61...0x66).contains($0) })
                else { throw JSParseError.syntax }
                out.append(code); index += 4
            default: throw JSParseError.syntax
            }
        }
    }
}

/// The legacy v1 preference store, `<profile>/preferences.json`:
/// `{"version":1,"values":{key: string | null}}`. Same rules as the retired Bun
/// writer; the only writer since LKM-111.
struct PreferenceValues: Equatable {
    static let maxKeyLength = 200        // exclusive, UTF-16 code units
    static let maxValueLength = 2_000_000 // inclusive, UTF-16 code units

    /// Insertion order is file order: an existing key keeps its position.
    private(set) var entries: [(key: JSText, value: JSText?)] = []
    private var positions: [JSText: Int] = [:]

    static func == (lhs: PreferenceValues, rhs: PreferenceValues) -> Bool {
        lhs.entries.count == rhs.entries.count && zip(lhs.entries, rhs.entries).allSatisfy { $0.key == $1.key && $0.value == $1.value }
    }

    /// `/^(trezi|praxis)[:.]/`, shorter than 200 code units.
    static func validKey(_ key: JSText) -> Bool {
        guard key.count < maxKeyLength else { return false }
        return ["trezi:", "trezi.", "praxis:", "praxis."].contains { key.hasPrefix($0) }
    }
    static func validValue(_ value: JSText?) -> Bool { (value?.count ?? 0) <= maxValueLength }
    /// `praxis:` / `praxis.` keys are written under `trezi`.
    static func canonical(_ key: JSText) -> JSText {
        key.hasPrefix("praxis:") || key.hasPrefix("praxis.") ? JSText("trezi") + key.dropFirst(6) : key
    }

    func contains(_ key: JSText) -> Bool { positions[key] != nil }
    func value(_ key: JSText) -> JSText?? { positions[key].map { entries[$0].value } }

    mutating func set(_ key: JSText, _ value: JSText?) {
        if let position = positions[key] { entries[position].value = value }
        else { positions[key] = entries.count; entries.append((key, value)) }
    }

    /// Reads a v1 file exactly as Bun does: anything but `version === 1` with an
    /// object-typed `values` is refused; invalid entries are dropped; legacy
    /// `praxis` keys are retained and copied to their canonical name when absent.
    static func decode(_ data: Data) throws -> PreferenceValues {
        let root = try JSValue.parse(data)
        guard case .number(1)? = root["version"] else { throw PreferencesError.invalidFile }
        var values = PreferenceValues()
        switch root["values"] {
        case .object(let fields)?:
            for (key, value) in fields where validKey(key) {
                switch value {
                case .null: values.set(key, nil)
                case .string(let text) where validValue(text): values.set(key, text)
                default: break
                }
            }
        case .array?: break // typeof [] === 'object'; no key matches the pattern
        default: throw PreferencesError.invalidFile
        }
        for entry in values.entries where entry.key.hasPrefix("praxis:") || entry.key.hasPrefix("praxis.") {
            let name = canonical(entry.key)
            if !values.contains(name) { values.set(name, entry.value) }
        }
        return values
    }

    func encoded() -> Data {
        JSValue.object([(JSText("version"), .number(1)),
            (JSText("values"), .object(entries.map { ($0.key, $0.value.map(JSValue.string) ?? .null) }))]).utf8()
    }
}

enum PreferencesError: Error, Equatable {
    case invalidFile
    case unreadable(Int32)
    case io(PreferencesWriteStep, Int32)
}

enum PreferencesWriteStep: String, CaseIterable, Sendable {
    case create, write, flush, rename, directory
}

/// State of the file as read: its bytes' digest names the version a snapshot or
/// a write was based on; `absent` when no file exists yet.
struct PreferencesDisk: Sendable {
    let path: String
    /// Test seam: runs before each step and may throw (fault injection).
    var fault: (@Sendable (PreferencesWriteStep) throws -> Void)? = nil
    /// Test seam: runs right after the rename (crash injection).
    var afterRename: (@Sendable () -> Void)? = nil

    static let absent = "absent"
    static func digest(_ data: Data?) -> String {
        guard let data else { return absent }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    func read() throws -> Data? {
        let fd = open(path, O_RDONLY | O_CLOEXEC)
        if fd < 0 {
            if errno == ENOENT { return nil }
            throw PreferencesError.unreadable(errno)
        }
        defer { close(fd) }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count == 0 { return data }
            if count < 0 { if errno == EINTR { continue }; throw PreferencesError.unreadable(errno) }
            data.append(contentsOf: buffer[..<count])
        }
    }

    var temporaryPath: String { path + ".tmp" }

    /// Same-directory temp file (0600), written and `F_FULLFSYNC`ed. Nothing visible
    /// has changed yet; a failure removes the temp file.
    func prepare(_ data: Data) throws {
        func fail(_ step: PreferencesWriteStep, _ code: Int32, _ fd: Int32 = -1) -> PreferencesError {
            if fd >= 0 { close(fd) }
            unlink(temporaryPath)
            return .io(step, code)
        }
        do { try fault?(.create) } catch { throw fail(.create, EIO) }
        unlink(temporaryPath)
        let fd = open(temporaryPath, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw fail(.create, errno) }
        do { try fault?(.write) } catch { throw fail(.write, EIO, fd) }
        let bytes = [UInt8](data)
        var offset = 0
        while offset < bytes.count {
            let written = bytes[offset...].withUnsafeBytes { Darwin.write(fd, $0.baseAddress!, $0.count) }
            if written < 0 { if errno == EINTR { continue }; throw fail(.write, errno, fd) }
            offset += written
        }
        do { try fault?(.flush) } catch { throw fail(.flush, EIO, fd) }
        if fcntl(fd, F_FULLFSYNC) != 0 && fsync(fd) != 0 { throw fail(.flush, errno, fd) }
        close(fd)
    }

    /// The commit point. A failed rename changed nothing (the temp file is removed).
    func replace() throws {
        do { try fault?(.rename) } catch { unlink(temporaryPath); throw PreferencesError.io(.rename, EIO) }
        guard rename(temporaryPath, path) == 0 else {
            let code = errno
            unlink(temporaryPath)
            throw PreferencesError.io(.rename, code)
        }
        afterRename?()
    }

    /// Persists the rename itself. The new file is already what readers see.
    func syncDirectory() throws {
        try fault?(.directory)
        let directory = (path as NSString).deletingLastPathComponent
        let fd = open(directory, O_RDONLY | O_CLOEXEC)
        guard fd >= 0 else { throw PreferencesError.io(.directory, errno) }
        defer { close(fd) }
        guard fsync(fd) == 0 else { throw PreferencesError.io(.directory, errno) }
    }
}
