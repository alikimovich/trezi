import Foundation

/// The body of a `github` request (`SkillsRequest.github`).
struct SkillsImportRequest: Sendable {
    let url: String, ref: String?, subpath: String?
    /// An existing skill imported from the same folder: the fetch becomes its new revision.
    let replacing: String?
}

/// GitHub import on the skills pipe (LKM-285). `github` starts a fetch and answers when
/// it ends, out of order with other replies (the frame `id` matches it); `cancel` names
/// the import's operation ID. At most `SkillsGitHubFetcher.maxImports` run at once, each
/// bounded by `importDeadline`. A fetch writes nothing; once it is validated the import
/// starts committing (no longer cancellable) and stores the package through `install`,
/// one ledger commit, so a failure at any step leaves the registry as it was.
extension SkillsOwner {
    func startImport(_ frame: PipeFrame, _ request: SkillsImportRequest) async -> Data {
        func refuse(_ failure: ServiceFailure) -> Data { Self.reply(id: frame.id, frame: frame, result: .failed(failure), snapshot: nil) }
        if let failure { return refuse(failure) }
        let operation = frame.operationID
        guard imports[operation] == nil else { return refuse(Self.fail(.conflict, "This import is already running.", operationID: operation)) }
        guard imports.count < SkillsGitHubFetcher.maxImports else {
            return refuse(Self.fail(.busy, "\(SkillsGitHubFetcher.maxImports) GitHub imports are already running. Try again when one finishes.", retryable: true, operationID: operation))
        }
        let work = Task { await self.runImport(frame, request) }
        imports[operation] = Import(connection: frame.connection, task: work)
        let deadline = UInt64(importDeadline * 1_000_000_000)
        let watchdog = Task {
            try? await Task.sleep(nanoseconds: deadline)
            if !Task.isCancelled { await self.expireImport(operation) }
        }
        let settle: @Sendable () async -> Data = {
            let reply = await work.value
            watchdog.cancel()
            await self.endImport(operation)
            return reply
        }
        guard let deliver else { return await settle() }
        Task { deliver(await settle()) }
        return Data()
    }

    /// Only the connection that started an import may cancel it, and only before it commits.
    func cancelImport(_ operation: String, connection: String) -> JSValue {
        var cancelled = false
        if let job = imports[operation], job.connection == connection, !job.committing { job.task.cancel(); cancelled = true }
        return .object([(JSText("operation"), .string(JSText(operation))), (JSText("cancelled"), .bool(cancelled))])
    }

    private func expireImport(_ operation: String) {
        guard var job = imports[operation], !job.committing else { return }
        job.expired = true
        imports[operation] = job
        job.task.cancel()
    }

    private func endImport(_ operation: String) { imports[operation] = nil }

    /// Marks the import as committing, unless it was cancelled, expired or the service stops.
    private func beginCommit(_ operation: String) -> ServiceFailure? {
        guard var job = imports[operation] else { return Self.fail(.cancelled, "The import was cancelled. Nothing was installed.", operationID: operation) }
        if job.expired { return Self.expired(operation, importDeadline) }
        if Task.isCancelled { return Self.fail(.cancelled, "The import was cancelled. Nothing was installed.", operationID: operation) }
        if closed { return Self.stopping }
        job.committing = true
        imports[operation] = job
        return nil
    }

    private func runImport(_ frame: PipeFrame, _ request: SkillsImportRequest) async -> Data {
        let operation = frame.operationID
        func done(_ result: PreferencesOwner.Answer, snapshot: JSValue? = nil) -> Data { Self.reply(id: frame.id, frame: frame, result: result, snapshot: snapshot) }
        let address: SkillsGitHubAddress
        do { address = try SkillsGitHubAddress.parse(url: request.url, ref: request.ref, subpath: request.subpath) }
        catch { return done(.failed(Self.failure(error, operationID: operation))) }
        let client = fetcher ?? SkillsGitHubFetcher(endpoints: github, limits: archiveLimits)
        fetcher = client
        let fetched: SkillsGitHubFetch
        do { fetched = try await client.fetch(address) }
        catch { return done(.failed(importFailure(error, operation))) }
        if let refused = beginCommit(operation) { return done(.failed(refused)) }
        let answer = await install(files: fetched.files, source: fetched.source, replacing: request.replacing)
        let snapshot = await committed().map(Self.listValue)
        guard case .succeeded(.object(let fields)) = answer else { return done(answer, snapshot: snapshot) }
        let name = (try? SkillsPackage.validate(fetched.files))?.name ?? ""
        return done(.succeeded(.object(fields + [
            (JSText("name"), .string(JSText(name))), (JSText("source"), fetched.source.value),
            (JSText("skipped"), .array(fetched.skipped.map { .string(JSText($0)) })),
            (JSText("attribution"), fetched.attribution.map { .string(JSText($0)) } ?? .null)
        ])), snapshot: snapshot)
    }

    private func importFailure(_ error: Error, _ operation: String) -> ServiceFailure {
        if imports[operation]?.expired == true { return Self.expired(operation, importDeadline) }
        switch error {
        case SkillsGitHubError.cancelled, is CancellationError:
            return closed ? Self.stopping : Self.fail(.cancelled, "The import was cancelled. Nothing was installed.", operationID: operation)
        case SkillsGitHubError.notFound(let message): return Self.fail(.notFound, message, operationID: operation)
        case SkillsGitHubError.unavailable(let message): return Self.fail(.unavailable, message, retryable: true, operationID: operation)
        default: return Self.failure(error, operationID: operation)
        }
    }

    static func expired(_ operation: String, _ deadline: TimeInterval) -> ServiceFailure {
        fail(.deadlineExceeded, "The import took longer than \(Int(deadline)) seconds and was stopped. Nothing was installed.", retryable: true, operationID: operation)
    }
}
