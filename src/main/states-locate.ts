import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import ts from 'typescript'
import { resolveSource, withinRoot } from './props'
import { type PropShape, propsSchema } from './states-schema'

/** The component Show states draws, found from the selection's stamps. */
export interface LocatedComponent {
  component: string
  /** Project-relative module the bundle imports (the call site's import target). */
  source: string
  exportName: string
  /** Project-relative file that defines the component; differs from `source` behind a barrel. */
  definition: string
  schema: Record<string, PropShape> | null
  /** Literal props written at the selected call site. */
  callProps: Record<string, unknown>
  /** The call site stamp the live instance carries, when the component was found from it. */
  callSite: string | null
  directive: 'client' | 'server' | null
  /** Why the component cannot render in the browser at all (an async Server Component). */
  server?: string
  /** Hooks in the definition that discovery cannot drive through props. */
  internal: { state: boolean; data: boolean }
}

export type Located = LocatedComponent | { error: string }

type Selection = { source: string | null; componentSource: string | null }

const isComponentName = (name: string) => /^[A-Z][\w$]*$/.test(name)

function program(root: string, file: string): ts.Program {
  // The file's own tsconfig (a monorepo app or subfolder), never one above the project.
  const found = ts.findConfigFile(dirname(file), ts.sys.fileExists)
  const configPath = found && !relative(root, found).startsWith('..') ? found : undefined
  const base = configPath ? dirname(configPath) : root
  const config = configPath ? ts.readConfigFile(configPath, ts.sys.readFile).config : {}
  const parsed = ts.parseJsonConfigFileContent(config ?? {}, ts.sys, base)
  return ts.createProgram([file], {
    ...parsed.options,
    noEmit: true,
    allowJs: true,
    skipLibCheck: true,
    jsx: ts.JsxEmit.Preserve,
    types: parsed.options.types ?? ['react'],
    typeRoots: parsed.options.typeRoots ?? [
      join(base, 'node_modules/@types'),
      join(root, 'node_modules/@types')
    ]
  })
}

function nodeAt(source: ts.SourceFile, line: number, column?: number) {
  let lineStart: number
  try {
    lineStart = source.getPositionOfLineAndCharacter(line - 1, 0)
  } catch {
    return null
  }
  const lineEnd = source.getLineEndOfPosition(lineStart)
  const offset = column === undefined ? -1 : lineStart + column
  const openings: ts.JsxOpeningLikeElement[] = []
  const walk = (node: ts.Node): void => {
    if (node.end < lineStart || node.pos > lineEnd) return
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const start = node.getStart(source)
      if (start >= lineStart && start <= lineEnd) openings.push(node)
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
  const exact = openings.find((node) => node.getStart(source) === offset)
  return { opening: exact ?? openings[0] ?? null, position: offset >= 0 ? offset : lineStart }
}

const directiveOf = (file: ts.SourceFile): LocatedComponent['directive'] => {
  for (const statement of file.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break
    if (statement.expression.text === 'use client') return 'client'
    if (statement.expression.text === 'use server') return 'server'
  }
  return null
}

/** The function behind a declaration, through `memo(...)`/`forwardRef(...)` wrappers. */
function functionOf(node: ts.Node | undefined): ts.SignatureDeclaration | null {
  if (!node) return null
  if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    return node
  if (ts.isVariableDeclaration(node)) return functionOf(node.initializer)
  if (ts.isExportAssignment(node)) return functionOf(node.expression)
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
    return functionOf(node.expression)
  if (ts.isCallExpression(node)) return functionOf(node.arguments[0])
  return null
}

const isAsync = (fn: ts.SignatureDeclaration | null) =>
  !!fn &&
  ts.canHaveModifiers(fn) &&
  !!ts.getModifiers(fn)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)

/** A JSON-able value written literally in source, or `undefined` when it is an expression. */
function literal(node: ts.Expression | undefined, depth = 0): unknown {
  if (!node || depth > 4) return undefined
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
    return literal(node.expression, depth)
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isNumericLiteral(node)) return Number(node.text)
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  )
    return -Number(node.operand.text)
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (node.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isArrayLiteralExpression(node)) {
    const items = node.elements.map((item) => literal(item, depth + 1))
    return items.every((item) => item !== undefined) ? items : undefined
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, unknown> = {}
    for (const prop of node.properties) {
      if (
        !ts.isPropertyAssignment(prop) ||
        !(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
      )
        return undefined
      const value = literal(prop.initializer, depth + 1)
      if (value === undefined) return undefined
      out[prop.name.text] = value
    }
    return out
  }
  return undefined
}

function callProps(opening: ts.JsxOpeningLikeElement): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const attr of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || !ts.isIdentifier(attr.name)) continue
    const name = attr.name.text
    if (name.startsWith('data-trezi') || name === 'key') continue
    const init = attr.initializer
    const value = !init
      ? true
      : ts.isStringLiteral(init)
        ? init.text
        : ts.isJsxExpression(init)
          ? literal(init.expression)
          : undefined
    if (value !== undefined) out[name] = value
  }
  return out
}

function internalHooks(text: string): LocatedComponent['internal'] {
  return {
    state: /\buse(State|Reducer)\s*[<(]/.test(text),
    data: /\b(useSWR|useQuery|useInfiniteQuery|useSuspenseQuery|use)\s*[<(]|\bfetch\s*\(/.test(text)
  }
}

function describe(
  root: string,
  checker: ts.TypeChecker,
  declaration: ts.Node,
  component: string,
  source: string,
  exportName: string,
  signature: ts.Signature | undefined,
  at: ts.Node
): LocatedComponent {
  const file = declaration.getSourceFile()
  const fn = functionOf(declaration)
  const directive = directiveOf(file)
  const definition = relative(root, file.fileName)
  return {
    component,
    source,
    exportName,
    definition,
    schema: propsSchema(checker, signature, at),
    callProps: {},
    callSite: null,
    directive,
    ...(isAsync(fn)
      ? {
          server: `${component} is an async Server Component (${definition}). It renders only on the server, so Trezi cannot draw it on its own. Select a client component inside it, or move its data loading to the page and pass the data in as props.`
        }
      : {}),
    internal: internalHooks(fn ? fn.getText(file) : file.text)
  }
}

/** The export name of a local declaration, if the file exports it. */
function exportNameOf(
  checker: ts.TypeChecker,
  file: ts.SourceFile,
  symbol: ts.Symbol
): string | null {
  const module = checker.getSymbolAtLocation(file)
  if (!module) return null
  for (const exported of checker.getExportsOfModule(module)) {
    const target =
      exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported
    if (target === symbol || exported === symbol) return exported.name
  }
  return null
}

/** The component imported at a call site: its module, its export and its definition. */
function fromCallSite(
  root: string,
  prog: ts.Program,
  opening: ts.JsxOpeningLikeElement
): Located | null {
  const checker = prog.getTypeChecker()
  const tag = opening.tagName
  const name = ts.isPropertyAccessExpression(tag) ? tag.name.text : tag.getText()
  if (!isComponentName(name)) return null
  const head = ts.isPropertyAccessExpression(tag) ? tag.expression : tag
  const symbol = checker.getSymbolAtLocation(head)
  if (!symbol) return null
  const callFile = opening.getSourceFile()
  const local = symbol.declarations?.[0]
  let source = relative(root, callFile.fileName)
  let exportName: string | null = null
  if (
    local &&
    (ts.isImportClause(local) || ts.isImportSpecifier(local) || ts.isNamespaceImport(local))
  ) {
    const declaration = ts.findAncestor(local, ts.isImportDeclaration)
    if (!declaration || !ts.isStringLiteral(declaration.moduleSpecifier)) return null
    const resolved = ts.resolveModuleName(
      declaration.moduleSpecifier.text,
      callFile.fileName,
      prog.getCompilerOptions(),
      ts.sys
    ).resolvedModule
    // A package's component (next/link, a UI kit) is not this project's to draw.
    if (
      !resolved ||
      resolved.isExternalLibraryImport ||
      !withinRoot(root, resolved.resolvedFileName)
    )
      return null
    source = relative(root, resolved.resolvedFileName)
    exportName = ts.isImportClause(local)
      ? 'default'
      : ts.isImportSpecifier(local)
        ? (local.propertyName ?? local.name).text
        : name
  } else exportName = exportNameOf(checker, callFile, symbol)
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
  const member = ts.isPropertyAccessExpression(tag) ? checker.getSymbolAtLocation(tag) : null
  const definition = (member ?? target).valueDeclaration ?? (member ?? target).declarations?.[0]
  if (!definition) return null
  if (!withinRoot(root, definition.getSourceFile().fileName)) return null
  if (!exportName)
    return {
      error: `${name} is not exported from ${source}. Export it so Trezi can render it on its own.`
    }
  return describe(
    root,
    checker,
    definition,
    name,
    source,
    exportName,
    checker.getResolvedSignature(opening),
    opening
  )
}

/** The exported component whose body contains `position`: the stamp is inside its markup. */
function enclosing(
  root: string,
  prog: ts.Program,
  file: ts.SourceFile,
  position: number
): Located | null {
  const checker = prog.getTypeChecker()
  let found: { name: string; node: ts.Node; fn: ts.SignatureDeclaration } | null = null
  const walk = (node: ts.Node): void => {
    if (position < node.getStart(file) || position > node.end) return
    const fn = functionOf(node)
    const name =
      (ts.isFunctionDeclaration(node) && node.name?.text) ||
      (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text) ||
      (ts.isExportAssignment(node) && 'default') ||
      ''
    if (fn && name && (isComponentName(name) || name === 'default')) found = { name, node, fn }
    ts.forEachChild(node, walk)
  }
  walk(file)
  const hit = found as { name: string; node: ts.Node; fn: ts.SignatureDeclaration } | null
  if (!hit) return null
  const symbol =
    ts.isExportAssignment(hit.node) || !(hit.node as ts.NamedDeclaration).name
      ? null
      : checker.getSymbolAtLocation((hit.node as ts.NamedDeclaration).name!)
  const isDefault =
    ts.isExportAssignment(hit.node) ||
    (ts.isFunctionDeclaration(hit.node) &&
      ts.getModifiers(hit.node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword))
  const exportName = isDefault ? 'default' : symbol ? exportNameOf(checker, file, symbol) : null
  const component = hit.name === 'default' ? 'Component' : hit.name
  const source = relative(root, file.fileName)
  if (!exportName)
    return {
      error: `${component} is not exported from ${source}. Export it so Trezi can render it on its own.`
    }
  const signature = checker.getSignatureFromDeclaration(hit.fn)
  return describe(root, checker, hit.node, component, source, exportName, signature, hit.fn)
}

/**
 * Find the component a selection belongs to. The nearest component call site wins; a call site
 * of a package component (next/link around a card) or a missing one falls back to the project
 * component whose markup holds the stamp.
 */
export function locateComponent(root: string, selection: Selection): Located {
  const tries: [string, boolean][] = []
  if (selection.componentSource) tries.push([selection.componentSource, true])
  if (selection.source) tries.push([selection.source, false])
  let error: string | null = null
  for (const [stamp, isCall] of tries) {
    const where = resolveSource(root, stamp)
    if (!where || !existsSync(where.file) || !/\.[cm]?[jt]sx?$/.test(where.file)) continue
    try {
      const prog = program(root, where.file)
      const file = prog.getSourceFile(where.file)
      if (!file) continue
      const at = nodeAt(file, where.line, where.column)
      if (!at) continue
      if (isCall && at.opening) {
        const found = fromCallSite(root, prog, at.opening)
        if (found && !('error' in found))
          return { ...found, callProps: callProps(at.opening), callSite: stamp }
        if (found) error ??= found.error
      }
      const around = enclosing(root, prog, file, at.position)
      if (around && !('error' in around)) return around
      if (around) error ??= around.error
    } catch {}
  }
  if (error) return { error }
  return {
    error:
      selection.source || selection.componentSource
        ? 'Trezi could not find a React component around this element. Select an element inside a component defined in this project.'
        : 'This element has no source stamp. Select an element rendered by a React component in this project.'
  }
}

/** A conventional providers module (`app/providers.tsx` …) the states render inside, looked up
 * in the component's own app (`app`, relative to the root: a monorepo package or ''). */
export function conventionalProvider(
  root: string,
  app = ''
): { source: string; exportName: string } | null {
  for (const dir of ['app', 'src/app', 'components', 'src/components', 'src', '.']) {
    for (const ext of ['.tsx', '.jsx', '.ts', '.js']) {
      const source = join(app, dir, `providers${ext}`).replace(/^\.\//, '')
      const file = join(root, source)
      if (!existsSync(file)) continue
      const text = readFileSync(file, 'utf8')
      const named = /export\s+(?:function|const)\s+(Providers|AppProviders|Provider)\b/.exec(text)
      const exportName = named?.[1] ?? (/export\s+default\b/.test(text) ? 'default' : null)
      if (exportName) return { source, exportName }
    }
  }
  return null
}
