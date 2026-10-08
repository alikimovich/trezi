import CoreGraphics
import Foundation

// Ruler, guide and layout-grid math (LKM-205), in page CSS pixels; no window needed.
func near(_ a: Double, _ b: Double, _ what: String) { precondition(abs(a - b) < 0.001, "\(what): \(a) != \(b)") }

// Columns: stretch fills the viewport inside the margins.
var mobile = OverlayMath.presets[1].grid
var spans = OverlayMath.columns(mobile, width: 390)
precondition(spans.count == 4)
near(spans[0].start, 16, "stretch start"); near(spans[0].width, (390 - 32 - 48) / 4.0, "stretch width")
near(spans[3].start + spans[3].width, 374, "stretch end at the right margin")
spans = OverlayMath.columns(mobile, width: 768)
near(spans[3].start + spans[3].width, 752, "stretch follows the viewport width")

// Centred fixed columns: 12 × 78 + 11 × 24 = 1200, centred whatever the viewport.
let twelve = OverlayMath.presets[0].grid
for viewport in [1440.0, 1280, 1000] {
    let columns = OverlayMath.columns(twelve, width: viewport)
    precondition(columns.count == 12)
    near(columns[0].start, (viewport - 1200) / 2, "centre start at \(viewport)")
    near(columns[11].start + columns[11].width, (viewport + 1200) / 2, "centre end at \(viewport)")
    near(columns[1].start - columns[0].start, 102, "column + gutter")
}

// Left: fixed columns from the margin; a stretch-width left grid fills like stretch.
var left = OverlayGrid(kind: "columns", count: 3, width: 100, gutter: 10, margin: 20, align: "left")
near(OverlayMath.columns(left, width: 1000)[2].start, 240, "left third column")
left.width = nil
near(OverlayMath.columns(left, width: 1000)[2].start + OverlayMath.columns(left, width: 1000)[2].width, 980, "left stretch")
// No room: no columns rather than negative widths.
precondition(OverlayMath.columns(mobile, width: 40).isEmpty)

// Periodic lines (baseline rows and squares) with an offset, inside a range.
near(OverlayMath.periodic(step: 8, offset: 4, in: 10...40).first!, 12, "first baseline")
precondition(OverlayMath.periodic(step: 8, offset: 4, in: 10...40) == [12, 20, 28, 36])
precondition(OverlayMath.periodic(step: 8, offset: 0, in: -16...0) == [-16, -8, 0])
precondition(OverlayMath.periodic(step: 1, offset: 0, in: 0...100_000, limit: 50).count == 50)

// Grid lines for snapping: column edges on x, rows on y.
let lines = OverlayMath.gridLines([mobile, OverlayMath.presets[2].grid], axis: "x", viewport: 390, in: 0...800)
precondition(lines.first == 16 && lines.last == 374 && lines.count == 8, "\(lines)")
precondition(OverlayMath.gridLines([OverlayMath.presets[2].grid], axis: "y", viewport: 390, in: 0...24) == [0, 8, 16, 24])

// Ruler steps stay at least 50 pt apart at any scale, from the 1-2-5 series.
for (scale, major) in [(1.0, 50.0), (2.0, 50), (0.5, 100), (0.3, 200), (3.0, 20), (10, 5)] {
    let step = OverlayMath.rulerStep(scale: scale)
    near(step.major, major, "major at \(scale)")
    precondition(step.major * scale >= 50 && step.minor >= 1)
}

// Scale and scroll: a page-anchored CSS 100 at scroll 40, scale 0.5 is 30 pt into the view.
near(OverlayMath.toView(100, scroll: 40, scale: 0.5, fixed: false), 30, "anchored to view")
near(OverlayMath.toView(100, scroll: 40, scale: 0.5, fixed: true), 50, "fixed to view")
near(OverlayMath.toCSS(30, scroll: 40, scale: 0.5, fixed: false), 100, "view to anchored")
near(OverlayMath.toCSS(OverlayMath.toView(321.5, scroll: 7, scale: 0.75, fixed: false), scroll: 7, scale: 0.75, fixed: false), 321.5, "round trip")

// Snapping: the nearest candidate within the threshold, else a whole pixel.
let snapped = OverlayMath.snap(11.4, candidates: [8, 30], threshold: 5)
precondition(snapped.snapped); near(snapped.value, 8, "snap to edge")
let whole = OverlayMath.snap(51.4, candidates: [8, 30], threshold: 5)
precondition(!whole.snapped); near(whole.value, 51, "whole pixel")

// Element candidates: only elements under the pointer on the other axis.
let rects = [CGRect(x: 8, y: 20, width: 200, height: 40), CGRect(x: 300, y: 500, width: 10, height: 10)]
precondition(OverlayMath.elementCandidates(rects, axis: "x", point: CGPoint(x: 11, y: 30), threshold: 5) == [8, 108, 208])
precondition(OverlayMath.elementCandidates(rects, axis: "x", point: CGPoint(x: 11, y: 90), threshold: 5).isEmpty)
precondition(OverlayMath.elementCandidates(rects, axis: "y", point: CGPoint(x: 100, y: 18), threshold: 5) == [20, 40, 60])

// Settings parse from untrusted preferences and round-trip.
var state = OverlayState(json: ["rulers":true, "gridVisible":true, "guides":[["id":"a", "axis":"x", "position":120.5], ["axis":"z", "position":3], ["axis":"y", "position":Double.infinity]],
                                "grids":[["kind":"columns", "count":500, "gutter":-4, "align":"weird", "color":"#00FF00", "opacity":7], ["kind":"bogus"]]])
precondition(state.rulers && state.guides.count == 1 && state.guides[0].position == 120.5)
precondition(state.grids.count == 1 && state.grids[0].count == 48 && state.grids[0].gutter == 0 && state.grids[0].align == "stretch")
precondition(state.grids[0].color == "#00ff00" && state.grids[0].opacity == 1 && state.grids[0].width == nil)
precondition(OverlayState(json: state.json()) == state, "round trip")
state.gridVisible = false
precondition(state.shownGrids.isEmpty)
print("PREVIEW OVERLAY MATH PASS — columns, baseline and square lines, ruler steps, scale/scroll, snapping and settings")
