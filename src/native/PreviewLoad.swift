import AppKit
import SwiftUI
import WebKit

/// The preview's navigation lifecycle (LKM-196). Bun records it (`src/main/preview-loads.ts`)
/// so `open_preview` reports the real result, and sends back `previewLoad` in the shell
/// state: a pill over the page while it loads, and when the server answered an error.
extension Host {
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard webView === views["preview"] else { return }
        emit(["event":"navigation-start", "view":"preview", "url":webView.url?.absoluteString ?? ""])
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        previewNavigationFailed(webView, error, committed: true)
    }
    /// A superseded or policy-ended navigation is a cancel, never the preview's error page.
    func previewNavigationFailed(_ webView: WKWebView, _ error: Error, committed: Bool) {
        let name = views.first(where: { $0.value === webView })?.key ?? ""
        let nsError = error as NSError
        let url = nsError.userInfo[NSURLErrorFailingURLStringErrorKey] as? String ?? webView.url?.absoluteString ?? ""
        let cancelled = (nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled) || (nsError.domain == "WebKitErrorDomain" && nsError.code == 102)
        if name.hasPrefix("agent:"), let pending = agentBrowserLoads.removeValue(forKey: name) {
            reply(pending, error: error.localizedDescription)
        }
        if cancelled { emit(["event":"navigation-cancelled", "view":name, "url":url]); return }
        ProductLog.warn("preview", "Preview load failed: \(error.localizedDescription)")
        // After the page committed it stays on screen; only the result is reported.
        emit(["event":committed ? "navigation-failed" : "load-error", "view":name, "url":url, "message":error.localizedDescription])
    }
}

/// LKM-197: a reload that cannot reuse a stale stylesheet or module. The preview's store
/// is non-persistent, but WebKit still keeps responses (Vite serves dependency files as
/// immutable) in its memory and network caches for the session; they are cleared first.
/// The same URL reloads from origin, which keeps the route and the scroll position.
enum PreviewCache {
    static let types: Set<String> = [WKWebsiteDataTypeMemoryCache, WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeFetchCache]
    static func reload(_ view: WKWebView, url: URL?) {
        view.configuration.websiteDataStore.removeData(ofTypes: types, modifiedSince: .distantPast) { [weak view] in
            guard let view else { return }
            if let url, view.url?.absoluteString != url.absoluteString {
                view.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData))
            } else { view.reloadFromOrigin() }
        }
    }
}

final class PreviewLoadModel: ObservableObject {
    @Published var kind = ""
    @Published var path = ""
    @Published var message = ""
    func action(_ name: String) { emit(["event":"preview-load-action", "action":name, "path":path]) }
}
struct PreviewLoadContent: View {
    @ObservedObject var model: PreviewLoadModel
    var body: some View {
        HStack(spacing: 8) {
            if model.kind == "loading" {
                ProgressView().controlSize(.small)
                Text("Opening \(model.path)…").font(.system(size: 12, weight: .medium)).lineLimit(1).truncationMode(.middle)
            } else {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange).accessibilityHidden(true)
                Text("\(model.message) · \(model.path)").font(.system(size: 12, weight: .medium)).lineLimit(1).truncationMode(.middle)
                Button("Reload") { model.action("reload") }.buttonStyle(.link)
                Button { model.action("dismiss") } label: { Image(systemName: "xmark") }.buttonStyle(.borderless).help("Dismiss")
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .frame(maxWidth: 520)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().stroke(Color(nsColor: .separatorColor).opacity(0.6)))
        .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
        .fixedSize()
        .accessibilityElement(children: .contain)
    }
}
final class NativePreviewLoad: NSHostingView<PreviewLoadContent> {
    let model = PreviewLoadModel()
    init() { super.init(rootView: PreviewLoadContent(model: model)); sizingOptions = []; isHidden = true }
    required init(rootView: PreviewLoadContent) { fatalError("init(rootView:) has not been implemented") }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    /// Whether the shell state shows a pill (the layout places it over the page).
    var wanted = false
    func update(_ state: [String: Any]) {
        let load = state["previewLoad"] as? [String: Any]
        model.kind = load?["kind"] as? String ?? ""
        model.path = load?["path"] as? String ?? ""
        model.message = load?["message"] as? String ?? ""
        wanted = !model.kind.isEmpty
    }
    /// Top center of the page area, below its edge.
    func place(in page: NSRect, visible: Bool) {
        isHidden = !wanted || !visible || page.width < 160
        guard !isHidden else { return }
        let size = fittingSize
        let width = min(size.width, page.width - 24)
        frame = NSRect(x: page.midX - width / 2, y: page.minY + 12, width: width, height: size.height)
    }
    override func hitTest(_ point: NSPoint) -> NSView? { super.hitTest(point) ?? (!isHidden && frame.contains(point) ? self : nil) }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func scrollWheel(with event: NSEvent) {}
    func inspect() -> [String: Any] { ["visible":!isHidden, "kind":model.kind, "path":model.path, "message":model.message, "frame":NSStringFromRect(frame)] }
}
