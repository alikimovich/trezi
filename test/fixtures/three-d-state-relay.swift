import Foundation

@main struct RelayFixture {
    static func main() throws {
        var selected = -1
        var active = false
        var sent: [[String: Any]] = []
        let forward: ([String: Any]) -> Void = { sent.append($0) }
        let accept: (String, [String: Any]?) -> Bool = { document, state in
            guard document == "document-1" else { return false }
            if let state {
                guard let next = state["selected"] as? Int, (0...1).contains(next) else { return false }
                selected = next
                active = true
            } else {
                guard active else { return false }
                active = false
            }
            return true
        }
        func message(_ state: [String: Any]?) -> [String: Any] {
            ["type": "send", "channel": "trezi:preview:three-d-state",
             "document": "document-1", "args": [state.map { $0 as Any } ?? NSNull()]]
        }
        let base: [String: Any] = ["session": "scene-1", "revision": 4,
                                    "layers": [[:], [:]], "hasSource": true]
        for index in [0, 1] {
            var state = base; state["selected"] = index
            precondition(ThreeDStateRelay.handle(view: "preview", body: message(state), accept: accept, forward: forward))
            precondition(selected == index)
        }
        precondition(ThreeDStateRelay.handle(view: "preview", body: message(nil), accept: accept, forward: forward))
        precondition(!active)
        precondition(!ThreeDStateRelay.handle(view: "main", body: message(base), accept: accept, forward: forward))
        precondition(ThreeDStateRelay.handle(view: "preview", body: message(nil), accept: accept, forward: forward))
        precondition(sent.count == 3)
        precondition(sent.allSatisfy { $0["view"] as? String == "preview" })
        let data = try JSONSerialization.data(withJSONObject: sent)
        print(String(decoding: data, as: UTF8.self))
    }
}
