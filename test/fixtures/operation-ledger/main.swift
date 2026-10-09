import Foundation
import Darwin

// Line-driven process around the real OperationLedger: one JSON command per stdin
// line, one JSON answer per stdout line. LEDGER_CRASH=<boundary> SIGKILLs this
// process at that durable boundary ("effect-performed": after the external effect,
// before its receipt). The external effect appends a line to effects/<operation>.

setvbuf(stdout, nil, _IOLBF, 0)
let env = ProcessInfo.processInfo.environment
let directory = URL(fileURLWithPath: CommandLine.arguments[1])
let effects = directory.deletingLastPathComponent().appendingPathComponent("effects")
let trace = directory.deletingLastPathComponent().appendingPathComponent("trace")
try? FileManager.default.createDirectory(at: effects, withIntermediateDirectories: true)
let crash = env["LEDGER_CRASH"]

func die(at point: String) { if crash == point { kill(getpid(), SIGKILL) } }
func json<T: Encodable>(_ value: T) -> ServiceJSON {
    let data = (try? JSONEncoder().encode(value)) ?? Data("null".utf8)
    return (try? JSONDecoder().decode(ServiceJSON.self, from: data)) ?? .null
}
func emit(_ value: ServiceJSON) {
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    print(String(decoding: try! encoder.encode(value), as: UTF8.self))
}
func append(_ url: URL, _ line: String) {
    let fd = open(url.path, O_WRONLY | O_APPEND | O_CREAT, 0o600)
    precondition(fd >= 0, "cannot open \(url.path): \(errno)")
    let bytes = Array((line + "\n").utf8)
    precondition(write(fd, bytes, bytes.count) == bytes.count)
    fsync(fd); close(fd)
}
func number(_ value: ServiceJSON?) -> Double? { value?.number }

var options = LedgerOptions()
if let now = env["LEDGER_NOW"].flatMap(Double.init) { options.now = { now } }
if let value = env["LEDGER_HORIZON"].flatMap(Double.init) { options.retryHorizon = value }
if let value = env["LEDGER_WINDOW"].flatMap(Int.init) { options.eventWindow = value }
if let value = env["LEDGER_COMPACT"].flatMap(UInt64.init) { options.compactEvery = value }
if let value = env["LEDGER_MAX_OPS"].flatMap(Int.init) { options.maxOperations = value }
options.boundary = { die(at: $0.rawValue) }

var opened: OperationLedger?
var quarantined: String?
do { opened = try OperationLedger(directory: directory, options: options) }
catch LedgerOpenError.corrupt(let reason) where env["LEDGER_QUARANTINE"] == "1" {
    // Explicit operator recovery, never the default: move the store aside whole.
    quarantined = try! quarantineLedgerStore(at: directory).path
    _ = reason
    opened = try? OperationLedger(directory: directory, options: options)
} catch {
    emit(.object(["open": .string("failed"), "error": .string("\(error)")]))
    exit(3)
}
guard let ledger = opened else { emit(.object(["open": .string("failed"), "error": .string("reopen")])); exit(3) }
emit(.object(["open": .string("ok"), "epoch": .string(ledger.epoch), "quarantined": quarantined.map(ServiceJSON.string) ?? .null]))

func outcome(_ value: LedgerOutcome) -> ServiceJSON {
    switch value {
    case .operation(let op): return .object(["kind": .string("operation"), "op": json(op), "result": json(value.result)])
    case .rejected(let failure): return .object(["kind": .string("rejected"), "failure": json(failure), "result": json(value.result)])
    }
}

/// {id, domain, expected:{epoch,counter}, body?, external?, prepareMs?, effectMs?, fail?: "before"|"notApplied"|"unknown"}
func perform(_ spec: ServiceJSON) async -> LedgerOutcome {
    let id = spec["id"]!.string!
    let expected = spec["expected"]!
    let request = ServiceRequest(connection: UUID().uuidString.lowercased(), requestID: UUID().uuidString.lowercased(),
        operationID: id, scope: ServiceScope(project: spec["project"]?.string, chat: nil, turn: nil, checkout: nil, document: nil),
        mode: .mutation, expectedRevision: ServiceRevision(epoch: expected["epoch"]!.string!, counter: expected["counter"]!.string!),
        timeoutMilliseconds: nil, service: "fixture", method: "increment", body: spec["body"]?.object ?? [:])
    let external = spec["external"] == .bool(true)
    let prepare = UInt64(number(spec["prepareMs"]) ?? 0)
    let after = UInt64(number(spec["effectMs"]) ?? 0)
    let fail = spec["fail"]?.string
    return await ledger.perform(request, domain: spec["domain"]!.string!) { context in
        append(trace, "start \(id)")
        defer { append(trace, "end \(id)") }
        if prepare > 0 { try await Task.sleep(nanoseconds: prepare * 1_000_000) }
        if fail == "before" { throw CocoaError(.fileWriteUnknown) }
        let count = (context.checkpoint["count"]?.number ?? 0) + 1
        if external {
            try await context.beginEffect()
            if fail == "notApplied" {
                throw LedgerEffectError.notApplied(OperationLedger.failure(.conflict, "Refused by the external system.", operationID: id))
            }
            // Atomic, so a kill never leaves a present-but-empty marker; a repeat adds a line.
            let marker = effects.appendingPathComponent(id)
            let previous = (try? Data(contentsOf: marker)) ?? Data()
            let temporary = marker.appendingPathExtension("tmp")
            try! (previous + Data("applied\n".utf8)).write(to: temporary)
            precondition(rename(temporary.path, marker.path) == 0)
            die(at: "effect-performed")
            if fail == "unknown" { throw CocoaError(.fileWriteUnknown) }
            if after > 0 { try await Task.sleep(nanoseconds: after * 1_000_000) }
        }
        return LedgerCommit(result: .object(["count": .number(count), "id": .string(id)]),
                            checkpoint: ["count": .number(count), "last": .string(id)])
    }
}

func cancelKind(_ value: LedgerCancel) -> ServiceJSON {
    switch value {
    case .cancelled(let op): return .object(["kind": .string("cancelled"), "op": json(op)])
    case .tooLate(let op): return .object(["kind": .string("tooLate"), "op": json(op)])
    case .finished(let op): return .object(["kind": .string("finished"), "op": json(op)])
    case .notFound: return .object(["kind": .string("notFound")])
    }
}

while let line = readLine() {
    guard let command = try? JSONDecoder().decode(ServiceJSON.self, from: Data(line.utf8)), let name = command["cmd"]?.string else {
        emit(.object(["error": .string("bad command")])); continue
    }
    switch name {
    case "register":
        let snapshot = await ledger.register(domain: command["domain"]!.string!, checkpoint: command["checkpoint"]?.object ?? [:])
        emit(snapshot.map(json) ?? .null)
    case "snapshot":
        emit((await ledger.snapshot(domain: command["domain"]!.string!)).map(json) ?? .null)
    case "perform":
        emit(outcome(await perform(command)))
    case "race":
        let specs = command["ops"]!.array!
        let results = await withTaskGroup(of: (Int, ServiceJSON).self) { group in
            for (index, spec) in specs.enumerated() { group.addTask { (index, outcome(await perform(spec))) } }
            var out = [ServiceJSON](repeating: .null, count: specs.count)
            for await (index, value) in group { out[index] = value }
            return out
        }
        emit(.array(results))
    case "cancelDuring":
        let spec = command["op"]!
        let task = Task { await perform(spec) }
        try? await Task.sleep(nanoseconds: UInt64(number(command["afterMs"]) ?? 100) * 1_000_000)
        let cancelled = await ledger.cancel(spec["id"]!.string!)
        emit(.object(["cancel": cancelKind(cancelled), "outcome": outcome(await task.value)]))
    case "cancel":
        emit(cancelKind(await ledger.cancel(command["id"]!.string!)))
    case "status":
        switch await ledger.status(command["id"]!.string!) {
        case .unknown: emit(.object(["status": .string("unknown")]))
        case .expired: emit(.object(["status": .string("expired")]))
        case .operation(let op): emit(.object(["status": .string("operation"), "op": json(op)]))
        }
    case "recoveries":
        emit(.array((await ledger.recoveries()).map(json)))
    case "reconcile":
        // Inspect the external world instead of replaying the effect.
        let id = command["id"]!.string!
        guard case .operation(let op) = await ledger.status(id), let snapshot = await ledger.snapshot(domain: op.domain) else {
            emit(.null); continue
        }
        let applied = FileManager.default.fileExists(atPath: effects.appendingPathComponent(id).path)
        let count = (snapshot.value["count"]?.number ?? 0) + 1
        let resolution: LedgerResolution = applied
            ? .applied(result: .object(["count": .number(count), "id": .string(id)]), checkpoint: ["count": .number(count), "last": .string(id)])
            : .notApplied(OperationLedger.failure(.cancelled, "Reconciled: the effect never happened.", retryable: true, operationID: id))
        emit(outcome(await ledger.reconcile(id, resolution)))
    case "events":
        let cursor = command["cursor"]!
        switch await ledger.events(after: ServiceCursor(serviceEpoch: cursor["serviceEpoch"]!.string!, sequence: cursor["sequence"]!.string!)) {
        case .snapshotRequired: emit(.object(["delta": .string("snapshotRequired")]))
        case .events(let events): emit(.object(["delta": .string("events"), "events": json(events)]))
        }
    case "cursor":
        emit(json(await ledger.cursor))
    case "digest":
        // Same operation identity for reordered keys; different for null/absence and Unicode spelling.
        let request = { (body: [String: ServiceJSON]) in ServiceRequest(connection: UUID().uuidString, requestID: UUID().uuidString,
            operationID: UUID().uuidString, scope: ServiceScope(project: nil, chat: nil, turn: nil, checkout: nil, document: nil),
            mode: .mutation, expectedRevision: ServiceRevision(epoch: "e", counter: "0"), timeoutMilliseconds: 5, service: "s",
            method: "m", body: body) }
        emit(.array(command["bodies"]!.array!.map { .string(OperationLedger.intentDigest(request($0.object!), domain: "d")) }))
    case "mirror":
        var mirror = LedgerMirror(domain: command["domain"]!.string!)
        var results: [ServiceJSON] = []
        for step in command["steps"]!.array! {
            let data = try! JSONEncoder().encode(step["value"]!)
            switch step["kind"]!.string! {
            case "snapshot": results.append(.string(mirror.apply(try! JSONDecoder().decode(ServiceSnapshot.self, from: data)).rawValue))
            case "event": results.append(.string(mirror.apply(try! JSONDecoder().decode(ServiceEvent.self, from: data)).rawValue))
            default: results.append(.string(mirror.acknowledge(try! JSONDecoder().decode(ServiceRevision.self, from: data)).rawValue))
            }
        }
        emit(.object(["results": .array(results), "revision": json(mirror.revision), "value": .object(mirror.value)]))
    case "exit":
        exit(0)
    default:
        emit(.object(["error": .string("unknown command \(name)")]))
    }
}
