import AppKit
import UniformTypeIdentifiers

/// LKM-168: the host's product log ("app" lines in ~/Library/Logs/Trezi, src/service/ProductLog.swift),
/// slow main-thread commands, and the Help menu's log items. Copy and Export are built by
/// Bun (src/main/log-support.ts); the host only owns the pasteboard and the save panel.
extension Host {
    static let slowCommandMs = 250.0

    func startProductLog() {
        ProductLog.configure(process: "app", environment: HostLaunch.environment)
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "?", build = info["CFBundleVersion"] as? String ?? "?"
        let os = ProcessInfo.processInfo.operatingSystemVersionString
        ProductLog.info("lifecycle", "App started version=\(version) build=\(build) sha=\(info["TreziCommit"] as? String ?? "?") pid=\(getpid()) macos=\"\(os)\"")
    }

    /// Runs one Bun command; a main-thread stall over 250 ms is logged with the method that ran.
    func dispatch(_ c: [String: Any]) {
        let started = DispatchTime.now().uptimeNanoseconds
        command(c)
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
        if elapsed > Host.slowCommandMs {
            ProductLog.warn("main-thread", "Slow main-thread operation: command \(c["method"] as? String ?? "?") took \(Int(elapsed)) ms")
        }
    }

    func installHelpMenu(_ menu: NSMenu) {
        let item = NSMenuItem(); item.title = "Help"; let help = NSMenu(title: "Help"); item.submenu = help; menu.addItem(item)
        for (label, action) in [("Copy Logs for Support", "copy-logs"), ("Show Logs in Finder", ""), ("Export Logs…", "export-logs")] {
            let entry = NSMenuItem(title: label, action: action.isEmpty ? #selector(showLogsInFinder(_:)) : #selector(menuAction(_:)), keyEquivalent: "")
            entry.target = self; entry.representedObject = action; help.addItem(entry)
        }
        NSApp.helpMenu = help
    }

    @objc func showLogsInFinder(_ sender: Any?) {
        let folder = ProductLog.configuredDirectory
        try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        ProductLog.info("support", "Show Logs in Finder")
        NSWorkspace.shared.open(URL(fileURLWithPath: folder, isDirectory: true))
    }

    /// `copyText` (Copy Logs for Support) and `pickLogExport` (Export Logs… save panel).
    func logCommand(_ c: [String: Any], id: Int) -> Bool {
        switch c["method"] as? String {
        case "copyText":
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(c["text"] as? String ?? "", forType: .string)
            reply(id, true)
        case "pickLogExport":
            let panel = NSSavePanel(); panel.nameFieldStringValue = c["name"] as? String ?? "Trezi Logs.zip"
            panel.allowedContentTypes = [.zip]; panel.canCreateDirectories = true
            panel.beginSheetModal(for: sheets.panel ?? window) { result in self.reply(id, result == .OK ? panel.url?.path as Any? ?? NSNull() : NSNull()) }
        default: return false
        }
        return true
    }

    /// A preview URL without its query or fragment, which can carry tokens.
    static func logURL(_ url: URL?) -> String {
        guard let url, var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return "-" }
        parts.query = nil; parts.fragment = nil; parts.user = nil; parts.password = nil
        return parts.string ?? "-"
    }
}
