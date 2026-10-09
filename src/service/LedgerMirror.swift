import Foundation

/// A consumer's copy of one ledger domain (the future UI/controller side). State
/// only moves forward through a snapshot or the next event in sequence; a reply
/// resolves its pending operation but never writes state, so a late or cancelled
/// response can't overwrite a newer snapshot. Any gap or foreign epoch asks for
/// a snapshot instead of guessing. Local drafts live elsewhere and are untouched.
struct LedgerMirror {
    enum Applied: String, Equatable { case applied, stale, snapshotRequired }
    let domain: String
    private(set) var cursor: ServiceCursor?
    private(set) var revision: ServiceRevision?
    private(set) var value: [String: ServiceJSON] = [:]

    init(domain: String) { self.domain = domain }

    mutating func apply(_ snapshot: ServiceSnapshot) -> Applied {
        if let cursor, cursor.serviceEpoch == snapshot.cursor.serviceEpoch,
           let held = UInt64(cursor.sequence), let offered = UInt64(snapshot.cursor.sequence), offered < held {
            return .stale
        }
        cursor = snapshot.cursor; revision = snapshot.revision; value = snapshot.value
        return .applied
    }

    mutating func apply(_ event: ServiceEvent) -> Applied {
        guard let cursor, event.serviceEpoch == cursor.serviceEpoch,
              let held = UInt64(cursor.sequence), let sequence = UInt64(event.sequence) else { return .snapshotRequired }
        if sequence <= held { return .stale }
        guard sequence == held + 1 else { return .snapshotRequired }
        self.cursor = ServiceCursor(serviceEpoch: cursor.serviceEpoch, sequence: event.sequence)
        if event.value["domain"] == .string(domain), let revision = event.revision {
            self.revision = revision
            if let checkpoint = event.value["checkpoint"]?.object { value = checkpoint }
        }
        return .applied
    }

    /// A reply's committed revision either is already reflected (`stale`) or is
    /// ahead of this copy (`snapshotRequired`: fetch deltas/snapshot). Never applied.
    func acknowledge(_ committed: ServiceRevision) -> Applied {
        guard let revision, revision.epoch == committed.epoch,
              let held = UInt64(revision.counter), let offered = UInt64(committed.counter) else { return .snapshotRequired }
        return offered <= held ? .stale : .snapshotRequired
    }
}
