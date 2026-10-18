import Foundation

/// The skills-only scope of a GitHub import (LKM-285). A package is instructions and
/// reference text; anything a provider could run, connect or grant from it is refused,
/// not stripped, so what is stored is exactly what was reviewed upstream:
///
/// - `SKILL.md` frontmatter holds only `name`, `description`, `license`, `compatibility`
///   and `metadata` (no `allowed-tools`, `hooks`, `context`, `agent`, `model`, …), as plain
///   top-level `key:` lines; YAML flow, anchors or complex keys are refused.
/// - No Markdown file uses dynamic preprocessing (`!` followed by a backtick), which
///   Claude runs as a shell command before the skill is read.
/// - No hook, MCP, plugin or settings manifest, and no dependency manifest.
/// - No script, executable or not: a script file extension or a `#!` first line is refused.
/// - No Codex `openai.yaml`/`openai.yml` at all: it is provider-control metadata that can
///   declare tool and MCP dependencies, and it is not parsed, so no spelling can hide one.
///
/// Links, special files and executables never reach this point (`TarReader`).
enum SkillsScope {
    static let frontmatterKeys: Set<String> = ["name", "description", "license", "compatibility", "metadata"]
    /// Compared case-insensitively against each file's name.
    static let controlFiles: Set<String> = [
        "hooks.json", "mcp.json", "plugin.json", "marketplace.json", "settings.json", "settings.local.json",
        "package.json", "package-lock.json", "requirements.txt", "pyproject.toml", "pipfile", "gemfile",
        "cargo.toml", "go.mod", "package.swift", "podfile", "makefile"
    ]

    /// Script file extensions, compared case-insensitively. A script is refused whether or
    /// not it is executable, and a file starting with `#!` is refused whatever its name.
    static let scriptExtensions: [String] = [
        ".sh", ".bash", ".zsh", ".fish", ".ksh", ".csh", ".py", ".rb", ".pl", ".php", ".lua", ".js", ".mjs", ".cjs",
        ".ts", ".mts", ".cts", ".ps1", ".bat", ".cmd", ".command", ".scpt", ".applescript"
    ]

    /// Codex's per-skill metadata. It can declare tool and MCP-server `dependencies`, and
    /// YAML has too many spellings (indented roots, flow, quoted or escaped keys) to vet
    /// with a partial parser, so any file with this name is refused, wherever it sits.
    static let providerMetadata: Set<String> = ["openai.yaml", "openai.yml"]

    static func check(_ files: [SkillFile]) throws {
        for file in files {
            let name = (file.path.split(separator: "/").last.map(String.init) ?? file.path).lowercased()
            guard !controlFiles.contains(name) else {
                throw SkillsPackageError.refused("\(file.path) is a hook, tool or dependency manifest; imported skills hold instructions only.")
            }
            guard !providerMetadata.contains(name) else {
                throw SkillsPackageError.refused("\(file.path) is provider-control metadata (it can declare tool dependencies); imported skills hold instructions only.")
            }
            guard !scriptExtensions.contains(where: { name.hasSuffix($0) }) else {
                throw SkillsPackageError.refused("\(file.path) is a script; imported skills hold instructions only.")
            }
            let text = try SkillsPackage.text(file)
            guard !text.hasPrefix("#!") else {
                throw SkillsPackageError.refused("\(file.path) starts with a shebang and is a script; imported skills hold instructions only.")
            }
            if name.hasSuffix(".md") || name.hasSuffix(".markdown"), let line = lineNumber(of: "!`", in: text) {
                throw SkillsPackageError.refused("\(file.path) line \(line) uses dynamic preprocessing (!`…`), which would run a command.")
            }
        }
        guard let entry = files.first(where: { $0.path == SkillsPackage.entryFile }) else { return }
        let keys = try frontmatter(try SkillsPackage.text(entry)).map(\.key)
        let extra = keys.filter { !frontmatterKeys.contains($0) }
        guard extra.isEmpty else {
            throw SkillsPackageError.refused("SKILL.md declares \(extra.prefix(5).joined(separator: ", ")); imported skills may only declare \(frontmatterKeys.sorted().joined(separator: ", ")).")
        }
    }

    static func lineNumber(of needle: String, in text: String) -> Int? {
        for (index, line) in text.components(separatedBy: "\n").enumerated() where line.contains(needle) { return index + 1 }
        return nil
    }

    /// The top-level `key: value` lines of the frontmatter; indented lines continue the
    /// previous key. Anything else at the top level is refused.
    static func frontmatter(_ content: String) throws -> [(key: String, value: String)] {
        let lines = content.components(separatedBy: "\n").map { $0.hasSuffix("\r") ? String($0.dropLast()) : $0 }
        guard lines.first == "---", let end = lines.dropFirst().firstIndex(of: "---") else { return [] }
        var out: [(key: String, value: String)] = []
        for line in lines[1..<end] {
            guard let first = line.first, first != " ", first != "\t", first != "#" else { continue }
            guard let colon = line.firstIndex(of: ":") else { throw SkillsPackageError.refused("SKILL.md has frontmatter that is not a plain key list.") }
            let key = String(line[..<colon])
            guard !key.isEmpty, key.utf8.allSatisfy({ (0x61...0x7A).contains($0) || (0x41...0x5A).contains($0) || (0x30...0x39).contains($0) || $0 == 0x2D || $0 == 0x5F }),
                  !out.contains(where: { $0.key == key }) else {
                throw SkillsPackageError.refused("SKILL.md has frontmatter that is not a plain key list.")
            }
            out.append((key, line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)))
        }
        return out
    }
}

/// License evidence for an imported skill: its own license file, its `license`
/// frontmatter (an SPDX identifier), or the repository's top-level license file. The
/// identifier is SPDX when the text is recognised, `NOASSERTION` when a license was
/// found but not recognised, and none when nothing was found.
enum SkillsLicense {
    static let names: Set<String> = ["license", "license.md", "license.txt", "licence", "licence.md", "licence.txt", "copying", "copying.md", "copying.txt"]
    static let identifiers = ["0BSD", "AGPL-3.0", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "CC-BY-4.0", "CC-BY-NC-4.0", "CC-BY-SA-4.0",
                              "CC0-1.0", "GPL-2.0", "GPL-3.0", "ISC", "LGPL-2.1", "LGPL-3.0", "MIT", "MIT-0", "MPL-2.0", "Unlicense"]
    static let unrecognized = "NOASSERTION"

    static func isLicenseFile(_ path: String) -> Bool { !path.contains("/") && names.contains(path.lowercased()) }

    struct Evidence: Equatable, Sendable {
        let license: String?
        /// Repository-relative path of the evidence (a file, or the skill's SKILL.md).
        let file: String?
        /// The repository license copied into the package for attribution, if any.
        let attribution: SkillFile?
    }

    static func evidence(files: [SkillFile], subpath: String, rootLicenses: [SkillFile]) -> Evidence {
        func repository(_ path: String) -> String { subpath.isEmpty ? path : subpath + "/" + path }
        if let own = files.filter({ isLicenseFile($0.path) }).min(by: { $0.path < $1.path }) {
            return Evidence(license: identify(own.data), file: repository(own.path), attribution: nil)
        }
        let root = rootLicenses.min { $0.path < $1.path }
        let declared = files.first { $0.path == SkillsPackage.entryFile }
            .flatMap { try? SkillsScope.frontmatter(String(decoding: $0.data, as: UTF8.self)) }?
            .first { $0.key == "license" }?.value.trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))
        if let declared, !declared.isEmpty, let id = identifiers.first(where: { $0.lowercased() == declared.lowercased() }) {
            return Evidence(license: id, file: repository(SkillsPackage.entryFile), attribution: root)
        }
        if let root { return Evidence(license: identify(root.data), file: root.path, attribution: root) }
        if let declared, !declared.isEmpty { return Evidence(license: unrecognized, file: repository(SkillsPackage.entryFile), attribution: nil) }
        return Evidence(license: nil, file: nil, attribution: nil)
    }

    /// Recognises common license texts by their operative sentences.
    static func identify(_ data: Data) -> String {
        let text = String(decoding: data, as: UTF8.self).lowercased()
            .components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
        func has(_ parts: String...) -> Bool { parts.allSatisfy { text.contains($0) } }
        if has("gnu affero general public license", "version 3") { return "AGPL-3.0" }
        if has("gnu lesser general public license", "version 3") { return "LGPL-3.0" }
        if has("gnu lesser general public license", "version 2.1") { return "LGPL-2.1" }
        if has("gnu general public license", "version 3") { return "GPL-3.0" }
        if has("gnu general public license", "version 2") { return "GPL-2.0" }
        if has("apache license", "version 2.0") { return "Apache-2.0" }
        if has("mozilla public license", "2.0") { return "MPL-2.0" }
        if has("noncommercial") { return has("creative commons", "4.0") ? "CC-BY-NC-4.0" : unrecognized }
        if has("attribution-sharealike 4.0") { return "CC-BY-SA-4.0" }
        if has("cc0 1.0 universal") { return "CC0-1.0" }
        if has("creative commons attribution 4.0 international") { return "CC-BY-4.0" }
        if has("this is free and unencumbered software released into the public domain") { return "Unlicense" }
        if has("permission is hereby granted, free of charge, to any person obtaining a copy") {
            return has("the above copyright notice and this permission notice shall be included") ? "MIT" : "MIT-0"
        }
        if has("permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted") {
            return has("provided that the above copyright notice and this permission notice appear in all copies") ? "ISC" : "0BSD"
        }
        if has("redistribution and use in source and binary forms") {
            return has("neither the name") ? "BSD-3-Clause" : "BSD-2-Clause"
        }
        return unrecognized
    }
}
