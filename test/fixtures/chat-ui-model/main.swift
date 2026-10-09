import Foundation

// Answer components (LKM-208): Swift decodes chat frames' `ui` and rejects what the zod
// catalog rejects, with path errors, without ever failing the frame. No window needed.
func payload(_ json: String) -> ChatUiPayload {
    guard let decoded = ChatUiCatalog.decode(Data(json.utf8)) else { fatalError("payload threw: \(json)") }
    return decoded
}
func record(_ component: String, extra: String = "", images: String = "{}") -> String { #"{"id":"ui-1","at":1,"images":\#(images)\#(extra),"component":\#(component)}"# }
func rejects(_ component: String, _ expected: String) {
    let decoded = payload(record(component))
    precondition(decoded.record == nil, "accepted: \(component)")
    precondition(decoded.problems.contains { $0.contains(expected) }, "expected \(expected) in \(decoded.problems)")
}

let options = #"{"kind":"options","title":"Hero layout","prompt":"Pick one","options":[{"id":"a","title":"Split","note":"Image right","tags":["calm"]},{"id":"b","title":"Stacked","note":"Image below"}]}"#
let shown = payload(record(options, extra: #","missing":{"b":"Preview is not open"}"#, images: #"{"a":{"src":"data:image/jpeg;base64,/9j/","route":"/"}}"#))
precondition(shown.problems.isEmpty, "\(shown.problems)")
precondition(shown.record?.component.options?.count == 2 && shown.record?.images["a"]?.route == "/" && shown.record?.missing?["b"] != nil)
precondition(ChatUiFormat.imageData("data:image/jpeg;base64,/9j/") != nil && ChatUiFormat.imageData("https://x") == nil)

// Bad payloads: each problem names its path, like Bun's.
rejects(#"{"kind":"options","title":"T","options":[{"id":"a","title":"A","note":"n"}]}"#, "options: show 2–4 options")
rejects(#"{"kind":"options","title":"T","options":[{"id":"A!","title":"A","note":"n"},{"id":"b","title":"B","note":"n"}]}"#, "options.0.id: use 1–32 lowercase letters")
rejects(#"{"kind":"options","title":"T","options":[{"id":"a","title":"A","note":"n"},{"id":"a","title":"B","note":"n"}]}"#, "options.1.id: duplicate id")
rejects(#"{"kind":"options","title":"  ","options":[{"id":"a","title":"A","note":"n"},{"id":"b","title":"B","note":"n"}]}"#, "title: must not be empty")
rejects(#"{"kind":"carousel","title":"T"}"#, "kind: unknown component")
rejects(#"{"kind":"options","title":"T","options":[{"id":"a","title":"A"},{"id":"b","title":"B","note":"n"}]}"#, "component: component.options.0.note is missing")
rejects(#"{"kind":"form","title":"T","fields":[]}"#, "fields: show 1–8 fields")
rejects(#"{"kind":"form","title":"T","fields":[{"id":"w","type":"slider","label":"Width","min":10,"max":5}]}"#, "fields.0.min: min must be below max")
rejects(#"{"kind":"form","title":"T","fields":[{"id":"w","type":"number","label":"Width","min":0,"max":5,"default":9}]}"#, "fields.0.default: default is outside")
rejects(#"{"kind":"form","title":"T","fields":[{"id":"c","type":"choice","label":"C","options":[{"value":"x","label":"X"},{"value":"y","label":"Y"}],"default":"z"}]}"#, "fields.0.default: default must be one of")
rejects(#"{"kind":"form","title":"T","fields":[{"id":"c","type":"choice","label":"C","options":[{"value":"x","label":"X"},{"value":"y","label":"Y"}],"default":["x"]}]}"#, "a single choice takes one default")
rejects(#"{"kind":"form","title":"T","fields":[{"id":"d","type":"date","label":"When"}]}"#, "fields.0.type: unknown field type")
precondition(payload("[1]").problems.first?.hasPrefix("component:") == true, "a non-object is a problem, not a throw")

// A form: defaults, what keeps Submit disabled, and the one answer it sends.
let form = ##"{"kind":"form","title":"Card","submitLabel":"Apply","fields":[{"id":"density","type":"choice","label":"Density","options":[{"value":"tight","label":"Tight"},{"value":"airy","label":"Airy"}]},{"id":"parts","type":"choice","label":"Parts","multiple":true,"options":[{"value":"icon","label":"Icon"},{"value":"badge","label":"Badge"}],"default":["icon"]},{"id":"radius","type":"number","label":"Radius","min":0,"max":32,"unit":"px"},{"id":"gap","type":"slider","label":"Gap","min":4,"max":24,"step":4},{"id":"accent","type":"color","label":"Accent","required":false,"suggestions":[{"name":"--brand-teal","value":"#0f766e"}]},{"id":"shadow","type":"toggle","label":"Shadow"},{"id":"note","type":"text","label":"Note","required":false,"multiline":true}]}"##
guard let card = payload(record(form)).record else { fatalError("form rejected: \(payload(record(form)).problems)") }
var state = ChatUiFormState(card.component)
precondition(state.values["parts"] == .list(["icon"]) && state.values["gap"] == .number(4) && state.values["shadow"] == .flag(false))
precondition(state.problems(card.component) == ["Density is required.", "Radius is required."], "\(state.problems(card.component))")
state.values["density"] = .text("airy"); state.values["radius"] = .number(40)
precondition(state.problems(card.component) == ["Radius: at most 32."])
state.values["radius"] = .number(12); state.values["note"] = .text("  ")
precondition(state.problems(card.component).isEmpty)
let sent = try! JSONSerialization.jsonObject(with: Data(state.answer(card.component).utf8)) as! [String: Any]
let values = sent["values"] as! [String: Any]
precondition(values["density"] as? String == "airy" && values["radius"] as? Double == 12 && values["parts"] as? [String] == ["icon"])
precondition(values["shadow"] as? Bool == false && values["note"] == nil && values["accent"] == nil, "\(values)")

// Options answers: a pick with a comment, and "none of these".
precondition(ChatUiFormat.pick("b", comment: " tighter ") == #"{"choice":"b","comment":"tighter"}"#)
precondition(ChatUiFormat.pick(nil, comment: "") == #"{"choice":null}"#)
let answered = payload(record(options, extra: #","answer":{"choice":null,"comment":"Warmer"},"answeredAt":2"#)).record
precondition(answered?.answer?.none == true && answered?.answer?.comment == "Warmer")
let picked = payload(record(options, extra: #","answer":{"choice":"b"}"#)).record
precondition(picked?.answer?.none == false && picked?.answer?.choice == "b")
let submitted = payload(record(form, extra: #","answer":{"values":{"radius":8,"shadow":true,"parts":["badge"]}}"#)).record
precondition(ChatUiFormat.value(submitted?.answer?.values?["radius"], unit: "px") == "8 px" && ChatUiFormat.value(submitted?.answer?.values?["shadow"], unit: nil) == "On")
precondition(ChatUiFormat.value(submitted?.answer?.values?["parts"], unit: nil) == "badge" && ChatUiFormat.letter(2) == "C")
print("CHAT UI MODEL PASS — decode, path errors for bad payloads, form defaults/validation/answer, pick encoding")
