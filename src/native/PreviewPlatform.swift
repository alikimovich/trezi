import AppKit
import WebKit

final class PreviewDownloads: NSObject, WKDownloadDelegate {
    weak var parent: NSWindow?
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard let parent else { completionHandler(nil); return }
        let panel = NSSavePanel(); panel.nameFieldStringValue = suggestedFilename; panel.canCreateDirectories = true
        panel.beginSheetModal(for: parent) { answer in completionHandler(answer == .OK ? panel.url : nil) }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) { if (error as NSError).code != NSURLErrorCancelled { emit(["event":"download-error", "message":error.localizedDescription]) } }
    func downloadDidFinish(_ download: WKDownload) { emit(["event":"download-finished"]) }
}
extension Host {
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = downloads }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = downloads }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let name = views.first(where: { $0.value === webView })?.key ?? ""
        // The main frame's HTTP status, so open_preview and the preview pill can report a 500 (LKM-196).
        if response.isForMainFrame, webView === views["preview"], let http = response.response as? HTTPURLResponse {
            emit(["event":"navigation-response", "view":"preview", "url":http.url?.absoluteString ?? "", "status":http.statusCode])
        } else if response.isForMainFrame, name.hasPrefix("agent:"), let http = response.response as? HTTPURLResponse {
            agentBrowserStatuses[name] = http.statusCode
        }
        if name.hasPrefix("agent:") {
            // LKM-230: an agent browser never downloads; a response the page cannot show is refused.
            let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
            if !response.canShowMIMEType || disposition.lowercased().hasPrefix("attachment") {
                agentBlocked(name, response.response.url, reason: "download"); decisionHandler(.cancel); return
            }
            decisionHandler(.allow); return
        }
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    /// LKM-230: an agent browser stays on its dev server's origin, posts no form to another
    /// host, opens no window and downloads nothing. Other frames may still load other origins.
    func agentPolicy(_ name: String, _ action: WKNavigationAction, url: URL, sameOrigin: Bool) -> WKNavigationActionPolicy {
        let form = action.navigationType == .formSubmitted || action.navigationType == .formResubmitted
        let subframe = action.targetFrame.map { !$0.isMainFrame } ?? false
        let reason: String?
        if action.shouldPerformDownload { reason = "download" }
        else if action.targetFrame == nil { reason = "new-window" }
        else if sameOrigin || url.absoluteString == "about:blank" || (subframe && !form) { reason = nil }
        else { reason = form ? "form" : "navigation" }
        guard let reason else { return .allow }
        agentBlocked(name, url, reason: reason)
        return .cancel
    }
    func agentBlocked(_ name: String, _ url: URL?, reason: String) {
        ProductLog.info("preview", "Agent browser refused \(reason) \(Host.logURL(url))")
        emit(["event":"agent-navigation", "view":name, "phase":"blocked", "reason":reason, "url":String((url?.absoluteString ?? "").prefix(500))])
    }
}
