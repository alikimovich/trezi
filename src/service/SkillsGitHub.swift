import Foundation

/// Where a GitHub import is fetched from. The shipped service uses GitHub's API (to
/// resolve a ref to a commit) and codeload (the commit's archive); tests use a
/// loopback server with the same paths.
struct SkillsGitHubEndpoints: Sendable {
    let api: String, archive: String
    let loopback: Bool
    static let github = SkillsGitHubEndpoints(api: "https://api.github.com", archive: "https://codeload.github.com", loopback: false)
    static func loopback(port: Int) -> SkillsGitHubEndpoints {
        SkillsGitHubEndpoints(api: "http://127.0.0.1:\(port)/api", archive: "http://127.0.0.1:\(port)/codeload", loopback: true)
    }
    /// The native smoke's loopback GitHub (LKM-286, `src/native/skills-github-fixture.ts`,
    /// started by `scripts/start-native.mjs --test`). Compiled only into the `test` build
    /// profile (`-D TREZI_TEST_PROFILE`, `scripts/native-swift.mjs`); a release build has no
    /// such switch and always keeps `.github`. Even there it needs a disposable launch:
    /// `TREZI_NATIVE_TEST_DIR` is set, the profile lives inside it, and the endpoint is
    /// 127.0.0.1 on the fixture's port, never another host.
    static func fixture(environment: [String: String], profile: String) -> SkillsGitHubEndpoints? {
        #if TREZI_TEST_PROFILE
        guard let directory = environment["TREZI_NATIVE_TEST_DIR"], !directory.isEmpty,
              URL(fileURLWithPath: profile).standardizedFileURL.path.hasPrefix(URL(fileURLWithPath: directory).standardizedFileURL.path + "/"),
              let port = environment["TREZI_SKILLS_GITHUB_FIXTURE_PORT"].flatMap(Int.init), (1024...65535).contains(port) else { return nil }
        return loopback(port: port)
        #else
        return nil
        #endif
    }
}

/// An import address, parsed strictly from `https://github.com/<owner>/<repo>` (with an
/// optional `ref` and `subpath`) or `https://github.com/<owner>/<repo>/tree/<ref>/<folder>`.
/// Only `A-Z a-z 0-9 . _ - /` may follow the host: no percent-encoding, query, fragment,
/// credentials, port, backslash or empty, `.`, `..` or hidden component. A tree address
/// cannot say where a ref with `/` ends, so every split is resolved and more than one
/// match is refused as ambiguous.
struct SkillsGitHubAddress: Equatable, Sendable {
    struct Candidate: Equatable, Sendable { let ref: String; let subpath: String }
    let owner: String, repo: String
    /// The (ref, folder) splits to resolve; empty means the default branch with `subpath`.
    let candidates: [Candidate]
    let subpath: String
    var repository: String { owner + "/" + repo }

    static let prefix = "https://github.com/"
    static let maxURL = 2048

    static func parse(url: String, ref: String?, subpath: String?) throws -> SkillsGitHubAddress {
        func invalid(_ message: String) -> SkillsPackageError { .invalid(message) }
        guard url.utf8.count <= maxURL, url.hasPrefix(prefix) else {
            throw invalid("Use a https://github.com/<owner>/<repository> address.")
        }
        var rest = String(url.dropFirst(prefix.count))
        if rest.hasSuffix("/") { rest.removeLast() }
        guard rest.utf8.allSatisfy(Self.safeByte) else {
            throw invalid("The address may only hold letters, digits, “.”, “_”, “-” and “/” after github.com.")
        }
        var parts = rest.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 2, parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            throw invalid("Use a https://github.com/<owner>/<repository> address.")
        }
        if parts.count == 2, parts[1].hasSuffix(".git"), parts[1].count > 4 { parts[1].removeLast(4) }
        guard validOwner(parts[0]), validRepo(parts[1]) else { throw invalid("“\(parts[0])/\(parts[1])” is not a GitHub repository name.") }
        if parts.count == 2 {
            if let ref { guard validRef(ref) else { throw invalid("“\(ref.prefix(80))” is not a branch, tag or full commit.") } }
            let folder = subpath ?? ""
            guard folder.isEmpty || SkillsPackage.validPath(folder) else { throw invalid("“\(folder.prefix(80))” is not an allowed folder.") }
            return SkillsGitHubAddress(owner: parts[0], repo: parts[1], candidates: ref.map { [Candidate(ref: $0, subpath: folder)] } ?? [], subpath: folder)
        }
        guard parts[2] == "tree", parts.count >= 4 else {
            throw invalid("Use the address of a repository or of a folder in it (…/tree/<branch>/<folder>).")
        }
        guard ref == nil, subpath == nil else { throw invalid("The address already names a branch and folder; send it without ref or subpath.") }
        let tail = Array(parts[3...])
        guard tail.count <= 1 + SkillsLimits.maxDepth + 8 else { throw invalid("The address is nested too deeply.") }
        var candidates: [Candidate] = []
        let splits = isCommit(tail[0]) ? 1...1 : 1...min(tail.count, 8)
        for count in splits {
            let candidate = Candidate(ref: tail[..<count].joined(separator: "/"), subpath: tail[count...].joined(separator: "/"))
            if validRef(candidate.ref), candidate.subpath.isEmpty || SkillsPackage.validPath(candidate.subpath) { candidates.append(candidate) }
        }
        guard !candidates.isEmpty else { throw invalid("The address does not name a valid branch and folder.") }
        return SkillsGitHubAddress(owner: parts[0], repo: parts[1], candidates: candidates, subpath: "")
    }

    static func safeByte(_ byte: UInt8) -> Bool {
        (0x41...0x5A).contains(byte) || (0x61...0x7A).contains(byte) || (0x30...0x39).contains(byte) || byte == 0x2E || byte == 0x5F || byte == 0x2D || byte == 0x2F
    }
    /// GitHub user and organisation names: 1–39 of `A-Z a-z 0-9 -`, no edge hyphen.
    static func validOwner(_ name: String) -> Bool {
        (1...39).contains(name.utf8.count) && name.first != "-" && name.last != "-"
            && name.utf8.allSatisfy { (0x41...0x5A).contains($0) || (0x61...0x7A).contains($0) || (0x30...0x39).contains($0) || $0 == 0x2D }
    }
    static func validRepo(_ name: String) -> Bool { SkillSource.validRepository("x/" + name) && !name.hasPrefix(".") }
    static func isCommit(_ value: String) -> Bool { SkillSource.validCommit(value) }
    /// A branch or tag (git's component rules on the safe alphabet) or a full commit. An
    /// abbreviated commit (7–39 hex digits) is refused: it may match more than one object.
    static func validRef(_ ref: String) -> Bool {
        guard (1...255).contains(ref.utf8.count), ref.utf8.allSatisfy(safeByte), ref != "HEAD" else { return false }
        if isCommit(ref) { return true }
        if (7...39).contains(ref.utf8.count), ref.utf8.allSatisfy({ (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }) { return false }
        return ref.split(separator: "/", omittingEmptySubsequences: false).allSatisfy { part in
            !part.isEmpty && !part.hasPrefix(".") && !part.hasSuffix(".") && !part.hasSuffix(".lock") && !part.contains("..")
        }
    }
}

enum SkillsGitHubError: Error, Equatable {
    case notFound(String), unavailable(String), cancelled
}

/// A skill fetched at one commit, validated and ready for `SkillsOwner.install`.
struct SkillsGitHubFetch: Sendable {
    let files: [SkillFile]
    let source: SkillSource
    let skipped: [String]
    /// The repository license copied into the package (its path), if any.
    let attribution: String?
}

/// The service-side GitHub import (LKM-285): resolve the ref to a full commit, then
/// download that commit's archive (never a branch), read the folder through
/// `SkillsArchive`, check the skills-only scope (`SkillsScope`) and the license. It
/// writes nothing and runs nothing; the caller stores the result in one ledger commit,
/// so a failure or cancellation at any step leaves no partial install.
struct SkillsGitHubFetcher: Sendable {
    static let deadline: TimeInterval = 120
    static let maxImports = 2
    static let maxJSONBytes = 1024 * 1024

    let endpoints: SkillsGitHubEndpoints
    let http: SkillsHTTP
    var limits = SkillsArchiveLimits()

    init(endpoints: SkillsGitHubEndpoints, limits: SkillsArchiveLimits = SkillsArchiveLimits()) {
        self.endpoints = endpoints; self.limits = limits
        http = SkillsHTTP(loopback: endpoints.loopback)
    }

    func fetch(_ address: SkillsGitHubAddress) async throws -> SkillsGitHubFetch {
        let base = "/repos/\(address.owner)/\(address.repo)"
        var candidates = address.candidates
        if candidates.isEmpty {
            guard let data = try await get(endpoints.api + base, accept: "application/vnd.github+json", limit: Self.maxJSONBytes, what: "The repository") else {
                throw SkillsGitHubError.notFound("\(address.repository) \(Self.missing)")
            }
            guard let branch = (try? JSValue.parse(data, maxDepth: 32))?["default_branch"]?.text?.string, SkillsGitHubAddress.validRef(branch) else {
                throw SkillsGitHubError.unavailable("GitHub did not name the repository's default branch.")
            }
            candidates = [.init(ref: branch, subpath: address.subpath)]
        }
        var resolved: [(SkillsGitHubAddress.Candidate, String)] = []
        for candidate in candidates {
            guard let commit = try await resolve(base, candidate.ref) else { continue }
            resolved.append((candidate, commit))
        }
        guard let (target, commit) = resolved.first else { throw SkillsGitHubError.notFound("No branch, tag or commit of \(address.repository) matches the address.") }
        guard resolved.count == 1 else {
            throw SkillsPackageError.invalid("The address is ambiguous: \(resolved.map { "“\($0.0.ref)”" }.joined(separator: " and ")) are both refs. Send the repository address with ref and subpath.")
        }
        guard let archive = try await get("\(endpoints.archive)/\(address.owner)/\(address.repo)/tar.gz/\(commit)", accept: "application/octet-stream",
                                          limit: limits.compressed, what: "The archive") else {
            throw SkillsGitHubError.notFound("The archive of \(commit.prefix(12)) \(Self.missing)")
        }
        let contents: SkillsArchiveContents
        do { contents = try SkillsArchive.read(archive, subpath: target.subpath, limits: limits, cancelled: { Task.isCancelled }) }
        catch is CancellationError { throw SkillsGitHubError.cancelled }
        catch SkillsArchive.Failure.refused(let message) { throw SkillsPackageError.refused(message) }
        catch SkillsArchive.Failure.invalid(let message) { throw SkillsPackageError.invalid(message) }
        catch SkillsArchive.Failure.tooLarge(let message) { throw SkillsPackageError.invalid(message) }
        guard contents.commit == commit else { throw SkillsPackageError.refused("The archive is not commit \(commit.prefix(12)); nothing was installed.") }
        let folder = target.subpath.isEmpty ? "the repository root" : target.subpath
        guard contents.found, !contents.files.isEmpty else { throw SkillsGitHubError.notFound("\(address.repository) has no folder \(folder) at \(commit.prefix(12)).") }
        guard contents.files.contains(where: { $0.path == SkillsPackage.entryFile }) else {
            throw SkillsPackageError.invalid("\(folder) has no SKILL.md at its top level.")
        }
        try SkillsScope.check(contents.files)
        let evidence = SkillsLicense.evidence(files: contents.files, subpath: target.subpath, rootLicenses: contents.rootLicenses)
        var files = contents.files
        if let attribution = evidence.attribution { files.append(attribution) }
        _ = try SkillsPackage.validate(files)
        try Task.checkCancellation()
        return SkillsGitHubFetch(files: files,
            source: .github(repository: address.repository, subpath: target.subpath, commit: commit, license: evidence.license,
                            ref: target.ref, licenseFile: evidence.file),
            skipped: contents.skipped, attribution: evidence.attribution?.path)
    }

    /// The full commit a ref names, or nil when GitHub has no such ref.
    private func resolve(_ base: String, _ ref: String) async throws -> String? {
        guard let data = try await get(endpoints.api + base + "/commits/" + ref, accept: "application/vnd.github.sha", limit: 256, what: "The ref") else { return nil }
        let commit = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard SkillSource.validCommit(commit), !SkillSource.validCommit(ref) || commit == ref else {
            throw SkillsGitHubError.unavailable("GitHub answered with an invalid commit for \(ref.prefix(80)).")
        }
        return commit
    }

    /// The body of a 200 answer, nil for 404 (and 422, GitHub's answer for an unknown
    /// commit). A redirect is refused, any other status is reported as unavailable.
    private func get(_ address: String, accept: String, limit: Int, what: String) async throws -> Data? {
        guard let url = URL(string: address), http.allowed(url) else { throw SkillsPackageError.invalid("Refused address.") }
        let response: SkillsHTTP.Response
        do { response = try await http.get(url, accept: accept, limit: limit) }
        catch SkillsHTTP.Failure.tooLarge { throw SkillsPackageError.invalid("\(what) is larger than allowed.") }
        catch SkillsHTTP.Failure.cancelled { throw SkillsGitHubError.cancelled }
        catch is CancellationError { throw SkillsGitHubError.cancelled }
        catch { throw SkillsGitHubError.unavailable("GitHub could not be reached (\(error)). Nothing was installed.") }
        switch response.status {
        case 200: return response.data
        case 404, 422: return nil
        case 300..<400: throw SkillsPackageError.refused("GitHub redirected the request (HTTP \(response.status)); redirects are not followed. Use the repository's current address.")
        default: throw SkillsGitHubError.unavailable("GitHub refused the request (HTTP \(response.status)), for example its rate limit. Try again later.")
        }
    }
    static let missing = "was not found on GitHub. Private repositories are not supported."
}
