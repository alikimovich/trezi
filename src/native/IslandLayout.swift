import AppKit

/// Where a moved island sits, kept from its nearest corner of the preview so a window resize
/// keeps it there (LKM-180). `x` and `y` are its matching edge's distance from that corner's
/// edges in canvas points (y grows downwards): negative from the right or bottom edge. The
/// top-right corner is the one LKM-179's saved Layers offset used, so that offset still reads.
struct IslandSpot: Equatable {
    var x: CGFloat, y: CGFloat, left = false, bottom = false
    /// The corner as saved: 1 for the left edge, 2 for the bottom; 0 is top-right.
    var corner: Double { Double((left ? 1 : 0) | (bottom ? 2 : 0)) }
    init(x: CGFloat, y: CGFloat, corner: Double = 0) { self.x = x; self.y = y; left = Int(corner) & 1 != 0; bottom = Int(corner) & 2 != 0 }
    /// The spot of `frame` from `area`'s nearest corner.
    init(_ frame: NSRect, in area: NSRect) {
        left = frame.midX < area.midX; bottom = frame.midY > area.midY
        x = left ? frame.minX - area.minX : frame.maxX - area.maxX
        y = bottom ? frame.maxY - area.maxY : frame.minY - area.minY
    }
    func frame(_ size: NSSize, in area: NSRect) -> NSRect {
        NSRect(x: left ? area.minX + x : area.maxX + x - size.width, y: bottom ? area.maxY + y - size.height : area.minY + y, width: size.width, height: size.height)
    }
}

/// Moving rules every floating island shares (LKM-180): kept inside the preview at the
/// standard inset, snapped to its edges and to the other island's within `threshold`, and
/// never dropped onto another island.
enum IslandPlacement {
    static let threshold: CGFloat = 8, gap: CGFloat = 10
    /// `frame` kept inside `inner` at its size (pinned to `inner`'s origin if larger).
    static func clamp(_ frame: NSRect, to inner: NSRect) -> NSRect {
        var next = frame
        next.origin.x = max(inner.minX, min(inner.maxX - frame.width, frame.minX))
        next.origin.y = max(inner.minY, min(inner.maxY - frame.height, frame.minY))
        return next
    }
    /// The nearest edge or neighbour line within `threshold` on each axis: the preview's inset
    /// edges, another island's edges, or `gap` beside it.
    static func snap(_ frame: NSRect, inner: NSRect, others: [NSRect]) -> NSRect {
        func nearest(_ low: CGFloat, _ size: CGFloat, _ lines: [(CGFloat, Bool)]) -> CGFloat {
            var best = low, distance = threshold + 0.001
            for (line, isEnd) in lines {
                let origin = isEnd ? line - size : line
                if abs(origin - low) < distance { best = origin; distance = abs(origin - low) }
            }
            return best
        }
        let others = others.filter { !$0.isEmpty }
        var x: [(CGFloat, Bool)] = [(inner.minX, false), (inner.maxX, true)], y: [(CGFloat, Bool)] = [(inner.minY, false), (inner.maxY, true)]
        for other in others {
            x += [(other.minX, false), (other.maxX, true), (other.maxX + gap, false), (other.minX - gap, true)]
            y += [(other.minY, false), (other.maxY, true), (other.maxY + gap, false), (other.minY - gap, true)]
        }
        var next = frame
        next.origin.x = nearest(frame.minX, frame.width, x); next.origin.y = nearest(frame.minY, frame.height, y)
        return clamp(next, to: inner)
    }
    /// `frame` if it clears `other` (by `gap`), else the nearest position beside or above/below
    /// it inside `inner`; nil when there is none.
    static func free(_ frame: NSRect, inner: NSRect, avoiding other: NSRect) -> NSRect? {
        let room = other.insetBy(dx: -gap + 0.5, dy: -gap + 0.5)
        guard !other.isEmpty, frame.intersects(room) else { return frame }
        let candidates = [
            NSPoint(x: other.minX - gap - frame.width, y: frame.minY), NSPoint(x: other.maxX + gap, y: frame.minY),
            NSPoint(x: frame.minX, y: other.minY - gap - frame.height), NSPoint(x: frame.minX, y: other.maxY + gap)
        ].map { clamp(NSRect(origin: $0, size: frame.size), to: inner) }
            .filter { !$0.intersects(room) && inner.insetBy(dx: -0.5, dy: -0.5).contains($0) }
        return candidates.min { hypot($0.minX - frame.minX, $0.minY - frame.minY) < hypot($1.minX - frame.minX, $1.minY - frame.minY) }
    }
}
