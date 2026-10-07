import AppKit

/// One block of an assistant segment in the rendered string (LKM-186).
struct ChatRichBlock {
    enum Kind: String { case text, heading, code, table }
    let kind: Kind
    /// Its characters, without the newline that separates it from the next block.
    let range: NSRange
    /// What copying the whole block gives: the shown text, a fenced block for code,
    /// the Markdown source for a table.
    let copy: String
    /// Code: the padded block behind its paragraphs. Table: one cell block per cell, by row.
    let code: NSTextBlock?
    let cells: [[NSTextTableBlock]]
}

/// An assistant text segment as one attributed string for one TextKit 1 text view, so
/// selection, Select All and Copy span every paragraph, list, heading, table and code
/// block of it. Foundation parses the inline Markdown; AppKit only, no SwiftUI.
struct ChatRichText {
    let string: NSAttributedString
    let blocks: [ChatRichBlock]

    static let fontSize: CGFloat = 13
    static let lineSpacing: CGFloat = 4
    static let blockSpacing: CGFloat = 12
    static let codeInset: CGFloat = 10
    /// Room above the code for its Copy button, as the former button row had.
    static let codeTop: CGFloat = 30
    static let cornerRadius: CGFloat = 8

    init(markdown: String) {
        let parsed = Self.parse(markdown)
        let output = NSMutableAttributedString()
        var blocks: [ChatRichBlock] = []
        for (index, block) in parsed.enumerated() {
            let last = index == parsed.count - 1
            let start = output.length
            var code: NSTextBlock?, cells: [[NSTextTableBlock]] = [], copy: String?
            switch block.kind {
            case .code:
                let box = Self.codeBlock(spacing: last ? 0 : Self.blockSpacing)
                output.append(Self.code(block.text.isEmpty ? " " : block.text, in: box))
                code = box
                let fence = block.fence.isEmpty ? "```" : block.fence
                copy = fence + "\n" + block.text + "\n" + String(fence.prefix(3))
            case .table:
                let rows = block.text.components(separatedBy: "\n").enumerated().filter { $0.offset != 1 }.map { tableCells($0.element) }
                let (text, table) = Self.table(rows, spacing: last ? 0 : Self.blockSpacing)
                output.append(text); cells = table; copy = block.text
            case .heading, .text:
                let font = block.kind == .heading ? NSFont.systemFont(ofSize: 16, weight: .semibold) : NSFont.systemFont(ofSize: Self.fontSize)
                output.append(Self.inline(block.text, font: font, paragraph: Self.prose(after: 0)))
                // TextKit adds the line spacing after the last line too.
                let paragraph = (output.string as NSString).paragraphRange(for: NSRange(location: max(start, output.length - 1), length: 0))
                if !last, paragraph.location >= start { output.addAttribute(.paragraphStyle, value: Self.prose(after: Self.blockSpacing - Self.lineSpacing), range: paragraph) }
            }
            let range = NSRange(location: start, length: output.length - start)
            blocks.append(ChatRichBlock(kind: block.kind, range: range, copy: copy ?? (output.string as NSString).substring(with: range), code: code, cells: cells))
            if !last, output.length > start {
                output.append(NSAttributedString(string: "\n", attributes: output.attributes(at: output.length - 1, effectiveRange: nil)))
            }
        }
        string = output; self.blocks = blocks
    }

    /// Plain text for the selected ranges, keeping paragraph breaks: a block that is
    /// selected whole copies as `copy` (code keeps its fences), a part of one as shown.
    func copyText(_ selections: [NSRange]) -> String {
        let text = string.string as NSString
        var parts: [String] = []
        for selection in selections where selection.length > 0 {
            for block in blocks {
                let part = NSIntersectionRange(selection, block.range)
                guard part.length > 0 else { continue }
                parts.append(part == block.range ? block.copy : text.substring(with: part))
            }
        }
        return parts.joined(separator: "\n\n")
    }

    // MARK: Parsing

    private struct Parsed { let kind: ChatRichBlock.Kind; let text: String; var fence = "" }
    /// Block layout: fenced code, `#` headings, pipe tables, and paragraphs (lists and
    /// soft line breaks stay as written).
    private static func parse(_ source: String) -> [Parsed] {
        var result: [Parsed] = [], lines: [String] = []
        var fence: String? = nil
        func flush(_ kind: ChatRichBlock.Kind = .text) {
            guard !lines.isEmpty else { return }
            let table = kind == .text && lines.count >= 2 && lines[0].contains("|") && lines[1].split(separator: "|").allSatisfy { $0.trimmingCharacters(in: .whitespaces).range(of: "^:?-{3,}:?$", options: .regularExpression) != nil }
            result.append(Parsed(kind: table ? .table : kind, text: lines.joined(separator: "\n"), fence: kind == .code ? fence ?? "" : "")); lines = []
        }
        for line in source.components(separatedBy: "\n") {
            if line.hasPrefix("```") || line.hasPrefix("~~~") {
                if fence != nil { flush(.code); fence = nil }
                else { flush(); fence = line }
            } else if fence != nil { lines.append(line) }
            else if line.isEmpty { flush() }
            else if line.hasPrefix("#") {
                flush(); result.append(Parsed(kind: .heading, text: line.trimmingCharacters(in: CharacterSet(charactersIn: "# "))))
            } else { lines.append(line) }
        }
        flush(fence == nil ? .text : .code)
        return result
    }

    // MARK: Styles

    private static func prose(after: CGFloat) -> NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.lineSpacing = lineSpacing; style.paragraphSpacing = after
        return style
    }
    private static func codeBlock(spacing: CGFloat) -> NSTextBlock {
        let block = NSTextBlock()
        // Without a width TextKit 1 drops the trailing padding and later paragraphs.
        block.setValue(100, type: .percentageValueType, for: .width)
        block.setWidth(codeInset, type: .absoluteValueType, for: .padding)
        block.setWidth(codeTop, type: .absoluteValueType, for: .padding, edge: .minY)
        block.setWidth(spacing, type: .absoluteValueType, for: .margin, edge: .maxY)
        return block
    }
    private static func code(_ text: String, in block: NSTextBlock) -> NSAttributedString {
        let style = NSMutableParagraphStyle(); style.textBlocks = [block]
        let output = NSMutableAttributedString(string: text, attributes: [.font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular), .foregroundColor: NSColor.labelColor, .paragraphStyle: style])
        highlightChatCode(output)
        return output
    }
    private static func table(_ rows: [[String]], spacing: CGFloat) -> (NSAttributedString, [[NSTextTableBlock]]) {
        let columns = max(1, rows.map(\.count).max() ?? 1)
        let table = NSTextTable(); table.numberOfColumns = columns; table.hidesEmptyCells = false
        let output = NSMutableAttributedString()
        var blocks: [[NSTextTableBlock]] = []
        for (row, values) in rows.enumerated() {
            var line: [NSTextTableBlock] = []
            for column in 0..<columns {
                let cell = NSTextTableBlock(table: table, startingRow: row, rowSpan: 1, startingColumn: column, columnSpan: 1)
                cell.setValue(55, type: .absoluteValueType, for: .minimumWidth)
                cell.setWidth(column == 0 ? codeInset : 0, type: .absoluteValueType, for: .padding, edge: .minX)
                cell.setWidth(column == columns - 1 ? codeInset : 16, type: .absoluteValueType, for: .padding, edge: .maxX)
                // 8 pt between rows; the header rule sits in the header's gap.
                cell.setWidth(row == 0 ? codeInset : row == 1 ? 9 : 4, type: .absoluteValueType, for: .padding, edge: .minY)
                cell.setWidth(row == rows.count - 1 ? codeInset : row == 0 ? 8 : 4, type: .absoluteValueType, for: .padding, edge: .maxY)
                if row == rows.count - 1 { cell.setWidth(spacing, type: .absoluteValueType, for: .margin, edge: .maxY) }
                let style = NSMutableParagraphStyle(); style.textBlocks = [cell]
                let text = column < values.count ? values[column] : ""
                let font = NSFont.systemFont(ofSize: fontSize, weight: row == 0 ? .semibold : .regular)
                if output.length > 0 { output.append(NSAttributedString(string: "\n", attributes: output.attributes(at: output.length - 1, effectiveRange: nil))) }
                let content = inline(text, font: font, paragraph: style)
                // An empty cell still needs a character to hold its block.
                output.append(content.length > 0 ? content : NSAttributedString(string: " ", attributes: [.font: font, .paragraphStyle: style]))
                line.append(cell)
            }
            blocks.append(line)
        }
        return (output, blocks)
    }
    /// Inline Markdown (strong, emphasis, code, strikethrough, links), whitespace kept.
    static func inline(_ source: String, font: NSFont, paragraph: NSParagraphStyle) -> NSAttributedString {
        let parsed = (try? AttributedString(markdown: source, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(source)
        let output = NSMutableAttributedString()
        for run in parsed.runs {
            var runFont = font
            var attributes: [NSAttributedString.Key: Any] = [.foregroundColor: NSColor.labelColor, .paragraphStyle: paragraph]
            if let intent = run.inlinePresentationIntent {
                if intent.contains(.code) { runFont = .monospacedSystemFont(ofSize: font.pointSize, weight: .regular) }
                var traits: NSFontDescriptor.SymbolicTraits = []
                if intent.contains(.stronglyEmphasized) { traits.insert(.bold) }
                if intent.contains(.emphasized) { traits.insert(.italic) }
                if !traits.isEmpty { runFont = NSFont(descriptor: runFont.fontDescriptor.withSymbolicTraits(runFont.fontDescriptor.symbolicTraits.union(traits)), size: runFont.pointSize) ?? runFont }
                if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            }
            if let link = run.link { attributes[.link] = link }
            attributes[.font] = runFont
            output.append(NSAttributedString(string: String(parsed[run.range].characters), attributes: attributes))
        }
        return output
    }
}

func copyChatText(_ text: String, to pasteboard: NSPasteboard = .general) { pasteboard.clearContents(); pasteboard.setString(text, forType: .string) }

private func tableCells(_ row: String) -> [String] {
    var cells: [String] = [], current = "", escaped = false, code = false
    for char in row {
        if escaped { current.append(char); escaped = false }
        else if char == "\\" { escaped = true }
        else if char == "`" { code.toggle(); current.append(char) }
        else if char == "|" && !code { cells.append(current.trimmingCharacters(in: .whitespaces)); current = "" }
        else { current.append(char) }
    }
    cells.append(current.trimmingCharacters(in: .whitespaces))
    if row.trimmingCharacters(in: .whitespaces).hasPrefix("|") { cells.removeFirst() }
    if row.trimmingCharacters(in: .whitespaces).hasSuffix("|") && !cells.isEmpty { cells.removeLast() }
    return cells
}
/// Light keyword, number, string and comment colours over the whole of `code`.
func highlightChatCode(_ code: NSMutableAttributedString) {
    let text = code.string
    guard text.utf16.count < 100_000 else { return }
    let rules: [(String, NSColor)] = [("\\b(?:const|let|var|func|function|return|class|struct|import|export|from|if|else|async|await|true|false|null|nil|type|interface|public|private)\\b", .systemPurple), ("\\b[0-9]+(?:\\.[0-9]+)?\\b", .systemBlue), ("\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'", .systemRed), ("//[^\\n]*|/\\*[\\s\\S]*?\\*/", .secondaryLabelColor)]
    for (pattern, color) in rules {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
        for match in regex.matches(in: text, range: NSRange(location: 0, length: text.utf16.count)) { code.addAttribute(.foregroundColor, value: color, range: match.range) }
    }
}
