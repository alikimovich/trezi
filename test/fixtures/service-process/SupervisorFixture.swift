import Foundation
import Darwin

@main struct SupervisorFixture {
    static func main() {
        do { try run() } catch { fputs("SUPERVISOR-ERROR \(error)\n", stderr); exit(1) }
    }
    static func run() throws {
        let args = CommandLine.arguments
        let mode = args[1], profile = args[2]
        let exclusion = try ProfileExclusion(profile: profile)
        if mode == "lock" {
            print("LOCKED")
            fflush(stdout)
            _ = readLine()
            exclusion.release()
            exclusion.release()
            return
        }
        if mode == "startup-failure" {
            let supervisor = BackendSupervisor()
            do {
                _ = try supervisor.start(executable: "/nonexistent/trezi-bun", arguments: [], environment: [:], onExit: { _ in })
                fatalError("missing child unexpectedly started")
            } catch { print("STARTUP-FAILURE") }
            supervisor.shutdown(gracePeriod: 0)
            supervisor.shutdown(gracePeriod: 0)
            exclusion.release()
            let reacquired = try ProfileExclusion(profile: profile)
            reacquired.release()
            return
        }
        let supervisor = BackendSupervisor()
        let exited = DispatchSemaphore(value: 0)
        let child = try supervisor.start(executable: args[3], arguments: [args[4]],
            environment: ProcessInfo.processInfo.environment, onExit: { _ in exited.signal() })
        print("CHILD \(child.pid)")
        fflush(stdout)
        _ = readLine()
        if mode == "child-death" {
            kill(child.pid, SIGKILL)
            guard exited.wait(timeout: .now() + 5) == .success else { fatalError("child exit not observed") }
        }
        let group = DispatchGroup()
        for _ in 0..<3 {
            group.enter()
            DispatchQueue.global().async { supervisor.shutdown(gracePeriod: 0.1); group.leave() }
        }
        guard group.wait(timeout: .now() + 5) == .success else { fatalError("repeated shutdown deadlocked") }
        supervisor.shutdown(gracePeriod: 0)
        exclusion.release()
        let reacquired = try ProfileExclusion(profile: profile)
        reacquired.release()
        print("STOPPED")
    }
}
