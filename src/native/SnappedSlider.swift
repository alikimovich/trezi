import SwiftUI

/// Rounds `value` to `lower + k * step`, as SwiftUI's stepped `Slider` does: `k`
/// stops at the last whole step, so 1...20 by 4 tops out at 17. A non-positive
/// or non-finite step only clamps.
func snapSliderValue(_ value: Double, in bounds: ClosedRange<Double>, step: Double) -> Double {
    let lower = bounds.lowerBound, upper = bounds.upperBound
    guard step > 0, step.isFinite else { return Swift.min(upper, Swift.max(lower, value)) }
    let steps = ((upper - lower) / step + 1e-9).rounded(.down)
    return lower + Swift.min(steps, Swift.max(0, ((value - lower) / step).rounded())) * step
}

/// A `Slider` that snaps to `step` in its binding. Passing `step:` to SwiftUI
/// makes AppKit draw one tick mark per step, a dense dotted line under the track.
struct SnappedSlider: View {
    @Binding var value: Double
    let bounds: ClosedRange<Double>
    let step: Double
    var onEditingChanged: (Bool) -> Void = { _ in }
    var body: some View {
        Slider(value: Binding(get: { value }, set: { value = snapSliderValue($0, in: bounds, step: step) }), in: bounds, onEditingChanged: onEditingChanged)
    }
}
