import Foundation
import WebKit

/// LKM-197: a reload that cannot reuse a stale stylesheet or module. The preview's store
/// is non-persistent, but WebKit still keeps responses (Vite serves dependency files as
/// immutable) in its memory and network caches for the session; they are cleared first.
/// The same URL reloads from origin, which keeps the route and the scroll position.
enum PreviewCache {
    static let types: Set<String> = [WKWebsiteDataTypeMemoryCache, WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeFetchCache]
    /// The caches clear asynchronously, so `shouldLoad` is asked once they are clear and before anything
    /// loads: a caller that was superseded or closed meanwhile must not start (and so cancel) a navigation.
    /// `started` receives the navigation once the load began.
    static func reload(_ view: WKWebView, url: URL?, shouldLoad: @escaping () -> Bool, started: ((WKNavigation?) -> Void)? = nil) {
        view.configuration.websiteDataStore.removeData(ofTypes: types, modifiedSince: .distantPast) { [weak view] in
            guard let view, shouldLoad() else { return }
            let navigation: WKNavigation?
            if let url, view.url?.absoluteString != url.absoluteString {
                navigation = view.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData))
            } else { navigation = view.reloadFromOrigin() }
            started?(navigation)
        }
    }
}

/// LKM-584: the host's `load` and `reload` commands of each view, in order. A hard load
/// clears WebKit's caches before it loads, and the clear finishes after a later `load`
/// (a project switch, the reset to the placeholder) already began: measured in WebKit,
/// the late callback then loaded the old URL over the newer one. Each command takes a
/// ticket; a hard load still clearing caches loads only while its ticket is the latest.
/// A `reload` that supersedes a hard load of a URL not loaded yet (a clean restart's new
/// server) reloads toward that URL, since the page shown is still the old one.
final class PreviewLoadFence {
    private var latest: [String: Int] = [:]
    private var unstarted: [String: URL] = [:]
    /// A new load or reload of `view`; `hardLoad` is the URL a hard load will load once the
    /// caches are clear. The returned check is true until the next command of `view`.
    func begin(_ view: String, hardLoad url: URL? = nil) -> () -> Bool {
        let ticket = latest[view, default: 0] + 1
        latest[view] = ticket
        unstarted[view] = url
        return { [weak self] in self?.latest[view] == ticket }
    }
    /// The hard load of the latest command began loading.
    func started(_ view: String) { unstarted.removeValue(forKey: view) }
    /// The URL of the latest command's hard load when it has not started loading yet.
    func pending(_ view: String) -> URL? { unstarted[view] }
}
