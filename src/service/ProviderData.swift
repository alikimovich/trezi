import Foundation
import Darwin

/// The provider owner's data (LKM-102), formerly Bun's own writers:
/// - v10 connections, `<profile>/trezi/providers.json` (twin of `main/providers-store.ts`):
///   byte-identical file (`JSON.stringify(body, null, 2)`, mode 0600, tmp + rename), an
///   unparseable file moved to `.corrupt` before the first write, untouched entries
///   rewritten exactly as parsed. A key is encrypted with the app's Keychain helper
///   (`Helpers/TreziSecrets --crypto`, the secret on stdin, never argv) and a key never follows an
///   origin change. A key never appears in a reply other than `connectionSecret`, nor
///   in any error text.
/// - the built-in seats' model catalogs, `<profile>/trezi/model-catalog.json` (twin of
///   `main/model-catalog.ts`'s `set`): compact JSON, an empty list ignored, the other
///   seat's entry kept as it is on disk.
/// - the Codex CLI's `debug models` probe (the only one since LKM-111): the SDK's
///   vendored binary unless `TREZI_CODEX_BIN` names one, bounded to 8 s and 16 MiB.
///   Bun parses the output (`parseCodexModels` in `main/model-catalog.ts`).
struct ProviderData {
    struct Tools {
        /// argv prefix of the Keychain helper (`[TreziHost]`); nil: no credential store.
        var crypto: [String]?
        /// The Trezi checkout (the vendored Codex binary lives in its node_modules).
        var checkout: String?
        var environment: [String: String] = [:]
        var probeTimeout: TimeInterval = 8
    }

    static let maxStore = 512 * 1024, maxCatalog = 256 * 1024, maxProbe = 16 * 1024 * 1024
    static let keychain = "macOS Keychain encryption unavailable; unlock the keychain and retry."
    static let noKeyring = "No OS credential store is available, so Trezi cannot store this API key " +
        "(it will never write a key to disk in plain text). On Linux, install/unlock " +
        "a keyring (gnome-keyring, kwallet) and try again."

    let profile: String
    var tools: Tools
    var now: @Sendable () -> Double

    /// The Keychain helper may wait on a macOS prompt that asks for the login password
    /// (LKM-144). Killing it after 30 s threw that answer away, so the next call asked
    /// again; and parallel calls each showed their own prompt. Calls now run one at a
    /// time, so the first approval serves the rest, with time to answer.
    static let keychainLock = NSLock()
    static let keychainTimeout: TimeInterval = 180

    /// `TreziSecrets --crypto encrypt|decrypt` with `input` on stdin; nil when it failed.
    func crypto(_ operation: String, _ input: Data) -> Data? {
        guard let crypto = tools.crypto, !crypto.isEmpty else { return nil }
        Self.keychainLock.lock(); defer { Self.keychainLock.unlock() }
        guard let result = try? PlatformTool.run(crypto[0], Array(crypto.dropFirst()) + ["--crypto", operation],
                                                 environment: tools.environment, timeout: Self.keychainTimeout, input: input),
              result.ok else { return nil }
        return result.stdout
    }

    var directory: String { profile + "/trezi" }
    var connectionsFile: String { directory + "/providers.json" }
    var catalogFile: String { directory + "/model-catalog.json" }

    // MARK: Connections

    static func safeID(_ id: String) -> Bool {
        !id.isEmpty && id.utf8.count <= 128 && id.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x41...0x5A).contains($0) || (0x61...0x7A).contains($0) || $0 == 0x5F || $0 == 0x2D }
    }

    /// `isStored`: every field `toPublic` passes through is checked.
    static func stored(_ entry: JSValue) -> Bool {
        guard let id = entry["id"]?.text, safeID(id.string), JSText(id.string) == id,
              entry["baseUrl"]?.text != nil, entry["label"]?.text != nil,
              case .array(let models)? = entry["models"] else { return false }
        return models.allSatisfy { $0.text != nil }
    }

    func loadConnections() -> (connections: [JSValue], corrupt: Bool) {
        guard let data = FileManager.default.contents(atPath: connectionsFile) else { return ([], false) }
        if data.count > Self.maxStore, String(decoding: data, as: UTF8.self).utf16.count > Self.maxStore { return ([], true) }
        guard let parsed = try? JSValue.parse(data), case .array(let entries)? = parsed["connections"] else { return ([], true) }
        return (entries.filter(Self.stored), false)
    }

    static func publicShape(_ c: JSValue) -> JSValue {
        .object([(JSText("id"), c["id"] ?? .null), (JSText("label"), c["label"] ?? .null), (JSText("preset"), c["preset"] ?? .null),
                 (JSText("baseUrl"), c["baseUrl"] ?? .null), (JSText("wireApi"), .string(JSText("responses"))),
                 (JSText("models"), c["models"] ?? .null), (JSText("hasKey"), .bool(truthy(c["secret"])))])
    }

    /// Create (no id) or update. Throws a user-readable `ProviderRefusal`.
    func saveConnection(_ input: JSValue) throws -> JSValue {
        guard case .object = input else { throw ServiceContractFailure.invalidRequest }
        let rawID = try Self.optionalText(input["id"]).map(Self.trim)
        let id = rawID.flatMap { $0.isEmpty ? nil : $0.string } ?? UUID().uuidString.lowercased()
        guard Self.safeID(id) else { throw ProviderRefusal(.invalidRequest, "unsafe connection id: \(id)") }
        let label = Self.trim(try Self.optionalText(input["label"]) ?? [])
        guard !label.isEmpty else { throw ProviderRefusal(.invalidRequest, "Give this connection a name.") }
        var baseUrl = Self.trim(try Self.optionalText(input["baseUrl"]) ?? [])
        while baseUrl.last == 0x2F { baseUrl.removeLast() }
        guard !baseUrl.isEmpty else { throw ProviderRefusal(.invalidRequest, "Enter the endpoint URL.") }

        let (connections, corrupt) = loadConnections()
        let previous = connections.first { $0["id"]?.text == JSText(id) }
        let plain = input["apiKey"]?.text.map(Self.trim) ?? []
        var secret: JSValue? = previous.flatMap { p in
            Self.sameOrigin(p["baseUrl"]?.text?.string ?? "", baseUrl.string) ? p["secret"] : nil
        }
        if !plain.isEmpty {
            guard let crypto = tools.crypto, !crypto.isEmpty else { throw ProviderRefusal(.unavailable, Self.noKeyring) }
            guard let sealed = self.crypto("encrypt", Data(plain.string.utf8)) else { throw ProviderRefusal(.unavailable, Self.keychain) }
            secret = .string(JSText(sealed.base64EncodedString()))
        }
        var fields: [(JSText, JSValue)] = [(JSText("id"), .string(JSText(id))), (JSText("label"), .string(label)),
            (JSText("preset"), .string(JSText(input["preset"]?.text == JSText("custom") ? "custom" : "gateway"))),
            (JSText("baseUrl"), .string(baseUrl)), (JSText("wireApi"), .string(JSText("responses"))),
            (JSText("models"), .array(Self.uniqueStrings(input["models"]).map { .string($0) }))]
        if let secret, Self.truthy(secret) { fields.append((JSText("secret"), secret)) }
        let next = JSValue.object(fields)
        let merged = previous == nil ? connections + [next] : connections.map { $0["id"]?.text == JSText(id) ? next : $0 }
        try writeConnections(merged, corrupt: corrupt)
        return Self.publicShape(next)
    }

    /// Unknown ids (and unsafe ones) change nothing: in particular, never the write that
    /// finally replaces an unparseable file.
    func removeConnection(_ id: String) throws {
        guard Self.safeID(id) else { return }
        let (connections, corrupt) = loadConnections()
        guard connections.contains(where: { $0["id"]?.text == JSText(id) }) else { return }
        try writeConnections(connections.filter { $0["id"]?.text != JSText(id) }, corrupt: corrupt)
    }

    /// The plaintext key, or nil (none, or it cannot be decrypted here).
    func secret(_ id: String) -> String? {
        guard Self.safeID(id), let found = loadConnections().connections.first(where: { $0["id"]?.text == JSText(id) }),
              Self.truthy(found["secret"]), let blob = found["secret"]?.text,
              let plain = crypto("decrypt", Self.base64(blob.string)) else { return nil }
        return String(decoding: plain, as: UTF8.self)
    }

    private func writeConnections(_ connections: [JSValue], corrupt: Bool) throws {
        try prepareDirectory()
        // A file that could not be parsed may still hold a key the user can recover by hand.
        if corrupt { _ = rename(connectionsFile, connectionsFile + ".corrupt") }
        let body = JSValue.object([(JSText("version"), .number(1)), (JSText("connections"), .array(connections))])
        try Self.replace(connectionsFile, Data(JSValue.pretty(body).utf8), mode: 0o600)
    }

    // MARK: Model catalogs

    static func catalogEntry(_ entry: JSValue?) -> Bool {
        guard case .number(let at)? = entry?["at"], at.isFinite, case .array(let models)? = entry?["models"], !models.isEmpty else { return false }
        return models.allSatisfy { $0["id"]?.text != nil && $0["label"]?.text != nil }
    }

    /// Records a discovered list (an empty one is ignored); a write failure costs only persistence.
    func saveCatalog(backend: String, models: [(id: JSText, label: JSText)], harness: String? = nil) -> Bool {
        guard !models.isEmpty else { return false }
        var entries: [(JSText, JSValue)] = []
        if let data = FileManager.default.contents(atPath: catalogFile),
           data.count <= Self.maxCatalog || String(decoding: data, as: UTF8.self).utf16.count <= Self.maxCatalog,
           let parsed = try? JSValue.parse(data), case .object(let fields)? = parsed["entries"] {
            // In the file's order, as Bun's writer keeps its loaded map: a JSON key
            // repeated keeps its first place and its last value.
            for (name, value) in fields where name == JSText("claude") || name == JSText("codex") {
                if let index = entries.firstIndex(where: { $0.0 == name }) { entries[index].1 = value } else { entries.append((name, value)) }
            }
            entries.removeAll { !Self.catalogEntry($0.1) }
        }
        var fields: [(JSText, JSValue)] = [(JSText("at"), .number(now())), (JSText("models"), .array(models.map {
            .object([(JSText("id"), .string($0.id)), (JSText("label"), .string($0.label))]) }))]
        // The bundled SDK/CLI versions the list came from (LKM-164); absent from older callers.
        if let harness { fields.append((JSText("harness"), .string(JSText(harness)))) }
        let entry = JSValue.object(fields)
        if let index = entries.firstIndex(where: { $0.0 == JSText(backend) }) { entries[index].1 = entry } else { entries.append((JSText(backend), entry)) }
        let body = JSValue.object([(JSText("version"), .number(1)), (JSText("entries"), .object(entries))])
        do { try prepareDirectory(); try Self.replace(catalogFile, body.utf8(), mode: 0o666); return true } catch { return false }
    }

    // MARK: Codex probe

    /// The binary the Codex SDK spawns for turns (never a different CLI on PATH, unless none is vendored).
    func codexBinary() -> String {
        if let override = tools.environment["TREZI_CODEX_BIN"] ?? tools.environment["PRAXIS_CODEX_BIN"], !override.isEmpty { return override }
        #if arch(arm64)
        let (package, triple) = ("@openai/codex-darwin-arm64", "aarch64-apple-darwin")
        #else
        let (package, triple) = ("@openai/codex-darwin-x64", "x86_64-apple-darwin")
        #endif
        if let checkout = tools.checkout {
            for base in ["\(checkout)/node_modules/@openai/codex/node_modules/\(package)", "\(checkout)/node_modules/\(package)"] {
                for shape in ["bin", "codex"] where access("\(base)/vendor/\(triple)/\(shape)/codex", X_OK) == 0 {
                    return "\(base)/vendor/\(triple)/\(shape)/codex"
                }
            }
        }
        return "codex"
    }

    /// `codex debug models`'s stdout, or nil on any failure (Bun keeps its cached list).
    func codexModels() -> String? {
        guard let result = try? PlatformTool.run(codexBinary(), ["debug", "models"], environment: tools.environment, timeout: tools.probeTimeout),
              result.ok, result.stdout.count <= Self.maxProbe else { return nil }
        return result.output
    }

    // MARK: Shared

    /// `<profile>/trezi`, created for a first write, but never beside an older session
    /// store the service has not aliased yet (that would split the store in two).
    func prepareDirectory() throws {
        var status = stat()
        if lstat(directory, &status) != 0 {
            guard errno == ENOENT else { throw ProviderRefusal(.ioFailure, "Trezi's session store is unreadable.") }
            for legacy in ["praxis", "dsgn"] where lstat(profile + "/" + legacy, &status) == 0 {
                throw ProviderRefusal(PreferencesOwner.fail(.unavailable, "Trezi's session store is not ready yet.", retryable: true))
            }
        }
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
    }

    /// `writeFileSync(tmp, …, {mode})` then `renameSync(tmp, file)`.
    static func replace(_ path: String, _ data: Data, mode: mode_t) throws {
        let tmp = path + ".tmp"
        let fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, mode)
        guard fd >= 0 else { throw ProviderRefusal(.ioFailure, "Could not write \(path): \(String(cString: strerror(errno)))") }
        var offset = 0
        let failed: Int32? = data.withUnsafeBytes { raw in
            while offset < raw.count {
                let wrote = write(fd, raw.baseAddress! + offset, raw.count - offset)
                if wrote < 0 { if errno == EINTR { continue }; return errno }
                offset += wrote
            }
            return nil
        }
        close(fd)
        if let failed { throw ProviderRefusal(.ioFailure, "Could not write \(path): \(String(cString: strerror(failed)))") }
        guard rename(tmp, path) == 0 else { throw ProviderRefusal(.ioFailure, "Could not write \(path): \(String(cString: strerror(errno)))") }
    }

    static func optionalText(_ value: JSValue?) throws -> JSText? {
        switch value {
        case nil, .null?: return nil
        case .string(let text)?: return text
        default: throw ServiceContractFailure.invalidRequest
        }
    }

    /// `String.prototype.trim` (ECMAScript WhiteSpace and LineTerminator).
    static func trim(_ text: JSText) -> JSText {
        let space: Set<UInt16> = [0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF]
        let blank: (UInt16) -> Bool = { space.contains($0) || (0x2000...0x200A).contains($0) }
        guard let first = text.firstIndex(where: { !blank($0) }), let last = text.lastIndex(where: { !blank($0) }) else { return [] }
        return Array(text[first...last])
    }

    static func uniqueStrings(_ value: JSValue?) -> [JSText] {
        guard case .array(let values)? = value else { return [] }
        var out: [JSText] = []
        for case .string(let raw) in values {
            let text = trim(raw)
            if !text.isEmpty && !out.contains(text) { out.append(text) }
        }
        return out
    }

    /// JavaScript truthiness (`!!c.secret`).
    static func truthy(_ value: JSValue?) -> Bool {
        switch value {
        case nil, .null?: return false
        case .bool(let flag)?: return flag
        case .number(let number)?: return number != 0 && !number.isNaN
        case .string(let text)?: return !text.isEmpty
        default: return true
        }
    }

    /// `Buffer.from(blob, 'base64')`: URL-safe letters accepted, other bytes skipped,
    /// decoding stops at padding.
    static func base64(_ blob: String) -> Data {
        var letters = ""
        for char in blob.unicodeScalars {
            if char == "=" { break }
            switch char {
            case "A"..."Z", "a"..."z", "0"..."9", "+", "/": letters.unicodeScalars.append(char)
            case "-": letters += "+"
            case "_": letters += "/"
            default: continue
            }
        }
        if letters.count % 4 == 1 { letters.removeLast() }
        letters += String(repeating: "=", count: (4 - letters.count % 4) % 4)
        return Data(base64Encoded: letters) ?? Data()
    }

    /// `new URL(a).origin === new URL(b).origin`, conservatively: only a plain
    /// `http(s)://host[:port]` pair can match, so any URL this does not fully understand
    /// reads as a different origin (the key is asked for again, never sent elsewhere).
    static func sameOrigin(_ a: String, _ b: String) -> Bool {
        guard let left = origin(a), let right = origin(b) else { return false }
        return left == right
    }

    static func origin(_ url: String) -> String? {
        guard url.unicodeScalars.allSatisfy({ $0.value > 0x20 && $0.value < 0x7F && $0 != "\\" }) else { return nil }
        let lower = url.lowercased()
        let scheme: String, defaultPort: Int
        if lower.hasPrefix("https://") { (scheme, defaultPort) = ("https", 443) }
        else if lower.hasPrefix("http://") { (scheme, defaultPort) = ("http", 80) }
        else { return nil }
        let rest = lower.dropFirst(scheme.count + 3)
        var authority = String(rest.prefix { $0 != "/" && $0 != "?" && $0 != "#" })
        if let at = authority.lastIndex(of: "@") { authority = String(authority[authority.index(after: at)...]) }
        var host = authority, port = defaultPort
        if let colon = authority.lastIndex(of: ":") {
            host = String(authority[..<colon])
            let digits = authority[authority.index(after: colon)...]
            if !digits.isEmpty {
                guard digits.utf8.allSatisfy({ (0x30...0x39).contains($0) }), let value = Int(digits), value <= 65535 else { return nil }
                port = value
            }
        }
        // ASCII labels only (no IPv6, IDN or percent-encoding); a trailing dot is kept, as WHATWG does.
        let digit: (Character) -> Bool = { ("0"..."9").contains($0) }
        guard !host.isEmpty, host.allSatisfy({ ("a"..."z").contains($0) || digit($0) || $0 == "." || $0 == "-" }) else { return nil }
        var labels = host.split(separator: ".", omittingEmptySubsequences: false)
        if labels.count > 1 && labels.last == "" { labels.removeLast() }
        guard !labels.contains(where: \.isEmpty), let last = labels.last, !last.hasPrefix("0x") else { return nil }
        // A host WHATWG reads as IPv4 (`127.1`, `0177.0.0.1`) must already be canonical, never guessed.
        if last.allSatisfy(digit) {
            guard labels.count == 4, !host.hasSuffix("."),
                  labels.allSatisfy({ $0.count <= 3 && ($0 == "0" || !$0.hasPrefix("0")) && Int($0).map { $0 <= 255 } == true }) else { return nil }
        }
        return "\(scheme)://\(host):\(port)"
    }
}
