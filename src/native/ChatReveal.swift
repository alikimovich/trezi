import CoreGraphics

/// One test-only island reveal. The revision identifies the request; the
/// island/edge pair identifies the anchor whose measured frame proves it.
struct IslandRevealRequest: Equatable {
    let revision: Int
    let island: String
    let bottom: Bool
    /// ID of the message row containing the island (a direct lazy-stack child).
    let message: String
    /// Key published through `IslandPositions` by `NativeChatIsland`.
    var position: String { (bottom ? "end-" : "start-") + island }
    /// SwiftUI scroll ID attached to the same anchor.
    var anchor: String { (bottom ? "island-end-" : "island-start-") + island }
}

/// Where `scrollTo` aligns its target. SwiftUI aligns the SAME unit point of the
/// target view and the viewport, so the reading edge (a fraction of the viewport)
/// only lands a view's bottom there when the view is ~1pt tall, like the anchors.
enum IslandRevealEdge: Equatable { case top, bottom, readingBottom }
struct IslandRevealScroll: Equatable {
    let id: String
    let edge: IslandRevealEdge
}
/// Unit-point y for `edge` in a viewport whose reading area ends at `readingHeight`.
func islandRevealUnitY(_ edge: IslandRevealEdge, readingHeight: CGFloat, viewportHeight: CGFloat) -> CGFloat {
    switch edge {
    case .top: return 0
    case .bottom: return 1
    case .readingBottom: return readingHeight / max(1, viewportHeight)
    }
}

/// Next reveal attempt. `scrollTo` resolves a nested anchor only while its lazy
/// row is on screen: an unrealized row publishes no frame, and a retained
/// offscreen row (e.g. after a width change reflows the history) publishes one
/// but does not move. Until the anchor is inside the viewport (behind the
/// composer counts), bring the containing row (a direct lazy-stack child) in by
/// its own near edge — aligning a tall row's reading-edge unit point instead
/// left a bottom anchor parked behind the composer on every attempt.
func islandRevealScroll(_ request: IslandRevealRequest, positions: [String: CGRect], viewportHeight: CGFloat) -> IslandRevealScroll {
    guard let frame = positions[request.position], frame.maxY > 0, frame.minY < viewportHeight else {
        return IslandRevealScroll(id: request.message, edge: request.bottom ? .bottom : .top)
    }
    return IslandRevealScroll(id: request.anchor, edge: request.bottom ? .readingBottom : .top)
}

/// Consecutive on-edge measurements a reveal needs before it counts as applied.
/// The lazy stack can re-measure rows above the target after the first
/// `scrollTo` lands (the recorded `revision=1, applied=1, attempts=1,
/// frame={{32, 44.2}, {376, 16}}`: the anchor reached the edge once, then
/// drifted 44pt), so one hit is not a settled reveal; drift resets the streak
/// and the attempt loop scrolls again.
let islandRevealStableChecks = 3
func islandRevealStreak(reached: Bool, streak: Int) -> Int { reached ? streak + 1 : 0 }

enum IslandRevealState: Equatable {
    case pending
    case settled(CGRect)
    /// A newer request replaced the viewport target before this one settled.
    case superseded(by: Int)
}

/// Whether the measured anchor reaches the requested edge of the reading area.
func islandRevealReached(_ request: IslandRevealRequest, frame: CGRect, readingHeight: CGFloat, tolerance: CGFloat = 8) -> Bool {
    abs((request.bottom ? frame.maxY : frame.minY) - (request.bottom ? readingHeight : 0)) <= tolerance
}

/// Resolve a reveal only against its own revision and anchor. Once a newer
/// request exists the viewport belongs to that request, so the older one is
/// superseded even if its stale anchor happens to sit at its requested edge.
func islandRevealState(_ request: IslandRevealRequest, currentRevision: Int, appliedRevision: Int,
                       positions: [String: CGRect], readingHeight: CGFloat) -> IslandRevealState {
    if currentRevision != request.revision { return .superseded(by: currentRevision) }
    guard appliedRevision == request.revision, let frame = positions[request.position],
          islandRevealReached(request, frame: frame, readingHeight: readingHeight) else { return .pending }
    return .settled(frame)
}
