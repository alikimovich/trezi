import Foundation

/// The conversation coordinator's in-memory state (S11, LKM-97): one entry per live
/// chat with its turn, the pending approvals of every chat, and the background-spawn
/// admission queue. Pure: no files, no pipe. `ConversationOwner` persists what must
/// survive a crash (the chat's record) in `ConversationStore`; everything here is
/// rebuilt from Bun's live sessions after a restart, like the provider sessions it
/// describes. There is no TypeScript twin since LKM-111; a recorded golden pins the
/// answers (`test/fixtures/conversation-owner/parity-golden.json`).
struct ConversationChat {
    enum Phase: String { case idle, preparing, running, landing }

    let chat: String
    var project: String
    var root: String
    var record: JSValue
    var options: JSValue
    var phase: Phase = .idle
    /// The user turn in flight, and which provider run of it (a reconciliation
    /// continuation is run 1, 2, …). Terminal events name both.
    var turn: String?
    var run = 0
    var claimed = false
    var cancelled = false
    /// A model handoff waiting for its first turn (consumed by `send`).
    var handoff = false
    /// A generated title is being computed (so a second terminal never asks twice).
    var titling = false
    /// A title chosen by the user; a generated title never replaces it.
    var titleSource: String?
    /// Monotonic record version from Bun; an older checkpoint is refused.
    var sequence: Double = 0

    /// Takes Bun's newer record (the provider's transcript capture). An older one is
    /// refused; a title the owner already decided is never taken back by it.
    mutating func adopt(_ record: JSValue, sequence: Double) -> Bool {
        guard sequence > self.sequence else { return false }
        var next = record
        if let title = ConversationState.title(self.record), titleSource == "user" || ConversationState.title(next) == nil {
            ConversationState.set(&next, "title", .string(title))
        }
        self.record = next; self.sequence = sequence
        return true
    }
}

enum ConversationRefusal: Error {
    case notFound(String)
    case busy(String)
    case cancelled
}

struct ConversationState {
    static let maxSpawnsPerProject = 3
    /// Mirrors `EDIT_TOOLS` in `src/main/backends/tools.ts`: what `acceptEdits` approves.
    static let editTools: Set<String> = ["Edit", "Write", "MultiEdit", "NotebookEdit"]

    private(set) var chats: [String: ConversationChat] = [:]
    /// Live order of chats (insertion), so snapshots are deterministic.
    private(set) var order: [String] = []
    /// project → the chat last active in it.
    private(set) var active: [String: String] = [:]

    struct Pending { let chat: String; let kind: String; let tool: String }
    private(set) var pending: [String: Pending] = [:]
    private var pendingOrder: [String] = []

    struct Spawn { let id: String; let project: String }
    private(set) var running: [String: String] = [:]   // spawn id → project
    private(set) var queue: [Spawn] = []

    // MARK: Chats

    mutating func open(_ chat: ConversationChat, active makeActive: Bool) {
        if chats[chat.chat] == nil { order.append(chat.chat) }
        chats[chat.chat] = chat
        if makeActive { active[chat.project] = chat.chat }
    }

    func get(_ key: String) throws -> ConversationChat {
        guard let chat = chats[key] else { throw ConversationRefusal.notFound("That chat is closed.") }
        return chat
    }

    mutating func update(_ key: String, _ change: (inout ConversationChat) throws -> Void) throws {
        var chat = try get(key)
        try change(&chat)
        chats[key] = chat
    }

    mutating func activate(_ key: String) throws {
        let chat = try get(key)
        active[chat.project] = key
    }

    func isActive(_ chat: ConversationChat) -> Bool { active[chat.project] == chat.chat }

    /// Forgets the chat and its approvals; answers the approvals Bun must now deny.
    mutating func close(_ key: String) -> (chat: ConversationChat?, released: [(String, String)]) {
        let released = release(key)
        guard let chat = chats.removeValue(forKey: key) else { return (nil, released) }
        order.removeAll { $0 == key }
        if active[chat.project] == key { active.removeValue(forKey: chat.project) }
        return (chat, released)
    }

    var live: [ConversationChat] { order.compactMap { chats[$0] } }

    // MARK: Turns

    /// idle → preparing. One turn per chat: anything else is `busy`.
    mutating func begin(_ key: String, turn: String) throws {
        try update(key) { chat in
            guard chat.phase == .idle else { throw ConversationRefusal.busy("This chat is already running.") }
            chat.phase = .preparing; chat.turn = turn; chat.run = 0; chat.claimed = false; chat.cancelled = false
        }
    }

    /// preparing → running, once Bun's preparation (worktree sync, context) is done.
    /// Answers whether this turn must carry the model handoff (then consumed).
    mutating func send(_ key: String, turn: String) throws -> Bool {
        var handoff = false
        try update(key) { chat in
            guard chat.phase == .preparing, chat.turn == turn else { throw ConversationRefusal.notFound("That message is no longer being sent.") }
            guard !chat.cancelled else { throw ConversationRefusal.cancelled }
            chat.phase = .running
            handoff = chat.handoff; chat.handoff = false
        }
        return handoff
    }

    /// A turn that never reached the provider (preparation failed or was cancelled).
    mutating func abort(_ key: String, turn: String) -> Bool {
        guard var chat = chats[key], chat.turn == turn, chat.phase == .preparing || chat.phase == .running else { return false }
        chat.phase = .idle; chat.turn = nil; chat.claimed = false; chat.cancelled = false
        chats[key] = chat
        return true
    }

    /// Stop: the turn in flight lands as failed and never continues.
    mutating func cancel(_ key: String) -> (phase: ConversationChat.Phase, turn: String?) {
        guard var chat = chats[key] else { return (.idle, nil) }
        if chat.phase != .idle { chat.cancelled = true; chats[key] = chat }
        return (chat.phase, chat.turn)
    }

    enum Claim: Equatable { case claimed(success: Bool, title: Bool, memory: Bool), stale, duplicate }

    /// The completion policy. Exactly one terminal per run is claimed; a terminal for
    /// any other turn or run (a late event) is `stale` and changes nothing.
    mutating func terminal(_ key: String, turn: String, run: Int, done: Bool, record: JSValue, sequence: Double) -> Claim {
        guard var chat = chats[key], chat.turn == turn, chat.run == run, chat.phase == .running || chat.phase == .landing else { return .stale }
        guard !chat.claimed else { return .duplicate }
        // The policy reads the transcript as the terminal left it.
        _ = chat.adopt(record, sequence: sequence)
        chat.claimed = true; chat.phase = .landing
        let success = done && !chat.cancelled
        let spoken = Self.spoken(chat.record)
        let title = success && spoken && !chat.titling && Self.title(chat.record) == nil
        if title { chat.titling = true }
        chats[key] = chat
        return .claimed(success: success, title: title, memory: success && spoken)
    }

    /// landing → running: the one automatic reconciliation continuation of this turn.
    mutating func `continue`(_ key: String, turn: String, run: Int) -> Bool {
        guard var chat = chats[key], chat.turn == turn, chat.phase == .landing, chat.claimed, !chat.cancelled, run == chat.run + 1 else { return false }
        chat.phase = .running; chat.run = run; chat.claimed = false
        chats[key] = chat
        return true
    }

    /// landing → idle. Stamps `completedAt` on the turn's user entry (once).
    mutating func landed(_ key: String, turn: String, at: Double) -> Double? {
        guard var chat = chats[key], chat.turn == turn, chat.phase == .landing else { return nil }
        chat.phase = .idle; chat.turn = nil; chat.claimed = false; chat.cancelled = false
        let stamped = Self.complete(&chat.record, at: at)
        chats[key] = chat
        return stamped
    }

    // MARK: Approvals

    mutating func register(chat key: String, id: String, kind: String, tool: String) throws {
        _ = try get(key)
        if pending[id] == nil { pendingOrder.append(id) }
        pending[id] = Pending(chat: key, kind: kind, tool: tool)
    }

    /// Settles one approval; a late or repeated answer finds nothing.
    mutating func resolve(id: String, kind: String) -> String? {
        guard let entry = pending[id], entry.kind == kind else { return nil }
        pending.removeValue(forKey: id); pendingOrder.removeAll { $0 == id }
        return entry.chat
    }

    /// A more permissive mode releases the prompts it would not have asked.
    mutating func mode(_ key: String, mode: String) -> [String] {
        let allow = pendingOrder.filter { id in
            guard let entry = pending[id], entry.chat == key, entry.kind == "permission" else { return false }
            return mode == "bypassPermissions" || (mode == "acceptEdits" && Self.editTools.contains(entry.tool))
        }
        for id in allow { pending.removeValue(forKey: id) }
        pendingOrder.removeAll { allow.contains($0) }
        return allow
    }

    /// Every open approval of a chat (closed, replaced or interrupted), as (id, kind).
    mutating func release(_ key: String) -> [(String, String)] {
        let ids = pendingOrder.filter { pending[$0]?.chat == key }
        let released = ids.map { ($0, pending[$0]!.kind) }
        for id in ids { pending.removeValue(forKey: id) }
        pendingOrder.removeAll { ids.contains($0) }
        return released
    }

    // MARK: Spawns

    func count(_ project: String) -> Int { running.values.filter { $0 == project }.count }

    /// Admitted now, or queued FIFO behind the project's running spawns.
    mutating func spawn(id: String, project: String) -> Bool {
        if count(project) < Self.maxSpawnsPerProject { running[id] = project; return true }
        queue.append(Spawn(id: id, project: project))
        return false
    }

    /// A spawn finished (or failed to start): admits the next queued ones, in order.
    mutating func spawnDone(id: String) -> [String] {
        guard let project = running.removeValue(forKey: id) else { return [] }
        var started: [String] = []
        while count(project) < Self.maxSpawnsPerProject, let index = queue.firstIndex(where: { $0.project == project }) {
            let next = queue.remove(at: index)
            running[next.id] = project; started.append(next.id)
        }
        return started
    }

    /// Cancels a queued spawn (true) — a running one is interrupted by Bun instead.
    mutating func spawnCancel(id: String) -> Bool {
        guard let index = queue.firstIndex(where: { $0.id == id }) else { return false }
        queue.remove(at: index)
        return true
    }

    func busy(_ project: String) -> Bool {
        count(project) > 0 || queue.contains { $0.project == project }
            || chats.values.contains { $0.project == project && $0.phase != .idle }
    }

    // MARK: Records

    /// Both sides have spoken (a user and an assistant entry).
    static func spoken(_ record: JSValue) -> Bool {
        guard case .array(let entries)? = record["transcript"] else { return false }
        let roles = Set(entries.compactMap { $0["role"]?.text?.string })
        return roles.contains("user") && roles.contains("assistant")
    }

    static func title(_ record: JSValue) -> JSText? {
        guard let title = record["title"]?.text, !title.isEmpty else { return nil }
        return title
    }

    /// Sets the last user entry's `completedAt` if it has none; returns the value set.
    static func complete(_ record: inout JSValue, at: Double) -> Double? {
        guard case .object(var fields) = record, let index = fields.lastIndex(where: { $0.0 == JSText("transcript") }),
              case .array(var entries) = fields[index].1,
              let last = entries.lastIndex(where: { $0["role"]?.text?.string == "user" }),
              case .object(var entry) = entries[last] else { return nil }
        // `turn.completedAt = …`: an existing (null) key keeps its place, a new one goes last.
        if let index = entry.firstIndex(where: { $0.0 == JSText("completedAt") }) {
            guard entry[index].1 == .null else { return nil }
            entry[index].1 = .number(at)
        } else { entry.append((JSText("completedAt"), .number(at))) }
        entries[last] = .object(entry); fields[index].1 = .array(entries)
        record = .object(fields)
        return at
    }

    /// `record[key] = value` with JavaScript's property order (an existing key keeps its place).
    static func set(_ record: inout JSValue, _ key: String, _ value: JSValue?) {
        guard case .object(var fields) = record else { return }
        let name = JSText(key)
        if let value {
            if let index = fields.firstIndex(where: { $0.0 == name }) { fields[index].1 = value } else { fields.append((name, value)) }
        } else { fields.removeAll { $0.0 == name } }
        record = .object(fields)
    }
}
