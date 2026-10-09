import Foundation
import Darwin

final class FixtureEvents: NSObject, TreziServiceEvents {
    func receive(_ data: Data) {
        print("EVENT \(data.base64EncodedString())")
        fflush(stdout)
    }
}

@main struct XPCFixture {
    static var client: ServiceClient?
    static var retained: NSXPCConnection?
    static let events = FixtureEvents()
    static func connect() -> NSXPCConnection {
        let connection = NSXPCConnection(serviceName: ServiceXPC.name)
        connection.remoteObjectInterface = NSXPCInterface(with: TreziServiceRemote.self)
        connection.exportedInterface = NSXPCInterface(with: TreziServiceEvents.self)
        connection.exportedObject = events
        connection.invalidationHandler = { print("INVALIDATED"); fflush(stdout) }
        connection.interruptionHandler = { print("INTERRUPTED"); fflush(stdout) }
        connection.resume()
        retained = connection
        return connection
    }
    static func codecChecks() throws {
        func reject(_ failure: ServiceContractFailure, _ body: () throws -> Void) {
            do { try body(); fatalError("expected rejection \(failure)") }
            catch { precondition(error as? ServiceContractFailure == failure, "wrong rejection: \(error)") }
        }
        let identity = UUID().uuidString
        var request = ServiceControl(connection: identity, kind: .wait)
        let roundtrip = try ServiceXPC.decode(ServiceXPC.encode(request))
        precondition(roundtrip.connection == identity)
        request.version = ServiceVersion(major: 2, minor: 0)
        reject(.unsupportedVersion) { _ = try ServiceXPC.decode(ServiceXPC.encode(request)) }
        request.version = ServiceXPC.version
        request.connection = "not-a-uuid"
        reject(.invalidRequest) { _ = try ServiceXPC.decode(ServiceXPC.encode(request)) }
        request.connection = identity
        request.payload = Data("illegal-for-wait".utf8)
        reject(.invalidRequest) { _ = try ServiceXPC.decode(ServiceXPC.encode(request)) }
        request.payload = nil
        request.resume = UUID().uuidString
        reject(.invalidRequest) { _ = try ServiceXPC.decode(ServiceXPC.encode(request)) }
        request.resume = nil
        var fields = try JSONSerialization.jsonObject(with: ServiceXPC.encode(request)) as! [String: Any]
        fields["untrusted"] = true
        reject(.invalidRequest) { _ = try ServiceXPC.decode(JSONSerialization.data(withJSONObject: fields)) }
        let validHello = ServiceHello(connection: identity, role: .ui, versions: [ServiceXPC.version], schemaHash: ServiceXPC.schema, capabilities: ServiceXPC.capabilities)
        try ServiceXPC.validateHello(validHello, connection: identity)
        reject(.unauthorized) { try ServiceXPC.validateHello(validHello, connection: UUID().uuidString) }
        for role in [ServiceHello.Role.parser, .legacy, .provider] {
            reject(.unauthorized) { try ServiceXPC.validateHello(ServiceHello(connection: identity, role: role, versions: [ServiceXPC.version], schemaHash: ServiceXPC.schema, capabilities: ServiceXPC.capabilities), connection: identity) }
        }
        reject(.unsupportedCapability) { try ServiceXPC.validateHello(ServiceHello(connection: identity, role: .ui, versions: [ServiceXPC.version], schemaHash: ServiceXPC.schema, capabilities: []), connection: identity) }
        reject(.unsupportedVersion) { try ServiceXPC.validateHello(ServiceHello(connection: identity, role: .ui, versions: [ServiceXPC.version], schemaHash: "wrong-schema", capabilities: ServiceXPC.capabilities), connection: identity) }
        var large = ServiceControl(connection: identity, kind: .hello)
        large.hello = validHello
        large.launch = ServiceLaunch(bun: "/bun", backend: "/backend", profile: "/profile", arguments: [], environment: ["padding": String(repeating: "a", count: 65536)])
        reject(.invalidRequest) { _ = try ServiceXPC.decode(ServiceXPC.encode(large)) }
        print("SERVICE-PROCESS control codec PASS")
    }
    static func awaitReady(_ instance: ServiceClient, deadline: Date) {
        if instance.isReady { print("RECONNECTED"); fflush(stdout); return }
        guard Date() < deadline else { fputs("CLIENT-ERROR reconnect timeout\n", stderr); exit(4) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) { awaitReady(instance, deadline: deadline) }
    }
    static func main() {
        if CommandLine.arguments.dropFirst().first == "--codec" {
            do { try codecChecks(); return } catch { fputs("CODEC-ERROR \(error)\n", stderr); exit(1) }
        }
        #if INTRUDER
        print("INTRUDER"); fflush(stdout)
        #endif
        if CommandLine.arguments.count == 4 {
            do {
                let launch = try JSONDecoder().decode(ServiceLaunch.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2])))
                let instance = try ServiceClient(launch: launch, serviceExecutable: CommandLine.arguments[3])
                client = instance
                instance.start(onReady: { print("READY"); fflush(stdout) }, onMessage: { data in
                    print("EVENT \(data.base64EncodedString())"); fflush(stdout)
                }, onFailure: { message in print("FAILURE \(message)"); fflush(stdout); exit(3) })
                DispatchQueue.global().async {
                    while let line = readLine() {
                        DispatchQueue.main.async {
                            if line == "reconnect" { instance.disconnectAndReconnect(); awaitReady(instance, deadline: Date().addingTimeInterval(5)) }
                            else if line == "shutdown" {
                                var completed = 0
                                for _ in 0..<3 {
                                    instance.shutdown {
                                        completed += 1
                                        if completed == 3 { instance.shutdown { print("STOPPED"); fflush(stdout); exit(0) } }
                                    }
                                }
                            } else if let data = Data(base64Encoded: line) { instance.send(data) }
                        }
                    }
                }
                dispatchMain()
            } catch { fputs("CLIENT-ERROR \(error)\n", stderr); exit(2) }
        }
        _ = connect()
        DispatchQueue.global().async {
            while let line = readLine() {
                if line == "reconnect" {
                    retained?.invalidate()
                    _ = connect()
                    print("RECONNECTED"); fflush(stdout)
                    continue
                }
                guard let data = Data(base64Encoded: line), let connection = retained else { exit(2) }
                let proxy = connection.remoteObjectProxyWithErrorHandler { error in
                    print("ERROR \(error as NSError)"); fflush(stdout)
                } as? TreziServiceRemote
                proxy?.exchange(data) { reply in
                    print("REPLY \(reply.base64EncodedString())"); fflush(stdout)
                }
            }
            retained?.invalidate()
            exit(0)
        }
        dispatchMain()
    }
}
