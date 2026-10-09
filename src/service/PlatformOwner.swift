import Foundation
import Darwin

/// The platform owner (S14, LKM-101): the remaining OS services Bun performed itself.
/// - the iOS Simulator preview (`SimulatorCoordinator`): xcrun/idb, the app's launch
///   command as a supervised group, the loopback bridge, picks and teardown;
/// - scoped media grants for the native source editor (`MediaScopes`);
/// - pasted composer images, uploaded in bounded chunks (`AttachmentUploads`);
/// - the "Running servers" recovery sheet's inspection and SIGTERM (`PreviewServers`);
/// - opening links, files and "Open in editor" (`PlatformOpen`, LKM-102).
/// Bun asks over the private pipe (`{"service":"platform",…}`) and keeps the views, the
/// sheet and the bridge page's bezel asset (a JS module it proposes with each start).
final class PlatformOwner: @unchecked Sendable {
    static let service = "platform"
    static let stopping = PlatformRefusal(.unavailable, "The service is stopping; the request was not started.")

    struct Options {
        var profile: String
        var environment: [String: String]
        var watchdog: String?
        var journal: RuntimeJournal?
        /// Never listed or signalled by the recovery sheet (supervised Bun, the host).
        var protectedPIDs: @Sendable () -> Set<pid_t> = { [] }
        var now: @Sendable () -> Date = { Date() }
        var mediaTTL: TimeInterval = 15 * 60
        var maxMediaTokens = 500
        var maxMediaBytes: Int64 = 256 * 1024 * 1024
        var maxAttachmentBytes = 25 * 1024 * 1024
        /// An upload that receives nothing for this long is dropped.
        var attachmentIdle: TimeInterval = 60
        var servers = PreviewServers.Tools()
        /// `open` and the editor CLIs (looked up on the launch environment's PATH).
        var open = PlatformOpen.Tools()
        /// Tool paths and timings for the simulator; nil uses the system tools.
        var simulator: SimulatorCoordinator.Options?
    }

    let options: Options
    let media: MediaScopes
    let attachments: AttachmentUploads
    private(set) var simulator: SimulatorCoordinator!
    private let send: @Sendable (Data) -> Void
    private let queue = DispatchQueue(label: "dev.trezi.platform.owner")
    private let work = DispatchQueue(label: "dev.trezi.platform.work", attributes: .concurrent)
    private var closed = false

    init(options: Options, send: @escaping @Sendable (Data) -> Void) {
        self.options = options; self.send = send
        media = MediaScopes(ttl: options.mediaTTL, maxTokens: options.maxMediaTokens, maxBytes: options.maxMediaBytes, now: options.now)
        attachments = AttachmentUploads(profile: options.profile, maxBytes: options.maxAttachmentBytes, idle: options.attachmentIdle, now: options.now)
        var simulatorOptions = options.simulator ?? SimulatorCoordinator.Options(environment: options.environment,
            scratch: options.profile + "/service/simulator")
        simulatorOptions.watchdog = simulatorOptions.watchdog ?? options.watchdog
        simulatorOptions.journal = simulatorOptions.journal ?? options.journal
        simulator = SimulatorCoordinator(options: simulatorOptions,
            log: { [weak self] line in self?.event("simulator-log", [("line", .string(JSText(line)))]) },
            picked: { [weak self] source, tag in
                self?.event("simulator-picked", [("source", source.map { .string(JSText($0)) } ?? .null), ("tag", .string(JSText(tag)))])
            })
    }

    // MARK: Requests (from the backend reader thread, in pipe order)

    func submit(_ line: Data) {
        let frame: PipeFrame
        do { frame = try PipeFrame(line, service: Self.service, maxDepth: 8) } catch {
            let code = error as? ServiceContractFailure ?? .invalidRequest
            send(Self.reply(id: (try? JSValue.parse(line, maxDepth: 8))?["id"] ?? .null, frame: nil,
                            result: .failed(Self.fail(PlatformRefusal(code, "Invalid platform request.")))))
            return
        }
        queue.async { self.dispatch(frame) }
    }

    enum Kind { case string, number, bool, object }

    /// Exactly the named body fields (plus `optional`), each of its kind.
    static func fields(_ frame: PipeFrame, _ required: [String: Kind], optional: [String: Kind] = [:]) throws -> [String: JSValue] {
        var fields: [String: JSValue] = [:]
        for (name, value) in frame.body {
            let key = name.string
            guard let kind = required[key] ?? optional[key], fields[key] == nil else { throw ServiceContractFailure.invalidRequest }
            switch (kind, value) {
            case (.string, .string), (.bool, .bool), (.object, .object): break
            case (.number, .number(let number)) where number.isFinite: break
            default: throw ServiceContractFailure.invalidRequest
            }
            fields[key] = value
        }
        guard Set(required.keys).isSubset(of: Set(fields.keys)) else { throw ServiceContractFailure.invalidRequest }
        return fields
    }

    /// A bounded string without NUL or lone surrogates.
    static func text(_ fields: [String: JSValue], _ key: String, max: Int = 4096) throws -> String {
        guard let text = fields[key]?.text, text.count <= max, !text.contains(0), JSText(text.string) == text else {
            throw ServiceContractFailure.invalidRequest
        }
        return text.string
    }

    static func root(_ fields: [String: JSValue]) throws -> String {
        let root = try text(fields, "root")
        guard root.hasPrefix("/") else { throw ServiceContractFailure.invalidRequest }
        return root
    }

    static func intent(_ fields: [String: JSValue], _ expected: String) throws {
        guard fields["intent"]?.text?.string == expected else { throw PlatformRefusal(.invalidRequest, "An explicit \(expected) intent is required.") }
    }

    private func dispatch(_ frame: PipeFrame) {
        guard !closed else { return answer(frame, .failed(Self.fail(Self.stopping, retryable: true))) }
        do {
            guard frame.expectedRevision == nil else { throw ServiceContractFailure.invalidRequest }
            switch (frame.method, frame.mode) {
            case ("status", "read"):
                _ = try Self.fields(frame, [:])
                answer(frame, .succeeded(.object([(JSText("simulator"), simulator.state), (JSText("grants"), .number(Double(media.count))),
                                                  (JSText("uploads"), .number(Double(attachments.count)))])))
            case ("simulatorPreflight", "read"):
                _ = try Self.fields(frame, [:])
                perform(frame) { try self.simulator.preflight().value }
            case ("simulatorStart", "mutation"):
                let body = try Self.fields(frame, ["root": .string, "intent": .string, "frame": .object], optional: ["command": .string, "udid": .string])
                try Self.intent(body, "start")
                let root = try Self.root(body)
                let command = body["command"] == nil ? nil : try Self.text(body, "command", max: 65_536)
                let udid = body["udid"] == nil ? nil : try Self.text(body, "udid", max: 64)
                guard udid.map({ UUID(uuidString: $0) != nil }) ?? true, let asset = SimulatorTools.Frame(body["frame"]) else {
                    throw ServiceContractFailure.invalidRequest
                }
                var isDirectory: ObjCBool = false
                guard FileManager.default.fileExists(atPath: root, isDirectory: &isDirectory), isDirectory.boolValue else {
                    throw PlatformRefusal(.notFound, "The project folder is not available.")
                }
                perform(frame) { try self.simulator.start(root: root, command: command, udid: udid, frame: asset) }
            case ("simulatorStop", "mutation"):
                try Self.intent(try Self.fields(frame, ["intent": .string]), "stop")
                perform(frame) { .object([(JSText("stopped"), .bool(self.simulator.stop()))]) }
            case ("simulatorSelect", "mutation"):
                guard case .bool(let active)? = try Self.fields(frame, ["active": .bool])["active"] else { throw ServiceContractFailure.invalidRequest }
                simulator.setSelectMode(active)
                answer(frame, .succeeded(.object([(JSText("active"), .bool(active))])))
            case ("mediaGrant", "mutation"):
                let body = try Self.fields(frame, ["root": .string, "path": .string, "view": .string])
                let root = try Self.root(body), path = try Self.text(body, "path"), view = try Self.text(body, "view", max: 64)
                perform(frame) { try self.media.grant(root: root, path: path, view: view).value(url: true) }
            case ("mediaResolve", "read"):
                let body = try Self.fields(frame, ["token": .string, "view": .string])
                let token = try Self.text(body, "token", max: 128), view = try Self.text(body, "view", max: 64)
                perform(frame) { try self.media.resolve(token: token, view: view).value(url: false) }
            case ("attachmentOpen", "mutation"):
                let body = try Self.fields(frame, ["mediaType": .string, "bytes": .number, "sha256": .string], optional: ["name": .string])
                guard case .number(let bytes)? = body["bytes"], bytes.rounded() == bytes, bytes >= 0, bytes <= Double(Int32.max) else {
                    throw ServiceContractFailure.invalidRequest
                }
                let upload = try attachments.open(mediaType: try Self.text(body, "mediaType", max: 128),
                                                  name: body["name"] == nil ? nil : try Self.text(body, "name", max: 1024),
                                                  bytes: Int(bytes), sha256: try Self.text(body, "sha256", max: 64))
                answer(frame, .succeeded(.object([(JSText("upload"), .string(JSText(upload)))])))
            case ("attachmentChunk", "mutation"):
                let body = try Self.fields(frame, ["upload": .string, "offset": .number, "data": .string])
                guard case .number(let offset)? = body["offset"], offset.rounded() == offset, offset >= 0, offset <= Double(Int32.max),
                      let data = Data(base64Encoded: try Self.text(body, "data", max: 2 * 1024 * 1024)) else { throw ServiceContractFailure.invalidRequest }
                try attachments.chunk(upload: try Self.text(body, "upload", max: 128), offset: Int(offset), data: data)
                answer(frame, .succeeded(.object([(JSText("received"), .number(offset + Double(data.count)))])))
            case ("attachmentCommit", "mutation"):
                let upload = try Self.text(try Self.fields(frame, ["upload": .string]), "upload", max: 128)
                perform(frame) { .object([(JSText("path"), .string(JSText(try self.attachments.commit(upload: upload))))]) }
            case ("servers", "read"):
                let root = try Self.root(try Self.fields(frame, ["root": .string]))
                perform(frame) { .array(try PreviewServers.find(root, tools: self.options.servers, protected: self.protected)) }
            case ("serverStop", "mutation"):
                let body = try Self.fields(frame, ["server": .object, "intent": .string])
                try Self.intent(body, "stop")
                let server = body["server"]!
                perform(frame) {
                    try PreviewServers.stop(server, tools: self.options.servers, protected: self.protected)
                    return .object([(JSText("stopped"), .bool(true))])
                }
            case ("openLink", "mutation"):
                let url = try Self.text(try Self.fields(frame, ["url": .string]), "url", max: 8192)
                perform(frame) { try PlatformOpen.link(url, tools: self.options.open); return .object([]) }
            case ("openFile", "mutation"):
                let path = try Self.text(try Self.fields(frame, ["path": .string]), "path")
                perform(frame) { .object([(JSText("error"), .string(JSText(PlatformOpen.file(path, tools: self.options.open))))]) }
            case ("openInEditor", "mutation"):
                let body = try Self.fields(frame, ["root": .string, "path": .string, "line": .number], optional: ["column": .number])
                let root = try Self.root(body), path = try Self.text(body, "path")
                func position(_ key: String) throws -> Int? {
                    guard case .number(let value)? = body[key] else { return nil }
                    guard value.rounded() == value, value >= 0, value <= Double(Int32.max) else { throw ServiceContractFailure.invalidRequest }
                    return Int(value)
                }
                guard path.hasPrefix("/"), let line = try position("line") else { throw ServiceContractFailure.invalidRequest }
                let column = try position("column")
                perform(frame) { try PlatformOpen.editor(root: root, path: path, line: line, column: column, tools: self.options.open) }
            default: throw ServiceContractFailure.invalidRequest
            }
        } catch let refusal as PlatformRefusal {
            answer(frame, .failed(Self.fail(refusal)))
        } catch {
            answer(frame, .failed(Self.fail(PlatformRefusal(error as? ServiceContractFailure ?? .invalidRequest, "Invalid platform request."))))
        }
    }

    /// The service itself, its parent, and whatever the options protect.
    private var protected: Set<pid_t> { options.protectedPIDs().union([getpid(), getppid()]) }

    /// Blocking work off the owner queue; a refusal becomes a failed answer.
    private func perform(_ frame: PipeFrame, _ body: @escaping @Sendable () throws -> JSValue) {
        work.async {
            do { self.answer(frame, .succeeded(try body())) } catch let refusal as PlatformRefusal {
                self.answer(frame, .failed(Self.fail(refusal, retryable: refusal.code == .busy || refusal.code == .deadlineExceeded)))
            } catch {
                self.answer(frame, .failed(Self.fail(PlatformRefusal(.ioFailure, "\(error)"))))
            }
        }
    }

    /// Service shutdown: refuse new requests, stop the simulator preview and its
    /// Metro group (bounded) before the profile lock is released. Grants and uploads
    /// are memory only and end with the service.
    @discardableResult
    func close(timeout: TimeInterval) -> Bool {
        queue.sync { closed = true }
        return simulator.close(timeout: timeout)
    }

    // MARK: Frames

    private func event(_ kind: String, _ fields: [(String, JSValue)]) {
        let head: [(JSText, JSValue)] = [(JSText("event"), .string(JSText("service-event"))), (JSText("service"), .string(JSText(Self.service))),
                                        (JSText("kind"), .string(JSText(kind)))]
        send(JSValue.object(head + fields.map { (JSText($0.0), $0.1) }).utf8())
    }

    private func answer(_ frame: PipeFrame, _ result: PreferencesOwner.Answer) { send(Self.reply(id: frame.id, frame: frame, result: result)) }

    static func fail(_ refusal: PlatformRefusal, retryable: Bool = false) -> ServiceFailure {
        PreferencesOwner.fail(refusal.code, refusal.message, retryable: retryable)
    }

    static func reply(id: JSValue, frame: PipeFrame?, result: PreferencesOwner.Answer) -> Data {
        let body: JSValue
        switch result {
        case .succeeded(let payload): body = .object([(JSText("kind"), .string(JSText("succeeded"))), (JSText("payload"), payload)])
        case .failed(let failure): body = .object([(JSText("kind"), .string(JSText("failed"))), (JSText("payload"), PreferencesOwner.value(failure))])
        }
        var reply: [(JSText, JSValue)] = []
        if let frame {
            reply = [(JSText("connection"), .string(JSText(frame.connection))), (JSText("requestID"), .string(JSText(frame.requestID))),
                     (JSText("operationID"), .string(JSText(frame.operationID))), (JSText("scope"), .object([]))]
        }
        reply.append((JSText("result"), body))
        return JSValue.object([(JSText("event"), .string(JSText("service-reply"))), (JSText("service"), .string(JSText(service))),
                               (JSText("id"), id), (JSText("reply"), .object(reply))]).utf8()
    }
}
