import Foundation
import Darwin

/// Opening things outside Trezi (LKM-102), formerly Bun's own `/usr/bin/open` and editor
/// CLI runs (`native/platform.ts` `shell.openExternal`/`openPath`, `main/props.ts`
/// "Open in editor"; the sole owner since LKM-111 removed the TS twins):
/// - an external link: http(s) only, handed to `open` as one argument;
/// - a file: an existing absolute path, opened with its default app;
/// - "Open in editor": a file inside the project, tried with the editor CLIs in order
///   (`code -g`, `cursor -g`, `zed`, `subl`: each takes `file:line[:col]`, 5 s each; a
///   missing one is skipped), then the file's default app without the jump.
/// Nothing runs through a shell and every tool gets its own bounded process group.
enum PlatformOpen {
    struct Tools {
        var open = "/usr/bin/open"
        /// The launch environment: the editor CLIs are looked up on its PATH.
        var environment: [String: String] = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        var timeout: TimeInterval = 5
        var editors: [(command: String, jump: [String])] = [("code", ["-g"]), ("cursor", ["-g"]), ("zed", []), ("subl", [])]
    }

    static func link(_ url: String, tools: Tools) throws {
        guard url.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil else {
            throw PlatformRefusal(.invalidRequest, "Only HTTP(S) external links are supported")
        }
        let result = try PlatformTool.run(tools.open, [url], environment: tools.environment, timeout: 30)
        guard result.ok else { throw PlatformRefusal(.ioFailure, PlatformTool.failure([tools.open, url], result)) }
    }

    /// The legacy `openPath` contract: "" on success, else the failure text.
    static func file(_ path: String, tools: Tools) -> String {
        guard path.hasPrefix("/"), FileManager.default.fileExists(atPath: path) else { return "The file does not exist." }
        do {
            let result = try PlatformTool.run(tools.open, [path], environment: tools.environment, timeout: 30)
            return result.ok ? "" : "Error: " + PlatformTool.failure([tools.open, path], result)
        } catch { return "Error: \(error)" }
    }

    /// `path` must be a regular file inside `root` (symlinks resolved); the first editor
    /// CLI that exits 0 wins.
    static func editor(root: String, path: String, line: Int, column: Int?, tools: Tools) throws -> JSValue {
        let realRoot = URL(fileURLWithPath: root).resolvingSymlinksInPath().path
        let realFile = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
        var info = stat()
        guard stat(realFile, &info) == 0, info.st_mode & S_IFMT == S_IFREG else {
            return .object([(JSText("ok"), .bool(false)), (JSText("error"), .string(JSText("The source file does not exist.")))])
        }
        guard realFile.hasPrefix(realRoot.hasSuffix("/") ? realRoot : realRoot + "/") else {
            throw PlatformRefusal(.unauthorized, "The file is outside the project.")
        }
        let target = "\(path):\(line)" + (column.map { ":\($0)" } ?? "")
        for editor in tools.editors {
            guard let result = try? PlatformTool.run(editor.command, editor.jump + [target], environment: tools.environment,
                                                      timeout: tools.timeout), result.ok else { continue }
            return .object([(JSText("ok"), .bool(true))])
        }
        let failure = file(path, tools: tools)
        return failure.isEmpty ? .object([(JSText("ok"), .bool(true))])
            : .object([(JSText("ok"), .bool(false)), (JSText("error"), .string(JSText(failure)))])
    }
}
