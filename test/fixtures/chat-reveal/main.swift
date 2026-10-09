import CoreGraphics
import Foundation

// Pure reveal acknowledgement logic: no application, window or run loop.
func require(_ condition: Bool, _ message: String) {
    if !condition { fputs("FAIL: \(message)\n", stderr); exit(1) }
}
let height: CGFloat = 600
let top = IslandRevealRequest(revision: 1, island: "shadow", bottom: false, message: "panel")
let bottom = IslandRevealRequest(revision: 2, island: "shadow", bottom: true, message: "panel")
require(top.position == "start-shadow" && top.anchor == "island-start-shadow", "Top reveal targets the island title anchor")
require(bottom.position == "end-shadow" && bottom.anchor == "island-end-shadow", "Bottom reveal targets the island end anchor")

// Overlap: the top request is still polling when the bottom request arrives and
// SwiftUI applies revision 2. The stale title frame sits exactly at the top
// edge, which the previous `applied >= revision` check acknowledged.
let staleTopAtEdge: [String: CGRect] = ["start-shadow": CGRect(x: 0, y: 0, width: 300, height: 20),
                                        "end-shadow": CGRect(x: 0, y: height - 1, width: 300, height: 1)]
require(islandRevealState(top, currentRevision: 2, appliedRevision: 2, positions: staleTopAtEdge, readingHeight: height) == .superseded(by: 2),
        "A superseded top reveal is never acknowledged with the newer revision's applied state")
require(islandRevealState(bottom, currentRevision: 2, appliedRevision: 2, positions: staleTopAtEdge, readingHeight: height) == .settled(staleTopAtEdge["end-shadow"]!),
        "The newest reveal settles against its own anchor")

// Superseded before anything was applied, and by a same-edge request.
require(islandRevealState(top, currentRevision: 2, appliedRevision: 0, positions: [:], readingHeight: height) == .superseded(by: 2),
        "Supersession does not wait for the newer request to apply")
let topAgain = IslandRevealRequest(revision: 3, island: "shadow", bottom: false, message: "panel")
require(islandRevealState(top, currentRevision: 3, appliedRevision: 3, positions: staleTopAtEdge, readingHeight: height) == .superseded(by: 3),
        "A same-target newer request still supersedes the older one")
require(islandRevealState(topAgain, currentRevision: 3, appliedRevision: 3, positions: staleTopAtEdge, readingHeight: height) == .settled(staleTopAtEdge["start-shadow"]!),
        "The same-target newest request settles")

// The newest request waits for its own applied revision, not an older one.
require(islandRevealState(bottom, currentRevision: 2, appliedRevision: 1, positions: staleTopAtEdge, readingHeight: height) == .pending,
        "An older applied revision cannot acknowledge a newer request")
// Applied but the measured anchor has not reached the requested edge.
let offEdge: [String: CGRect] = ["end-shadow": CGRect(x: 0, y: height + 100, width: 300, height: 1)]
require(islandRevealState(bottom, currentRevision: 2, appliedRevision: 2, positions: offEdge, readingHeight: height) == .pending,
        "An applied revision still requires measured edge settlement")
require(islandRevealState(bottom, currentRevision: 2, appliedRevision: 2, positions: [:], readingHeight: height) == .pending,
        "A missing anchor frame remains pending")
// A nested anchor in an offscreen lazy row cannot be scrolled to: target the
// containing message row, by its own near edge, until the anchor is on screen.
let viewport: CGFloat = 800
let row = { (edge: IslandRevealEdge) in IslandRevealScroll(id: "panel", edge: edge) }
require(islandRevealScroll(top, positions: [:], viewportHeight: viewport) == row(.top), "Unrealized top anchor scrolls its message row's top in first")
require(islandRevealScroll(bottom, positions: ["start-shadow": staleTopAtEdge["start-shadow"]!], viewportHeight: viewport) == row(.bottom),
        "Bottom reveal needs its own end anchor, not the start anchor, before targeting it")
require(islandRevealScroll(top, positions: staleTopAtEdge, viewportHeight: viewport) == IslandRevealScroll(id: "island-start-shadow", edge: .top), "Visible top anchor is targeted directly")
require(islandRevealScroll(bottom, positions: staleTopAtEdge, viewportHeight: viewport) == IslandRevealScroll(id: "island-end-shadow", edge: .readingBottom),
        "Visible bottom anchor is targeted at the reading edge")
// Retained but offscreen rows (the native 320pt failure: title frame at y=1760
// after a width change reflowed the history) still publish frames.
let belowViewport: [String: CGRect] = ["start-shadow": CGRect(x: 32, y: 1760, width: 256, height: 16)]
require(islandRevealScroll(top, positions: belowViewport, viewportHeight: viewport) == row(.top), "Anchor below the viewport scrolls its message row in first")
let aboveViewport: [String: CGRect] = ["end-shadow": CGRect(x: 32, y: -900, width: 256, height: 1)]
require(islandRevealScroll(bottom, positions: aboveViewport, viewportHeight: viewport) == row(.bottom), "Anchor above the viewport scrolls its message row in first")
// Behind the composer is outside the reading area but still on screen, where
// scrollTo resolves the nested anchor (the Shadow Light end anchor at 718.5).
require(islandRevealScroll(bottom, positions: ["end-shadow": CGRect(x: 36, y: 718.5, width: 368, height: 1)], viewportHeight: 776).id == "island-end-shadow",
        "An anchor behind the composer is targeted directly")
require(islandRevealScroll(top, positions: ["start-shadow": CGRect(x: 0, y: viewport, width: 1, height: 16)], viewportHeight: viewport) == row(.top),
        "An anchor starting at the viewport's bottom edge is offscreen")
require(islandRevealUnitY(.readingBottom, readingHeight: 580, viewportHeight: 776) == 580 / 776 && islandRevealUnitY(.bottom, readingHeight: 580, viewportHeight: 776) == 1,
        "Only anchors use the reading-edge unit point")

// Drive the attempt loop against SwiftUI's scrollTo alignment (the target's and
// the viewport's same unit point coincide). A nested anchor only moves while it
// is on screen; the row, a direct lazy child, always does.
func settles(_ request: IslandRevealRequest, rowTop: CGFloat, rowHeight: CGFloat, startOffset: CGFloat, endOffset: CGFloat,
             viewportHeight: CGFloat, readingHeight: CGFloat) -> Bool {
    var rowTop = rowTop
    func positions() -> [String: CGRect] {
        ["start-shadow": CGRect(x: 36, y: rowTop + startOffset, width: 368, height: 16), "end-shadow": CGRect(x: 36, y: rowTop + endOffset, width: 368, height: 1)]
    }
    for _ in 1...80 {
        let target = islandRevealScroll(request, positions: positions(), viewportHeight: viewportHeight)
        let u = islandRevealUnitY(target.edge, readingHeight: readingHeight, viewportHeight: viewportHeight)
        if target.id == request.message {
            rowTop = u * viewportHeight - u * rowHeight
        } else if let frame = positions()[request.position], frame.maxY > 0, frame.minY < viewportHeight {
            rowTop += u * viewportHeight - (frame.minY + u * frame.height)
        }
        if islandRevealReached(request, frame: positions()[request.position]!, readingHeight: readingHeight) { return true }
    }
    return false
}
// The recorded Shadow Light failure: `revision=2, applied=1, attempts=80,
// frame={{36, 718.5}, {368, 1}}` in a 776pt viewport reading to 580. Aligning
// the 621pt row's 580/776 point parked the end anchor at 718.5 every attempt.
require(settles(bottom, rowTop: 116, rowHeight: 621, startOffset: 45, endOffset: 602.5, viewportHeight: 776, readingHeight: 580),
        "A tall row's bottom reveal leaves the composer-covered fixed point")
require(settles(top, rowTop: 1760 - 45, rowHeight: 621, startOffset: 45, endOffset: 602.5, viewportHeight: 776, readingHeight: 580),
        "A retained row far below the viewport reaches the top edge")
require(settles(bottom, rowTop: -900 - 602.5, rowHeight: 621, startOffset: 45, endOffset: 602.5, viewportHeight: 776, readingHeight: 580),
        "A retained row far above the viewport reaches the reading edge")
require(settles(bottom, rowTop: 3000, rowHeight: 1400, startOffset: 45, endOffset: 1381.5, viewportHeight: 776, readingHeight: 580),
        "A row taller than the viewport reaches the reading edge from below")
// The recorded drift: `revision=1, applied=1, attempts=1, frame={{32, 44.2}, {376, 16}}`.
// One on-edge hit used to count as applied; the streak needs several in a row and
// restarts when the anchor drifts off the edge.
var streak = 0
for reached in [true, true, false, true, true] { streak = islandRevealStreak(reached: reached, streak: streak) }
require(streak == 2 && streak < islandRevealStableChecks, "A drift off the edge restarts the stability streak")
for _ in 0..<islandRevealStableChecks { streak = islandRevealStreak(reached: true, streak: streak) }
require(streak >= islandRevealStableChecks, "Consecutive on-edge measurements settle the reveal")
require(!islandRevealReached(top, frame: CGRect(x: 32, y: 44.237, width: 376, height: 16), readingHeight: height), "A 44pt drift is not at the top edge")
// Tolerance boundary.
require(islandRevealReached(top, frame: CGRect(x: 0, y: 8, width: 1, height: 1), readingHeight: height), "Top within 8 points")
require(!islandRevealReached(top, frame: CGRect(x: 0, y: -8.5, width: 1, height: 1), readingHeight: height), "Top beyond 8 points")

print("Native chat reveal: overlapping island reveals resolve only against their own revision and anchor.")
