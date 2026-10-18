import Foundation
import SwiftParser
import SwiftSyntax

// The preview scanner (LKM-276): `scanner.ts` compiles this file once per toolchain
// against the selected Xcode's own SwiftSyntax (`usr/lib/swift/host`), then runs it
// with one absolute `.swift` path per stdin line. It parses each file (no type
// checking, nothing is written) and prints one JSON document: every `#Preview` with
// its name, traits, `@Previewable` declarations and body text and lines, every
// `PreviewProvider`, and every type declaration (access, inheritance, initializers,
// stored properties, methods, enum cases) with the `#if` clauses and `@available`
// attributes around it. `catalog.ts` decides what can be previewed from that.

struct Param: Codable { var label: String; var name: String; var type: String; var hasDefault: Bool }
struct Initializer: Codable { var access: String; var failable: Bool; var effects: String; var params: [Param]; var line: Int }
struct Property: Codable {
    var name: String; var type: String; var wrapper: String; var wrapperArgs: String
    var hasDefault: Bool; var isLet: Bool; var isStatic: Bool; var computed: Bool; var access: String
}
struct EnumCase: Codable { var name: String; var associated: Bool }
struct TypeDecl: Codable {
    var kind: String; var name: String; var qualified: String; var access: String; var ownAccess: String
    var line: Int; var endLine: Int; var inherits: [String]; var generic: Bool; var conditions: [String]
    var attributes: [String]; var inits: [Initializer]; var properties: [Property]; var methods: [String]
    var cases: [EnumCase]; var nested: Bool; var parentPrivate: Bool
}
struct Statement: Codable { var text: String; var line: Int }
struct Preview: Codable {
    var index: Int; var line: Int; var endLine: Int; var name: String?; var nameExpr: String?
    var traits: [String]; var attributes: [String]; var conditions: [String]; var context: String
    var bodyLine: Int; var body: String; var previewable: [Statement]; var rest: Statement?
    var previewableAfter: Bool; var identifiers: [String]; var problems: [String]
}
struct Import: Codable { var text: String; var conditions: [String] }
struct FileScan: Codable {
    var path: String; var error: String?; var imports: [Import]; var privateNames: [String]
    var previews: [Preview]; var types: [TypeDecl]
}

let accessWords = ["private", "fileprivate", "internal", "package", "public", "open"]
let rank = ["private": 0, "fileprivate": 1, "internal": 2, "package": 3, "public": 4, "open": 5]

func ownAccess(_ modifiers: DeclModifierListSyntax) -> String {
    for m in modifiers where m.detail == nil && accessWords.contains(m.name.text) { return m.name.text }
    return ""
}

func hasModifier(_ modifiers: DeclModifierListSyntax, _ names: [String]) -> Bool {
    modifiers.contains { names.contains($0.name.text) }
}

/// The narrower of two access levels; nested declarations cannot be seen wider than their parent.
func narrower(_ a: String, _ b: String) -> String { (rank[a] ?? 2) <= (rank[b] ?? 2) ? a : b }

func attributeTexts(_ list: AttributeListSyntax) -> [String] {
    list.compactMap { element in
        guard case .attribute(let attribute) = element else { return nil }
        return attribute.trimmedDescription
    }
}

/// The `#if` clauses around a node, as conditions that are true exactly where it compiles.
func conditions(of node: Syntax) -> [String] {
    var found: [String] = []
    var current = node.parent
    while let parent = current {
        if let clause = parent.as(IfConfigClauseSyntax.self), let list = clause.parent?.as(IfConfigClauseListSyntax.self) {
            var parts: [String] = []
            for other in list {
                if other.id == clause.id { break }
                if let condition = other.condition { parts.append("!(\(condition.trimmedDescription))") }
            }
            if let condition = clause.condition { parts.append("(\(condition.trimmedDescription))") }
            if !parts.isEmpty { found.insert(parts.joined(separator: " && "), at: 0) }
        }
        current = parent.parent
    }
    return found
}

final class Identifiers: SyntaxVisitor {
    var names = Set<String>()
    override func visit(_ node: DeclReferenceExprSyntax) -> SyntaxVisitorContinueKind {
        names.insert(node.baseName.text); return .visitChildren
    }
    override func visit(_ node: IdentifierTypeSyntax) -> SyntaxVisitorContinueKind {
        names.insert(node.name.text); return .visitChildren
    }
}

/// Names declared `private` or `fileprivate` anywhere in the file.
final class PrivateNames: SyntaxVisitor {
    var names = Set<String>()
    func add(_ modifiers: DeclModifierListSyntax, _ name: String) {
        if modifiers.contains(where: { $0.detail == nil && ($0.name.text == "private" || $0.name.text == "fileprivate") }) { names.insert(name) }
    }
    override func visit(_ node: StructDeclSyntax) -> SyntaxVisitorContinueKind { add(node.modifiers, node.name.text); return .visitChildren }
    override func visit(_ node: ClassDeclSyntax) -> SyntaxVisitorContinueKind { add(node.modifiers, node.name.text); return .visitChildren }
    override func visit(_ node: EnumDeclSyntax) -> SyntaxVisitorContinueKind { add(node.modifiers, node.name.text); return .visitChildren }
    override func visit(_ node: ActorDeclSyntax) -> SyntaxVisitorContinueKind { add(node.modifiers, node.name.text); return .visitChildren }
    override func visit(_ node: ProtocolDeclSyntax) -> SyntaxVisitorContinueKind { add(node.modifiers, node.name.text); return .visitChildren }
    override func visit(_ node: TypeAliasDeclSyntax) -> SyntaxVisitorContinueKind { add(node.modifiers, node.name.text); return .visitChildren }
    override func visit(_ node: FunctionDeclSyntax) -> SyntaxVisitorContinueKind { add(node.modifiers, node.name.text); return .visitChildren }
    override func visit(_ node: VariableDeclSyntax) -> SyntaxVisitorContinueKind {
        for binding in node.bindings { if let id = binding.pattern.as(IdentifierPatternSyntax.self) { add(node.modifiers, id.identifier.text) } }
        return .visitChildren
    }
}

final class Scanner {
    let source: String
    let tree: SourceFileSyntax
    let converter: SourceLocationConverter
    var scan: FileScan
    var previewCount = 0

    init(path: String, source: String) {
        self.source = source
        tree = Parser.parse(source: source)
        converter = SourceLocationConverter(fileName: path, tree: tree)
        scan = FileScan(path: path, error: nil, imports: [], privateNames: [], previews: [], types: [])
    }

    func line(_ node: some SyntaxProtocol) -> Int { node.startLocation(converter: converter).line }
    func endLine(_ node: some SyntaxProtocol) -> Int { node.endLocation(converter: converter).line }

    /// The original text from the start of `first` to the end of `last`, comments inside kept.
    func text(from first: some SyntaxProtocol, to last: some SyntaxProtocol) -> String {
        let bytes = Array(source.utf8)
        let start = first.positionAfterSkippingLeadingTrivia.utf8Offset
        let end = last.endPositionBeforeTrailingTrivia.utf8Offset
        guard start <= end, end <= bytes.count else { return "" }
        return String(decoding: bytes[start..<end], as: UTF8.self)
    }

    func run() -> FileScan {
        let names = PrivateNames(viewMode: .sourceAccurate)
        names.walk(tree)
        scan.privateNames = names.names.sorted()
        // File scope does not narrow: a public type there is public.
        items(tree.statements, chain: [], access: "open", parentPrivate: false)
        return scan
    }

    func items(_ list: CodeBlockItemListSyntax, chain: [String], access: String, parentPrivate: Bool) {
        for item in list {
            switch item.item {
            case .decl(let decl): declaration(decl, chain: chain, access: access, parentPrivate: parentPrivate)
            case .expr(let expr):
                if let macro = expr.as(MacroExpansionExprSyntax.self), macro.macroName.text == "Preview" {
                    preview(Syntax(macro), arguments: macro.arguments, closure: macro.trailingClosure, attributes: [], context: "file")
                }
            default: break
            }
        }
    }

    func members(_ list: MemberBlockItemListSyntax, chain: [String], access: String, parentPrivate: Bool) {
        for member in list { declaration(member.decl, chain: chain, access: access, parentPrivate: parentPrivate) }
    }

    func declaration(_ decl: DeclSyntax, chain: [String], access: String, parentPrivate: Bool) {
        if let node = decl.as(ImportDeclSyntax.self), chain.isEmpty {
            scan.imports.append(Import(text: node.trimmedDescription, conditions: conditions(of: Syntax(node))))
        } else if let node = decl.as(IfConfigDeclSyntax.self) {
            for clause in node.clauses {
                switch clause.elements {
                case .statements(let list): items(list, chain: chain, access: access, parentPrivate: parentPrivate)
                case .decls(let list): members(list, chain: chain, access: access, parentPrivate: parentPrivate)
                default: break
                }
            }
        } else if let node = decl.as(MacroExpansionDeclSyntax.self), node.macroName.text == "Preview" {
            preview(Syntax(node), arguments: node.arguments, closure: node.trailingClosure,
                    attributes: attributeTexts(node.attributes), context: chain.isEmpty ? "file" : "type")
        } else if let node = decl.as(StructDeclSyntax.self) {
            type("struct", Syntax(node), node.name.text, node.modifiers, node.attributes, node.inheritanceClause,
                 node.genericParameterClause != nil, node.memberBlock, chain, access, parentPrivate)
        } else if let node = decl.as(ClassDeclSyntax.self) {
            type("class", Syntax(node), node.name.text, node.modifiers, node.attributes, node.inheritanceClause,
                 node.genericParameterClause != nil, node.memberBlock, chain, access, parentPrivate)
        } else if let node = decl.as(EnumDeclSyntax.self) {
            type("enum", Syntax(node), node.name.text, node.modifiers, node.attributes, node.inheritanceClause,
                 node.genericParameterClause != nil, node.memberBlock, chain, access, parentPrivate)
        } else if let node = decl.as(ActorDeclSyntax.self) {
            type("actor", Syntax(node), node.name.text, node.modifiers, node.attributes, node.inheritanceClause,
                 node.genericParameterClause != nil, node.memberBlock, chain, access, parentPrivate)
        } else if let node = decl.as(ExtensionDeclSyntax.self), chain.isEmpty {
            let name = node.extendedType.trimmedDescription
            type("extension", Syntax(node), name, node.modifiers, node.attributes, node.inheritanceClause,
                 node.genericWhereClause != nil, node.memberBlock, [], access, parentPrivate, qualified: name)
        }
    }

    func type(_ kind: String, _ node: Syntax, _ name: String, _ modifiers: DeclModifierListSyntax,
              _ attributes: AttributeListSyntax, _ inheritance: InheritanceClauseSyntax?, _ generic: Bool,
              _ block: MemberBlockSyntax, _ chain: [String], _ outer: String, _ parentPrivate: Bool,
              qualified: String? = nil) {
        let own = ownAccess(modifiers)
        let effective = narrower(own.isEmpty ? (kind == "extension" ? "internal" : narrower(outer, "internal")) : own, outer)
        let qualifiedName = qualified ?? (chain + [name]).joined(separator: ".")
        var decl = TypeDecl(kind: kind, name: name, qualified: qualifiedName, access: effective, ownAccess: own,
                            line: line(node), endLine: endLine(node),
                            inherits: inheritance?.inheritedTypes.map { $0.type.trimmedDescription } ?? [],
                            generic: generic, conditions: conditions(of: node), attributes: attributeTexts(attributes),
                            inits: [], properties: [], methods: [], cases: [], nested: !chain.isEmpty,
                            parentPrivate: parentPrivate)
        // Members of an extension default to the extension's own access.
        let memberDefault = kind == "extension" && !own.isEmpty ? own : "internal"
        collect(block.members, into: &decl, memberDefault: memberDefault)
        scan.types.append(decl)
        let isPrivate = parentPrivate || own == "private"
        let chainNext = kind == "extension" ? qualifiedName.split(separator: ".").map(String.init) : chain + [name]
        members(block.members, chain: chainNext, access: effective, parentPrivate: isPrivate)
    }

    func collect(_ members: MemberBlockItemListSyntax, into decl: inout TypeDecl, memberDefault: String) {
        for member in members {
            if let node = member.decl.as(IfConfigDeclSyntax.self) {
                for clause in node.clauses { if case .decls(let list) = clause.elements { collect(list, into: &decl, memberDefault: memberDefault) } }
            } else if let node = member.decl.as(InitializerDeclSyntax.self) {
                let own = ownAccess(node.modifiers)
                let params = node.signature.parameterClause.parameters.map { p in
                    Param(label: p.firstName.text, name: (p.secondName ?? p.firstName).text,
                          type: p.type.trimmedDescription, hasDefault: p.defaultValue != nil)
                }
                decl.inits.append(Initializer(access: own.isEmpty ? memberDefault : own, failable: node.optionalMark != nil,
                                              effects: node.signature.effectSpecifiers?.trimmedDescription ?? "",
                                              params: params, line: line(node)))
            } else if let node = member.decl.as(VariableDeclSyntax.self) {
                let own = ownAccess(node.modifiers)
                let wrapper = node.attributes.compactMap { element -> AttributeSyntax? in
                    if case .attribute(let attribute) = element { return attribute }
                    return nil
                }.first
                for binding in node.bindings {
                    guard let id = binding.pattern.as(IdentifierPatternSyntax.self) else { continue }
                    var computed = false
                    if let accessors = binding.accessorBlock {
                        switch accessors.accessors {
                        case .getter: computed = true
                        case .accessors(let list): computed = list.contains { ["get", "_read", "unsafeAddress"].contains($0.accessorSpecifier.text) }
                        @unknown default: computed = true
                        }
                    }
                    decl.properties.append(Property(
                        name: id.identifier.text, type: binding.typeAnnotation?.type.trimmedDescription ?? "",
                        wrapper: wrapper?.attributeName.trimmedDescription ?? "",
                        wrapperArgs: wrapper?.arguments?.trimmedDescription ?? "",
                        hasDefault: binding.initializer != nil, isLet: node.bindingSpecifier.text == "let",
                        isStatic: hasModifier(node.modifiers, ["static", "class"]), computed: computed,
                        access: own.isEmpty ? memberDefault : own))
                }
            } else if let node = member.decl.as(FunctionDeclSyntax.self) {
                decl.methods.append(node.name.text)
            } else if let node = member.decl.as(EnumCaseDeclSyntax.self) {
                for element in node.elements { decl.cases.append(EnumCase(name: element.name.text, associated: element.parameterClause != nil)) }
            }
        }
    }

    func preview(_ node: Syntax, arguments: LabeledExprListSyntax, closure: ClosureExprSyntax?, attributes: [String], context: String) {
        previewCount += 1
        var entry = Preview(index: previewCount, line: line(node), endLine: endLine(node), name: nil, nameExpr: nil,
                            traits: [], attributes: attributes, conditions: conditions(of: node), context: context,
                            bodyLine: 0, body: "", previewable: [], rest: nil, previewableAfter: false,
                            identifiers: [], problems: [])
        var inTraits = false
        var body = closure
        for (offset, argument) in arguments.enumerated() {
            let label = argument.label?.text
            if label == "body", let closure = argument.expression.as(ClosureExprSyntax.self) { body = closure; continue }
            if offset == 0 && label == nil {
                if let literal = argument.expression.as(StringLiteralExprSyntax.self),
                   literal.segments.allSatisfy({ $0.is(StringSegmentSyntax.self) }) {
                    entry.name = literal.segments.compactMap { $0.as(StringSegmentSyntax.self)?.content.text }.joined()
                } else { entry.nameExpr = argument.expression.trimmedDescription }
                continue
            }
            if label == "traits" { inTraits = true }
            if inTraits && (label == "traits" || label == nil) { entry.traits.append(argument.expression.trimmedDescription); continue }
            entry.problems.append("an argument \(label.map { "\($0): " } ?? "")Trezi does not know")
        }
        guard let body else {
            entry.problems.append("no body closure")
            scan.previews.append(entry)
            return
        }
        let statements = Array(body.statements)
        let identifiers = Identifiers(viewMode: .sourceAccurate)
        identifiers.walk(body)
        entry.identifiers = identifiers.names.sorted()
        if let first = statements.first, let last = statements.last {
            entry.bodyLine = line(first)
            entry.body = text(from: first, to: last)
        }
        var restStart: Int?
        for (offset, statement) in statements.enumerated() {
            if case .decl(let decl) = statement.item, var variable = decl.as(VariableDeclSyntax.self),
               variable.attributes.contains(where: { element in
                   if case .attribute(let attribute) = element { return attribute.attributeName.trimmedDescription == "Previewable" }
                   return false
               }) {
                if restStart != nil { entry.previewableAfter = true }
                variable.attributes = variable.attributes.filter { element in
                    if case .attribute(let attribute) = element { return attribute.attributeName.trimmedDescription != "Previewable" }
                    return true
                }
                entry.previewable.append(Statement(text: variable.trimmedDescription, line: line(statement)))
            } else if restStart == nil { restStart = offset }
        }
        if let start = restStart, let last = statements.last {
            entry.rest = Statement(text: text(from: statements[start], to: last), line: line(statements[start]))
        }
        scan.previews.append(entry)
    }
}

var results: [FileScan] = []
while let path = readLine(strippingNewline: true) {
    if path.isEmpty { continue }
    guard let data = FileManager.default.contents(atPath: path), let source = String(data: data, encoding: .utf8) else {
        results.append(FileScan(path: path, error: "could not be read as UTF-8", imports: [], privateNames: [], previews: [], types: []))
        continue
    }
    results.append(Scanner(path: path, source: source).run())
}
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
FileHandle.standardOutput.write(try! encoder.encode(["files": results]))
