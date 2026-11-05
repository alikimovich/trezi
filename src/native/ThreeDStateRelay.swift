import Foundation

/// Forward only a state the visible preview's native chrome accepted. The view
/// identity comes from Host's WKWebView lookup, never from the page's message.
enum ThreeDStateRelay {
    static func handle(view: String, body: [String: Any],
                       accept: (String, [String: Any]?) -> Bool,
                       forward: ([String: Any]) -> Void) -> Bool {
        guard view == "preview", body["channel"] as? String == "trezi:preview:three-d-state" else { return false }
        guard let document = body["document"] as? String, !document.isEmpty,
              let args = body["args"] as? [Any], args.count == 1 else { return true }
        let state: [String: Any]?
        if args[0] is NSNull { state = nil }
        else if let value = args[0] as? [String: Any] { state = value }
        else { return true }
        if accept(document, state) {
            forward(["event": "ipc", "view": view, "message": body])
        }
        return true
    }
}
