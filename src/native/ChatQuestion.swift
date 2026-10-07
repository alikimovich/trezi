import SwiftUI

struct NativeQuestionCard: View {
    let request: ChatQuestionRequest
    @ObservedObject var model: ChatModel
    /// False inside a background agent's card (LKM-193), which draws the frame.
    var framed = true
    @State private var step = 0
    @State private var selected: [Int: Set<String>] = [:]
    @State private var other: [Int: String] = [:]
    private func answer(_ index: Int) -> String {
        let q = request.questions[index]
        let labels = q.options.map(\.label).filter { selected[index, default: []].contains($0) }
        return (labels + (other[index, default: ""].isEmpty ? [] : [other[index, default: ""]])).joined(separator: ", ")
    }
    private func submit() {
        var answers: [String: String] = [:]
        for (index, q) in request.questions.enumerated() { answers[q.question] = answer(index) }
        model.action("question", id: request.id, answers: answers)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if request.questions.indices.contains(step) {
                let q = request.questions[step]
                Text("\(q.header) · \(step + 1)/\(request.questions.count)").font(.caption).foregroundStyle(.secondary)
                Text(q.question).font(.headline).textSelection(.enabled)
                ForEach(Array(q.options.enumerated()), id: \.offset) { _, option in
                    Button {
                        if q.multiSelect {
                            if selected[step, default: []].contains(option.label) { selected[step]?.remove(option.label) }
                            else { selected[step, default: []].insert(option.label) }
                        } else { selected[step] = [option.label]; other[step] = "" }
                    } label: {
                        HStack(alignment: .top) {
                            Image(systemName: selected[step, default: []].contains(option.label) ? "checkmark.circle.fill" : "circle")
                            VStack(alignment: .leading) {
                                Text(option.label)
                                if let detail = option.description { Text(detail).font(.caption).foregroundStyle(.secondary) }
                            }
                            Spacer()
                        }.padding(5)
                    }.buttonStyle(.plain)
                }
                TextField("Other answer", text: Binding(get: { other[step, default: ""] }, set: { other[step] = $0; if !q.multiSelect { selected[step] = [] } })).textFieldStyle(.roundedBorder)
                HStack {
                    Button("Skip") { model.action("question", id: request.id) }
                    Spacer()
                    if step > 0 { Button("Back") { step -= 1 } }
                    Button(step + 1 == request.questions.count ? "Send answer" : "Next") {
                        if step + 1 == request.questions.count { submit() } else { step += 1 }
                    }.disabled(answer(step).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }.padding(framed ? 12 : 0).background(framed ? AnyShapeStyle(.quaternary) : AnyShapeStyle(.clear), in: RoundedRectangle(cornerRadius: 10))
    }
}
