import Foundation
import Security

// XPC only exposes this bounded transport, never filesystem/provider selectors.
@objc protocol TreziServiceRemote {
    func exchange(_ data: Data, withReply reply: @escaping (Data) -> Void)
    /// Diagnostics only, before the first hello: the host's stderr becomes Bun's
    /// stderr, as on the legacy pipe. An XPC service's own stderr is discarded.
    func attachDiagnostics(_ output: FileHandle, withReply reply: @escaping (Bool) -> Void)
}
@objc protocol TreziServiceEvents {
    func receive(_ data: Data)
}

struct ServiceLaunch: Codable, Equatable {
    let bun: String
    let backend: String
    let profile: String
    let arguments: [String]
    let environment: [String: String]
}

struct ServiceControl: Codable {
    enum Kind: String, Codable { case hello, legacy, wait, cancel, shutdown }
    var version = ServiceVersion(major: 1, minor: 0)
    var connection: String
    var requestID = UUID().uuidString
    var kind: Kind
    var hello: ServiceHello? = nil
    var launch: ServiceLaunch? = nil
    var payload: Data? = nil
    var target: String? = nil
    /// Reattach only: the epoch the client negotiated before losing the connection.
    var resume: String? = nil
}

struct ServiceControlReply: Codable {
    let requestID: String
    var failure: ServiceContractFailure? = nil
    var hello: ServiceHelloAck? = nil
    var payload: Data? = nil
}

enum ServiceXPC {
    static let name = "dev.trezi.service"
    static let schema = "trezi-supervision-1"
    static let version = ServiceVersion(major: 1, minor: 0)
    static let capabilities = [ServiceCapability(name: "legacy.ui", version: 1),
                               ServiceCapability(name: "supervision", version: 1)]
    // Existing screenshot/media replies can exceed the S01 domain DTO limit.
    // This separately bounded legacy bridge is not a migrated domain API.
    static let maxLegacyBytes = 32 * 1024 * 1024
    static let maxControlBytes = 64 * 1024

    static func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.withoutEscapingSlashes]
        return try encoder.encode(value)
    }
    static func decode(_ data: Data) throws -> ServiceControl {
        guard data.count <= maxLegacyBytes * 2 else { throw ServiceContractFailure.invalidRequest }
        let value = try JSONDecoder().decode(ServiceControl.self, from: data)
        guard let fields = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ServiceContractFailure.invalidRequest
        }
        let common: Set<String> = ["version", "connection", "requestID", "kind"]
        let specific: Set<String>
        switch value.kind {
        case .hello: specific = ["hello", "launch", "resume"]
        case .legacy: specific = ["payload"]
        case .cancel: specific = ["target"]
        case .wait, .shutdown: specific = []
        }
        guard Set(fields.keys).isSubset(of: common.union(specific)) else { throw ServiceContractFailure.invalidRequest }
        guard value.version == version else { throw ServiceContractFailure.unsupportedVersion }
        guard UUID(uuidString: value.connection) != nil, UUID(uuidString: value.requestID) != nil,
              (value.payload?.count ?? 0) <= maxLegacyBytes else { throw ServiceContractFailure.invalidRequest }
        if value.kind != .legacy && data.count > maxControlBytes { throw ServiceContractFailure.invalidRequest }
        return value
    }
    static func validateHello(_ hello: ServiceHello, connection: String) throws {
        guard hello.connection == connection, hello.role == .ui else { throw ServiceContractFailure.unauthorized }
        guard hello.versions == [version], hello.schemaHash == schema else { throw ServiceContractFailure.unsupportedVersion }
        guard hello.capabilities == capabilities else { throw ServiceContractFailure.unsupportedCapability }
    }
    static func signingRequirement(executable: String) throws -> String {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: executable) as CFURL, [], &code) == errSecSuccess,
              let code else { throw ServiceContractFailure.unauthorized }
        var requirement: SecRequirement?
        guard SecCodeCopyDesignatedRequirement(code, [], &requirement) == errSecSuccess,
              let requirement else { throw ServiceContractFailure.unauthorized }
        var text: CFString?
        guard SecRequirementCopyString(requirement, [], &text) == errSecSuccess, let text else {
            throw ServiceContractFailure.unauthorized
        }
        return text as String
    }
}
