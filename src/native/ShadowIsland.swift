import SwiftUI

/// Shadow Light's compound block. Backend validation owns the same bounds and
/// writes the CSS/class output with each gesture. There is no local preview box
/// (LKM-133): the page preview shows every drag frame through a temporary override and
/// the source is written on release (LKM-140); the CSS text follows drafts.
struct ShadowIsland: View {
    let fields: [IslandField]
    let value: (IslandField) -> IslandValue
    let field: (IslandField) -> AnyView
    let light: (Double, Double, Bool) -> Void
    /// The light's typed X/Y field, applying like every other island field.
    let input: (IslandField) -> AnyView
    private func number(_ i: Int) -> Double { value(fields[i]).number }
    private var channels: [Double] {
        let text = value(fields[6]).text
        let regex = try! NSRegularExpression(pattern: "\\d*\\.?\\d+")
        let numbers = regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { Range($0.range, in: text).flatMap { Double(text[$0]) } }
        return numbers.count == 4 ? numbers : [0, 0, 0, 0.35]
    }
    private var count: Int { Int(min(8, max(1, number(4))).rounded()) }
    private var color: Color { Color(red: channels[0]/255, green: channels[1]/255, blue: channels[2]/255) }
    private func fraction(_ i: Int) -> Double { pow(Double(i + 1) / Double(count), 2) }
    private func alpha(_ i: Int) -> Double { channels[3] * pow(min(1, max(0, number(5))), Double(i)) }
    private func format(_ n: Double) -> String { String(format: "%.3f", n == 0 ? 0 : n).replacingOccurrences(of: "\\.?0+$", with: "", options: .regularExpression) }
    private var css: String {
        (0..<count).map { i in
            let f = fraction(i)
            return "\(format(-number(0)*number(2)*f))px \(format(-number(1)*number(2)*f))px \(format(number(3)*f))px rgba(\(format(channels[0])),\(format(channels[1])),\(format(channels[2])),\(format(alpha(i))))"
        }.joined(separator: ",\n  ")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Light Source").font(.caption.weight(.medium))
            HStack(spacing: 12) {
                IslandPoint(x: number(0), y: number(1), xRange: -1...1, yRange: -1...1,
                            label: "Light source", change: light).frame(width: 120)
                VStack(spacing: 14) { input(fields[0]); input(fields[1]) }
            }
            Text("Shadow").font(.caption.weight(.medium))
            HStack(alignment: .top, spacing: 12) { field(fields[2]); field(fields[3]) }
            HStack(alignment: .top, spacing: 12) { field(fields[4]); field(fields[5]) }
            HStack {
                Circle().fill(color.opacity(channels[3])).frame(width: 28, height: 28)
                    .overlay(Circle().stroke(.separator))
                field(fields[6])
            }
            Text("box-shadow:\n  " + css + ";").font(.system(size: 11, design: .monospaced))
                .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                .padding(10).background(.background, in: RoundedRectangle(cornerRadius: 10))
        }
    }
}
