import AppKit
import SwiftUI

// Windowless: the sliders are hosted in NSHostingViews that never join a window.
var emitted: [[String: Any]] = []
func emit(_ value: [String: Any]) { emitted.append(value) }
func require(_ condition: Bool, _ message: String) {
    if !condition { fputs("FAIL: \(message)\n", stderr); exit(1) }
}
func host<V: View>(_ view: V) -> NSHostingView<V> {
    let hosting = NSHostingView(rootView: view)
    hosting.setFrameSize(NSSize(width: 280, height: 200))
    for _ in 0..<4 { hosting.layoutSubtreeIfNeeded(); RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.02)) }
    require(hosting.window == nil, "Fixture must stay windowless")
    return hosting
}
func sliders(_ view: NSView) -> [NSSlider] { (view as? NSSlider).map { [$0] } ?? view.subviews.flatMap(sliders) }
// SwiftUI may normalise the NSSlider's range, so position the knob by track fraction.
func drag(_ slider: NSSlider, to value: Double, in bounds: ClosedRange<Double>) {
    let fraction = (value - bounds.lowerBound) / (bounds.upperBound - bounds.lowerBound)
    slider.doubleValue = slider.minValue + fraction * (slider.maxValue - slider.minValue)
    require(slider.sendAction(slider.action, to: slider.target), "Slider action reaches its SwiftUI binding")
}

// The probe must see ticks on a stepped SwiftUI Slider, or "no ticks" proves nothing.
let stepped = sliders(host(Slider(value: .constant(4), in: 0...100, step: 1)))
require(stepped.count == 1 && stepped[0].numberOfTickMarks > 0, "Baseline stepped Slider draws tick marks (\(stepped.map(\.numberOfTickMarks)))")

// Pure snapping matches SwiftUI's stepped Slider: lower + k * step, clamped.
require(snapSliderValue(12.4, in: 0...100, step: 1) == 12, "Rounds down to the step")
require(snapSliderValue(12.6, in: 0...100, step: 1) == 13, "Rounds up to the step")
require(snapSliderValue(6.9, in: 1...20, step: 4) == 5 && snapSliderValue(7.1, in: 1...20, step: 4) == 9, "Steps count from the lower bound")
require(snapSliderValue(19.9, in: 1...20, step: 4) == 17, "Stops at the last whole step, like SwiftUI")
require(snapSliderValue(-3, in: 0...10, step: 2) == 0 && snapSliderValue(30, in: 0...10, step: 2) == 10, "Clamps to the bounds")
require(snapSliderValue(0.27, in: 0...1, step: 0.1) == 3 * 0.1 && snapSliderValue(1, in: 0...0.3, step: 0.1) == 3 * 0.1, "Matches SwiftUI's lower + k * step values")
require(abs(snapSliderValue(0.4374, in: 0...1, step: 0.001) - 0.437) < 1e-12, "Snaps to a fine island default step")
require(snapSliderValue(3.3, in: 0...10, step: 0) == 3.3, "A zero step only clamps")

// Inspector: the real field view, e.g. Layout padding-top (default step 1, then 5).
let model = InspectorModel()
func inspectorState(step: Double?) -> InspectorState {
    var field: [String: Any] = ["id":"padding-top", "label":"Padding top", "group":"Layout", "kind":"number", "value":"12", "min":0, "max":200, "unit":"px"]
    if let step { field["step"] = step }
    let raw: [String: Any] = ["root":"/fixture", "generation":1, "visible":true, "title":"div", "tab":"layout", "fields":[field], "actions":[], "error":"", "busy":false]
    return try! JSONDecoder().decode(InspectorState.self, from: JSONSerialization.data(withJSONObject: raw))
}
for (step, target, expected) in [(nil, 37.4, "37.0"), (5.0, 37.4, "35.0")] as [(Double?, Double, String)] {
    model.state = inspectorState(step: step)
    let view = host(InspectorFieldView(field: model.state!.fields[0], model: model, value: "12"))
    let found = sliders(view)
    require(found.count == 1, "Inspector number field hosts one slider")
    require(found[0].numberOfTickMarks == 0, "Inspector slider draws no tick marks (\(found[0].numberOfTickMarks))")
    emitted = []
    drag(found[0], to: target, in: 0...200)
    let preview = emitted.last { $0["action"] as? String == "preview" }
    require(preview?["value"] as? String == expected, "Inspector slider snaps \(target) to \(expected), got \(preview?["value"] ?? "nothing")")
}

// Chat island: the default step is 1/1000 of the range.
var islandValue = 0.0
let island = host(SnappedSlider(value: Binding(get: { islandValue }, set: { islandValue = $0 }), bounds: -2...2, step: 4.0 / 1000))
let islandSliders = sliders(island)
require(islandSliders.count == 1 && islandSliders[0].numberOfTickMarks == 0, "Island slider draws no tick marks")
drag(islandSliders[0], to: 1.2345, in: -2...2)
require(abs(islandValue - 1.236) < 1e-9, "Island slider snaps to the default step, got \(islandValue)")
print("Slider ticks: inspector and island sliders draw no tick marks and snap to the step without a window")
