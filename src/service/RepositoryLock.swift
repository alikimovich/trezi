import Foundation
import Darwin

/// Stale Git lock cleanup (LKM-225). A crashed or killed Git leaves `index.lock` behind
/// and every later Git effect in that checkout fails. The lock is removed only when it
/// is a plain file at least `minAge` seconds old and no Git process has its working
/// directory in the checkout (or its Git directory); otherwise it is left alone.
extension RepositoryEffects {
    /// `reason`: `removed`, `none` (no lock), `fresh` (younger than `minAge`), `git-running`
    /// (a Git process may own it) or `unsafe` (not a plain file). `age` is whole seconds.
    func clearStaleIndexLock(_ c: RepositoryContext, minAge: TimeInterval, now: Date = Date()) throws
        -> (removed: Bool, reason: String, age: Int?) {
        let paths = try git.text(c.root, ["rev-parse", "--path-format=absolute", "--git-path", "index.lock", "--show-toplevel"])
            .split(separator: "\n").map(String.init)
        guard let lock = paths.first, lock.hasPrefix("/"), lock.hasSuffix("/index.lock") else {
            throw RepositoryRefusal(.invalidRequest, "Not a Git checkout: \(c.root)")
        }
        var before = stat()
        guard lstat(lock, &before) == 0 else { return (false, "none", nil) }
        guard (before.st_mode & S_IFMT) == S_IFREG else { return (false, "unsafe", nil) }
        let age = max(0, Int(now.timeIntervalSince1970 - TimeInterval(before.st_mtimespec.tv_sec)))
        guard TimeInterval(age) >= minAge else { return (false, "fresh", age) }
        let gitDir = (lock as NSString).deletingLastPathComponent
        let tops = [paths.count > 1 ? paths[1] : nil, gitDir].compactMap { $0 }.map { RepositoryPaths.realpath($0) ?? $0 }
        if Self.gitRunning(near: tops) { return (false, "git-running", age) }
        // The lock must still be the file we judged: a new Git may have replaced it meanwhile.
        var after = stat()
        guard lstat(lock, &after) == 0, after.st_ino == before.st_ino, after.st_mtimespec.tv_sec == before.st_mtimespec.tv_sec,
              unlink(lock) == 0 else { return (false, "fresh", age) }
        log("Removed a stale Git lock (\(age) s old) in \(c.root)")
        return (true, "removed", age)
    }

    /// True when a process named `git` (or a `git-*` helper) may be working in one of
    /// `directories`. A process whose directory cannot be read counts as running.
    static func gitRunning(near directories: [String]) -> Bool {
        let bytes = proc_listallpids(nil, 0)
        guard bytes > 0 else { return true }
        var pids = [pid_t](repeating: 0, count: Int(bytes) + 64)
        let found = proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size))
        guard found > 0 else { return true }
        var name = [CChar](repeating: 0, count: 64)
        for pid in pids.prefix(Int(found)) where pid > 0 {
            guard proc_name(pid, &name, UInt32(name.count)) > 0 else { continue }
            let command = String(cString: name)
            guard command == "git" || command.hasPrefix("git-") else { continue }
            guard let cwd = workingDirectory(pid) else { return true }
            let real = RepositoryPaths.realpath(cwd) ?? cwd
            if directories.contains(where: { RepositoryPaths.contains($0, real) }) { return true }
        }
        return false
    }

    private static func workingDirectory(_ pid: pid_t) -> String? {
        var info = proc_vnodepathinfo()
        let size = Int32(MemoryLayout<proc_vnodepathinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, size) == size else { return nil }
        return withUnsafePointer(to: &info.pvi_cdir.vip_path) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) { String(cString: $0) }
        }
    }
}
