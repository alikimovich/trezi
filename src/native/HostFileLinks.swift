import AppKit

extension Host {
    /// `quickLookFile`, `revealFile` and (test profiles) `artifactPreviewInspect`.
    func fileLinkCommand(_ c: [String: Any], id: Int) -> Bool {
        switch c["method"] as? String {
        case "quickLookFile":
            let path = c["path"] as? String ?? ""
            guard LocalFileLink.previewable(path) else { reply(id, error: "This file cannot be previewed."); return true }
            ProductLog.info("chat", "Chat link previewed in Quick Look")
            ArtifactPreview.shared.show(path, over: window)
            reply(id, true)
        case "revealFile":
            let path = c["path"] as? String ?? ""
            guard LocalFileLink.revealable(path) else { reply(id, error: "This location cannot be shown in Finder."); return true }
            ProductLog.info("chat", "Chat link revealed in Finder")
            Host.revealedFiles.append(path)
            if !ephemeral { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
            reply(id, true)
        case "artifactPreviewInspect":
            guard ephemeral else { reply(id, error: "Test profile required"); return true }
            if c["close"] as? Bool == true { ArtifactPreview.shared.close() }
            reply(id, ArtifactPreview.shared.inspect.merging(["revealed": Host.revealedFiles]) { a, _ in a })
        default: return false
        }
        return true
    }
    /// What Reveal in Finder selected, for verification. A disposable test profile
    /// records the reveal instead of bringing Finder to the front.
    static var revealedFiles: [String] = []
}
