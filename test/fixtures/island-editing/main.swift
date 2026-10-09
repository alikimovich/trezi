import Foundation

// Pure island editing policy: no application, window or run loop.
func require(_ condition: Bool, _ message: String) {
    if !condition { fputs("FAIL: \(message)\n", stderr); exit(1) }
}
let start = Date(timeIntervalSince1970: 1_000)
func at(_ ms: Double) -> Date { start.addingTimeInterval(ms / 1000) }

// A drag: frames are throttled to the interval, held-back values ride with the next
// batch, the release always writes, and every write of the gesture shares one id.
var writes = IslandLiveWrites()
var sent: [(gesture: String, values: [String: IslandValue], ended: Bool)] = []
for (ms, x) in [(0.0, 0.1), (20, 0.2), (50, 0.3), (85, 0.4), (120, 0.5), (170, 0.6)] {
    if let batch = writes.change(["x": .number(x)], ended: false, at: at(ms)) { sent.append(batch) }
}
if let batch = writes.change(["y": .number(0.9)], ended: true, at: at(180)) { sent.append(batch) }
require(sent.count == 4, "A drag writes live, throttled to \(IslandLiveWrites.interval)s, then on release (\(sent.count) writes)")
require(sent.prefix(3).map { $0.values["x"] } == [.number(0.1), .number(0.4), .number(0.6)], "Each write carries the latest value")
require(sent.last?.values == ["y": .number(0.9)], "The release writes its own change")
// Only the release is marked ended: a Shadow island writes its source then (LKM-140).
require(sent.map(\.ended) == [false, false, false, true], "Only the release batch is the gesture's end")
// A value held back by the throttle is never lost: it rides with the release.
var held = IslandLiveWrites()
_ = held.change(["x": .number(0.1)], ended: false, at: at(0))
_ = held.change(["x": .number(0.3)], ended: false, at: at(30))
require(held.change(["y": .number(0.2)], ended: true, at: at(40))?.values == ["x": .number(0.3), "y": .number(0.2)], "Held-back frames are flushed on release")
require(Set(sent.map(\.gesture)).count == 1, "One gesture id: one Undo group")
// The next gesture (a typed value, a toggle, a slider) is a new Undo group and is not throttled.
guard let next = writes.change(["x": .number(0.2)], ended: true, at: at(185)) else { require(false, "A discrete change writes at once"); exit(1) }
require(next.gesture != sent[0].gesture, "A new gesture gets a new Undo group")
let slider = writes.change(["blur": .number(10)], ended: false, at: at(190))
require(slider != nil && slider?.gesture != next.gesture, "A slider's first frame writes at once in its own group")

// Typed number field: Return and blur both apply, with no separate step; invalid or
// out-of-range drafts are never written; an unchanged or just-sent draft is not rewritten.
var number = IslandEntry(.number(-1...1))
require(number.commit("0.5", current: "0") == .number(0.5), "Return applies a valid number")
require(number.commit("0.5", current: "0") == nil, "Blur right after Return does not write it again")
for invalid in ["", "abc", "1.5", "-2", "nan", "inf", "0.5.1"] {
    require(number.commit(invalid, current: "0.5") == nil, "Invalid typed value \"\(invalid)\" is not written")
    require(number.parse(invalid) == nil, "\"\(invalid)\" shows as invalid")
}
require(number.commit("-0.25", current: "0.5") == .number(-0.25), "Once valid, the typed value applies")
require(number.commit("0.5", current: "0.5") == nil, "The source value is not rewritten")
number.sourceChanged()
require(number.commit("-0.25", current: "0.5") == .number(-0.25), "After the source changes, the same draft applies again")
var unbounded = IslandEntry(.number(nil))
require(unbounded.commit("120", current: "12") == .number(120), "A field without bounds takes any finite number")

// Text and bezier fields take the same path.
var text = IslandEntry(.text)
require(text.commit("rgba(0, 0, 0, 0.5)", current: "rgba(0, 0, 0, 0.35)") == .text("rgba(0, 0, 0, 0.5)"), "Text applies on Return or blur")
require(text.commit("rgba(0, 0, 0, 0.5)", current: "rgba(0, 0, 0, 0.35)") == nil, "Blur after Return does not repeat the write")
var bezier = IslandEntry(.bezier)
require(bezier.commit("cubic-bezier(0.1, 0.2)", current: "cubic-bezier(0.25, 0.1, 0.25, 1)") == nil, "An incomplete curve is not written")
require(bezier.commit("cubic-bezier(0.1, 0.2, 0.3, 1)", current: "cubic-bezier(0.25, 0.1, 0.25, 1)") == .text("cubic-bezier(0.1, 0.2, 0.3, 1)"), "A complete curve applies")
print("NATIVE-ISLAND-EDITING PASS — throttled live writes, one gesture id per drag, Return/blur apply, invalid values never written")
