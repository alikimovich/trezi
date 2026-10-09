import Foundation

// This Foundation-only executable never starts the host, service, or providers.
struct Fixture: Decodable {
    let name: String
    let wire: String?
    let wireBase64: String?
    let expectedScope: ServiceJSON?
    let currentRevision: ServiceJSON?
    let allowedMethods: [ServiceMethod]?
    let previous: String?
}
struct FixtureResult: Encodable {
    let name: String
    var value: ServiceJSON? = nil
    var error: String? = nil
    var disposition: String? = nil
}

do {
    guard CommandLine.arguments.count >= 2 else { throw ServiceContractFailure.invalidRequest }
    let schemaData = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
    let schema = try JSONDecoder().decode(ServiceJSON.self, from: schemaData)
    let codec = ServiceContractCodec(schema: schema)
    let input = CommandLine.arguments.count >= 3
        ? try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
        : FileHandle.standardInput.readDataToEndOfFile()
    let fixtures = try JSONDecoder().decode([Fixture].self, from: input)
    let results = fixtures.map { fixture -> FixtureResult in
        do {
            let context = ServiceValidationContext(expectedScope: fixture.expectedScope,
                currentRevision: fixture.currentRevision, allowedMethods: fixture.allowedMethods)
            let wire: Data
            if let encoded = fixture.wireBase64 {
                guard let decoded = Data(base64Encoded: encoded) else { throw ServiceContractFailure.invalidRequest }
                wire = decoded
            } else if let text = fixture.wire { wire = Data(text.utf8) }
            else { throw ServiceContractFailure.invalidRequest }
            let envelope = try codec.decode(wire, context: context)
            let value = try JSONDecoder().decode(ServiceJSON.self, from: codec.encode(envelope))
            var result = FixtureResult(name: fixture.name, value: value)
            if let previous = fixture.previous {
                let previousEnvelope = try codec.decode(Data(previous.utf8))
                guard case .request(let request) = envelope.payload,
                      case .request(let previousRequest) = previousEnvelope.payload else {
                    throw ServiceContractFailure.invalidRequest
                }
                result.disposition = ServiceContractCodec.disposition(request, previous: previousRequest)
            }
            return result
        } catch let error as ServiceContractFailure {
            return FixtureResult(name: fixture.name, error: error.rawValue)
        } catch { return FixtureResult(name: fixture.name, error: "invalidRequest") }
    }
    FileHandle.standardOutput.write(try JSONEncoder().encode(results))
} catch {
    FileHandle.standardError.write(Data("Service contract fixture setup failed: \(error)\n".utf8))
    exit(1)
}
