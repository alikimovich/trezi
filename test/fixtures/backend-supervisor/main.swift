import Foundation
import Darwin

if let mode = CommandLine.arguments.dropFirst().first, ["--guard", "--guard-backend"].contains(mode) {
    runProcessGuardian(arguments: Array(CommandLine.arguments.dropFirst(2)), backend: mode == "--guard-backend")
}

if CommandLine.arguments.dropFirst().first == "--lifetime-owner" {
    let ownerProfile = CommandLine.arguments[2]
    let ownerBun = CommandLine.arguments[3]
    let lease = try ProfileExclusion(profile: ownerProfile)
    let supervisor = BackendSupervisor()
    let script = """
    require('node:fs').writeFileSync(process.env.OWNER_PROFILE + '/newer-state', 'newer durable work');
    require('node:fs').writeFileSync(process.env.OWNER_PROFILE + '/backend.pid', String(process.pid));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    """
    var environment = ProcessInfo.processInfo.environment
    environment["OWNER_PROFILE"] = ownerProfile
    _ = try supervisor.start(executable: ownerBun, arguments: ["-e", script], environment: environment,
                             profileDescriptor: lease.guardDescriptor, guardianExecutable: CommandLine.arguments[0], onExit: { _ in })
    withExtendedLifetime((lease, supervisor)) { dispatchMain() }
}

func check(_ value: @autoclosure () -> Bool, _ message: String) {
    guard value() else { fputs("FAIL: \(message)\n", stderr); exit(1) }
}
func fails(_ message: String, _ body: () throws -> Void) {
    do { try body(); check(false, message) } catch {}
}
/// A pid file exists before its digits are written; wait for a complete pid.
func waitForPID(_ path: String, _ message: String, timeout: TimeInterval = 5) -> pid_t {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
        let text = (try? String(contentsOfFile: path, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if let pid = pid_t(text), pid > 1 { return pid }
        usleep(10_000)
    } while Date() < deadline
    check(false, message)
    return 0
}
// Honor the caller's TMPDIR (sandboxed runners); Foundation's default ignores it.
let profile = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory()).appendingPathComponent("trezi-supervisor-\(UUID().uuidString)")
try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: profile) }
let first = try ProfileExclusion(profile: profile.path)
fails("contending profile lock must fail") { _ = try ProfileExclusion(profile: profile.path) }
first.release()
first.release()
let second = try ProfileExclusion(profile: profile.path)
second.release()
try String(getpid()).write(to: profile.appendingPathComponent("native.lock"), atomically: false, encoding: .utf8)
fails("live legacy owner must fail") { _ = try ProfileExclusion(profile: profile.path) }
try "malformed".write(to: profile.appendingPathComponent("native.lock"), atomically: false, encoding: .utf8)
fails("malformed legacy lock must fail closed") { _ = try ProfileExclusion(profile: profile.path) }
try "2147483647".write(to: profile.appendingPathComponent("native.lock"), atomically: false, encoding: .utf8)
let stale = try ProfileExclusion(profile: profile.path)
check(try! String(contentsOf: profile.appendingPathComponent("native.lock"), encoding: .utf8) == String(getpid()), "stale lock replaced by live owner")
try "newer-owner".write(to: profile.appendingPathComponent("native.lock"), atomically: false, encoding: .utf8)
stale.release()
check(try! String(contentsOf: profile.appendingPathComponent("native.lock"), encoding: .utf8) == "newer-owner", "release preserves changed owner")
try FileManager.default.removeItem(at: profile.appendingPathComponent("native.lock"))
// Bridge reads must return short lines promptly rather than waiting to fill the buffer.
let bridge = Pipe()
bridge.fileHandleForWriting.write(Data("{\"method\":\"short\"}\n".utf8))
check(try! bridge.fileHandleForReading.readAvailable(upTo: 65536) == Data("{\"method\":\"short\"}\n".utf8), "short bridge line read without filling the buffer")
bridge.fileHandleForWriting.closeFile()
check(try! bridge.fileHandleForReading.readAvailable(upTo: 65536).isEmpty, "EOF reads empty")
let failed = BackendSupervisor()
fails("missing executable must fail") {
    _ = try failed.start(executable: "/nonexistent/trezi", arguments: [], environment: [:], onExit: { _ in })
}
failed.shutdown()
failed.shutdown()
let echo = BackendSupervisor()
let ended = DispatchSemaphore(value: 0)
let child = try echo.start(executable: "/bin/cat", arguments: [], environment: ProcessInfo.processInfo.environment, onExit: { _ in ended.signal() })
try child.input.write(contentsOf: Data("handshake\n".utf8))
check(String(data: child.output.availableData, encoding: .utf8) == "handshake\n", "stdio transport")
try child.input.close()
check(ended.wait(timeout: .now() + 3) == .success, "child death observed")
echo.shutdown(gracePeriod: 0.05)
echo.shutdown()
let tree = BackendSupervisor()
let stubborn = try tree.start(executable: "/bin/sh", arguments: ["-c", "trap '' TERM; /bin/sh -c 'trap \"\" TERM; while :; do sleep 1; done' & echo $!; wait"], environment: ProcessInfo.processInfo.environment, onExit: { _ in })
let line = String(data: stubborn.output.availableData, encoding: .utf8)!.trimmingCharacters(in: .whitespacesAndNewlines)
let descendant = Int32(line)!
check(kill(descendant, 0) == 0, "fixture descendant exists")
let start = Date()
tree.shutdown(gracePeriod: 0.1)
tree.shutdown()
check(Date().timeIntervalSince(start) < 3, "bounded repeated shutdown")
let deadline = Date().addingTimeInterval(3)
while kill(descendant, 0) == 0 && Date() < deadline { usleep(10_000) }
check(kill(stubborn.pid, 0) != 0 && errno == ESRCH, "direct child reaped")
check(kill(descendant, 0) != 0 && errno == ESRCH, "descendant cleaned")
print("PASS: profile exclusion, legacy exclusion, startup failure, stdio, child death, repeated shutdown and descendant cleanup")

// A real Bun child starts a detached guardian; killing Bun must close Swift's
// lifetime writer and clean the guardian's separate target group.
let bun = ProcessInfo.processInfo.environment["TREZI_TEST_BUN"] ?? "/opt/homebrew/bin/bun"
let binary = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.path
let targetFile = profile.appendingPathComponent("target.pid").path
let grandchildFile = profile.appendingPathComponent("grandchild.pid").path
let detached = BackendSupervisor()
let bunScript = """
const {spawn} = require('node:child_process');
spawn(process.env.GUARD_BINARY, ['--guard', '/bin/sh', '-c', 'trap \"\" TERM; echo $$ > \"$TARGET_PID_FILE\"; sleep 1000 & echo $! > \"$GRANDCHILD_PID_FILE\"; wait'], {detached:true, stdio:['ignore','ignore','inherit',3]});
setInterval(()=>{}, 1000);
"""
var guardianEnvironment = ProcessInfo.processInfo.environment
guardianEnvironment["GUARD_BINARY"] = binary
guardianEnvironment["TARGET_PID_FILE"] = targetFile
guardianEnvironment["GRANDCHILD_PID_FILE"] = grandchildFile
let bunChild = try detached.start(executable: bun, arguments: ["-e", bunScript], environment: guardianEnvironment, onExit: { _ in })
let grandchildPID = waitForPID(grandchildFile, "detached fixture started")
let targetPID = waitForPID(targetFile, "detached target recorded")
kill(bunChild.pid, SIGKILL)
let cleanupDeadline = Date().addingTimeInterval(5)
while (kill(targetPID, 0) == 0 || kill(grandchildPID, 0) == 0) && Date() < cleanupDeadline { usleep(10_000) }
check(kill(targetPID, 0) != 0 && errno == ESRCH, "Bun death cleans detached target")
check(kill(grandchildPID, 0) != 0 && errno == ESRCH, "Bun death cleans detached descendant")
detached.shutdown(gracePeriod: 0.1)
print("PASS: lifetime pipe cleans detached children and descendants after abrupt Bun death")

let crashProfile = profile.appendingPathComponent("service-crash")
let owner = Process()
owner.executableURL = URL(fileURLWithPath: binary)
owner.arguments = ["--lifetime-owner", crashProfile.path, bun]
try owner.run()
let backendFile = crashProfile.appendingPathComponent("backend.pid")
let backendPID = waitForPID(backendFile.path, "guarded backend started")
// The backend has installed its TERM handler before it yields its first timer.
usleep(50_000)
kill(owner.processIdentifier, SIGKILL)
owner.waitUntilExit()
fails("guardian retains profile exclusion while backend drains") { _ = try ProfileExclusion(profile: crashProfile.path) }
let backendDeadline = Date().addingTimeInterval(5)
while kill(backendPID, 0) == 0 && Date() < backendDeadline { usleep(10_000) }
check(kill(backendPID, 0) != 0 && errno == ESRCH, "service death cleans guarded backend")
var recovered: ProfileExclusion?
while recovered == nil && Date() < backendDeadline {
    recovered = try? ProfileExclusion(profile: crashProfile.path)
    if recovered == nil { usleep(10_000) }
}
check(recovered != nil, "profile available after complete crash cleanup")
check(try! String(contentsOf: crashProfile.appendingPathComponent("newer-state"), encoding: .utf8) == "newer durable work", "recovery preserves newer state")
recovered?.release()
print("PASS: abrupt service death drains backend under inherited profile lease and preserves newer data")
let earlyReleaseProfile = profile.appendingPathComponent("early-release")
let earlyLease = try ProfileExclusion(profile: earlyReleaseProfile.path)
let heldBackend = BackendSupervisor()
let heldChild = try heldBackend.start(executable: "/bin/sh", arguments: ["-c", "trap '' TERM; echo ready; while :; do sleep 1; done"], environment: ProcessInfo.processInfo.environment,
                                     profileDescriptor: earlyLease.guardDescriptor, guardianExecutable: binary, onExit: { _ in })
check(String(data: heldChild.output.availableData, encoding: .utf8) == "ready\n", "backend holds inherited lease")
earlyLease.release()
fails("parent release cannot unlock live guardian lease") { _ = try ProfileExclusion(profile: earlyReleaseProfile.path) }
heldBackend.shutdown(gracePeriod: 0.1)
let afterRelease = try ProfileExclusion(profile: earlyReleaseProfile.path)
afterRelease.release()
print("PASS: releasing parent profile descriptor cannot unlock a live guardian lease")
