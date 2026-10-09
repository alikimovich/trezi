import Foundation

/// JSON values retain explicit nulls separately from missing dictionary keys.
indirect enum ServiceJSON: Codable, Equatable, Sendable {
    case null, bool(Bool), number(Double), string(String)
    case array([ServiceJSON]), object([String: ServiceJSON])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode([ServiceJSON].self) { self = .array(value) }
        else { self = .object(try container.decode([String: ServiceJSON].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    static func == (lhs: ServiceJSON, rhs: ServiceJSON) -> Bool {
        switch (lhs, rhs) {
        case (.null, .null): return true
        case (.bool(let lhs), .bool(let rhs)): return lhs == rhs
        case (.number(let lhs), .number(let rhs)): return lhs == rhs
        case (.string(let lhs), .string(let rhs)): return lhs.utf8.elementsEqual(rhs.utf8)
        case (.array(let lhs), .array(let rhs)): return lhs == rhs
        case (.object(let lhs), .object(let rhs)):
            guard lhs.count == rhs.count else { return false }
            return lhs.allSatisfy { key, value in
                guard let match = rhs.first(where: { $0.key.utf8.elementsEqual(key.utf8) }) else { return false }
                return value == match.value
            }
        default: return false
        }
    }

    subscript(_ key: String) -> ServiceJSON? { object?[key] }
    var object: [String: ServiceJSON]? { if case .object(let value) = self { return value }; return nil }
    var array: [ServiceJSON]? { if case .array(let value) = self { return value }; return nil }
    var string: String? { if case .string(let value) = self { return value }; return nil }
    var number: Double? { if case .number(let value) = self { return value }; return nil }
}

enum ServiceContractFailure: String, Error, Codable {
    case invalidRequest, unsupportedVersion, unsupportedCapability, unauthorized
    case notFound, conflict, busy, cancelled, deadlineExceeded, unavailable
    case ioFailure, providerFailure, recoveryRequired, idempotencyMismatch
}

/// Independently implements the contract's small schema vocabulary. The schema
/// is trusted application data, never selected by a request or remote client.
struct ServiceSchemaValidator {
    let schema: ServiceJSON

    func validate(_ value: ServiceJSON, against rule: ServiceJSON? = nil) throws {
        guard let rule = rule ?? Optional(schema), let object = rule.object else {
            throw ServiceContractFailure.invalidRequest
        }
        if let reference = object["$ref"]?.string {
            guard reference.hasPrefix("#/$defs/"),
                  let definition = schema["$defs"]?[String(reference.dropFirst(8))] else {
                throw ServiceContractFailure.invalidRequest
            }
            try validate(value, against: definition)
            return
        }
        if let alternatives = object["oneOf"]?.array {
            let matches = alternatives.filter { (try? validate(value, against: $0)) != nil }.count
            guard matches == 1 else { throw ServiceContractFailure.invalidRequest }
        }
        if let constant = object["const"], value != constant { throw ServiceContractFailure.invalidRequest }
        if let choices = object["enum"]?.array, !choices.contains(value) { throw ServiceContractFailure.invalidRequest }
        if let type = object["type"]?.string {
            let matches: Bool
            switch (type, value) {
            case ("object", .object), ("array", .array), ("string", .string),
                 ("number", .number), ("boolean", .bool), ("null", .null): matches = true
            case ("integer", .number(let number)): matches = number.rounded() == number
            default: matches = false
            }
            guard matches else { throw ServiceContractFailure.invalidRequest }
        }
        if let fields = value.object {
            for required in object["required"]?.array ?? [] {
                guard let key = required.string, fields[key] != nil else { throw ServiceContractFailure.invalidRequest }
            }
            let properties = object["properties"]?.object ?? [:]
            for (key, field) in fields {
                if let property = properties[key] { try validate(field, against: property) }
                else if object["additionalProperties"] == .bool(false) { throw ServiceContractFailure.invalidRequest }
                else if let additional = object["additionalProperties"], additional.object != nil {
                    try validate(field, against: additional)
                }
            }
        }
        if let items = value.array {
            if let minimum = object["minItems"]?.number, Double(items.count) < minimum { throw ServiceContractFailure.invalidRequest }
            if let maximum = object["maxItems"]?.number, Double(items.count) > maximum { throw ServiceContractFailure.invalidRequest }
            if object["uniqueItems"] == .bool(true) {
                for index in items.indices where items[..<index].contains(items[index]) { throw ServiceContractFailure.invalidRequest }
            }
            if let item = object["items"] { for value in items { try validate(value, against: item) } }
        }
        if let string = value.string {
            let length = Double(string.unicodeScalars.count)
            if let minimum = object["minLength"]?.number, length < minimum { throw ServiceContractFailure.invalidRequest }
            if let maximum = object["maxLength"]?.number, length > maximum { throw ServiceContractFailure.invalidRequest }
            if let pattern = object["pattern"]?.string {
                guard let match = string.range(of: pattern, options: .regularExpression),
                      match == string.startIndex..<string.endIndex else { throw ServiceContractFailure.invalidRequest }
            }
        }
        if let number = value.number {
            if let minimum = object["minimum"]?.number, number < minimum { throw ServiceContractFailure.invalidRequest }
            if let maximum = object["maximum"]?.number, number > maximum { throw ServiceContractFailure.invalidRequest }
        }
    }
}

struct ServiceVersion: Codable, Equatable, Sendable { let major: UInt16; let minor: UInt16 }
struct ServiceScope: Codable, Equatable, Sendable {
    let project: String?; let chat: String?; let turn: String?
    let checkout: String?; let document: String?
}
struct ServiceRevision: Codable, Equatable, Sendable { let epoch: String; let counter: String }
struct ServiceCursor: Codable, Equatable, Sendable { let serviceEpoch: String; let sequence: String }
struct ServiceCapability: Codable, Equatable, Sendable { let name: String; let version: UInt16 }
struct ServiceLimits: Codable, Equatable, Sendable { let maxBytes: Int; let maxDepth: Int; let maxCollection: Int }
struct ServiceFailure: Codable, Sendable {
    let code: ServiceContractFailure; let message: String; let retryable: Bool
    let operationID: String?; let currentRevision: ServiceRevision?; let recoveryID: String?
}
struct ServiceRequest: Codable, Sendable {
    enum Mode: String, Codable, Sendable { case read, mutation }
    let connection: String; let requestID: String; let operationID: String
    let scope: ServiceScope; let mode: Mode; let expectedRevision: ServiceRevision?
    let timeoutMilliseconds: UInt32?; let service: String; let method: String
    let body: [String: ServiceJSON]
}
enum ServiceResult: Codable, Sendable {
    case succeeded(ServiceJSON), failed(ServiceFailure)
    private enum Keys: String, CodingKey { case kind, payload }
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "succeeded": self = .succeeded(try container.decode(ServiceJSON.self, forKey: .payload))
        case "failed": self = .failed(try container.decode(ServiceFailure.self, forKey: .payload))
        default: throw ServiceContractFailure.invalidRequest
        }
    }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        switch self {
        case .succeeded(let value):
            try container.encode("succeeded", forKey: .kind); try container.encode(value, forKey: .payload)
        case .failed(let value):
            try container.encode("failed", forKey: .kind); try container.encode(value, forKey: .payload)
        }
    }
}
struct ServiceReply: Codable, Sendable {
    let connection: String; let requestID: String; let operationID: String
    let scope: ServiceScope; let result: ServiceResult
}
struct ServiceEvent: Codable, Sendable {
    let serviceEpoch: String; let sequence: String; let operationID: String?
    let scope: ServiceScope; let revision: ServiceRevision?; let name: String
    let value: [String: ServiceJSON]
}
struct ServiceHello: Codable, Sendable {
    enum Role: String, Codable, Sendable { case ui, legacy, provider, parser }
    let connection: String; let role: Role; let versions: [ServiceVersion]
    let schemaHash: String; let capabilities: [ServiceCapability]
}
struct ServiceHelloAck: Codable, Sendable {
    let connection: String; let version: ServiceVersion; let serviceEpoch: String
    let capabilities: [ServiceCapability]; let limits: ServiceLimits; let cursor: ServiceCursor
}
struct ServiceCancel: Codable, Sendable {
    let connection: String; let requestID: String; let operationID: String
    let scope: ServiceScope; let target: String
}
struct ServiceSnapshot: Codable, Sendable {
    let scope: ServiceScope; let revision: ServiceRevision; let cursor: ServiceCursor
    let value: [String: ServiceJSON]
}

/// Explicit discriminator codec; never Swift's synthesized enum representation.
struct ServiceEnvelope: Codable, Sendable {
    enum Payload: Sendable {
        case request(ServiceRequest), reply(ServiceReply), event(ServiceEvent)
        case hello(ServiceHello), helloAck(ServiceHelloAck), cancel(ServiceCancel), snapshot(ServiceSnapshot)
    }
    let version: ServiceVersion
    let payload: Payload
    private enum Keys: String, CodingKey { case version, kind, payload }
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        version = try container.decode(ServiceVersion.self, forKey: .version)
        switch try container.decode(String.self, forKey: .kind) {
        case "request": payload = .request(try container.decode(ServiceRequest.self, forKey: .payload))
        case "reply": payload = .reply(try container.decode(ServiceReply.self, forKey: .payload))
        case "event": payload = .event(try container.decode(ServiceEvent.self, forKey: .payload))
        case "hello": payload = .hello(try container.decode(ServiceHello.self, forKey: .payload))
        case "helloAck": payload = .helloAck(try container.decode(ServiceHelloAck.self, forKey: .payload))
        case "cancel": payload = .cancel(try container.decode(ServiceCancel.self, forKey: .payload))
        case "snapshot": payload = .snapshot(try container.decode(ServiceSnapshot.self, forKey: .payload))
        default: throw ServiceContractFailure.invalidRequest
        }
    }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        try container.encode(version, forKey: .version)
        switch payload {
        case .request(let value):
            try container.encode("request", forKey: .kind); try container.encode(value, forKey: .payload)
        case .reply(let value):
            try container.encode("reply", forKey: .kind); try container.encode(value, forKey: .payload)
        case .event(let value):
            try container.encode("event", forKey: .kind); try container.encode(value, forKey: .payload)
        case .hello(let value):
            try container.encode("hello", forKey: .kind); try container.encode(value, forKey: .payload)
        case .helloAck(let value):
            try container.encode("helloAck", forKey: .kind); try container.encode(value, forKey: .payload)
        case .cancel(let value):
            try container.encode("cancel", forKey: .kind); try container.encode(value, forKey: .payload)
        case .snapshot(let value):
            try container.encode("snapshot", forKey: .kind); try container.encode(value, forKey: .payload)
        }
    }
}

/// Separate fields: both identifiers may contain dots.
struct ServiceMethod: Codable {
    let service: String
    let method: String
}

struct ServiceValidationContext {
    var expectedScope: ServiceJSON? = nil
    var currentRevision: ServiceJSON? = nil
    var allowedMethods: [ServiceMethod]? = nil
}

struct ServiceContractCodec {
    static let maxBytes = 65_536
    static let maxDepth = 24
    static let maxCollection = 256
    let schema: ServiceJSON

    func decode(_ data: Data, context: ServiceValidationContext = .init()) throws -> ServiceEnvelope {
        do {
            guard data.count <= Self.maxBytes, String(data: data, encoding: .utf8) != nil else {
                throw ServiceContractFailure.invalidRequest
            }
            // Bound nesting before Foundation allocates a decoded object graph.
            let bytes = Array(data)
            var keySets: [Set<String>?] = []
            var quoted = false; var escaped = false; var stringStart = 0
            for (index, byte) in bytes.enumerated() {
                if quoted {
                    if escaped { escaped = false }
                    else if byte == 92 { escaped = true }
                    else if byte == 34 {
                        quoted = false
                        var next = index + 1
                        while next < bytes.count, [9, 10, 13, 32].contains(bytes[next]) { next += 1 }
                        if next < bytes.count, bytes[next] == 58, !keySets.isEmpty,
                           var keys = keySets[keySets.count - 1] {
                            let key = try JSONDecoder().decode(String.self, from: Data(bytes[stringStart...index]))
                            // Swift String keys use canonical Unicode equivalence. Reject
                            // collisions in both codecs rather than silently dropping a key.
                            guard keys.insert(key).inserted else { throw ServiceContractFailure.invalidRequest }
                            keySets[keySets.count - 1] = keys
                        }
                    }
                } else if byte == 34 { quoted = true; stringStart = index }
                else if byte == 123 || byte == 91 {
                    keySets.append(byte == 123 ? Set<String>() : nil)
                    guard keySets.count <= Self.maxDepth else { throw ServiceContractFailure.invalidRequest }
                } else if byte == 125 || byte == 93 {
                    // Foundation accepts trailing commas; the wire uses strict JSON.
                    var previous = index - 1
                    while previous >= 0, [9, 10, 13, 32].contains(bytes[previous]) { previous -= 1 }
                    guard previous < 0 || bytes[previous] != 44 else { throw ServiceContractFailure.invalidRequest }
                    guard !keySets.isEmpty else { throw ServiceContractFailure.invalidRequest }
                    keySets.removeLast()
                }
            }
            let value = try JSONDecoder().decode(ServiceJSON.self, from: data)
            try bounded(value, depth: 0)
            guard value.object != nil else { throw ServiceContractFailure.invalidRequest }
            try checkVersion(value["version"])
            let payload = value["payload"]
            if value["kind"]?.string == "hello" {
                for version in payload?["versions"]?.array ?? [] { try checkVersion(version) }
            }
            if value["kind"]?.string == "helloAck" { try checkVersion(payload?["version"]) }
            try ServiceSchemaValidator(schema: schema).validate(value)
            try semantics(value, context: context)
            return try JSONDecoder().decode(ServiceEnvelope.self, from: data)
        } catch let error as ServiceContractFailure { throw error }
        catch { throw ServiceContractFailure.invalidRequest }
    }

    func encode(_ envelope: ServiceEnvelope) throws -> Data {
        let encoder = JSONEncoder()
        // Match JSON.stringify's slash encoding so valid frames stay within the
        // same byte limit when re-encoded by either language.
        encoder.outputFormatting = [.withoutEscapingSlashes]
        let data = try encoder.encode(envelope)
        _ = try decode(data)
        return data
    }

    private func checkVersion(_ version: ServiceJSON?) throws {
        guard let version, let definition = schema["$defs"]?["version"],
              (try? ServiceSchemaValidator(schema: schema).validate(version, against: definition)) != nil else {
            throw ServiceContractFailure.unsupportedVersion
        }
    }

    private func bounded(_ value: ServiceJSON, depth: Int) throws {
        guard depth <= Self.maxDepth else { throw ServiceContractFailure.invalidRequest }
        switch value {
        case .number(let number):
            guard number.isFinite, abs(number) <= 9_007_199_254_740_991 else { throw ServiceContractFailure.invalidRequest }
        case .object(let object):
            guard object.count <= Self.maxCollection else { throw ServiceContractFailure.invalidRequest }
            for value in object.values { try bounded(value, depth: depth + 1) }
        case .array(let array):
            guard array.count <= Self.maxCollection else { throw ServiceContractFailure.invalidRequest }
            for value in array { try bounded(value, depth: depth + 1) }
        default: break
        }
    }

    private func semantics(_ value: ServiceJSON, context: ServiceValidationContext) throws {
        guard let payload = value["payload"] else { throw ServiceContractFailure.invalidRequest }
        let kind = value["kind"]?.string
        if let scope = payload["scope"] {
            for key in ["chat", "checkout", "document"] where scope[key] != nil {
                guard scope["project"] != nil else { throw ServiceContractFailure.invalidRequest }
            }
            if scope["turn"] != nil, scope["chat"] == nil { throw ServiceContractFailure.invalidRequest }
            if let expected = context.expectedScope, scope != expected { throw ServiceContractFailure.unauthorized }
        }
        if kind == "request" {
            if payload["mode"]?.string == "mutation" {
                guard let expected = payload["expectedRevision"] else { throw ServiceContractFailure.invalidRequest }
                if let current = context.currentRevision, expected != current { throw ServiceContractFailure.conflict }
            }
            if let allowed = context.allowedMethods,
               !allowed.contains(where: {
                   $0.service == payload["service"]?.string && $0.method == payload["method"]?.string
               }) {
                throw ServiceContractFailure.unsupportedCapability
            }
        }
        if kind == "hello" || kind == "helloAck" {
            let names = (payload["capabilities"]?.array ?? []).compactMap { $0["name"]?.string }
            guard Set(names).count == names.count else { throw ServiceContractFailure.invalidRequest }
        }
        if kind == "helloAck", payload["cursor"]?["serviceEpoch"] != payload["serviceEpoch"] {
            throw ServiceContractFailure.invalidRequest
        }
        // Only contract counters are checked here; domain bodies may have any JSON key.
        let failureRevision = kind == "reply" && payload["result"]?["kind"]?.string == "failed"
            ? payload["result"]?["payload"]?["currentRevision"] : nil
        for revision in [payload["revision"], payload["expectedRevision"], failureRevision] {
            if let counter = revision?["counter"]?.string, UInt64(counter) == nil { throw ServiceContractFailure.invalidRequest }
        }
        for sequence in [payload["sequence"], payload["cursor"]?["sequence"]] {
            if let counter = sequence?.string, UInt64(counter) == nil { throw ServiceContractFailure.invalidRequest }
        }
    }

    /// Pure comparison only. Durable receipt storage is a later service owner.
    static func disposition(_ request: ServiceRequest, previous: ServiceRequest) -> String {
        guard request.operationID == previous.operationID else { return "fresh" }
        let same = request.mode == previous.mode && request.service == previous.service &&
            request.method == previous.method && request.scope == previous.scope &&
            request.expectedRevision == previous.expectedRevision && ServiceJSON.object(request.body) == .object(previous.body)
        return same ? "duplicate" : "idempotencyMismatch"
    }
}
