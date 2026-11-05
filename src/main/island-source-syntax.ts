import ts from 'typescript'

/** Parse JavaScript/TypeScript island source without accepting a recovered AST.
 * Other source types keep their existing binding-specific validation. */
export function parseIslandProgram(code: string, file: string): ts.SourceFile | null {
  if (!/\.[cm]?[jt]sx?$/.test(file)) return null
  const kind = file.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : file.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : /\.[cm]?ts$/.test(file)
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS
  const source = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    true,
    kind
  ) as ts.SourceFile & {
    parseDiagnostics: readonly ts.Diagnostic[]
  }
  if (source.parseDiagnostics.length) return null
  const bindings = new Map<string, boolean>()
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    const lexical =
      (statement.declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) !== 0
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue
      const name = declaration.name.text
      if (bindings.has(name) && (lexical || bindings.get(name))) return null
      bindings.set(name, lexical)
    }
  }
  return source
}
