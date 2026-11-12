import Foundation

/// LKM-657: the host's own checks before it previews or reveals a path a chat link named
/// (Bun already resolved and contained it; the host trusts nothing it is sent), and the
/// preview's origin rule for keeping a navigation in Trezi.
enum LocalFileLink {
    /// Quick Look shows these natively, without running page scripts (`QUICK_LOOK_EXTENSIONS`).
    static let quickLookExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp", "avif", "pdf", "mov", "mp4", "m4v"]
    /// Automounted or network locations: Finder would mount or reach the network.
    static let remotePrefixes = ["/net", "/Network", "/Volumes", "/home", "/afs"]

    /// An absolute, already normalized local path that is not on a network mount.
    static func plain(_ path: String) -> Bool {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), path.count <= 4096,
              !path.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }),
              (path as NSString).standardizingPath == path else { return false }
        return !remotePrefixes.contains { path == $0 || path.hasPrefix($0 + "/") }
    }
    /// Reveal in Finder: an existing file or folder.
    static func revealable(_ path: String) -> Bool { plain(path) && FileManager.default.fileExists(atPath: path) }
    /// Quick Look: an existing regular file (not a link) of a supported kind.
    static func previewable(_ path: String) -> Bool {
        guard plain(path), quickLookExtensions.contains((path as NSString).pathExtension.lowercased()),
              let attributes = try? FileManager.default.attributesOfItem(atPath: path) else { return false }
        return attributes[.type] as? FileAttributeType == .typeRegular
    }
}

enum PreviewOrigin {
    /// Scheme, host and port, with the scheme's default port filled in: another port of
    /// the same host is another site.
    static func same(_ url: URL, _ target: URL) -> Bool {
        func parts(_ u: URL) -> (String, String, Int?)? {
            guard let scheme = u.scheme?.lowercased(), let host = u.host?.lowercased() else { return nil }
            return (scheme, host, u.port ?? (scheme == "https" ? 443 : scheme == "http" ? 80 : nil))
        }
        guard let a = parts(url), let b = parts(target) else { return false }
        return a == b
    }
    /// Only a deliberate HTTP(S) link click leaves the preview for the browser; scripted
    /// redirects, form posts and subresources never open a window.
    static func opensExternally(_ url: URL, linkActivated: Bool) -> Bool {
        linkActivated && ["https", "http"].contains(url.scheme?.lowercased() ?? "")
    }
}
