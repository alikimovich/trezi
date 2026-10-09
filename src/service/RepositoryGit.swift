import Foundation
import Darwin

/// A git command that exited non-zero. `description` matches Node's execFile
/// message ("Command failed: git …\n<stderr>"), which the conflict detection and
/// the user-facing errors were written against.
struct GitFailure: Error, CustomStringConvertible {
    let arguments: [String]
    let status: Int32
    let stdout: String
    let stderr: String
    /// The program's name (S13 runs gh and package managers through the same runner).
    var tool = "git"
    var description: String { "Command failed: \(tool) \(arguments.joined(separator: " "))\n\(stderr)" }
}

/// Watches a running command (S13): its process group once started (so a cancelled
/// workflow can stop a long local step) and each chunk of its output (progress).
struct ToolObserver: Sendable {
    var started: @Sendable (pid_t) -> Void = { _ in }
    var output: @Sendable (Data) -> Void = { _ in }
}

struct GitOutput {
    let status: Int32
    let stdout: Data
    let stderr: Data
    var text: String { String(decoding: stdout, as: UTF8.self) }
}

/// Runs git for the repository owner (S07). One process per call, in its own group,
/// stdin /dev/null, no inherited descriptor, bounded time and output. The launch
/// environment Bun was given supplies PATH (the user's git), minus every variable
/// that could point git at a different repository or index.
final class RepositoryGit: @unchecked Sendable {
    static let identity = ["GIT_AUTHOR_NAME": "Trezi", "GIT_AUTHOR_EMAIL": "trezi@local",
                           "GIT_COMMITTER_NAME": "Trezi", "GIT_COMMITTER_EMAIL": "trezi@local"]
    static let scrubbed: Set<String> = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY",
                                        "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX", "GIT_CEILING_DIRECTORIES"]
    let executable: String
    let environment: [String: String]
    let timeout: TimeInterval
    let maxOutput: Int
    let tool: String

    init(environment: [String: String], timeout: TimeInterval = 60, maxOutput: Int = 64 * 1024 * 1024,
         tool: String = "git", executable: String? = nil) {
        var clean = environment.filter { !Self.scrubbed.contains($0.key) }
        clean["GIT_TERMINAL_PROMPT"] = "0"
        // Status must never refresh (write) an index as a side effect of looking.
        clean["GIT_OPTIONAL_LOCKS"] = "0"
        self.environment = clean
        self.tool = tool
        self.executable = executable ?? ManagedProcess.resolve(tool, path: clean["PATH"]) ?? (tool == "git" ? "/usr/bin/git" : tool)
        self.timeout = timeout
        self.maxOutput = maxOutput
    }

    /// The raw result; throws only when git could not be run at all.
    func run(_ directory: String, _ arguments: [String], env extra: [String: String] = [:], observer: ToolObserver? = nil) throws -> GitOutput {
        var environment = self.environment
        for (key, value) in extra { environment[key] = value }
        var out: [Int32] = [0, 0], err: [Int32] = [0, 0]
        guard pipe(&out) == 0 else { throw ManagedProcessError.spawn("git output pipe", errno) }
        guard pipe(&err) == 0 else { close(out[0]); close(out[1]); throw ManagedProcessError.spawn("git error pipe", errno) }
        for fd in [out[0], err[0]] { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }
        let pid: pid_t
        do {
            pid = try ManagedProcess.spawn(executable, [tool] + arguments, environment: environment, directory: directory,
                                           actions: [.null(0), .dup(out[1], 1), .dup(err[1], 2)], newGroup: true)
        } catch {
            for fd in out + err { close(fd) }
            throw error
        }
        close(out[1]); close(err[1])
        observer?.started(pid)
        let limit = maxOutput
        let collected = DispatchGroup()
        final class Sink: @unchecked Sendable { var data = Data(); var overflow = false }
        let stdout = Sink(), stderr = Sink()
        for (fd, sink) in [(out[0], stdout), (err[0], stderr)] {
            collected.enter()
            Thread.detachNewThread {
                var buffer = [UInt8](repeating: 0, count: 64 * 1024)
                while true {
                    let count = read(fd, &buffer, buffer.count)
                    if count < 0 && errno == EINTR { continue }
                    if count <= 0 { break }
                    if sink.data.count + count > limit { sink.overflow = true; kill(-pid, SIGKILL); continue }
                    sink.data.append(contentsOf: buffer[..<count])
                    observer?.output(Data(buffer[..<count]))
                }
                close(fd)
                collected.leave()
            }
        }
        let exited = DispatchSemaphore(value: 0)
        final class Status: @unchecked Sendable { var raw: Int32 = 0 }
        let status = Status()
        Thread.detachNewThread {
            var raw: Int32 = 0
            while waitpid(pid, &raw, 0) < 0 && errno == EINTR {}
            status.raw = raw
            exited.signal()
        }
        if exited.wait(timeout: .now() + timeout) == .timedOut {
            kill(-pid, SIGKILL)
            exited.wait()
            collected.wait()
            return GitOutput(status: 124, stdout: stdout.data, stderr: Data("\(tool) timed out after \(Int(timeout)) s".utf8))
        }
        // A helper that outlived git (credential/fsmonitor) must not keep the pipes open.
        if collected.wait(timeout: .now() + 2) == .timedOut { kill(-pid, SIGKILL); collected.wait() }
        let code = ProcessGroup.exitCode(status.raw) ?? 128
        if stdout.overflow { return GitOutput(status: 125, stdout: Data(), stderr: Data("\(tool) output exceeded \(limit) bytes".utf8)) }
        return GitOutput(status: code, stdout: stdout.data, stderr: stderr.data)
    }

    /// Stdout of a successful command; a non-zero exit throws `GitFailure`.
    @discardableResult
    func data(_ directory: String, _ arguments: [String], env: [String: String] = [:], observer: ToolObserver? = nil) throws -> Data {
        let result = try run(directory, arguments, env: env, observer: observer)
        guard result.status == 0 else {
            throw GitFailure(arguments: arguments, status: result.status, stdout: result.text, stderr: String(decoding: result.stderr, as: UTF8.self), tool: tool)
        }
        return result.stdout
    }

    @discardableResult
    func text(_ directory: String, _ arguments: [String], env: [String: String] = [:], observer: ToolObserver? = nil) throws -> String {
        String(decoding: try data(directory, arguments, env: env, observer: observer), as: UTF8.self)
    }

    /// `text(...)` trimmed, as `stdout.trim()` was.
    func line(_ directory: String, _ arguments: [String], env: [String: String] = [:]) throws -> String {
        try text(directory, arguments, env: env).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func succeeds(_ directory: String, _ arguments: [String], env: [String: String] = [:]) -> Bool {
        (try? run(directory, arguments, env: env).status) == 0
    }

    /// NUL-separated path output (`-z`): exact names, never C-quoted.
    func paths(_ directory: String, _ arguments: [String], env: [String: String] = [:]) throws -> [String] {
        try text(directory, arguments, env: env).split(separator: "\0").map(String.init).filter { !$0.isEmpty }
    }

    func revision(_ directory: String, _ rev: String) -> String? {
        guard let value = try? line(directory, ["rev-parse", "--verify", "--quiet", "\(rev)^{commit}"]), !value.isEmpty else { return nil }
        return value
    }
}

/// Path and snapshot rules shared by every repository operation (the Swift twin of
/// `excludedWorktreePath` / `captureBase` in `src/main/worktrees.ts`).
enum RepositoryPaths {
    static let safeEnvTemplates: Set<String> = [".env.example", ".env.sample", ".env.template", ".env.defaults"]
    /// Symlinked into every worktree so it can build; never committed, snapshotted or cleaned.
    static let runtimeDeps = ["node_modules", ".env"]
    static let cleanArguments = ["clean", "-fd"] + runtimeDeps.flatMap { ["-e", $0] } + ["-e", ".trezi/", "-e", ".praxis/", "-e", ".dsgn/"]
    static let workPrefixes = ["trezi/", "praxis/", "dsgn/"]

    /// Paths that belong to the machine/tooling, not to an agent turn.
    static func excluded(_ raw: String) -> Bool {
        var rel = raw.replacingOccurrences(of: "\\", with: "/")
        if rel.hasPrefix("./") { rel.removeFirst(2) }
        let parts = rel.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        if parts.contains("node_modules") { return true }
        if let first = parts.first, [".trezi", ".praxis", ".dsgn"].contains(first) { return true }
        let name = parts.last ?? ""
        if name.hasSuffix(".tsbuildinfo") || name == ".env" { return true }
        return name.hasPrefix(".env.") && !safeEnvTemplates.contains(name)
    }

    /// Meaningful changes in a checkout: `status --porcelain -z`, excluded paths ignored.
    static func meaningfulChanges(_ git: RepositoryGit, _ directory: String) throws -> [String] {
        let records = try git.paths(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        var changed: [String] = [], index = 0
        while index < records.count {
            let record = records[index]
            let hasStatus = record.count > 3 && record[record.index(record.startIndex, offsetBy: 2)] == " "
            let path = hasStatus ? String(record.dropFirst(3)) : record
            if !excluded(path) { changed.append(path) }
            // A rename/copy record is followed by its source path (no status prefix).
            if hasStatus, record.prefix(2).contains(where: { $0 == "R" || $0 == "C" }), index + 1 < records.count {
                index += 1
                if !excluded(records[index]) { changed.append(records[index]) }
            }
            index += 1
        }
        return changed
    }

    /// Resets excluded staged paths back to HEAD in the given (usually private) index.
    static func unstageExcluded(_ git: RepositoryGit, _ directory: String, env: [String: String] = [:]) throws {
        let excludedPaths = try git.paths(directory, ["diff", "--cached", "--name-only", "-z"], env: env).filter(excluded)
        var start = 0
        while start < excludedPaths.count {
            let chunk = Array(excludedPaths[start..<min(start + 500, excludedPaths.count)])
            try git.data(directory, ["reset", "-q", "HEAD", "--"] + chunk, env: env)
            start += chunk.count
        }
    }

    /// The checkout's full current state (tracked changes and untracked files, minus
    /// excluded paths) as a commit on top of HEAD, built in a PRIVATE index: the
    /// checkout's own index and files are never touched. A clean tree yields HEAD.
    static func snapshot(_ git: RepositoryGit, _ directory: String, index: String, message: String) throws -> String {
        let head = try git.line(directory, ["rev-parse", "HEAD"])
        var env = RepositoryGit.identity
        env["GIT_INDEX_FILE"] = index
        defer { unlink(index); unlink(index + ".lock") }
        try git.data(directory, ["read-tree", "HEAD"], env: env)
        try git.data(directory, ["add", "-A"], env: env)
        try unstageExcluded(git, directory, env: env)
        let tree = try git.line(directory, ["write-tree"], env: env)
        if tree.isEmpty { return head }
        if let headTree = try? git.line(directory, ["rev-parse", "HEAD^{tree}"]), headTree == tree { return head }
        let commit = try git.line(directory, ["commit-tree", tree, "-p", head, "-m", message], env: env)
        return commit.isEmpty ? head : commit
    }

    /// Git-style unresolved markers: `^<<<<<<< .+$`, `^=======$`, `^>>>>>>> .+$` (multiline).
    static func hasConflictMarkers(_ data: Data) -> Bool {
        var open = false, middle = false, close = false
        for raw in String(decoding: data, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: false) {
            var line = Substring(raw)
            if line.hasSuffix("\r") { line = line.dropLast() }
            if line.hasPrefix("<<<<<<< ") && line.count > 8 { open = true }
            else if line == "=======" { middle = true }
            else if line.hasPrefix(">>>>>>> ") && line.count > 8 { close = true }
            if open && middle && close { return true }
        }
        return false
    }

    static func isWorkBranch(_ branch: String) -> Bool { workPrefixes.contains { branch.hasPrefix($0) } }
    static func isChatBranch(_ branch: String) -> Bool { branch.hasPrefix("trezi/chat-") || branch.hasPrefix("praxis/chat-") }

    static func realpath(_ path: String) -> String? {
        guard let resolved = Darwin.realpath(path, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    /// `child` is `parent` or inside it (both already resolved).
    static func contains(_ parent: String, _ child: String) -> Bool {
        child == parent || child.hasPrefix(parent.hasSuffix("/") ? parent : parent + "/")
    }
}
