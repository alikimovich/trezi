import AppKit
import Quartz

// LKM-657: the host's own path checks before Quick Look / Reveal in Finder, the preview's
// origin rule (another port is another site; only a deliberate click opens the browser),
// and the Quick Look panel showing a synthetic image without ordering a window in.
func check(_ condition: @autoclosure () -> Bool, _ label: String, line: Int = #line) {
    if !condition() { FileHandle.standardError.write(Data("FAIL \(label) (line \(line))\n".utf8)); exit(1) }
}
let folder = URL(fileURLWithPath: CommandLine.arguments[1]).resolvingSymlinksInPath().path
let image = folder + "/before.png", pdf = folder + "/summary.pdf", zip = folder + "/trace.zip", link = folder + "/linked.png"
let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")!
FileManager.default.createFile(atPath: image, contents: png)
FileManager.default.createFile(atPath: pdf, contents: Data("%PDF-1.4\n%%EOF\n".utf8))
FileManager.default.createFile(atPath: zip, contents: Data([0x50, 0x4b, 3, 4]))
try? FileManager.default.removeItem(atPath: link)
try! FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: image)

check(LocalFileLink.previewable(image), "image previews")
check(LocalFileLink.previewable(pdf), "PDF previews")
check(!LocalFileLink.previewable(zip), "zip does not preview")
check(!LocalFileLink.previewable(link), "a symlink is not previewed (Bun sends canonical paths)")
check(!LocalFileLink.previewable(folder), "a folder is not previewed")
check(!LocalFileLink.previewable(folder + "/missing.png"), "missing")
check(!LocalFileLink.previewable(folder + "/../" + (folder as NSString).lastPathComponent + "/before.png"), "unnormalized path")
check(!LocalFileLink.previewable("before.png"), "relative path")
check(!LocalFileLink.previewable(image + "\n"), "control character")
check(LocalFileLink.revealable(folder) && LocalFileLink.revealable(zip), "folders and files reveal")
check(!LocalFileLink.revealable(folder + "/missing"), "missing never reveals")
for remote in ["/Volumes/Share/a.pdf", "/net/host/a.pdf", "/Network/a", "//server/share"] {
    check(!LocalFileLink.revealable(remote) && !LocalFileLink.plain(remote), "remote \(remote)")
}

let target = URL(string: "http://localhost:5173/")!
check(PreviewOrigin.same(URL(string: "http://localhost:5173/about#team")!, target), "same origin, other path and hash")
check(PreviewOrigin.same(URL(string: "HTTP://LOCALHOST:5173/x")!, target), "scheme and host case")
check(!PreviewOrigin.same(URL(string: "http://localhost:5174/")!, target), "another port is another site")
check(!PreviewOrigin.same(URL(string: "https://localhost:5173/")!, target), "another scheme")
check(!PreviewOrigin.same(URL(string: "http://127.0.0.1:5173/")!, target), "another host")
check(PreviewOrigin.same(URL(string: "http://example.test:80/")!, URL(string: "http://example.test/")!), "default port")
check(PreviewOrigin.opensExternally(URL(string: "https://example.com/")!, linkActivated: true), "clicked web link")
check(!PreviewOrigin.opensExternally(URL(string: "https://example.com/")!, linkActivated: false), "a scripted redirect never opens a browser")
for scheme in ["javascript:alert(1)", "file:///etc/hosts", "mailto:a@b.c", "data:text/html,x", "vscode://file/x"] {
    check(!PreviewOrigin.opensExternally(URL(string: scheme)!, linkActivated: true), "never external: \(scheme)")
}

let app = NSApplication.shared
ArtifactPreview.shared.show(image, over: nil, order: false)
let shown = ArtifactPreview.shared.inspect
check(shown["path"] as? String == image && shown["item"] as? String == image, "Quick Look item is the image")
check(shown["title"] as? String == "before.png" && shown["visible"] as? Bool == false, "titled, never ordered in")
ArtifactPreview.shared.show(pdf, over: nil, order: false)
check(ArtifactPreview.shared.inspect["item"] as? String == pdf && ArtifactPreview.shared.shown == 2, "the panel is reused")
_ = app
print("{\"ok\":true}")
